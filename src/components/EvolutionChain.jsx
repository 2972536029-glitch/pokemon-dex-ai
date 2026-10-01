import { useEffect, useState } from "react";
import { fetchEvolutionChain } from "../api/pokemon.js";
import { artworkUrl } from "../shared/artwork.js";
import { fetchPokemonNames } from "../api/pokemon.js";

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

  return <EvoChainWithFaces chain={chain} currentName={currentName} onSelect={onSelect} />;
};

// 补全各阶段的名字→id 映射(用于头像),失败时退回纯文字胶囊。
const EvoChainWithFaces = ({ chain, currentName, onSelect }) => {
  const [ids, setIds] = useState(null); // name -> id
  useEffect(() => {
    let cancelled = false;
    fetchPokemonNames()
      .then((list) => {
        if (cancelled) return;
        const map = {};
        for (const it of list) map[it.name] = it.id;
        setIds(map);
      })
      .catch(() => setIds({}));
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div className="evo">
      <div className="evo-label">进化链</div>
      <div className="evo-chain">
        {chain.map((stage, i) => {
          const id = ids?.[stage.name];
          return (
            <div className="evo-stage-wrap" key={stage.name}>
              {i > 0 && (
                <span className="evo-arrow" aria-hidden="true">
                  {stage.minLevel ? `Lv.${stage.minLevel}` : ""}
                  <em>→</em>
                </span>
              )}
              <button
                type="button"
                className={`evo-stage ${stage.name === currentName ? "is-current" : ""}`}
                onClick={() => onSelect(stage.name)}
                title={stage.name}
              >
                {id ? (
                  <img src={artworkUrl(id)} alt="" loading="lazy" />
                ) : null}
                <span>{stage.name}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default EvolutionChain;
