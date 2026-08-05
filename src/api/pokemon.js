// Data layer: everything that talks to PokeAPI lives here.
import { MAX_ID, POKEAPI_BASE } from "../config/pokemon.js";

export function randomId() {
  return Math.floor(Math.random() * MAX_ID) + 1;
}

export function pokemonUrl(idOrName) {
  return `${POKEAPI_BASE}/${idOrName}`;
}

// One-time list of all Pokémon names for the search autocomplete.
// Module-level cache so we only ever fetch it once per session.
let namesCache = null;

export async function fetchPokemonNames() {
  if (namesCache) return namesCache;
  const res = await fetch(`${POKEAPI_BASE}?limit=${MAX_ID}&offset=0`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  // The list URL looks like .../pokemon/25/ — pull the id off the end.
  namesCache = json.results.map(({ name, url }) => ({
    name,
    id: Number(url.split("/").filter(Boolean).pop()),
  }));
  return namesCache;
}

// Fetches a Pokémon's evolution chain as a flat list, in evolution order.
// Returns [] if this Pokémon doesn't evolve (or the data is unavailable).
// PokeAPI nests evolution data in a tree, so we walk it depth-first.
export async function fetchEvolutionChain(speciesUrl) {
  if (!speciesUrl) return [];
  try {
    const speciesRes = await fetch(speciesUrl);
    if (!speciesRes.ok) return [];
    const species = await speciesRes.json();
    const chainUrl = species.evolution_chain?.url;
    if (!chainUrl) return [];

    const chainRes = await fetch(chainUrl);
    if (!chainRes.ok) return [];
    const chain = await chainRes.json();

    // Walk the evolution tree: chain.chain is the base form.
    const result = [];
    let node = chain.chain;
    while (node) {
      result.push({
        name: node.species.name,
        // PokeAPI exposes min_level in details[0]; may be missing.
        minLevel: node.evolves_to?.[0]?.evolution_details?.[0]?.min_level,
      });
      node = node.evolves_to?.[0];
    }
    return result;
  } catch {
    return [];
  }
}

// Basic frontend check: does the response look like a real Pokémon?
// Guards against rendering an unexpected payload (e.g. a proxy error page
// that still came back as 200 JSON).
export function isValidPokemon(data) {
  return (
    data &&
    typeof data === "object" &&
    typeof data.id === "number" &&
    typeof data.name === "string" &&
    Array.isArray(data.types) &&
    Array.isArray(data.stats)
  );
}

// Fetches one Pokémon. Returns { status, data }.
// On a non-OK response, throws an Error with `.status` attached.
export async function fetchPokemon(idOrName) {
  const res = await fetch(pokemonUrl(idOrName));
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  const data = await res.json();
  if (!isValidPokemon(data)) {
    const error = new Error("Invalid Pokémon data");
    error.status = res.status;
    throw error;
  }
  return { status: res.status, data };
}
