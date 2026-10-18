// Battle engine: pure functions, zero I/O, deterministic given the RNG seed.
// The AI (rule or reasoned) only CHOOSES actions here — all arithmetic
// (damage, KO, rewards) happens in this module, because a model must never
// be the source of game math (see docs/updates/v1.2-battle-sim.md, 决策 1).

export type PType =
  | "normal" | "fire" | "water" | "electric" | "grass" | "ice" | "fighting"
  | "poison" | "ground" | "flying" | "psychic" | "bug" | "rock" | "ghost"
  | "dragon" | "dark" | "steel" | "fairy";

/** Gen-6+ type chart, only non-1x entries: CHART[attacking][defending]. */
const CHART: Partial<Record<PType, Partial<Record<PType, number>>>> = {
  normal: { rock: 0.5, ghost: 0, steel: 0.5 },
  fire: { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 0.5 },
  water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
  electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
  grass: { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
  ice: { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
  fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
  poison: { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
  ground: { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
  flying: { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
  psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
  bug: { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5 },
  rock: { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
  ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
  dragon: { dragon: 2, steel: 0.5, fairy: 0 },
  dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
  steel: { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
  fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 },
};

/** Special-category types: these moves use the special attack/defense stats. */
const SPECIAL_TYPES = new Set<PType>(["fire", "water", "electric", "grass", "ice", "psychic", "dragon", "dark", "fairy"]);

export function effectiveness(attack: PType, defenderTypes: PType[]): number {
  return defenderTypes.reduce((mult, dt) => mult * (CHART[attack]?.[dt] ?? 1), 1);
}

export interface Move {
  id: string;
  name: string;
  type: PType;
  power: number;
  /** v3: energy cost (legacy moves carry none; v3 engine treats missing as 0) */
  cost?: number;
  /** v3: priority bracket (quick moves strike first regardless of speed) */
  priority?: number;
  /** v3: move tier for UI affordances */
  tier?: "quick" | "strike" | "heavy" | "ult";
}

const TACKLE: Move = { id: "tackle", name: "撞击", type: "normal", power: 40 };

const TYPE_MOVES: Record<PType, Move> = {
  normal: TACKLE,
  fire: { id: "fire-strike", name: "火花", type: "fire", power: 65 },
  water: { id: "water-strike", name: "水枪", type: "water", power: 65 },
  electric: { id: "electric-strike", name: "电击", type: "electric", power: 65 },
  grass: { id: "grass-strike", name: "飞叶快刀", type: "grass", power: 65 },
  ice: { id: "ice-strike", name: "冰冻光束", type: "ice", power: 65 },
  fighting: { id: "fighting-strike", name: "空手劈", type: "fighting", power: 65 },
  poison: { id: "poison-strike", name: "溶解液", type: "poison", power: 65 },
  ground: { id: "ground-strike", name: "泥巴射击", type: "ground", power: 65 },
  flying: { id: "flying-strike", name: "翅膀攻击", type: "flying", power: 65 },
  psychic: { id: "psychic-strike", name: "幻象光线", type: "psychic", power: 65 },
  bug: { id: "bug-strike", name: "虫咬", type: "bug", power: 65 },
  rock: { id: "rock-strike", name: "落石", type: "rock", power: 65 },
  ghost: { id: "ghost-strike", name: "暗影球", type: "ghost", power: 65 },
  dragon: { id: "dragon-strike", name: "龙息", type: "dragon", power: 65 },
  dark: { id: "dark-strike", name: "咬碎", type: "dark", power: 65 },
  steel: { id: "steel-strike", name: "金属爪", type: "steel", power: 65 },
  fairy: { id: "fairy-strike", name: "魔法闪耀", type: "fairy", power: 65 },
};

/** Official artwork URL (derived from dex id; PokeAPI sprite repo). */
export const artworkFor = (id: number) =>
  `https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/other/official-artwork/${id}.png`;

export interface BattleMon {
  cardId: number;
  name: string;
  zhName: string | null;
  rarity: string;
  types: PType[];
  stats: Record<string, number>;
  sprite: string | null;
  artwork: string;
  maxHp: number;
  hp: number;
  moves: Move[];
  /** v3: energy meter 0-100 (legacy states carry none; v3 engine defaults) */
  energy?: number;
}

/** Clamp hp to [0, maxHp] for every mon. Historical battles persisted before
 * catalog stat changes can carry hp > maxHp; sanitize on every read so the
 * UI never shows impossible numbers (e.g. 168/166). */
/** Rewrite stale artwork/sprite URLs (pre-CDN battles froze
 * raw.githubusercontent links, which time out from CN networks) to the
 * jsDelivr mirror. Heals every battle on read. */
function healMonUrls<T extends BattleMon>(mon: T): T {
  const toJsdelivr = (u: string | null, path: string) =>
    !u || u.includes("raw.githubusercontent")
      ? `https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/${path}/${mon.cardId}.png`
      : u;
  mon.artwork = toJsdelivr(mon.artwork ?? null, "pokemon/other/official-artwork");
  mon.sprite = toJsdelivr(mon.sprite ?? null, "pokemon");
  return mon;
}

export function clampBattleState<T extends { userTeam: BattleMon[]; aiTeam: BattleMon[] }>(state: T): T {
  for (const mon of [...state.userTeam, ...state.aiTeam]) {
    mon.hp = Math.min(Math.max(0, mon.hp), mon.maxHp);
    if (typeof mon.energy === "number") {
      mon.energy = Math.min(Math.max(0, Math.round(mon.energy)), ENERGY.CAP);
    }
    healMonUrls(mon);
  }
  return state;
}

/** Build a battle-ready mon from a catalog card (level-50 simplification).
 *  v3 battles pass { v3: true } for the four-tier moveset + energy; the
 *  default keeps the legacy moveset so the friend-battle simulator and
 *  historical states behave bit-identically. */
export function battleMonFromCard(card: {
  id: number; name: string; zh_name?: string | null; rarity: string;
  types: string[]; stats: Record<string, number>; sprite?: string | null;
}, opts?: { v3?: boolean }): BattleMon {
  const types = card.types as PType[];
  let moves: Move[];
  let energy: number | undefined;
  if (opts?.v3) {
    moves = buildV3Moves(types);
    energy = ENERGY.START;
  } else {
    moves = [TACKLE];
    for (const t of types.slice(0, 2)) {
      const m = TYPE_MOVES[t];
      if (m && m.id !== "tackle") moves.push(m);
    }
  }
  return {
    cardId: card.id,
    name: card.name,
    zhName: card.zh_name ?? null,
    rarity: card.rarity,
    types,
    stats: card.stats,
    sprite: card.sprite ?? null,
    artwork: artworkFor(card.id),
    maxHp: (card.stats.hp ?? 50) + 60,
    hp: (card.stats.hp ?? 50) + 60,
    moves,
    energy,
  };
}

export interface LogEntry {
  turn: number;
  kind: string;
  actor: string;
  text: string;
}

export interface BattleState {
  userTeam: BattleMon[];
  aiTeam: BattleMon[];
  activeUser: number;
  activeAi: number;
  turn: number;
  status: "active" | "won" | "lost";
  /** Opponent mode: rule (zero model calls) or reasoned (model chooses + explains). */
  mode?: "rule" | "reasoned";
  /** Persisted turn narrative (appended by the battle routes). */
  log?: LogEntry[];
  /** v3: engine generation marker (intent + energy battles). */
  version?: number;
  /** v3: the AI's COMMITTED action for the CURRENT player turn — generated
   *  after each resolution and telegraphed to the player before they act. */
  aiIntent?: Intent | null;
}

export type Action =
  | { kind: "move"; moveId: string }
  | { kind: "switch"; index: number };

/** v3 adds guard to the action vocabulary (halve incoming + bank energy). */
export type V3Action = Action | { kind: "guard" };

/** v3: the telegraphed AI plan. label is UI-ready Chinese; reason (reasoned
 *  mode) rides WITH the intent and is logged when the intent EXECUTES —
 *  理由与真实行动同回合配对,而不是生成时就提前一拍入日志。 */
export interface Intent {
  kind: "move" | "guard" | "switch";
  moveId?: string;
  index?: number;
  tier?: Move["tier"];
  label: string;
  reason?: string | null;
}

export interface TurnEvent {
  kind: "move" | "switch" | "ko" | "end" | "info" | "guard";
  actor: "user" | "ai" | "system";
  text: string;
  damage?: number;
  /** v3: energy deltas for UI replay (popup + bar animation). */
  energy?: Array<{ side: "user" | "ai"; amount: number }>;
}

export interface Rng {
  /** float in [0, 1) */
  next(): number;
}

export const systemRng: Rng = { next: () => Math.random() };

/** Deterministic RNG (mulberry32) for tests. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next: () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

const alive = (mon: BattleMon) => mon.hp > 0;

function damageOf(attacker: BattleMon, move: Move, defender: BattleMon, rng: Rng): { dmg: number; eff: number } {
  const eff = effectiveness(move.type, defender.types);
  if (eff === 0) return { dmg: 0, eff };
  const spec = SPECIAL_TYPES.has(move.type);
  const atk = spec ? attacker.stats["special-attack"] : attacker.stats.attack;
  const def = spec ? defender.stats["special-defense"] : defender.stats.defense;
  const stab = attacker.types.includes(move.type) ? 1.5 : 1;
  const variance = 0.85 + rng.next() * 0.15;
  const base = Math.floor((22 * move.power * atk) / Math.max(1, def) / 50 + 2);
  return { dmg: Math.max(1, Math.floor(base * stab * eff * variance)), eff };
}

function effText(eff: number): string {
  if (eff === 0) return "没有效果…";
  if (eff >= 2) return "效果绝佳!";
  if (eff < 1) return "效果不佳…";
  return "";
}

function firstAttacker(state: BattleState, rng: Rng): "user" | "ai" {
  const u = state.userTeam[state.activeUser];
  const a = state.aiTeam[state.activeAi];
  if (u.stats.speed === a.stats.speed) return rng.next() < 0.5 ? "user" : "ai";
  return u.stats.speed >= a.stats.speed ? "user" : "ai";
}

function applyMove(state: BattleState, actor: "user" | "ai", move: Move, events: TurnEvent[], rng: Rng): void {
  const atkIdx = actor === "user" ? state.activeUser : state.activeAi;
  const defIdx = actor === "user" ? state.activeAi : state.activeUser;
  const atkTeam = actor === "user" ? state.userTeam : state.aiTeam;
  const defTeam = actor === "user" ? state.aiTeam : state.userTeam;
  const atkMon = atkTeam[atkIdx];
  const defMon = defTeam[defIdx];

  const { dmg, eff } = damageOf(atkMon, move, defMon, rng);
  defMon.hp = Math.max(0, defMon.hp - dmg);
  const zh = atkMon.zhName ? `${atkMon.zhName}(${atkMon.name})` : atkMon.name;
  const targetZh = defMon.zhName ? `${defMon.zhName}(${defMon.name})` : defMon.name;
  const effSuffix = effText(eff) ? `,${effText(eff)}` : "";
  events.push({
    kind: "move", actor,
    text: `${zh} 使用了 ${move.name},对 ${targetZh} 造成 ${dmg} 点伤害${effSuffix}`,
    damage: dmg,
  });

  if (defMon.hp === 0) {
    events.push({ kind: "ko", actor: actor === "user" ? "ai" : "user", text: `${targetZh} 倒下了!` });
    // Auto-send the next living mon (both sides follow this rule).
    const team = defTeam;
    const next = team.findIndex(alive);
    if (next === -1) {
      state.status = actor === "user" ? "won" : "lost";
      events.push({ kind: "end", actor: "system", text: actor === "user" ? "你赢得了战斗!" : "AI 对手赢得了战斗…" });
    } else {
      if (actor === "user") state.activeAi = next;
      else state.activeUser = next;
      const newMon = team[next];
      const nzh = newMon.zhName ? `${newMon.zhName}(${newMon.name})` : newMon.name;
      const sender = actor === "user" ? "你" : "AI 对手";
      events.push({ kind: "switch", actor: actor === "user" ? "ai" : "user", text: `${sender}派出了 ${nzh}!` });
    }
  }
}

function applySwitch(state: BattleState, actor: "user" | "ai", index: number, events: TurnEvent[]): boolean {
  const team = actor === "user" ? state.userTeam : state.aiTeam;
  const activeIdx = actor === "user" ? state.activeUser : state.activeAi;
  if (index < 0 || index >= team.length || index === activeIdx || !alive(team[index])) return false;
  const mon = team[index];
  if (actor === "user") state.activeUser = index;
  else state.activeAi = index;
  const zh = mon.zhName ? `${mon.zhName}(${mon.name})` : mon.name;
  events.push({ kind: "switch", actor, text: `${actor === "user" ? "你" : "AI 对手"}换上了 ${zh}!` });
  return true;
}

/**
 * Resolve one full turn. Order: switches are free actions resolved first
 * (user's first), then the faster side attacks; a fainted defender is
 * replaced immediately and the slower attacker hits the NEW target.
 */
export function resolveTurn(
  state: BattleState,
  userAction: Action,
  aiAction: Action,
  rng: Rng = systemRng
): { state: BattleState; events: TurnEvent[] } {
  if (state.status !== "active") throw new Error("battle is not active");
  const events: TurnEvent[] = [];

  const doSwitch = (actor: "user" | "ai", a: Action) => {
    if (a.kind === "switch") return applySwitch(state, actor, a.index, events);
    return false;
  };
  // Switches first (user's switch takes precedence in the same turn).
  doSwitch("user", userAction);
  doSwitch("ai", aiAction);

  if (state.status === "active") {
    const order: Array<"user" | "ai"> = firstAttacker(state, rng) === "user" ? ["user", "ai"] : ["ai", "user"];
    for (const actor of order) {
      if (state.status !== "active") break;
      const a = actor === "user" ? userAction : aiAction;
      const team = actor === "user" ? state.userTeam : state.aiTeam;
      const idx = actor === "user" ? state.activeUser : state.activeAi;
      if (!alive(team[idx])) continue; // fainted by the first attack this turn
      if (a.kind === "switch") continue; // already acted as a free switch
      const move = team[idx].moves.find((m) => m.id === a.moveId) ?? team[idx].moves[0];
      applyMove(state, actor, move, events, rng);
    }
  }

  if (state.status === "active") state.turn += 1;
  return { state, events };
}

/**
 * Rule-mode brain (zero model calls), SYMMETRIC for either side (v2.3):
 * pick the move with the highest power × effectiveness (× STAB) against the
 * opponent's active mon; if badly wounded and a bench mon has a better
 * matchup, switch instead. The friend-battle simulator drives both teams
 * through this — the old ai-only variant made every "user" action secretly
 * control the defender.
 */
export function chooseAction(state: BattleState, side: "user" | "ai"): Action {
  const myTeam = side === "user" ? state.userTeam : state.aiTeam;
  const oppTeam = side === "user" ? state.aiTeam : state.userTeam;
  const myIdx = side === "user" ? state.activeUser : state.activeAi;
  const oppIdx = side === "user" ? state.activeAi : state.activeUser;
  const myMon = myTeam[myIdx];
  const oppMon = oppTeam[oppIdx];
  const best = (mon: BattleMon) =>
    Math.max(...mon.moves.map((m) => m.power * effectiveness(m.type, oppMon.types) * (mon.types.includes(m.type) ? 1.5 : 1)));

  if (myMon.hp < myMon.maxHp * 0.3) {
    let bestBench = -1;
    let bestScore = best(myMon) * 1.5; // switching must clearly dominate
    myTeam.forEach((mon, i) => {
      if (i !== myIdx && alive(mon)) {
        const s = best(mon);
        if (s > bestScore) {
          bestScore = s;
          bestBench = i;
        }
      }
    });
    if (bestBench !== -1) return { kind: "switch", index: bestBench };
  }
  // Best move by expected damage.
  let bestMove = myMon.moves[0];
  let bestExp = -1;
  for (const m of myMon.moves) {
    const e = m.power * effectiveness(m.type, oppMon.types) * (myMon.types.includes(m.type) ? 1.5 : 1);
    if (e > bestExp) {
      bestExp = e;
      bestMove = m;
    }
  }
  return { kind: "move", moveId: bestMove.id };
}

/** Back-compat alias: the PvE opponent always acts for aiTeam. */
export const chooseAiAction = (state: BattleState): Action => chooseAction(state, "ai");

/** Generate an AI opponent team from the catalog (3 distinct, rarity-weighted). */
export interface CatalogMon {
  id: number; name: string; zh_name: string | null; rarity: string;
  types: string[]; stats: Record<string, number>;
}

// ==================== v3 战斗引擎:意图 × 能量 × 弱点节奏 ====================
// 设计依据 docs/updates/v3.0-battle-rework.md(调研驱动的四件套):
// 1. 意图预告(Slay the Spire)——AI 行动在玩家出手前掷定并如实展示,反制真实。
// 2. 能量经济(Bravely Default/StS)——招式四档定价,防御=储蓄,进攻=透支。
// 3. 弱点回能(Persona One More 的行动经济转译)——打克制回能量,双向对称。
// 4. AI 混合策略(Smogon 预测理论)——top-3 加权抽样,倾向可读、不能背板。
// 旧的 resolveTurn 保留:好友 PvP 模拟器与存量战斗仍走它,语义零变化。

export const ENERGY = {
  START: 25,
  REGEN_ACTIVE: 15,
  REGEN_BENCH: 5,
  GUARD: 35,
  SWITCH_IN: 10,
  PAIN: 10,
  WEAKNESS: 20,
  CAP: 100,
} as const;

const V3_TIERS = [
  { key: "quick", suffix: "·迅", power: 40, cost: 0, priority: 1 },
  { key: "strike", suffix: "", power: 65, cost: 25, priority: 0 },
  { key: "heavy", suffix: "·重", power: 95, cost: 45, priority: 0 },
  { key: "ult", suffix: "·极", power: 135, cost: 90, priority: 0 },
] as const;

/** 四档招式派生:迅/强用主属性,重招用第二属性(双属性才有覆盖面),极招主属性。 */
function buildV3Moves(types: PType[]): Move[] {
  const t1 = types[0] ?? "normal";
  const t2 = types[1] ?? t1;
  const base1 = TYPE_MOVES[t1] ?? TACKLE;
  const base2 = TYPE_MOVES[t2] ?? TACKLE;
  return V3_TIERS.map((tier, i) => {
    const base = i === 2 ? base2 : base1; // heavy rides the secondary type
    const id = tier.key === "strike" ? base.id : `${base.id}-${tier.key === "quick" ? "q" : tier.key === "heavy" ? "h" : "u"}`;
    return {
      id,
      name: `${base.name}${tier.suffix}`,
      type: base.type,
      power: tier.power,
      cost: tier.cost,
      priority: tier.priority,
      tier: tier.key,
    } satisfies Move;
  });
}

function addEnergy(events: TurnEvent[], side: "user" | "ai", mon: BattleMon, amount: number): void {
  if (amount <= 0) return;
  mon.energy = Math.min(ENERGY.CAP, (mon.energy ?? ENERGY.START) + amount);
  (events[events.length - 1].energy ??= []).push({ side, amount });
}

/** v3 damage: same school as legacy but variance tightened to 10% (fairness
 *  principle — no crits, no accuracy rolls; randomness lives in AI sampling). */
function damageV3(attacker: BattleMon, move: Move, defender: BattleMon, rng: Rng): { dmg: number; eff: number } {
  const eff = effectiveness(move.type, defender.types);
  if (eff === 0) return { dmg: 0, eff };
  const spec = SPECIAL_TYPES.has(move.type);
  const atk = spec ? attacker.stats["special-attack"] : attacker.stats.attack;
  const def = spec ? defender.stats["special-defense"] : defender.stats.defense;
  const stab = attacker.types.includes(move.type) ? 1.5 : 1;
  const variance = 0.9 + rng.next() * 0.1;
  const base = Math.floor((22 * move.power * atk) / Math.max(1, def) / 50 + 2);
  return { dmg: Math.max(1, Math.floor(base * stab * eff * variance)), eff };
}

/** Deterministic expected damage (no variance) for AI scoring. */
export function estDamage(attacker: BattleMon, move: Move, defender: BattleMon): number {
  const eff = effectiveness(move.type, defender.types);
  if (eff === 0) return 0;
  const spec = SPECIAL_TYPES.has(move.type);
  const atk = spec ? attacker.stats["special-attack"] : attacker.stats.attack;
  const def = spec ? defender.stats["special-defense"] : defender.stats.defense;
  const stab = attacker.types.includes(move.type) ? 1.5 : 1;
  return Math.max(1, Math.floor((22 * move.power * atk) / Math.max(1, def) / 50 + 2) * stab * eff);
}

const energyOf = (m: BattleMon) => m.energy ?? ENERGY.START;
const costOf = (m: Move) => m.cost ?? 0;
const priorityOf = (m: Move) => m.priority ?? 0;

/** Resolve one v3 turn. Order: regen → switches (+momentum) → guards (bank)
 *  → moves by priority/speed (guard halves; weakness/pain bank energy) →
 *  KO auto-replace → guards cleared. The NEXT ai intent is NOT set here —
 *  routes own intent lifecycle (rule vs reasoned generation). */
export function resolveBattleTurn(
  state: BattleState,
  userAction: V3Action,
  aiAction: V3Action,
  rng: Rng = systemRng
): { state: BattleState; events: TurnEvent[] } {
  if (state.status !== "active") throw new Error("battle is not active");
  const events: TurnEvent[] = [];
  const guards = new Set<"user" | "ai">();

  // 1) 回合开始回能:在场+15,替补热身+5(静默,条形图随新状态跳变)
  for (const mon of state.userTeam) {
    const bench = mon !== state.userTeam[state.activeUser];
    if (mon.hp > 0) mon.energy = Math.min(ENERGY.CAP, energyOf(mon) + (bench ? ENERGY.REGEN_BENCH : ENERGY.REGEN_ACTIVE));
  }
  for (const mon of state.aiTeam) {
    const bench = mon !== state.aiTeam[state.activeAi];
    if (mon.hp > 0) mon.energy = Math.min(ENERGY.CAP, energyOf(mon) + (bench ? ENERGY.REGEN_BENCH : ENERGY.REGEN_ACTIVE));
  }

  // 2) 换人先行(玩家侧优先):换上来的精灵 +10 动量能量
  const doSwitch = (actor: "user" | "ai", a: V3Action) => {
    if (a.kind !== "switch") return;
    const ok = applySwitch(state, actor, a.index, events);
    if (ok) {
      const team = actor === "user" ? state.userTeam : state.aiTeam;
      const idx = actor === "user" ? state.activeUser : state.activeAi;
      const mon = team[idx];
      events.push({ kind: "info", actor, text: `${mon.zhName ?? mon.name} 蓄势待发(⚡+${ENERGY.SWITCH_IN})` });
      addEnergy(events, actor, mon, ENERGY.SWITCH_IN);
    }
  };
  doSwitch("user", userAction);
  doSwitch("ai", aiAction);

  // 3) 防御标记:受伤减半 + 回能(储蓄)
  const doGuard = (actor: "user" | "ai", a: V3Action) => {
    if (a.kind !== "guard") return;
    guards.add(actor);
    const team = actor === "user" ? state.userTeam : state.aiTeam;
    const idx = actor === "user" ? state.activeUser : state.activeAi;
    const mon = team[idx];
    events.push({ kind: "guard", actor, text: `${mon.zhName ?? mon.name} 摆出了防御姿态!(本回合受伤减半)` });
    addEnergy(events, actor, mon, ENERGY.GUARD);
  };
  doGuard("user", userAction);
  doGuard("ai", aiAction);

  // 4) 出招:先制度 → 速度 → 掷随机。能量不足自动降档为迅招(免费)。
  if (state.status === "active") {
    const u = state.userTeam[state.activeUser];
    const a = state.aiTeam[state.activeAi];
    const uPr = userAction.kind === "move" ? priorityOf(u.moves.find((m) => m.id === userAction.moveId) ?? u.moves[0]) : -Infinity;
    const aPr = aiAction.kind === "move" ? priorityOf(a.moves.find((m) => m.id === aiAction.moveId) ?? a.moves[0]) : -Infinity;
    let order: Array<"user" | "ai">;
    if (uPr !== aPr) order = uPr > aPr ? ["user", "ai"] : ["ai", "user"];
    else if (u.stats.speed !== a.stats.speed) order = u.stats.speed > a.stats.speed ? ["user", "ai"] : ["ai", "user"];
    else order = rng.next() < 0.5 ? ["user", "ai"] : ["ai", "user"];

    for (const actor of order) {
      if (state.status !== "active") break;
      const act = actor === "user" ? userAction : aiAction;
      if (act.kind !== "move") continue; // switch/guard already resolved
      const team = actor === "user" ? state.userTeam : state.aiTeam;
      const idx = actor === "user" ? state.activeUser : state.activeAi;
      const mon = team[idx];
      if (!alive(mon)) continue;
      let move = mon.moves.find((m) => m.id === act.moveId) ?? mon.moves[0];
      if (costOf(move) > energyOf(mon)) {
        // 与旧引擎「非法招式回退普招」同款容错:能量不足自动降档
        const quick = mon.moves.find((m) => costOf(m) === 0) ?? mon.moves[0];
        events.push({ kind: "info", actor, text: `能量不足,自动改用 ${quick.name}` });
        move = quick;
      }
      mon.energy = energyOf(mon) - costOf(move);

      const defSide = actor === "user" ? "ai" : "user";
      const defTeam = defSide === "user" ? state.userTeam : state.aiTeam;
      const defIdx = defSide === "user" ? state.activeUser : state.activeAi;
      const defMon = defTeam[defIdx];

      events.push({ kind: "move", actor, text: "", damage: 0 }); // anchor replaced below
      const anchor = events.length - 1;
      const { dmg: rawDmg, eff } = damageV3(mon, move, defMon, rng);
      const dmg = guards.has(defSide) ? Math.ceil(rawDmg / 2) : rawDmg;
      defMon.hp = Math.max(0, defMon.hp - dmg);
      const zh = mon.zhName ? `${mon.zhName}(${mon.name})` : mon.name;
      const targetZh = defMon.zhName ? `${defMon.zhName}(${defMon.name})` : defMon.name;
      const effSuffix = effText(eff) ? `,${effText(eff)}` : "";
      const guardSuffix = guards.has(defSide) ? "(防御减半)" : "";
      events[anchor] = {
        kind: "move",
        actor,
        text: `${zh} 使用了 ${move.name},对 ${targetZh} 造成 ${dmg} 点伤害${effSuffix}${guardSuffix}`,
        damage: dmg,
      };
      // 弱点回能(≥2x,双向对称)+ 痛感回能
      if (eff >= 2) addEnergy(events, actor, mon, ENERGY.WEAKNESS);
      if (dmg > 0) addEnergy(events, defSide, defMon, ENERGY.PAIN);

      if (defMon.hp === 0) {
        events.push({ kind: "ko", actor: defSide, text: `${targetZh} 倒下了!` });
        const next = defTeam.findIndex(alive);
        if (next === -1) {
          state.status = actor === "user" ? "won" : "lost";
          events.push({ kind: "end", actor: "system", text: actor === "user" ? "你赢得了战斗!" : "AI 对手赢得了战斗…" });
        } else {
          if (defSide === "user") state.activeUser = next;
          else state.activeAi = next;
          const newMon = defTeam[next];
          const nzh = newMon.zhName ? `${newMon.zhName}(${newMon.name})` : newMon.name;
          events.push({ kind: "switch", actor: defSide, text: `接下来是 ${nzh}!` });
        }
      }
    }
  }

  if (state.status === "active") state.turn += 1;
  return { state, events };
}

/** 把持久化的意图转成引擎动作(路由层调用)。 */
export function intentToAction(intent: Intent | null | undefined): V3Action | null {
  if (!intent) return null;
  if (intent.kind === "move" && typeof intent.moveId === "string") return { kind: "move", moveId: intent.moveId };
  if (intent.kind === "guard") return { kind: "guard" };
  if (intent.kind === "switch" && Number.isInteger(intent.index)) {
    return { kind: "switch", index: intent.index as number };
  }
  return null;
}

/** 意图是否仍对当前局面有效(换人后旧招式/替补编号可能失效)。 */
export function intentStillValid(state: BattleState, intent: Intent | null | undefined): boolean {
  if (!intent) return false;
  const ai = state.aiTeam[state.activeAi];
  if (intent.kind === "move") {
    const move = ai.moves.find((m) => m.id === intent.moveId);
    return move ? costOf(move) <= energyOf(ai) : false;
  }
  if (intent.kind === "switch") {
    const i = intent.index ?? -1;
    return i >= 0 && i < state.aiTeam.length && i !== state.activeAi && alive(state.aiTeam[i]);
  }
  return intent.kind === "guard";
}

/**
 * v3 mixed-strategy brain (the Smogon lesson: never a fixed script). Scores
 * every legal action, then samples from the top-3 with 0.62/0.28/0.10 — the
 * player can read tendencies over time but cannot memorize a script.
 */
export function generateAiIntent(state: BattleState, rng: Rng = systemRng): Intent {
  const ai = state.aiTeam[state.activeAi];
  const user = state.userTeam[state.activeUser];
  const candidates: Array<{ intent: Intent; score: number }> = [];

  for (const move of ai.moves) {
    if (costOf(move) > energyOf(ai)) continue;
    let score = estDamage(ai, move, user);
    if (score >= user.hp) score *= 1.6; // KO potential
    if (move.tier === "ult" && score < user.hp * 0.5) score *= 0.7; // don't waste the ult
    candidates.push({
      intent: { kind: "move", moveId: move.id, tier: move.tier, label: `${move.name} · 威力${move.power}` },
      score,
    });
  }

  // Guard: banking energy + halving the incoming hit; values survival.
  const threat = Math.max(...user.moves.map((m) => estDamage(user, m, ai)));
  let guardScore = 22;
  if (ai.hp < ai.maxHp * 0.4) guardScore += 45;
  if (energyOf(ai) >= 55) guardScore += 20;
  if (threat >= ai.hp * 0.5) guardScore += 25;
  candidates.push({ intent: { kind: "guard", label: "防御蓄力 · 受伤减半⚡+35" }, score: guardScore });

  // Switch: escape a hard-counter matchup for a better one.
  const currentBest = Math.max(...ai.moves.map((m) => estDamage(ai, m, user)));
  state.aiTeam.forEach((mon, i) => {
    if (i === state.activeAi || !alive(mon)) return;
    const benchBest = Math.max(...mon.moves.map((m) => estDamage(mon, m, user)));
    const gap = benchBest - currentBest;
    const countered = effectiveness(user.moves[0]?.type ?? "normal", ai.types) >= 2;
    if (gap > 25 || (countered && gap > 0)) {
      const name = mon.zhName ?? mon.name;
      candidates.push({
        intent: { kind: "switch", index: i, label: `换上 ${name}` },
        score: 25 + gap * 0.3 + (countered ? 30 : 0),
      });
    }
  });

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 3);
  const weights = [0.62, 0.28, 0.1].slice(0, top.length);
  const total = weights.reduce((s, w) => s + w, 0);
  let roll = rng.next() * total;
  for (let i = 0; i < top.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return top[i].intent;
  }
  return top[0].intent;
}
