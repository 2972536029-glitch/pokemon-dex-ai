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
    healMonUrls(mon);
  }
  return state;
}

/** Build a battle-ready mon from a catalog card (level-50 simplification). */
export function battleMonFromCard(card: {
  id: number; name: string; zh_name?: string | null; rarity: string;
  types: string[]; stats: Record<string, number>; sprite?: string | null;
}): BattleMon {
  const types = card.types as PType[];
  const moves: Move[] = [TACKLE];
  for (const t of types.slice(0, 2)) {
    const m = TYPE_MOVES[t];
    if (m && m.id !== "tackle") moves.push(m);
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
}

export type Action =
  | { kind: "move"; moveId: string }
  | { kind: "switch"; index: number };

export interface TurnEvent {
  kind: "move" | "switch" | "ko" | "end" | "info";
  actor: "user" | "ai" | "system";
  text: string;
  damage?: number;
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
 * Rule-mode AI (zero model calls): pick the move with the highest
 * power × effectiveness (× STAB) against the user's active mon; if badly
 * wounded and a bench mon has a better matchup, switch instead.
 */
export function chooseAiAction(state: BattleState): Action {
  const aiMon = state.aiTeam[state.activeAi];
  const userMon = state.userTeam[state.activeUser];
  const best = (mon: BattleMon) =>
    Math.max(...mon.moves.map((m) => m.power * effectiveness(m.type, userMon.types) * (mon.types.includes(m.type) ? 1.5 : 1)));

  if (aiMon.hp < aiMon.maxHp * 0.3) {
    let bestBench = -1;
    let bestScore = best(aiMon) * 1.5; // switching must clearly dominate
    state.aiTeam.forEach((mon, i) => {
      if (i !== state.activeAi && alive(mon)) {
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
  let bestMove = aiMon.moves[0];
  let bestExp = -1;
  for (const m of aiMon.moves) {
    const e = m.power * effectiveness(m.type, userMon.types) * (aiMon.types.includes(m.type) ? 1.5 : 1);
    if (e > bestExp) {
      bestExp = e;
      bestMove = m;
    }
  }
  return { kind: "move", moveId: bestMove.id };
}

/** Generate an AI opponent team from the catalog (3 distinct, rarity-weighted). */
export interface CatalogMon {
  id: number; name: string; zh_name: string | null; rarity: string;
  types: string[]; stats: Record<string, number>;
}

export function pickAiTeam(catalog: CatalogMon[], rng: Rng = systemRng): CatalogMon[] {
  const pool = [...catalog];
  const picks: CatalogMon[] = [];
  while (picks.length < 3 && pool.length) {
    picks.push(pool.splice(Math.floor(rng.next() * pool.length), 1)[0]);
  }
  return picks;
}
