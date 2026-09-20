// Minimal OpenAI-compatible streaming client for the GLM chat API.
//
// Why hand-rolled instead of the Vercel AI SDK / openai package?
// - The whole point of this project is to demonstrate understanding of the
//   agent loop. A SDK hides exactly the parts an interviewer asks about:
//   how tool_calls stream in fragments and get assembled by index, how SSE
//   chunks split mid-line, what finish_reason means.
// - The API surface we need is ONE endpoint; the client below is ~150 lines
//   and has zero dependencies.
//
// GLM (open.bigmodel.cn) exposes the OpenAI /chat/completions contract,
// including `stream: true` with tools. Chunks follow OpenAI conventions:
//   data: {"choices":[{"delta":{"content":"你"}}]}        // text token
//   data: {"choices":[{"delta":{"tool_calls":[{"index":0,
//          "id":"call_x","function":{"name":"get_pokemon",
//          "arguments":"{\"na"}}]}}]}                     // argument fragment
//   data: {"choices":[{"finish_reason":"tool_calls"}]}
//   data: [DONE]
// Argument fragments arrive in pieces — the assembler below concatenates
// them by `index` and only emits the calls once finish_reason arrives.

import { LlmError } from "./types.js";
import type { LlmMessage, ToolCallRequest } from "./types.js";

export const GLM_CONFIG = {
  get apiKey() {
    return process.env.GLM_API_KEY ?? "";
  },
  get baseUrl() {
    return (process.env.GLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4").replace(/\/$/, "");
  },
  get model() {
    return process.env.GLM_MODEL ?? "glm-4-flash";
  },
};

export type LlmStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: ToolCallRequest[] }
  | { type: "finish"; reason: string };

export interface StreamChatOptions {
  messages: LlmMessage[];
  /** Omit to force a text-only answer (used for the guard's correction round). */
  tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: object } }>;
  signal: AbortSignal;
}

export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<LlmStreamEvent> {
  const body: Record<string, unknown> = {
    model: GLM_CONFIG.model,
    messages: opts.messages,
    stream: true,
    temperature: 0.3, // low: this is a data lookup assistant, not a poem writer
  };
  if (opts.tools?.length) body.tools = opts.tools;
  // GLM-4.5+ models ship with a built-in thinking mode that streams a
  // private reasoning phase first — smart, but adds 30s+ of invisible
  // latency before the first visible token. A snappy dex assistant wants
  // it off; the param is 4.5+-only, older models would reject it.
  if (/glm-(4\.5|4\.6|5)/.test(GLM_CONFIG.model)) {
    body.thinking = { type: process.env.GLM_THINKING === "1" ? "enabled" : "disabled" };
  }

  const res = await fetch(`${GLM_CONFIG.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${GLM_CONFIG.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new LlmError(res.status, detail.slice(0, 300) || `LLM HTTP ${res.status}`);
  }
  if (!res.body) throw new LlmError(502, "LLM returned an empty body");

  // ---- SSE parsing -------------------------------------------------------
  // Network chunks arrive at arbitrary byte boundaries, so a chunk can end
  // in the middle of a JSON line. We therefore buffer everything and only
  // consume complete "\n\n"-terminated events. This is the classic SSE bug;
  // handling it explicitly is why the parser is written by hand.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // tool_calls assembly state, keyed by the server-provided index.
  const pending = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason: string | null = null;
  let sawDone = false;

  const handleEvent = function* (payload: string): Generator<LlmStreamEvent> {
    if (payload === "[DONE]") {
      sawDone = true;
      return;
    }
    let json: any;
    try {
      json = JSON.parse(payload);
    } catch {
      return; // tolerate keep-alive/comment lines we don't understand
    }
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content.length > 0) {
      yield { type: "text", text: delta.content };
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = typeof tc.index === "number" ? tc.index : 0;
      const slot = pending.get(idx) ?? { id: "", name: "", arguments: "" };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (typeof tc.function?.arguments === "string") slot.arguments += tc.function.arguments;
      if (!slot.id) slot.id = `call_${idx}_${Date.now()}`; // defensive: never emit an id-less call
      pending.set(idx, slot);
    }
    if (choice.finish_reason) {
      const reason: string = choice.finish_reason;
      finishReason = reason;
      if (reason === "tool_calls" && pending.size > 0) {
        yield {
          type: "tool_calls",
          calls: [...pending.entries()].map(([idx, p]) => ({
            id: p.id || `call_${idx}_${Date.now()}`,
            function: { name: p.name, arguments: p.arguments },
          })),
        };
      }
      yield { type: "finish", reason };
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of rawEvent.split("\n")) {
        if (!line.startsWith("data:")) continue; // ignore "event:"/"comment" lines
        yield* handleEvent(line.slice(5).trim());
      }
    }
  }

  if (!sawDone && !finishReason) {
    throw new LlmError(502, "LLM stream ended without a finish reason");
  }
}
