import type { AuditLog } from '../audit.js';
import type { ToolCall, ToolSpec } from '../model.js';
import { type ToolDefinition, toolSpecs } from './definitions.js';

/** Where untrusted text in the model's context came from (the `source` of its <untrusted> wrapper). */
export type UntrustedSource = 'email' | 'calendar' | 'document';

/** True when everything untrusted in view is document text (D2): no email, no calendar event, nothing unknown. */
export function onlyDocuments(ctx: { untrustedInContext: boolean; untrustedSources?: ReadonlySet<UntrustedSource> | undefined }): boolean {
  return ctx.untrustedInContext && !!ctx.untrustedSources?.size && [...ctx.untrustedSources].every((s) => s === 'document');
}

export interface ToolContext {
  signal: AbortSignal;
  /**
   * True when text from an untrusted source (an email) is in the model's context for
   * this call, so the call may have been steered by it. Computed by the agent, not the model.
   */
  untrustedInContext: boolean;
  /** D2: which kinds of untrusted text are in view. Left out, it counts as unknown (never documents only). */
  untrustedSources?: ReadonlySet<UntrustedSource>;
  /** The user's own message that started this turn. */
  userText: string;
}

/** A handler may add fields to its audit entry, e.g. a device change's old and new value. */
export interface ToolResult {
  content: string;
  audit?: Record<string, unknown>;
}

export interface RegisteredTool {
  def: ToolDefinition;
  /** Shown in the chat while the tool runs, e.g. "Checking the time…". */
  label: string;
  handler: (args: unknown, ctx: ToolContext) => Promise<string | ToolResult>;
  /**
   * Write tier only: show a card asking the user to confirm, and change nothing. The action
   * itself runs from a click on that card (system/actions.ts), never from here.
   */
  propose?: (args: unknown, ctx: ToolContext) => Promise<string | ToolResult>;
  /**
   * Device tier only: what happens instead of the change while untrusted content is in
   * context. Shows a card to confirm; changes nothing. Without it the call is refused.
   */
  confirmWhenUntrusted?: (args: unknown, ctx: ToolContext) => Promise<string | ToolResult>;
  /** The result carries untrusted text (mail tools, A4). Anything the model does after reading it is tainted. */
  untrustedOutput?: boolean;
  /** Write tier: what the model is told when its call is refused. */
  deniedMessage?: string;
  /**
   * D2 (decided 2026-10-31): a write-tier tool with `propose` that may still show its card while
   * the only untrusted text in view is from documents. Never while an email or calendar event is.
   */
  allowWithDocuments?: boolean;
  /** What the audit log records of valid arguments, when they hold the user's own words (S4). Default: all of them. */
  auditArgs?: (args: unknown) => unknown;
}

export interface ToolOutcome {
  ok: boolean;
  /** Text returned to the model as the tool result. */
  content: string;
  label: string;
}

const TOOL_TIMEOUT_MS = 15_000;

export interface ToolRegistryOptions {
  /** Device-tier calls are refused while paused (S1). */
  isPaused?: () => boolean;
  /** At most this many device-tier changes per window. Default 10 a minute (plan §4). */
  deviceLimit?: { max: number; windowMs: number };
  clock?: () => number;
}

const UNTRUSTED_REFUSAL =
  'Error: this cannot run while text from an email or another outside source is in the conversation. Ask the user to request it in a new message of their own.';

/**
 * Executes tool calls with argument validation, risk-tier enforcement, a timeout and an
 * audit entry for every call. Only registered tools are offered to the model.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly deviceCalls: number[] = [];
  private readonly clock: () => number;

  constructor(
    private readonly audit: AuditLog,
    private readonly opts: ToolRegistryOptions = {},
  ) {
    this.clock = opts.clock ?? Date.now;
  }

  register(tool: RegisteredTool): this {
    this.tools.set(tool.def.name, tool);
    return this;
  }

  /**
   * While email text is in context, write-tier tools are left out, so an email cannot even
   * ask for one, and so are device-tier tools unless they can turn into a confirm card.
   */
  specs(opts: { untrustedInContext?: boolean; untrustedSources?: ReadonlySet<UntrustedSource> } = {}): ToolSpec[] {
    const tools = [...this.tools.values()];
    const docsOnly = onlyDocuments({ untrustedInContext: !!opts.untrustedInContext, untrustedSources: opts.untrustedSources });
    const offered = opts.untrustedInContext
      ? tools.filter((t) => (t.def.tier === 'write' ? docsOnly && t.allowWithDocuments && !!t.propose : t.def.tier !== 'device' || t.confirmWhenUntrusted))
      : tools;
    return toolSpecs(offered.map((t) => t.def));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  returnsUntrusted(name: string): boolean {
    return this.tools.get(name)?.untrustedOutput === true;
  }

  label(name: string): string {
    return this.tools.get(name)?.label ?? `Running ${name}…`;
  }

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools.get(call.name);
    const label = this.label(call.name);
    const log = (entry: Record<string, unknown>) =>
      this.audit.append({ kind: 'tool', tool: call.name, tier: tool?.def.tier ?? 'unknown', callId: call.id, ...entry });

    if (!tool) {
      log({ decision: 'rejected', reason: 'unknown tool', args: call.arguments.slice(0, 2000) });
      return { ok: false, content: `Error: there is no tool named "${call.name}".`, label };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(call.arguments || '{}');
    } catch {
      log({ decision: 'rejected', reason: 'arguments not JSON', args: call.arguments.slice(0, 2000) });
      return { ok: false, content: 'Error: tool arguments were not valid JSON.', label };
    }
    const parsed = tool.def.input.safeParse(raw);
    if (!parsed.success) {
      log({ decision: 'rejected', reason: 'invalid arguments', args: raw });
      return { ok: false, content: `Error: invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, label };
    }

    const args = tool.auditArgs ? tool.auditArgs(parsed.data) : parsed.data;
    const tier = tool.def.tier;
    // Changes to this computer never run from a context an email is in. A device change may
    // become a card the user confirms (below); anything else is refused.
    const asCard = ctx.untrustedInContext && tier === 'device' && !!tool.confirmWhenUntrusted;
    // D2: an edit card may still be shown while only document text is in view.
    const docCard = tier === 'write' && !!tool.propose && !!tool.allowWithDocuments && onlyDocuments(ctx);
    if (ctx.untrustedInContext && !asCard && !docCard && (tier === 'device' || (tier === 'write' && tool.propose))) {
      log({ decision: 'denied', reason: 'untrusted content in context', untrustedInContext: true, args });
      return { ok: false, content: UNTRUSTED_REFUSAL, label };
    }
    // Write-tier actions never run from a model call. They run only from a click on their
    // card, through an approval broker (mail/approvals.ts, system/actions.ts), which audits
    // them itself. A tool with `propose` may show that card; nothing else happens here.
    if (tier === 'write' && !tool.propose) {
      log({ decision: 'denied', reason: 'write tier runs only from a user click', untrustedInContext: ctx.untrustedInContext, args });
      return { ok: false, content: tool.deniedMessage ?? 'Error: only the user can do this, by approving it on a card.', label };
    }
    if (tier === 'device') {
      if (this.opts.isPaused?.()) {
        log({ decision: 'denied', reason: 'paused', args });
        return { ok: false, content: 'Error: paused. The user types /resume to allow changes again.', label };
      }
      const { max, windowMs } = this.opts.deviceLimit ?? { max: 10, windowMs: 60_000 };
      const now = this.clock();
      while (this.deviceCalls.length && this.deviceCalls[0]! <= now - windowMs) this.deviceCalls.shift();
      if (this.deviceCalls.length >= max) {
        log({ decision: 'denied', reason: 'device change limit', limit: max, windowMs, args });
        return { ok: false, content: `Error: that is more than ${max} changes in a minute, so I stopped. Tell the user and wait before trying again.`, label };
      }
      this.deviceCalls.push(now);
    }

    const proposing = tier === 'write' || asCard;
    const run = tier === 'write' ? tool.propose! : asCard ? tool.confirmWhenUntrusted! : tool.handler;
    const started = Date.now();
    try {
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS)]);
      const r = await run(parsed.data, { ...ctx, signal });
      const { content, audit: extra } = typeof r === 'string' ? { content: r, audit: undefined } : r;
      log({
        decision: proposing ? 'proposed' : 'allowed',
        untrustedInContext: ctx.untrustedInContext,
        args,
        ok: true,
        resultBytes: Buffer.byteLength(content),
        ms: Date.now() - started,
        ...extra,
      });
      return { ok: true, content, label };
    } catch (err) {
      const message = (err as Error).message;
      log({ decision: proposing ? 'proposed' : 'allowed', args, ok: false, error: message, ms: Date.now() - started });
      return { ok: false, content: `Error: ${message}`, label };
    }
  }
}
