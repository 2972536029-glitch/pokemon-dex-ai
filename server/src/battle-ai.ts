// Reasoned AI opponent (v3): the model CHOOSES THE NEXT INTENT — an action
// the player will SEE before they act (telegraphed, Slay-the-Spire style) —
// and explains why. Every number it sees is precomputed server-side and the
// chosen intent is validated against the real state: the model is the
// strategist, the server stays the source of truth (design decision 1 of v1.2).
//
// Failure policy: model error / timeout / unparsable output / illegal intent
// all fall back to the mixed-strategy brain, so a reasoned battle can never
// stall. `reasoned=false` marks that fallback for the UI.

import { BattleState, Intent, effectiveness, PType } from "./battle.js";
import { chatComplete, GLM_CONFIG } from "./llm.js";
import type { LlmMessage } from "./types.js";

export interface ReasonedIntent {
  intent: Intent;
  reason: string;
  reasoned: boolean;
}

const displayName = (m: { zhName: string | null; name: string }) =>
  m.zhName ? `${m.zhName}(${m.name})` : m.name;

/** Build the decision prompt with PRECOMPUTED effectiveness numbers + the
 *  v3 economy (energy costs, guard option, telegraph semantics). */
function buildMessages(state: BattleState): LlmMessage[] {
  const ai = state.aiTeam[state.activeAi];
  const user = state.userTeam[state.activeUser];

  const moveLines = ai.moves
    .map((m) => {
      const eff = effectiveness(m.type, user.types as PType[]);
      const afford = (m.cost ?? 0) <= (ai.energy ?? 0);
      return `- moveId:"${m.id}" 名称:${m.name} 属性:${m.type} 威力:${m.power} 费用⚡:${m.cost ?? 0}` +
        ` 克制倍数:${eff}(本系加成:${ai.types.includes(m.type) ? "有,1.5x" : "无"})${afford ? "" : " ⚠️能量不足,选它会被系统降档"}`;
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
        "你是对战中的 AI 对手,负责选择你的下一个行动(意图)并说明理由。" +
        "重要:你选的行动会先展示给对手,对手会针对它行动,然后你的行动才执行——" +
        "所以你要选「即使被看到也合理」的行动。" +
        '严格只输出一个 JSON 对象,不要输出任何其他文字:' +
        '出招 {"kind":"move","moveId":"<moves列表中的id>","reason":"不超过30字"};' +
        '防御 {"kind":"guard","reason":"不超过30字"}(本回合受伤减半,⚡+35);' +
        '换人 {"kind":"switch","index":<bench列表中的index>,"reason":"不超过30字"}。' +
        "克制倍数已为你算好:≥2 才算克制,0 为免疫,<1 为抗性。打中克制(≥2)你会额外回 ⚡20。",
    },
    {
      role: "user" as const,
      content:
        `你的在场宝可梦:${displayName(ai)} HP:${ai.hp}/${ai.maxHp} ⚡能量:${ai.energy ?? 0}/100 属性:${ai.types.join("/")}\n` +
        `你的招式(克制倍数已算好):\n${moveLines}\n` +
        (benchLines ? `你的替补:\n${benchLines}\n` : "") +
        `对手在场宝可梦:${displayName(user)} HP:${user.hp}/${user.maxHp} 属性:${user.types.join("/")}\n` +
        "请选择你的下一个行动(意图)并给出理由。",
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
 * Ask the model for the AI's NEXT intent. THROWS on model error / timeout /
 * unparsable output / illegal choice — the CALLER falls back to the mixed
 * strategy in every failure case (reasoned=false marks that fallback).
 */
export async function chooseAiIntentReasoned(
  state: BattleState,
  signal: AbortSignal
): Promise<ReasonedIntent> {
  const ai = state.aiTeam[state.activeAi];
  const user = state.userTeam[state.activeUser];

  if (!GLM_CONFIG.apiKey) throw new Error("model unavailable");
  const signalAny = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  let retried = false;

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
    if (!retried && !(err?.name === "TimeoutError" || err?.name === "AbortError")) {
      retried = true;
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
    if ((move.cost ?? 0) > (ai.energy ?? 0)) throw new Error("model chose an unaffordable move");
    const reason = guardReason(String(parsed.reason ?? "").slice(0, 60) || "按属性克制选择", move, user.types);
    return {
      intent: { kind: "move", moveId: move.id, tier: move.tier, label: `${move.name} · 威力${move.power}` },
      reason,
      reasoned: true,
    };
  }

  if (parsed.kind === "guard") {
    const reason = String(parsed.reason ?? "").slice(0, 60) || "防御蓄力";
    return { intent: { kind: "guard", label: "防御蓄力 · 受伤减半⚡+35" }, reason, reasoned: true };
  }

  if (parsed.kind === "switch") {
    const idx = Number(parsed.index);
    const benchOk =
      Number.isInteger(idx) && idx >= 0 && idx < state.aiTeam.length &&
      idx !== state.activeAi && state.aiTeam[idx].hp > 0;
    if (!benchOk) throw new Error("model chose an invalid switch");
    const mon = state.aiTeam[idx];
    const reason = String(parsed.reason ?? "").slice(0, 60) || "调整阵容";
    return { intent: { kind: "switch", index: idx, label: `换上 ${mon.zhName ?? mon.name}` }, reason, reasoned: true };
  }

  throw new Error("model output had no valid action kind");
}
