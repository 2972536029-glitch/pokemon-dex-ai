// Minimal OpenAI-compatible streaming client for the GLM chat API.
//
// Why hand-rolled instead of the Vercel AI SDK / openai package?
// - An SDK hides exactly the parts worth understanding: how tool_calls
//   stream in fragments and get assembled by index, how SSE chunks split
//   mid-line, what finish_reason means. Owning this code keeps every part
//   of the loop explainable and debuggable.
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
export type { LlmMessage } from "./types.js";
import type { LlmMessage, ToolCallRequest } from "./types.js";
import { q } from "./db.js";

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

// ==================== v3.2 token 预算与熔断(ROADMAP-NEXT T2) ====================
// 三个消费点(chat/battle/lore)的全部成本治理收口在本模块:
//   发起前调用方 llmGate() —— 超预算返回原因,调用方走各自的规则降级路径;
//   请求本身带 meter —— streamChat/chatComplete 集中记账(含 mock,保持
//   "CI 与生产行为同构"的既有教训)。DB 故障一律 fail-open:预算保护的是
//   成本不是核心功能,与 ratelimit 同款取舍。
//
// 近似口径:token ≈ 字符数/2。GLM 的中文≈1字/token、英文≈4字符/token,
// 混合语料取 /2 是量级正确的工程近似——预算要的是"量级护栏",不是计费账单。

export type LlmFeature = "chat" | "battle" | "lore";

/** 计量与预算的归属:ident 是预算桶("u:<id>"/"ip:<ip>"),userId 仅落库备查。 */
export interface LlmMeter {
  feature: LlmFeature;
  ident: string;
  userId: number | null;
}

export type LlmGateResult = { ok: true } | { ok: false; reason: "user_daily_cap" | "global_budget" };

export function estimateTokens(...texts: string[]): number {
  let chars = 0;
  for (const t of texts) chars += t?.length ?? 0;
  return Math.ceil(chars / 2);
}

/** 预算上限:token 不是"尝试次数",不随 RATE_LIMIT_SCALE 放大(QA 用专用小值触发)。 */
function budgetCaps(): { user: number; global: number } {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v ?? "");
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  };
  return {
    user: num(process.env.LLM_USER_DAILY_TOKENS, 100_000),
    global: num(process.env.LLM_GLOBAL_DAILY_TOKENS, 2_000_000),
  };
}

/**
 * 发起 LLM 外呼前的预算闸:先查个人日额度,再查全局日预算(一个查询同时
 * 算两个桶)。超限自动记一条 capped 行(pokemon.llm.capped 指标的数据源),
 * 调用方拿到 reason 走各自降级路径——熔断是降级,永远不该变成 500。
 */
export async function llmGate(meter: LlmMeter): Promise<LlmGateResult> {
  try {
    const { user, global } = budgetCaps();
    const { rows } = await q<{ used: number; total: string }>(
      `SELECT
         COALESCE(sum(tokens) FILTER (WHERE ident = $1), 0)::int AS used,
         COALESCE(sum(tokens), 0)::text AS total
       FROM llm_usage
       WHERE created_at > now() - interval '24 hours' AND capped = false`,
      [meter.ident]
    );
    const used = Number(rows[0]?.used ?? 0);
    const total = Number(rows[0]?.total ?? 0);
    if (used >= user) {
      console.warn(`[llm-budget] capped: user_daily_cap ident=${meter.ident}`);
      await recordCapped(meter);
      return { ok: false, reason: "user_daily_cap" };
    }
    if (total >= global) {
      console.warn(`[llm-budget] capped: global_budget ident=${meter.ident}`);
      await recordCapped(meter);
      return { ok: false, reason: "global_budget" };
    }
    return { ok: true };
  } catch (err: any) {
    console.warn("[llm-budget] db unavailable, failing open:", err?.message);
    return { ok: true };
  }
}

function recordCapped(meter: LlmMeter): Promise<void> {
  return q(
    `INSERT INTO llm_usage (feature, ident, user_id, tokens, capped) VALUES ($1, $2, $3, 0, true)`,
    [meter.feature, meter.ident, meter.userId]
  ).then(
    () => undefined,
    (err: unknown) => {
      console.warn("[llm-budget] capped marker dropped:", (err as Error).message);
    }
  );
}

/** 记一笔真实/mock 消耗。尽力而为:计量丢失只影响预算精度,不阻塞主流程。 */
export function recordLlmUsage(meter: LlmMeter, tokens: number): void {
  if (!meter || tokens <= 0) return;
  q(
    `INSERT INTO llm_usage (feature, ident, user_id, tokens) VALUES ($1, $2, $3, $4)`,
    [meter.feature, meter.ident, meter.userId, Math.min(tokens, 20_000_000)]
  ).catch((err: unknown) => {
    console.warn("[llm-budget] usage row dropped:", (err as Error).message);
  });
  maybePrune();
}

let lastPrune = 0;
/** 5% 采样 + 每分钟一次:清理 7 天前的用量行(预算只看 24h 滚动窗)。 */
function maybePrune(): void {
  if (Math.random() >= 0.05) return;
  const now = Date.now();
  if (now - lastPrune < 60_000) return;
  lastPrune = now;
  q(
    `DELETE FROM llm_usage WHERE id IN (
       SELECT id FROM llm_usage WHERE created_at < now() - interval '7 days' LIMIT 500)`
  ).catch((err: unknown) => {
    console.warn("[llm-budget] prune failed:", (err as Error).message);
  });
}

export type LlmStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: ToolCallRequest[] }
  | { type: "finish"; reason: string };

export interface StreamChatOptions {
  messages: LlmMessage[];
  /** Omit to force a text-only answer (used for the guard's correction round). */
  tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: object } }>;
  signal: AbortSignal;
  /** v3.2:传入才计量。预算闸(llmGate)由调用方在发起前自行检查;
   *  这里只负责记账:输入在流开始时入账,输出在流结束/中断时入账。 */
  meter?: LlmMeter;
  /** v3.2.1(QA-044):输出上限。token 预算是事后计量,输出是最难预估的
   *  一头——battle/lore 各有 160/300 的界,chat 不能裸奔,否则单发超调
   *  幅度不可控。1024 对回答与 tool_calls 实参都是充裕上界。 */
  maxTokens?: number;
}

export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<LlmStreamEvent> {
  if (opts.meter) recordLlmUsage(opts.meter, estimateTokens(...opts.messages.map((m) => String(m.content ?? ""))));
  let outChars = 0;

  const body: Record<string, unknown> = {
    model: GLM_CONFIG.model,
    messages: opts.messages,
    stream: true,
    temperature: 0.3, // low: this is a data lookup assistant, not a poem writer
    max_tokens: opts.maxTokens ?? 1024,
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
    signal: AbortSignal.any([opts.signal, AbortSignal.timeout(45_000)]), // v3.1:外呼 45s 上限,防上游挂起拖满函数
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
      outChars += delta.content.length;
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

  try {
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
  } finally {
    // 中断(客户端走人/超时)也要把已流出的部分入账——烧掉的钱不因没人看而变少
    if (opts.meter && outChars > 0) recordLlmUsage(opts.meter, Math.ceil(outChars / 2));
  }
}

/** Non-streaming single completion (used by the battle advisor). */
export async function chatComplete(
  messages: LlmMessage[],
  opts: {
    signal: AbortSignal;
    maxTokens?: number;
    temperature?: number;
    meter?: LlmMeter;
  } = { signal: new AbortController().signal }
): Promise<string> {
  const inTokens = opts.meter ? estimateTokens(...messages.map((m) => String(m.content ?? ""))) : 0;
  let outChars = 0;
  try {
    const res = await fetch(`${GLM_CONFIG.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${GLM_CONFIG.apiKey}`,
      },
      body: JSON.stringify({
        model: GLM_CONFIG.model,
        messages,
        stream: false,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 300,
      }),
      signal: AbortSignal.any([opts.signal, AbortSignal.timeout(45_000)]), // v3.1:外呼 45s 上限,防上游挂起拖满函数
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new LlmError(res.status, detail.slice(0, 300) || `LLM HTTP ${res.status}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : "";
    outChars = text.length;
    return text;
  } finally {
    // 失败的调用同样花钱:输入恒入账,输出按已拿到的长度入账
    if (opts.meter) recordLlmUsage(opts.meter, inTokens + Math.ceil(outChars / 2));
  }
}
