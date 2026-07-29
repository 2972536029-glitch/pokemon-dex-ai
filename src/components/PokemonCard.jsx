import { TYPE_COLORS, STAT_LABELS } from "../config/pokemon.js";

const PokemonCard = ({ pokemon }) => {
  const { id, name, height, weight, types, stats } = pokemon;
  const image =
    pokemon.sprites?.other?.["official-artwork"]?.front_default ||
    pokemon.sprites?.front_default;

  const primaryType = types[0]?.type?.name ?? "normal";

  return (
    <div
      className="pkmn-card"
      style={{ "--type-color": TYPE_COLORS[primaryType] || "#888" }}
    >
      <div className="pkmn-card-id">No.{String(id).padStart(4, "0")}</div>

      <div className="pkmn-card-image-wrap">
        {image ? (
          <img className="pkmn-card-image" src={image} alt={name} />
        ) : (
          <div className="pkmn-card-image-placeholder">?</div>
        )}
      </div>

      <h2 className="pkmn-card-name">{name}</h2>

      <div className="pkmn-card-types">
        {types.map(({ type }) => (
          <span
            key={type.name}
            className="pkmn-type-badge"
            style={{ background: TYPE_COLORS[type.name] || "#888" }}
          >
            {type.name}
          </span>
        ))}
      </div>

      <div className="pkmn-card-basics">
        <div>
          <span className="muted">Height</span> {(height / 10).toFixed(1)} m
        </div>
        <div>
          <span className="muted">Weight</span> {(weight / 10).toFixed(1)} kg
        </div>
      </div>

      <div className="pkmn-card-stats">
        {stats.map((s) => (
          <div key={s.stat.name} className="pkmn-stat">
            <span className="pkmn-stat-label">
              {STAT_LABELS[s.stat.name] || s.stat.name}
            </span>
            <div className="pkmn-stat-bar">
              <div
                className="pkmn-stat-fill"
                style={{
                  width: `${Math.min(100, (s.base_stat * 100) / 200)}%`,
                }}
              />
            </div>
            <span className="pkmn-stat-value">{s.base_stat}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default PokemonCard;
