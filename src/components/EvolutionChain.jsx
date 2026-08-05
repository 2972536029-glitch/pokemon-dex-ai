import { useEffect, useState } from "react";
import { fetchEvolutionChain } from "../api/pokemon.js";

// Shows a Pokémon's evolution line, e.g.  bulbasaur → ivysaur → venusaur.
// Fetches its own data whenever the current species changes.
const EvolutionChain = ({ speciesUrl, currentName, onSelect }) => {
  const [chain, setChain] = useState([]);

  useEffect(() => {
    let cancelled = false;
    setChain([]);
    fetchEvolutionChain(speciesUrl).then((list) => {
      if (!cancelled) setChain(list);
    });
    return () => {
      cancelled = true;
    };
  }, [speciesUrl]);

  // Only one stage (or none loaded) — nothing interesting to show.
  if (chain.length <= 1) return null;

  return (
    <div className="evo">
      <div className="evo-label">Evolution</div>
      <div className="evo-chain">
        {chain.map((stage, i) => (
          <div className="evo-stage-wrap" key={stage.name}>
            {i > 0 && (
              <span className="evo-arrow" aria-hidden="true">
                {stage.minLevel ? `Lv.${stage.minLevel} →` : "→"}
              </span>
            )}
            <button
              type="button"
              className={`evo-stage ${
                stage.name === currentName ? "is-current" : ""
              }`}
              onClick={() => onSelect(stage.name)}
            >
              {stage.name}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default EvolutionChain;
