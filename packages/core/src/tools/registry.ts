import type { AuditLog } from '../audit.js';
import type { ToolCall, ToolSpec } from '../model.js';
import { type ToolDefinition, toolSpecs } from './definitions.js';

export interface ToolContext {
  signal: AbortSignal;
  /**
   * True when text from an untrusted source (an email) is in the model's context for
   * this call, so the call may have been steered by it. Computed by the agent, not the model.
   */
  untrustedInContext: boolean;
  /** The user's own message that started this turn. */
  userText: string;
}

export interface RegisteredTool {
  def: ToolDefinition;
  /** Shown in the chat while the tool runs, e.g. "Checking the time…". */
  label: string;
  handler: (args: unknown, ctx: ToolContext) => Promise<string>;
  /** The result carries untrusted text (mail tools, A4). Anything the model does after reading it is tainted. */
  untrustedOutput?: boolean;
  /** Write tier: what the model is told when its call is refused. */
  deniedMessage?: string;
}

export interface ToolOutcome {
  ok: boolean;
  /** Text returned to the model as the tool result. */
  content: string;
  label: string;
}

const TOOL_TIMEOUT_MS = 15_000;

/**
 * Executes tool calls with argument validation, risk-tier enforcement, a timeout and an
 * audit entry for every call. Only registered tools are offered to the model.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(private readonly audit: AuditLog) {}

  register(tool: RegisteredTool): this {
    this.tools.set(tool.def.name, tool);
    return this;
  }

  /** Write-tier tools are left out while email text is in context, so an email cannot even ask for one. */
  specs(opts: { untrustedInContext?: boolean } = {}): ToolSpec[] {
    const defs = [...this.tools.values()].map((t) => t.def);
    return toolSpecs(opts.untrustedInContext ? defs.filter((d) => d.tier !== 'write') : defs);
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

    // Write-tier actions never run from a model call. They run only from a click on their
    // card, through the approval broker (mail/approvals.ts), which audits them itself.
    if (tool.def.tier === 'write') {
      log({ decision: 'denied', reason: 'write tier runs only from a user click', untrustedInContext: ctx.untrustedInContext, args: parsed.data });
      return { ok: false, content: tool.deniedMessage ?? 'Error: only the user can do this, by approving it on a card.', label };
    }

    const started = Date.now();
    try {
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS)]);
      const content = await tool.handler(parsed.data, { ...ctx, signal });
      log({ decision: 'allowed', untrustedInContext: ctx.untrustedInContext, args: parsed.data, ok: true, resultBytes: Buffer.byteLength(content), ms: Date.now() - started });
      return { ok: true, content, label };
    } catch (err) {
      const message = (err as Error).message;
      log({ decision: 'allowed', args: parsed.data, ok: false, error: message, ms: Date.now() - started });
      return { ok: false, content: `Error: ${message}`, label };
    }
  }
}
