// Hallucination guard: cross-check the model's final answer against the
// data its tool calls actually returned.
//
// Why this exists: the #1 failure mode of a chat-over-API assistant is a
// fluent answer with made-up numbers (a stat from memory, not from the
// tool). Prompting alone ("only use tool data") reduces but does not
// eliminate it — so we verify mechanically, the same spirit as a test
// asserting on real output.
//
// Design decisions (each deliberately conservative):
// - Only NUMERIC claims are checked (stats, weight, height). Verbal claims
//   ("是否克制") are NOT verified — they need NLP we shouldn't hand-roll;
//   v1 scope is documented in README.md.
// - Existence of mentioned Pokémon is NOT checked: mentioning a Pokémon the
//   tools never returned is not itself an error ("我不知道" is a valid
//   answer), so there is no sound way to flag it without an NLP model.
// -宁漏判不误判: a number we fail to parse is counted as "unchecked", never
//   as "wrong". A false positive would trigger an unnecessary regeneration.
//   Comparative sentences ("比皮卡丘重3公斤") are skipped entirely for the
//   same reason — their numbers are deltas, not dex values.
// - Max ONE correction round. If the model still gets it wrong after being
//   shown the correct values, we don't loop — we stream a visible warning
//   so the user knows to trust the dex card over the prose.

import { ZH_NAME_ALIASES, collectFacts } from "./tools.js";
import type { ToolLogEntry } from "./types.js";

export interface GuardResult {
  status: "pass" | "corrected" | "warn";
  checked: number;
  problems: Problem[];
}
export interface Problem {
  claim: string; // the sentence that failed
  field: string;
  expected: string;
  actual: string; // what the answer said
}

// Reverse the zh→en alias map so Chinese mentions can be matched too.
const EN_TO_ZH: Record<string, string> = {};
for (const [zh, en] of Object.entries(ZH_NAME_ALIASES)) {
  if (!EN_TO_ZH[en]) EN_TO_ZH[en] = zh;
}
export { EN_TO_ZH };

// Chinese type names → PokeAPI type slugs, for parsing "火系克水系" claims.
// A Chinese token only counts when followed by 系/属性 — otherwise "喷火龙"
// would read as a mention of the fire type.
const TYPE_ZH: Record<string, string> = {
  普通: "normal", 一般: "normal", 火: "fire", 水: "water", 雷: "electric",
  电: "electric", 草: "grass", 冰: "ice", 格斗: "fighting", 毒: "poison",
  地面: "ground", 岩石: "rock", 石头: "rock", 飞行: "flying",
  超能力: "psychic", 虫: "bug", 幽灵: "ghost", 龙: "dragon", 恶: "dark",
  钢: "steel", 妖精: "fairy",
};
const EN_TYPES = new Set([
  "normal", "fire", "water", "electric", "grass", "ice", "fighting", "poison",
  "ground", "rock", "flying", "psychic", "bug", "ghost", "dragon", "dark",
  "steel", "fairy",
]);
const TYPE_TOKEN_RE = /(普通|一般|火|水|雷|电|草|冰|格斗|毒|地面|岩石|石头|飞行|超能力|虫|幽灵|龙|恶|钢|妖精)(?=系|属性)|\b(normal|fire|water|electric|grass|ice|fighting|poison|ground|rock|flying|psychic|bug|ghost|dragon|dark|steel|fairy)\b/g;

/** All type mentions in a sentence, deduplicated, order preserved. */
function typesIn(sentence: string): string[] {
  const found: string[] = [];
  for (const m of sentence.matchAll(TYPE_TOKEN_RE)) {
    const token = m[0].toLowerCase();
    const norm = EN_TYPES.has(token) ? token : TYPE_ZH[token] ?? null;
    if (norm && !found.includes(norm)) found.push(norm);
  }
  return found;
}

// Keyword → canonical stat field. Order matters: "特攻"/"特殊攻击" must be
// tested before "攻击", otherwise every special-attack mention reads as attack.
const STAT_PATTERNS: Array<{ field: string; re: RegExp }> = [
  { field: "special-attack", re: /特[攻击]|特殊攻击|sp\.?\s*atk/i },
  { field: "special-defense", re: /特[防御]|特殊防御|sp\.?\s*def/i },
  { field: "hp", re: /\bhp\b|血量|生命/ },
  { field: "attack", re: /攻击|物攻|\batk\b/i },
  { field: "defense", re: /防御|物防|\bdef(ense)?\b/i },
  { field: "speed", re: /速度|\bspeed\b/i },
  { field: "weight_kg", re: /体重|\bweight\b|\bkg\b|公斤/ },
  { field: "height_m", re: /身高|\bheight\b/ },
];

const NUMBER_RE = /\d+(?:\.\d+)?/g;

/** Extract verifiable facts from every tool log entry. */
export function buildSheet(log: ToolLogEntry[]) {
  return collectFacts(log);
}

function statOf(pokemon: any, field: string): number | null {
  if (field === "weight_kg") return typeof pokemon.weight_kg === "number" ? pokemon.weight_kg : null;
  if (field === "height_m") return typeof pokemon.height_m === "number" ? pokemon.height_m : null;
  return typeof pokemon.stats?.[field] === "number" ? pokemon.stats[field] : null;
}

/**
 * Type-effectiveness claims: verify explicit "A克B" / "B怕A" / "B的弱点是A"
 * statements against the get_type_matchup data actually fetched. Direction
 * comes from the keyword (克: attacker before; 怕/弱点: attacker after).
 * Only sentences where at least one side was QUERIED are checkable — the
 * rest are skipped, not flagged (宁漏判不误判). Negations skip entirely.
 */
function checkTypeClaim(
  sentence: string,
  matchups: Map<string, { takesDoubleFrom: Set<string>; dealsDoubleTo: Set<string> }>
): { checked: number; problems: Problem[] } {
  if (/不克|不怕|无法克|未必克|不一定克|克制不了|没有弱点/.test(sentence)) return { checked: 0, problems: [] };

  const mkIdx = sentence.indexOf("克");
  const fearMatch = /怕|弱点/.exec(sentence);
  const fearIdx = fearMatch ? fearMatch.index : -1;
  if (mkIdx === -1 && fearIdx === -1) return { checked: 0, problems: [] };

  let a: string | undefined; // attacker
  let b: string | undefined; // defender
  if (mkIdx !== -1 && (fearIdx === -1 || mkIdx < fearIdx)) {
    const leftTypes = typesIn(sentence.slice(Math.max(0, mkIdx - 14), mkIdx));
    const rightTypes = typesIn(sentence.slice(mkIdx + 1, mkIdx + 12));
    a = leftTypes[leftTypes.length - 1];
    b = rightTypes[0];
  } else {
    // "水系怕电系" / "水系的弱点是草" — defender before, attacker after.
    const leftTypes = typesIn(sentence.slice(Math.max(0, fearIdx - 14), fearIdx));
    const rightTypes = typesIn(sentence.slice(fearIdx + fearMatch![0].length, fearIdx + fearMatch![0].length + 12));
    b = leftTypes[leftTypes.length - 1];
    a = rightTypes[0];
  }
  if (!a || !b || a === b) return { checked: 0, problems: [] };

  const def = matchups.get(b);
  const atk = matchups.get(a);
  if (!def && !atk) return { checked: 0, problems: [] }; // nothing queried — unverifiable
  const holds = def ? def.takesDoubleFrom.has(a) : atk!.dealsDoubleTo.has(b);
  if (!holds) {
    return {
      checked: 1,
      problems: [
        {
          claim: sentence.trim().slice(0, 60),
          field: `type: ${a} 克 ${b}`,
          expected: def
            ? `图鉴中克 ${b} 的是: ${[...def.takesDoubleFrom].join(", ")}`
            : `图鉴中 ${a} 克的是: ${[...atk!.dealsDoubleTo].join(", ")}`,
          actual: sentence.trim().slice(0, 40),
        },
      ],
    };
  }
  return { checked: 1, problems: [] };
}

/**
 * Check one sentence for (stat keyword + number) pairs against ONE pokemon.
 * Returns mismatches; unparsable numbers are ignored by design.
 */
function checkSentence(sentence: string, name: string, facts: Map<string, any>): { checked: number; problems: Problem[] } {
  const pokemon = facts.get(name);
  let checked = 0;
  const problems: Problem[] = [];
  if (!pokemon) return { checked, problems };
  const lower = sentence.toLowerCase();

  // Comparative/delta sentences ("比皮卡丘重3公斤") contain numbers that are
  // NOT dex values — checking them would misfire, so skip up front.
  if (/比较|相比|比.{0,8}[重高快多少长短大小]|更[重高快多少]|重了|高了|快了|多出|少了|相差|倍/.test(sentence)) {
    return { checked, problems };
  }

  for (const { field, re } of STAT_PATTERNS) {
    if (!re.test(lower)) continue;
    const expected = statOf(pokemon, field);
    if (expected === null) continue;

    // Numbers near the keyword (same sentence) are the claims we can see.
    const numbers = sentence.match(NUMBER_RE)?.map(Number) ?? [];
    if (numbers.length === 0) continue;
    checked++;
    const tol = field === "weight_kg" ? 0.2 : field === "height_m" ? 0.15 : 0;
    const matches = numbers.some((n) => Math.abs(n - expected) <= tol);
    if (!matches) {
      problems.push({
        claim: sentence.trim().slice(0, 60),
        field,
        expected: String(expected),
        actual: numbers.join("/"),
      });
    }
  }
  return { checked, problems };
}

/**
 * Check the whole answer. Subject tracking: a stats sentence usually omits
 * the pokemon name ("种族值:HP 35、攻击 55。"), inheriting the subject from
 * the previous sentence — we carry it forward. A sentence mentioning TWO
 * pokemon sets no subject (which number belongs to whom is ambiguous, and
 * guessing would misfire).
 */
export function checkAnswer(
  text: string,
  facts: Map<string, any>,
  matchups: Map<string, { takesDoubleFrom: Set<string>; dealsDoubleTo: Set<string> }> = new Map()
): { checked: number; problems: Problem[] } {
  const sentences = text.split(/(?<=[。!?!\n])/).filter((s) => s.trim().length > 1);
  let checked = 0;
  const problems: Problem[] = [];
  let subject: string | null = null; // English name of the current topic pokemon

  for (const s of sentences) {
    // numeric claims vs the current topic pokemon
    const mentioned = [...facts.keys()].filter(
      (name) => s.toLowerCase().includes(name) || (EN_TO_ZH[name] && s.includes(EN_TO_ZH[name]))
    );
    if (mentioned.length >= 1) subject = mentioned.length === 1 ? mentioned[0] : null;
    if (subject) {
      const r = checkSentence(s, subject, facts);
      checked += r.checked;
      problems.push(...r.problems);
    }
    // "A克B" claims vs the queried type matchup data
    if (matchups.size > 0) {
      const t = checkTypeClaim(s, matchups);
      checked += t.checked;
      problems.push(...t.problems);
    }
  }
  return { checked, problems };
}

/**
 * Team/pack RECOMMENDATION claims: inside a recommendation sentence, every
 * CATALOG pokemon mentioned must be one the user OWNS. The model cannot
 * recommend a card the collection does not contain — the same mechanical
 * honesty as the numeric guard, applied to user state.
 *
 * Conservative by design: only sentences with recommendation keywords are
 * checked; only names that exist in the CATALOG can be flagged (mentions of
 * unknown pokemon are ignored — 宁漏判不误判); matching covers the alias
 * map, so Chinese names outside it are silently skipped.
 */
export function checkTeamRecommendations(
  text: string,
  ownedEn: Set<string>,
  knownEn: Set<string>,
  questionScoped = false
): { checked: number; problems: Problem[] } {
  if (ownedEn.size === 0 || knownEn.size === 0) return { checked: 0, problems: [] };
  const sentences = text.split(/(?<=[。!?!\n])/).filter((s) => s.trim().length > 1);
  let checked = 0;
  const problems: Problem[] = [];
  for (const s of sentences) {
        // questionScoped: the USER asked for a team/pack recommendation, so the
    // whole answer is a recommendation — every catalog pokemon mentioned in
    // it must be owned. Without the question, fall back to per-sentence
    // keywords (names and the keyword often live in different sentences).
    if (!questionScoped && !/推荐|队伍|组队|建议|带上|首发|阵容/.test(s)) continue;
    for (const en of knownEn) {
      const zh = EN_TO_ZH[en];
      const mentioned = s.toLowerCase().includes(en) || (zh && s.includes(zh));
      if (!mentioned) continue;
      checked++;
      if (!ownedEn.has(en)) {
        problems.push({
          claim: s.trim().slice(0, 60),
          field: `owned: ${en}`,
          expected: "只能推荐用户收藏中拥有的卡",
          actual: s.trim().slice(0, 40),
        });
      }
    }
  }
  return { checked, problems };
}

/** System message for the single correction round. */
export function correctionMessage(problems: Problem[]): string {
  const lines = problems
    .slice(0, 5)
    .map((p) => `- 你写的是「${p.actual}」(${p.field}),图鉴数据是「${p.expected}」。原文:「${p.claim}」`)
    .join("\n");
  return (
    "你的上一条回答中有与图鉴工具返回不一致的数据,请修正后重新输出完整回答:\n" +
    lines +
    "\n要求:只使用工具返回的数据;保持简体中文;直接输出修正后的完整回答。"
  );
}

export { checkSentence };
