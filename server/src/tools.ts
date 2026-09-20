// PokeAPI tools exposed to the model via Function Calling.
//
// Design principles (each is an interview talking point):
// 1. Small argument schemas. Every argument is either a plain string or an
//    enum — enums eliminate a whole class of hallucinated arguments ("type:
//    'electrico'"), because the model can only pick from the listed values.
// 2. Trimmed responses. PokeAPI payloads are huge (a pokemon object has
//    ~50 keys); we shape each result down to the fields the assistant can
//    actually use. Less noise = fewer tokens = cheaper, faster, and the
//    model hallucinates less because it isn't drowning in irrelevant data.
// 3. Errors as data, not exceptions. A 404 is returned to the model as
//    { error, hint } so it can react (retry with an English name, tell the
//    user honestly) instead of crashing the loop.
// 4. Every result is logged for the hallucination guard (see guard.ts) —
//    the model may only claim numbers it received from a tool.

import type { ToolDef, ToolLogEntry, ToolResult, ToolArgs } from "./types.js";

const POKEAPI = "https://pokeapi.co/api/v2";
// PokeAPI TTFB can exceed 8s from mainland networks; 15s + one retry keeps
// the tool layer usable without hanging the agent loop.
const POKEMON_FETCH_TIMEOUT_MS = 15_000;

// In-process cache for SHAPED tool results. PokeAPI data is static (dex
// numbers don't change), so "cache forever, evict FIFO at 300 entries" is
// correct here — a repeated lookup answers in 0ms instead of re-paying a
// multi-second fetch mid-conversation.
const resultCache = new Map<string, ToolResult>();
function cacheGet(key: string): ToolResult | undefined {
  const hit = resultCache.get(key);
  if (hit) {
    // refresh insertion order for FIFO eviction
    resultCache.delete(key);
    resultCache.set(key, hit);
  }
  return hit;
}
function cacheSet(key: string, value: ToolResult) {
  resultCache.set(key, value);
  if (resultCache.size > 300) {
    const oldest = resultCache.keys().next();
    if (!oldest.done) resultCache.delete(oldest.value);
  }
}

const TYPES = [
  "normal", "fire", "water", "electric", "grass", "ice", "fighting", "poison",
  "ground", "flying", "psychic", "bug", "rock", "ghost", "dragon", "dark",
  "steel", "fairy",
] as const;

// Common Chinese names → PokeAPI English names. The model usually translates
// Chinese names itself, but this map (a) covers the names it most often gets
// wrong and (b) lets the guard recognise Chinese mentions when checking the
// final answer. Small on purpose: it only needs to cover demo-grade names.
export const ZH_NAME_ALIASES: Record<string, string> = {
  "皮卡丘": "pikachu", "雷丘": "raichu",
  "妙蛙种子": "bulbasaur", "妙蛙草": "ivysaur", "妙蛙花": "venusaur",
  "小火龙": "charmander", "火恐龙": "charmeleon", "喷火龙": "charizard",
  "杰尼龟": "squirtle", "卡咪龟": "wartortle", "水箭龟": "blastoise",
  "伊布": "eevee", "雷伊布": "jolteon", "水伊布": "vaporeon", "火伊布": "flareon",
  "太阳伊布": "espeon", "月亮伊布": "umbreon",
  "卡比兽": "snorlax", "超梦": "mewtwo", "梦幻": "mew",
  "胖丁": "jigglypuff", "喵喵": "meowth", "百变怪": "ditto",
  "快龙": "dragonite", "乘龙": "lapras", "耿鬼": "gengar", "鬼斯": "gastly",
  "大岩蛇": "onix", "鲤鱼王": "magikarp", "暴鲤龙": "gyarados",
  "可达鸭": "psyduck", "呆呆兽": "slowpoke", "大舌头": "lickitung",
  "波克比": "togepi", "皮皮": "clefairy", "六尾": "vulpix",
};

/** Normalize a model-supplied name into PokeAPI's slug format. */
export function normalizePokemonName(raw: unknown): string {
  let name = String(raw ?? "").trim().toLowerCase();
  if (ZH_NAME_ALIASES[name]) return ZH_NAME_ALIASES[name];
  // PokeAPI slugs use "-" for spaces and drop apostrophes/periods:
  // "Mr. Mime" -> "mr-mime", "Farfetch'd" -> "farfetchd", "Ho-Oh" -> "ho-oh".
  return name.replace(/\s+/g, "-").replace(/['’.]/g, "");
}

/**
 * fetch() with a hard timeout that is ALSO tied to the request-level abort
 * signal. AbortSignal.any lets a PokeAPI call be cancelled either by its own
 * 15s timer or by the client disconnecting — whichever happens first.
 */
async function pokeFetch(path: string, signal: AbortSignal): Promise<Response> {
  return fetch(`${POKEAPI}${path}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(POKEMON_FETCH_TIMEOUT_MS)]),
    headers: { accept: "application/json" },
  });
}

/** pokeFetch with one retry — first-hit DNS/TLS to pokeapi.co is often slow. */
async function pokeFetchRetry(path: string, signal: AbortSignal): Promise<Response> {
  try {
    return await pokeFetch(path, signal);
  } catch (err) {
    if (signal.aborted) throw err; // client cancelled: do NOT resurrect the request
    console.warn(`[tools] pokeFetch ${path} failed once:`, err instanceof Error ? err.message : err);
    return pokeFetch(path, signal);
  }
}

function notFound(what: string, hint: string): ToolResult {
  return { ok: false, error: "not_found", hint: `${what} not found. ${hint}` };
}

async function upstreamFail(what: string): Promise<ToolResult> {
  return { ok: false, error: "upstream_unavailable", hint: `${what} could not be fetched right now.` };
}

interface ShapedPokemon {
  id: number;
  name: string;
  types: string[];
  stats: Record<string, number>;
  height_m: number;
  weight_kg: number;
  abilities: string[];
  sprite: string | null;
}

/** Keep only the fields the assistant answers questions with. */
function shapePokemon(raw: any): ShapedPokemon {
  const stats: Record<string, number> = {};
  for (const s of raw.stats ?? []) stats[s.stat.name] = s.base_stat;
  return {
    id: raw.id,
    name: raw.name,
    types: (raw.types ?? []).map((t: any) => t.type.name),
    stats: {
      hp: stats.hp, attack: stats.attack, defense: stats.defense,
      "special-attack": stats["special-attack"], "special-defense": stats["special-defense"],
      speed: stats.speed,
    },
    height_m: raw.height / 10, // PokeAPI stores decimetres
    weight_kg: raw.weight / 10, // ...and hectograms
    abilities: (raw.abilities ?? []).map((a: any) => a.ability.name),
    sprite: raw.sprites?.front_default ?? null,
  };
}

async function getPokemon(args: ToolArgs, signal: AbortSignal): Promise<ToolResult> {
  const name = normalizePokemonName(args.name);
  if (!name) return { ok: false, error: "bad_request", hint: "Provide a pokemon name." };
  const cacheKey = `pokemon:${name}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let res: Response;
  try {
    res = await pokeFetchRetry(`/pokemon/${encodeURIComponent(name)}`, signal);
  } catch {
    return upstreamFail(`PokeAPI /pokemon/${name}`);
  }
  if (res.status === 404) {
    return notFound(`Pokemon "${name}"`, "Check spelling; PokeAPI uses English names like 'pikachu'.");
  }
  if (!res.ok) return upstreamFail(`PokeAPI /pokemon/${name}`);
  const result: ToolResult = { ok: true, data: shapePokemon(await res.json()) };
  cacheSet(cacheKey, result);
  return result;
}

async function getEvolutionChain(args: ToolArgs, signal: AbortSignal): Promise<ToolResult> {
  const name = normalizePokemonName(args.name);
  if (!name) return { ok: false, error: "bad_request", hint: "Provide a pokemon name." };
  const cacheKey = `evo:${name}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // PokeAPI nests evolution data three levels deep:
  // pokemon -> species -> evolution_chain. The server walks all three so the
  // model only ever sees one clean tool result.
  let speciesRes: Response;
  try {
    speciesRes = await pokeFetchRetry(`/pokemon/${encodeURIComponent(name)}`, signal);
  } catch {
    return upstreamFail(`PokeAPI /pokemon/${name}`);
  }
  if (speciesRes.status === 404) return notFound(`Pokemon "${name}"`, "Use an English name.");
  if (!speciesRes.ok) return upstreamFail(`PokeAPI /pokemon/${name}`);
  const species = (await speciesRes.json()).species;
  if (!species?.url) return { ok: false, error: "no_evolution_data", hint: "No species entry." };

  // The species URL points at /pokemon-species/{id}; the chain lives at
  // /evolution-chain/{id} — same numeric id, different resource.
  const chainId = species.url.split("/").filter(Boolean).pop();
  let chainRes: Response;
  try {
    chainRes = await pokeFetchRetry(`/evolution-chain/${chainId}`, signal);
  } catch {
    return upstreamFail("evolution chain");
  }
  if (!chainRes.ok) return upstreamFail("evolution chain");
  const chainJson = await chainRes.json();

  // Depth-first walk of the evolution tree. Flat list with depth keeps the
  // payload tiny while preserving order and branches (eevee has 8).
  const stages: Array<{ name: string; depth: number; trigger?: string }> = [];
  const visit = (node: any, depth: number) => {
    stages.push({
      name: node.species.name,
      depth,
      trigger: node.evolution_details?.[0]?.trigger,
    });
    for (const child of node.evolves_to ?? []) visit(child, depth + 1);
  };
  visit(chainJson.chain, 0);
  const result: ToolResult = { ok: true, data: { chain: stages } };
  cacheSet(cacheKey, result);
  return result;
}

async function getTypeMatchup(args: ToolArgs, signal: AbortSignal): Promise<ToolResult> {
  const type = String(args.type ?? "").trim().toLowerCase();
  const cacheKey = `type:${type}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let res: Response;
  try {
    res = await pokeFetchRetry(`/type/${encodeURIComponent(type)}`, signal);
  } catch {
    return upstreamFail(`PokeAPI /type/${type}`);
  }
  if (res.status === 404) return notFound(`Type "${type}"`, `Use one of: ${TYPES.join(", ")}.`);
  if (!res.ok) return upstreamFail(`PokeAPI /type/${type}`);
  const raw = await res.json();
  const rel = raw.damage_relations ?? {};
  // Names only — the model explains the semantics itself.
  const names = (key: string) => (rel[key] ?? []).map((t: any) => t.name);
  const result: ToolResult = {
    ok: true,
    data: {
      type,
      deals_double_damage_to: names("double_damage_to"),
      deals_half_damage_to: names("half_damage_to"),
      deals_no_damage_to: names("no_damage_to"),
      takes_double_damage_from: names("double_damage_from"),
      takes_half_damage_from: names("half_damage_from"),
      takes_no_damage_from: names("no_damage_from"),
    },
  };
  cacheSet(cacheKey, result);
  return result;
}

async function listPokemonOfType(args: ToolArgs, signal: AbortSignal): Promise<ToolResult> {
  const type = String(args.type ?? "").trim().toLowerCase();
  const cacheKey = `typelist:${type}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let res: Response;
  try {
    res = await pokeFetchRetry(`/type/${encodeURIComponent(type)}`, signal);
  } catch {
    return upstreamFail(`PokeAPI /type/${type}`);
  }
  if (res.status === 404) return notFound(`Type "${type}"`, `Use one of: ${TYPES.join(", ")}.`);
  if (!res.ok) return upstreamFail(`PokeAPI /type/${type}`);
  const raw = await res.json();
  // Ascending id = generation order. For a Chinese-speaking audience the
  // classic low-number pokemon are the most useful suggestions; also keeps
  // the list deterministic (no surprise reshuffles between identical asks).
  const list = (raw.pokemon ?? [])
    .map((p: any) => ({
      name: p.pokemon.name,
      id: Number(p.pokemon.url.split("/").filter(Boolean).pop()),
    }))
    .filter((p: any) => Number.isFinite(p.id) && p.id <= 10_000)
    .sort((a: any, b: any) => a.id - b.id)
    .slice(0, 12);
  const result: ToolResult = { ok: true, data: { type, examples: list } };
  cacheSet(cacheKey, result);
  return result;
}

const pokemonSummary = (args: ToolArgs, r: ToolResult) =>
  r.ok ? `${normalizePokemonName(args.name)} ✓` : `${normalizePokemonName(args.name)} ✗`;

export const TOOLS: ToolDef[] = [
  {
    name: "get_pokemon",
    description:
      "Look up one Pokémon by name (English, e.g. 'pikachu') or dex number. " +
      "Returns id, types, base stats (hp/attack/defense/special-attack/special-defense/speed), height_m, weight_kg, abilities.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "English name or dex number, e.g. 'pikachu' or '25'" } },
      required: ["name"],
    },
    execute: getPokemon,
    summary: pokemonSummary,
  },
  {
    name: "get_evolution_chain",
    description:
      "Get the full evolution line of a Pokémon (all branches), in order, with evolution depth.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "English name, e.g. 'eevee'" } },
      required: ["name"],
    },
    execute: getEvolutionChain,
    summary: (args, r) => (r.ok ? `进化链 ${normalizePokemonName(args.name)} ✓` : `进化链 ${normalizePokemonName(args.name)} ✗`),
  },
  {
    name: "get_type_matchup",
    description:
      "Get type effectiveness relations for ONE type: what it hits hard, what resists it, and what damages it. " +
      "Use this for '克制/弱点/克谁' questions.",
    parameters: {
      type: "object",
      properties: { type: { type: "string", enum: [...TYPES], description: "A Pokémon type, e.g. 'water'" } },
      required: ["type"],
    },
    execute: getTypeMatchup,
    summary: (args, r) => (r.ok ? `克制关系 ${String(args.type)} ✓` : `克制关系 ${String(args.type)} ✗`),
  },
  {
    name: "list_pokemon_of_type",
    description:
      "List example Pokémon of one type (ascending dex number, classic picks first). Use after get_type_matchup " +
      "when asked to suggest pokemon or build a team.",
    parameters: {
      type: "object",
      properties: { type: { type: "string", enum: [...TYPES] } },
      required: ["type"],
    },
    execute: listPokemonOfType,
    summary: (args, r) => (r.ok ? `${String(args.type)} 候选 ✓` : `${String(args.type)} 候选 ✗`),
  },
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Run one tool call defensively: validation errors and throws both become results. */
export async function executeTool(
  callId: string,
  name: string,
  rawArgs: string,
  signal: AbortSignal
): Promise<{ id: string; name: string; result: ToolResult }> {
  const tool = findTool(name);
  if (!tool) return { id: callId, name, result: { ok: false, error: "unknown_tool", hint: `No tool named "${name}".` } };
  let args: ToolArgs;
  try {
    args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return { id: callId, name, result: { ok: false, error: "bad_arguments", hint: "Arguments must be valid JSON." } };
  }
  try {
    const result = await tool.execute(args, signal);
    return { id: callId, name, result };
  } catch {
    return { id: callId, name, result: { ok: false, error: "tool_failed", hint: "Tool execution failed." } };
  }
}

/** Build the fact sheet the hallucination guard checks against. */
export function collectFacts(log: ToolLogEntry[]) {
  const facts = new Map<string, any>();
  const chainNames = new Set<string>();
  const typeMatchups = new Map<
    string,
    { takesDoubleFrom: Set<string>; dealsDoubleTo: Set<string> }
  >();
  for (const entry of log) {
    if (entry.tool === "get_pokemon" && entry.result.ok) {
      const p = entry.result.data as ShapedPokemon;
      facts.set(p.name, p);
    }
    if (entry.tool === "get_evolution_chain" && entry.result.ok) {
      for (const stage of (entry.result.data as any).chain ?? []) chainNames.add(stage.name);
    }
    if (entry.tool === "get_type_matchup" && entry.result.ok) {
      const d = entry.result.data as any;
      typeMatchups.set(d.type, {
        takesDoubleFrom: new Set(d.takes_double_damage_from ?? []),
        dealsDoubleTo: new Set(d.deals_double_damage_to ?? []),
      });
    }
  }
  return { facts, chainNames, typeMatchups };
}
