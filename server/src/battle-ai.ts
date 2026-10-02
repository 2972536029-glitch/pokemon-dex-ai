// Reasoned AI opponent: the model CHOOSES the action and explains why, but
// every number it sees is precomputed server-side and the chosen action is
// validated against the real state — the model is the strategist, the
// server stays the source of truth (design decision 1 of v1.2).
//
// Failure policy: model error / timeout / unparsable output / illegal move
// all fall back to the rule-mode action, so a reasoned battle can never
// stall. `reasoned=false` marks that fallback for the UI.

import { BattleState, Action, effectiveness, PType } from "./battle.js";
import { chatComplete, GLM_CONFIG } from "./llm.js";
import type { LlmMessage } from "./types.js";

export interface ReasonedAction {
  action: Action;
  reason: string;
  reasoned: boolean;
}

const displayName = (m: { zhName: string | null; name: string }) =>
  m.zhName ? `${m.zhName}(${m.name})` : m.name;

/** Build the decision prompt with PRECOMPUTED effectiveness numbers. */
function buildMessages(state: BattleState): import("./llm.js").LlmMessage[] {
  const ai = state.aiTeam[state.activeAi];
  const user = state.userTeam[state.activeUser];

  const moveLines = ai.moves
    .map((m) => {
      const eff = effectiveness(m.type, user.types as PType[]);
      const stab = ai.types.includes(m.type);
      return `- moveId:"${m.id}" 名称:${m.name} 属性:${m.type} 威力:${m.power} ` +
        `对你在场宝可梦的克制倍数:${eff}(本系加成:${stab ? "有,1.5x" : "无"})`;
    })
    .join("\n");

  const benchLines = state.aiTeam
    .map((m, i) => ({ m, i }))
    .filter(({ m, i }) => i !== state.activeAi && m.hp > 0)
    .map(({ m, i }) => `- index:${i} ${displayName(m)} HP:${m.hp}/${m.maxHp} 属性:${m.types.join("/")}`)
    .join("\n");

  return [
    {
      role: "system" as const,
      content:
        "你是对战中的 AI 对手,只负责选择行动并说明理由。" +
        '严格只输出一个 JSON 对象,不要输出任何其他文字:' +
        '出招 {"kind":"move","moveId":"<moves列表中的id>","reason":"不超过30字"};' +
        '换人 {"kind":"switch","index":<bench列表中的index>,"reason":"不超过30字"}。' +
        "克制倍数已为你算好:≥2 才算克制,0 为免疫,<1 为抗性。",
    },
    {
      role: "user" as const,
      content:
        `你的在场宝可梦:${displayName(ai)} HP:${ai.hp}/${ai.maxHp} 属性:${ai.types.join("/")}\n` +
        `你的招式(克制倍数已算好):\n${moveLines}\n` +
        (benchLines ? `你的替补:\n${benchLines}\n` : "") +
        `对手在场宝可梦:${displayName(user)} HP:${user.hp}/${user.maxHp} 属性:${user.types.join("/")}\n` +
        "请选择行动并给出理由。",
    },
  ];
}

/** Guard the stated reason against server-computed effectiveness. */
function guardReason(reason: string, move: import("./battle.js").Move, defenderTypes: PType[]): string {
  const eff = effectiveness(move.type, defenderTypes);
  const claimsStrong = /克制|效果绝佳|2倍|双倍/.test(reason);
  const claimsWeak = /抗性|效果不佳|打不动/.test(reason);
  if (claimsStrong && eff < 2) return `${reason}(⚠️ 守卫:该说法与数据不符,实际倍数 ${eff})`;
  if (claimsWeak && eff >= 2) return `${reason}(⚠️ 守卫:该说法与数据不符,实际倍数 ${eff})`;
  return reason;
}

/**
 * Ask the model for the next AI action. THROWS on model error / timeout /
 * unparsable output / illegal choice — the CALLER falls back to the rule
 * strategy in every failure case (reasoned=false marks that fallback).
 */
export async function chooseAiActionReasoned(
  state: BattleState,
  signal: AbortSignal
): Promise<ReasonedAction> {
  const ai = state.aiTeam[state.activeAi];
  const user = state.userTeam[state.activeUser];

  if (!GLM_CONFIG.apiKey) throw new Error("model unavailable");
  const signalAny = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  // GLM 上游偶发 5xx/断流:重试一次(预算内),仍失败才走规则回退
  let llmAttempt = 0;


  const askModel = () =>
    chatComplete(buildMessages(state), {
      signal: signalAny,
      maxTokens: 160,
      temperature: 0.4,
    });
  // GLM 上游偶发 5xx/断流:静默重试一次(12s 预算内),仍失败由调用方回退规则
  let raw: string;
  try {
    raw = await askModel();
  } catch (err: any) {
    if (llmAttempt++ === 0 && !(err?.name === "TimeoutError" || err?.name === "AbortError")) {
      raw = await askModel();
    } else {
      throw err;
    }
  }

  const jsonText = raw.replace(/```json|```/g, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in model output");
  const parsed = JSON.parse(jsonText.slice(start, end + 1));

  if (parsed.kind === "move") {
    const move = ai.moves.find((m) => m.id === parsed.moveId);
    if (!move) throw new Error(`model chose unknown move: ${parsed.moveId}`);
    const reason = guardReason(String(parsed.reason ?? "").slice(0, 60) || "按属性克制选择", move, user.types);
    return { action: { kind: "move", moveId: move.id }, reason, reasoned: true };
  }

  if (parsed.kind === "switch") {
    const idx = Number(parsed.index);
    const benchOk =
      Number.isInteger(idx) && idx >= 0 && idx < state.aiTeam.length &&
      idx !== state.activeAi && state.aiTeam[idx].hp > 0;
    if (!benchOk) throw new Error("model chose an invalid switch");
    const reason = String(parsed.reason ?? "").slice(0, 60) || "调整阵容";
    return { action: { kind: "switch", index: idx }, reason, reasoned: true };
  }

  throw new Error("model output had no valid action kind");
}
