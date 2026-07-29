// Data layer: everything that talks to PokeAPI lives here.
import { MAX_ID, POKEAPI_BASE } from "../config/pokemon.js";

export function randomId() {
  return Math.floor(Math.random() * MAX_ID) + 1;
}

export function pokemonUrl(idOrName) {
  return `${POKEAPI_BASE}/${idOrName}`;
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
  return { status: res.status, data };
}
