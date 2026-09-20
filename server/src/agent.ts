// The agent loop: plan → call tools → observe → (repeat) → answer → verify.
//
// Shape of one request:
//   [system]  persona + ground rules for the model
//   ...user/assistant turns from the browser (trimmed to a safe window)
//   round 1:  model streams text OR emits tool_calls
//             └─ for each call: execute against PokeAPI, log it, and append
//                an assistant(tool_calls) + tool(result) message pair
//   round N:  repeat while the model keeps asking for tools (bounded!)
//   guard:    cross-check the final text against every tool result
//             └─ mismatch → ONE correction round, then a visible warning
//
// Why hand-rolled: every aspect of "how the agent works" maps to a concrete,
// readable block below — the loop is also the right place to enforce the two
// hard limits that keep the demo honest: MAX_ROUNDS (no runaway tool
// spirals) and the abort signal (client disconnect cancels the LLM stream
// AND in-flight PokeAPI calls).

import { GLM_CONFIG, streamChat } from "./llm.js";
import { streamChatMock } from "./mock.js";
import { TOOLS, executeTool } from "./tools.js";
import { buildSheet, checkAnswer, correctionMessage } from "./guard.js";
import type { ChatEvent, LlmMessage, ToolCallRequest, ToolLogEntry } from "./types.js";

// 6 rounds covers the deepest realistic chain (type matchup → candidate
// lists → 2-3 pokemon lookups → answer). Bounded, but not starved: a team
// question legitimately fans out before it can answer.
const MAX_ROUNDS = 6;
const MAX_HISTORY_MESSAGES = 12;
const MAX_TURN_LENGTH = 2_000;

function systemPrompt(contextName?: string | null): string {
  return [
    "你是「宝可梦图鉴 AI 版」的图鉴助手,回答宝可梦数据、进化、属性克制类问题。",
    "硬性规则:",
    "1. 一切数值(种族值/身高/体重)必须来自工具返回的数据,禁止凭记忆报数;工具没查到的信息,直接说查不到。",
    "2. 用户可能用中文常用译名(如 妙蛙种子),调用工具前换成英文名(如 bulbasaur)。",
    "3. 回答用简体中文;首次提到某只宝可梦时写成「中文名(英文名)」格式,方便数据核对;不确定官方中文译名时直接写英文名,禁止自造译名。",
    "4. 克制/组队类问题:先调 get_type_matchup 查克制关系,需要举例时再调 list_pokemon_of_type。克制结论只能来自工具返回的 damage_relations(如 water 的 takes_double_damage_from),禁止凭印象推断「谁克谁」;推荐队伍时只从 takes_double_damage_from 列出的属性、list_pokemon_of_type 返回的候选里选,不要添加记忆里的属性或宝可梦。",
    "5. 工具调用过程会在界面上单独展示,不要在正文里描述你调用了什么工具。",
    "6. 回答简洁,分点陈述,查完即答。",
    contextName ? `当前用户正在查看的宝可梦:${contextName}。如果问题里的"它/这只"指代不明,默认指它。` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Trim history to the last N messages WITHOUT splitting a tool-call pair. */
function trimHistory(messages: LlmMessage[]): LlmMessage[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
  // Walk forward to a cut point that starts on a user message: cutting
  // between an assistant(tool_calls) and its tool result would produce an
  // orphan tool message the API rejects.
  const start = messages.length - MAX_HISTORY_MESSAGES;
  let i = start;
  while (i < messages.length && messages[i].role !== "user") i++;
  return i < messages.length ? messages.slice(i) : messages.slice(start);
}

export interface AgentOptions {
  history: Array<{ role: "user" | "assistant"; content: string }>;
  contextName?: string | null;
  signal: AbortSignal;
  emit: (event: ChatEvent) => void;
}

export async function runAgent(opts: AgentOptions): Promise<void> {
  const { emit, signal } = opts;

  const llmMessages: LlmMessage[] = [
    { role: "system", content: systemPrompt(opts.contextName) },
    ...trimHistory(
      opts.history.slice(-20).map((m) => ({
        role: m.role,
        content: String(m.content ?? "").slice(0, MAX_TURN_LENGTH),
      }))
    ),
  ];

  const toolLog: ToolLogEntry[] = [];
  // Mock mode: no key configured, or explicitly requested. Keeps the app
  // demo-able and gives CI a full-loop test path that costs nothing.
  const useMock = process.env.MOCK_LLM === "1" || !GLM_CONFIG.apiKey;
  const stream = useMock ? streamChatMock : streamChat;

  let finalText = "";

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (signal.aborted) return;
    emit({ event: "round", data: { round, phase: "tools" } });

    let text = "";
    let finishReason = "";
    let calls: ToolCallRequest[] = [];

    for await (const ev of stream({ messages: llmMessages, tools: TOOLS.map(toApiTool), signal })) {
      if (ev.type === "text") {
        text += ev.text;
        emit({ event: "delta", data: { text: ev.text } });
      } else if (ev.type === "tool_calls") {
        calls = ev.calls;
      } else if (ev.type === "finish") {
        finishReason = ev.reason;
      }
    }

    if (finishReason !== "tool_calls" || calls.length === 0) {
      finalText = text;
      break;
    }

    // Replay the assistant's tool request into the transcript (required by
    // the API: every tool message must follow its assistant(tool_calls)).
    // GLM validates tool_call.type strictly — omitting "function" here gets
    // a 400 "工具类型不能为空" on the NEXT round, even though round 1 worked.
    llmMessages.push({
      role: "assistant",
      content: text || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: c.function })),
    });

    // UI chips first, so the user sees WHAT is being fetched while it runs.
    for (const call of calls) {
      emit({ event: "tool", data: { id: call.id, name: call.function.name, args: safeJson(call.function.arguments), status: "start" } });
    }

    // Execute all calls in parallel — independent lookups, and parallelism
    // is a free latency win for multi-pokemon comparison questions.
    const results = await Promise.all(
      calls.map((c) => executeTool(c.id, c.function.name, c.function.arguments, signal))
    );

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const { result } = results[i];
      const args = safeJson(call.function.arguments);
      toolLog.push({ tool: call.function.name, args, result });
      const def = TOOLS.find((t) => t.name === call.function.name);
      emit({
        event: "tool",
        data: { id: call.id, name: call.function.name, args, status: "done", summary: def ? def.summary(args, result) : "" },
      });
      // Errors go back as data (not exceptions) so the model can react:
      // retry with an English name, or tell the user it's not in the dex.
      llmMessages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result.ok ? result.data : { error: result.error, hint: result.hint }),
      });
    }
    finalText = text; // keep any narration if we exit via MAX_ROUNDS
  }

  if (signal.aborted) return;
  if (!finalText.trim()) {
    // Ran out of rounds without an answer (broad questions that fan out
    // into many lookups). Never end SILENTLY — the UI would hang on a
    // spinning bubble; say what happened instead.
    emit({
      event: "error",
      data: { message: "这个问题查了很多轮还没得出结论,试着问得具体一点(比如指定某只宝可梦)。" },
    });
    return;
  }

  // ---- hallucination guard ------------------------------------------------
  const sheet = buildSheet(toolLog);
  const firstCheck = checkAnswer(finalText, sheet.facts, sheet.typeMatchups);
  let verify: "pass" | "corrected" | "warn" = firstCheck.problems.length === 0 ? "pass" : "warn";
  let checkedCount = firstCheck.checked;
  let finalProblems = firstCheck.problems.length;

  if (firstCheck.problems.length > 0) {
    emit({ event: "round", data: { round: MAX_ROUNDS, phase: "correct" } });
    // One bounded correction round, tools disabled so the model must
    // rewrite text instead of stalling on another lookup.
    const correction: LlmMessage[] = [
      ...llmMessages,
      { role: "assistant", content: finalText },
      { role: "user", content: correctionMessage(firstCheck.problems) },
    ];
    let corrected = "";
    for await (const ev of stream({ messages: correction, signal })) {
      if (ev.type === "text") corrected += ev.text;
      if (signal.aborted) return;
    }
    const recheck = checkAnswer(corrected, sheet.facts, sheet.typeMatchups);
    if (corrected.trim() && recheck.problems.length < firstCheck.problems.length) {
      // Swap the streamed answer for the corrected one in the UI.
      emit({ event: "replace", data: { text: corrected } });
      finalText = corrected;
      checkedCount = recheck.checked;
      finalProblems = recheck.problems.length;
      verify = recheck.problems.length === 0 ? "corrected" : "warn";
      if (verify === "warn") {
        emit({ event: "delta", data: { text: warningFooter(recheck) } });
      }
    } else {
      verify = "warn";
      emit({ event: "delta", data: { text: warningFooter(firstCheck) } });
    }
  }

  emit({ event: "done", data: { verify, checked: checkedCount, problems: finalProblems } });
}

function warningFooter(check: { checked: number; problems: unknown[] }): string {
  return `\n\n⚠️ 已核对 ${check.checked} 处数据,仍有 ${check.problems.length} 处与图鉴不符,请以图鉴卡片为准。`;
}

function toApiTool(t: (typeof TOOLS)[number]) {
  return { type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } };
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}
