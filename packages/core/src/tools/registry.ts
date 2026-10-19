import type { AuditLog } from '../audit.js';
import type { ToolCall, ToolSpec } from '../model.js';
import { type ToolDefinition, toolSpecs } from './definitions.js';

export interface ToolContext {
  signal: AbortSignal;
}

export interface RegisteredTool {
  def: ToolDefinition;
  /** Shown in the chat while the tool runs, e.g. "Checking the time…". */
  label: string;
  handler: (args: unknown, ctx: ToolContext) => Promise<string>;
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

  specs(): ToolSpec[] {
    return toolSpecs([...this.tools.values()].map((t) => t.def));
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

    // Write-tier actions need a user click through the approval broker (A5). Until then: never.
    if (tool.def.tier === 'write') {
      log({ decision: 'denied', reason: 'write tier requires approval', args: parsed.data });
      return { ok: false, content: 'Error: this action needs the user to approve it, and approvals are not available yet.', label };
    }

    const started = Date.now();
    try {
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS)]);
      const content = await tool.handler(parsed.data, { signal });
      log({ decision: 'allowed', args: parsed.data, ok: true, resultBytes: Buffer.byteLength(content), ms: Date.now() - started });
      return { ok: true, content, label };
    } catch (err) {
      const message = (err as Error).message;
      log({ decision: 'allowed', args: parsed.data, ok: false, error: message, ms: Date.now() - started });
      return { ok: false, content: `Error: ${message}`, label };
    }
  }
}
