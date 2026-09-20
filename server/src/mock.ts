// Mock LLM: same streaming interface as llm.ts, no API key needed.
//
// Purpose: (1) local dev without a key, (2) an end-to-end test harness that
// exercises the REAL tool layer — the mock reads the actual tool result out
// of the message history and composes its answer from it, so the loop,
// SSE transport, guard and UI are all genuinely exercised.
//
// Script: first round emits a get_pokemon tool call for the name found in
// the last user message (or "pikachu"); second round streams an answer
// built from that tool result, correctly — so the guard's fact check passes.

import type { LlmMessage, ToolCallRequest } from "./types.js";
import type { LlmStreamEvent, StreamChatOptions } from "./llm.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function* streamChatMock(opts: StreamChatOptions): AsyncGenerator<LlmStreamEvent> {
  const lastUser = [...opts.messages].reverse().find((m) => m.role === "user");
  const question = lastUser?.content ?? "";
  const hasToolResult = opts.messages.some((m) => m.role === "tool");

  if (!hasToolResult) {
    // Round 1: ask for a pokemon lookup. Reuse the zh→en alias map indirectly
    // by just picking a name the demo questions contain.
    const guess =
      [/([a-z][a-z\-\d\.']{2,})/i.exec(question)?.[1]?.toLowerCase(), "pikachu"].find(
        (n) => n && n.length > 1
      ) ?? "pikachu";
    const call: ToolCallRequest = {
      id: "mock_call_1",
      function: { name: "get_pokemon", arguments: JSON.stringify({ name: guess }) },
    };
    yield { type: "tool_calls", calls: [call] };
    yield { type: "finish", reason: "tool_calls" };
    return;
  }

  // Round 2: answer from the actual tool result (never from thin air).
  const toolMsg = [...opts.messages].reverse().find((m) => m.role === "tool");
  let text: string;
  try {
    const p = JSON.parse(toolMsg?.content ?? "{}");
    if (p.error) {
      text = "抱歉,图鉴里查不到这只宝可梦,换个名字或编号试试?";
    } else {
      const stats = p.stats ?? {};
      text =
        `查到啦!${p.name}(编号 #${p.id})是 ${String(p.types).replace(/,/g, " / ")} 属性的宝可梦。\n` +
        `种族值:HP ${stats.hp}、攻击 ${stats.attack}、防御 ${stats.defense}、速度 ${stats.speed}。\n` +
        `身高 ${p.height_m} 米,体重 ${p.weight_kg} 公斤。` +
        `\n\n(演示模式:此回答由内置 mock 生成,数据仍来自真实 PokeAPI 工具调用)`;
    }
  } catch {
    text = "抱歉,数据解析出了问题,请再问一次。";
  }

  for (const chunk of text.match(/.{1,6}/gs) ?? []) {
    if (opts.signal.aborted) return;
    yield { type: "text", text: chunk };
    await sleep(30);
  }
  yield { type: "finish", reason: "stop" };
}
