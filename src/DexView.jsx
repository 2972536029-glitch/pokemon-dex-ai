import { useEffect, useRef, useState } from "react";
import { fetchPokemon, randomId, pokemonUrl } from "./api/pokemon.js";
import { MAX_ID } from "./config/pokemon.js";
import LoadingState from "./components/LoadingState.jsx";
import ErrorState from "./components/ErrorState.jsx";
import PokemonCard from "./components/PokemonCard.jsx";
import NetworkInfo from "./components/NetworkInfo.jsx";
import SearchSuggestions from "./components/SearchSuggestions.jsx";
import FavoritesBar from "./components/FavoritesBar.jsx";
import EvolutionChain from "./components/EvolutionChain.jsx";
import { useFavorites } from "./hooks/useFavorites.js";
import { useTheme } from "./hooks/useTheme.js";

// Validate input before hitting the network. PokeAPI accepts a name
// (letters, "-", ".") or an id (1..MAX_ID). Anything else is rejected
// locally so we skip a wasted HTTP request.
const VALID_INPUT = /^[a-z.\-]+$/i;

function validateInput(raw) {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "Type a name or id";
  if (/^\d+$/.test(trimmed)) {
    const id = Number(trimmed);
    if (id < 1 || id > MAX_ID) return `Id must be between 1 and ${MAX_ID}`;
    return null; // valid id
  }
  if (!VALID_INPUT.test(trimmed))
    return "Only letters, numbers, - and . are allowed";
  return null; // valid name
}

export default function DexView({ onContextChange }) {
  const [pokemon, setPokemon] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [requestUrl, setRequestUrl] = useState("");
  const [statusCode, setStatusCode] = useState(null);

  // Search: what the user has typed vs. what we actually look up.
  // We only fetch when the user submits, so `query` only changes on purpose.
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState(null); // null = random mode
  // Collapse the search box into a 🔍 icon after a successful search to keep
  // the card in focus. Re-open on click.
  const [searchOpen, setSearchOpen] = useState(true);
  const searchInputRef = useRef(null);
  // Local validation message — shown under the input, no request fired.
  // Auto-clears after the fade-out animation so it stops taking up space.
  const [searchError, setSearchError] = useState(null);
  const errorTimerRef = useRef(null);

  // Mirror the latest loading/pokemon into a ref so the keydown listener can
  // read fresh values WITHOUT re-registering on every change (the listener
  // is registered once below). This is the idiomatic way to avoid the
  // "stale closure" problem for long-lived event listeners.
  const stateRef = useRef({ loading, pokemon });
  stateRef.current = { loading, pokemon };

  // Show an error and schedule it to clear itself after the bubble fades out.
  function showError(message) {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setSearchError(message);
    // CSS: 2.5s hold + 0.6s fade = 3.1s, clear right after.
    errorTimerRef.current = setTimeout(() => setSearchError(null), 3150);
  }

  // Favorites persisted to localStorage.
  const { favorites, isFavorite, toggleFavorite, removeFavorite } =
    useFavorites();

  // Light/dark theme, persisted to localStorage. Supports an "auto" mode
  // that follows the OS preference.
  const { mode, theme, toggle: toggleTheme } = useTheme();

  // Core fetch. Renamed from the starter's `catchOne` so it can take either
  // an id or a name (search needs names; the random button passes nothing).
  // Without this rename, search and the random "Catch another" button would
  // need two near-identical functions.
  async function fetchOne(target) {
    const idOrName = target ?? randomId();
    setLoading(true);
    setError(null);
    setRequestUrl(pokemonUrl(idOrName));
    setStatusCode(null);

    try {
      const { status, data } = await fetchPokemon(idOrName);
      setStatusCode(status);
      setPokemon(data);
      onContextChange?.(data); // assistant follows the card on screen
      setSearchOpen(false); // collapse on success
    } catch (e) {
      setStatusCode(e.status ?? null);
      setError(e.message);
      onContextChange?.(null);
    } finally {
      setLoading(false);
    }
  }

  // "Catch another" button — keeps the starter's random-catch behaviour
  // but now routes through fetchOne so the search box gets cleared too.
  function catchOne() {
    setSearchInput("");
    setQuery(null);
    fetchOne();
  }

  // Flip to the previous/next Pokémon by id. Wraps around at the ends.
  function flip(direction) {
    const current = pokemon?.id;
    if (loading || !current) return;
    let next;
    if (direction === "next") {
      next = current >= MAX_ID ? 1 : current + 1;
    } else {
      next = current <= 1 ? MAX_ID : current - 1;
    }
    setSearchInput("");
    setQuery(String(next));
    fetchOne(next);
  }

  // Submit the search box (Enter or the Search button).
  function submitSearch(e) {
    e.preventDefault();
    if (loading) return;
    const invalid = validateInput(searchInput);
    if (invalid) {
      showError(invalid);
      return; // block the request
    }
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setSearchError(null);
    const trimmed = searchInput.trim().toLowerCase();
    setQuery(trimmed);
    fetchOne(trimmed);
  }

  // Re-open the collapsed search box: clear the old input and focus it so
  // the user can type immediately.
  function openSearch() {
    setSearchInput("");
    setSearchError(null);
    setSearchOpen(true);
    // focus on next paint, after the input is rendered
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }

  // Random Pokémon on first load.
  useEffect(() => {
    fetchOne();
  }, []);

  // Arrow keys flip between Pokémon, but only when the user isn't typing
  // in the search box (otherwise arrow keys move the caret).
  // The listener is registered ONCE (empty deps). It reads the latest
  // loading/pokemon from stateRef above, so it never goes stale and never
  // needs to be re-registered.
  useEffect(() => {
    function onKey(e) {
      if (stateRef.current.loading) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft") flip("prev");
      else if (e.key === "ArrowRight") flip("next");
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label="Toggle theme"
          title={
            mode === "auto"
              ? `Auto (now ${theme}) — click for light`
              : mode === "light"
              ? "Light — click for dark"
              : "Dark — click for auto"
          }
        >
          {mode === "auto" ? "🖥️" : theme === "light" ? "☀️" : "🌙"}
        </button>
        <h1>Random Pokémon</h1>
      </header>

      <div className="pkmn">
        <section className="pkmn-stage">
          <div className="pkmn-stage-bg" />

          {searchOpen ? (
            <form className="pkmn-search" onSubmit={submitSearch}>
              <div className="pkmn-search-wrap">
                <input
                  ref={searchInputRef}
                  className={`pkmn-search-input ${
                    searchError ? "has-error" : ""
                  }`}
                  type="text"
                  value={searchInput}
                  onChange={(e) => {
                    setSearchInput(e.target.value);
                    if (searchError) setSearchError(null);
                  }}
                  placeholder="Name or id, e.g. pikachu or 25"
                  aria-label="Search Pokémon"
                  autoComplete="off"
                />
              <SearchSuggestions
                value={searchInput}
                loading={loading}
                onSelect={(name) => {
                  setSearchInput(name);
                  setQuery(name);
                  fetchOne(name);
                }}
              />
            </div>
            <button
              className="pkmn-search-btn"
              type="submit"
              disabled={loading}
            >
              {loading ? "…" : "Search"}
            </button>
            {searchError && (
              <p className="pkmn-search-error" role="alert">
                <span aria-hidden="true">ⓘ</span>
                {searchError}
              </p>
            )}
          </form>
          ) : (
            <button
              type="button"
              className="pkmn-search-collapsed"
              onClick={openSearch}
              aria-label="Open search"
              title="Search"
            >
              🔍
            </button>
          )}

          {loading && <LoadingState />}
          {/* Retry re-runs the *last* query (not a random one) so the user can
              re-check e.g. a typo'd name without losing context. */}
          {error && <ErrorState error={error} onRetry={() => fetchOne(query)} />}
          {!loading && !error && pokemon && (
            <>
              <div className="pkmn-deck">
                <button
                  type="button"
                  className="pkmn-nav pkmn-nav-prev"
                  onClick={() => flip("prev")}
                  disabled={loading}
                  aria-label="Previous Pokémon"
                >
                  ‹
                </button>
                <PokemonCard
                  pokemon={pokemon}
                  isFavorite={isFavorite(pokemon.id)}
                  onToggleFavorite={() =>
                    toggleFavorite({
                      id: pokemon.id,
                      name: pokemon.name,
                      image:
                        pokemon.sprites?.other?.["official-artwork"]
                          ?.front_default ||
                        pokemon.sprites?.front_default,
                    })
                  }
                />
                <button
                  type="button"
                  className="pkmn-nav pkmn-nav-next"
                  onClick={() => flip("next")}
                  disabled={loading}
                  aria-label="Next Pokémon"
                >
                  ›
                </button>
              </div>

              <EvolutionChain
                speciesUrl={pokemon.species?.url}
                currentName={pokemon.name}
                onSelect={(name) => {
                  setQuery(name);
                  setSearchInput("");
                  fetchOne(name);
                }}
              />
            </>
          )}

          <button
            className="catch-btn"
            type="button"
            onClick={catchOne}
            disabled={loading}
          >
            {loading ? "Summoning…" : "Catch another!"}
          </button>
        </section>

        <NetworkInfo
          url={requestUrl}
          method="GET"
          status={statusCode}
          loading={loading}
          error={error}
          responseKeys={pokemon ? Object.keys(pokemon).slice(0, 8) : []}
        />

        <FavoritesBar
          favorites={favorites}
          onSelect={(id) => {
            setQuery(String(id));
            setSearchInput("");
            fetchOne(id);
          }}
          onRemove={removeFavorite}
        />
      </div>
    </div>
  );
};


