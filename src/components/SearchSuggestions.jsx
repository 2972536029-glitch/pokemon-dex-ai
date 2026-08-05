import { useEffect, useRef, useState } from "react";
import { fetchPokemonNames } from "../api/pokemon.js";

// Autocomplete dropdown for the search box.
// Loads the full Pokémon name list once (cached), then filters locally.
// Keyboard: ArrowDown/ArrowUp to move, Enter to confirm (Enter when no row is
// highlighted falls through to the form submit).
const SearchSuggestions = ({ value, loading, onSelect }) => {
  const [names, setNames] = useState(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef(null);

  // Load the name list once on mount. Failure is silent — the user can
  // still type freely, just without suggestions.
  useEffect(() => {
    let cancelled = false;
    fetchPokemonNames()
      .then((list) => !cancelled && setNames(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmed = value.trim().toLowerCase();

  const matches =
    !loading && names && trimmed
      ? names
          .filter(
            ({ name, id }) => name.startsWith(trimmed) || String(id) === trimmed
          )
          .slice(0, 8)
      : [];

  // Reset highlight whenever the input changes.
  useEffect(() => {
    setActiveIndex(-1);
  }, [trimmed]);

  // Expose keyboard handling up to the parent so Enter at the input still
  // has a chance to confirm a highlighted row.
  useEffect(() => {
    function onKey(e) {
      if (matches.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % matches.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i <= 0 ? matches.length - 1 : i - 1));
      } else if (e.key === "Enter" && activeIndex >= 0) {
        e.preventDefault();
        onSelect(matches[activeIndex].name);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [matches, activeIndex, onSelect]);

  if (matches.length === 0) return null;

  return (
    <ul className="pkmn-suggest" ref={listRef}>
      {matches.map((m, i) => (
        <li
          key={m.id}
          className={`pkmn-suggest-item ${i === activeIndex ? "is-active" : ""}`}
          onMouseDown={(e) => {
            // preventDefault keeps the input focused so click feels instant.
            e.preventDefault();
            onSelect(m.name);
          }}
          onMouseEnter={() => setActiveIndex(i)}
        >
          <span className="pkmn-suggest-id">#{m.id}</span>
          <span className="pkmn-suggest-name">{m.name}</span>
        </li>
      ))}
    </ul>
  );
};

export default SearchSuggestions;
