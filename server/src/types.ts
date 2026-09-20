// Shared types for the AI chat server.
// Kept deliberately small: the LLM wire format is modelled loosely
// (strings for arguments) because we validate tool arguments ourselves
// before executing anything — see tools.ts.

export type ToolArgs = Record<string, unknown>;

/** A tool call as it arrives from the model (OpenAI-compatible wire shape). */
export interface ToolCallRequest {
  id: string;
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Present on role:"assistant" messages that requested tool calls. */
  tool_calls?: ToolCallRequest[];
  /** Present on role:"tool" messages, ties the result to the call id. */
  tool_call_id?: string;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  /** Machine-readable error class, fed back to the model verbatim. */
  error?: string;
  /** Human/model-readable hint so the model can retry intelligently. */
  hint?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments — the model sees exactly this. */
  parameters: object;
  execute(args: ToolArgs, signal: AbortSignal): Promise<ToolResult>;
  /** One-line status for the UI chip, computed from the result. */
  summary(args: ToolArgs, result: ToolResult): string;
}

/** Record of every tool execution, kept for the hallucination guard. */
export interface ToolLogEntry {
  tool: string;
  args: ToolArgs;
  result: ToolResult;
}

/** SSE events the server streams to the browser. */
export type ChatEvent =
  | { event: "delta"; data: { text: string } }
  | {
      event: "tool";
      data: { id: string; name: string; args: ToolArgs; status: "start" | "done"; summary?: string };
    }
  | { event: "round"; data: { round: number; phase: "tools" | "verify" | "correct" } }
  | { event: "replace"; data: { text: string } }
  | { event: "error"; data: { message: string } }
  | {
      event: "done";
      data: { verify: "pass" | "corrected" | "warn"; checked: number; problems: number };
    };

export class LlmError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
