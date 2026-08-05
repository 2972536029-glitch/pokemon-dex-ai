import { TYPE_COLORS } from "../config/pokemon.js";

// Bottom bar showing favorited Pokémon. Click to re-open, × to remove.
const FavoritesBar = ({ favorites, onSelect, onRemove }) => {
  if (favorites.length === 0) return null;

  return (
    <section className="favs">
      <div className="favs-head">
        <h3 className="favs-title">
          ❤️ Favorites <span className="favs-count">{favorites.length}</span>
        </h3>
        <span className="favs-hint">click to open · × to remove</span>
      </div>

      <div className="favs-list">
        {favorites.map((f) => (
          <div
            key={f.id}
            className="favs-chip"
            style={{ "--type-color": TYPE_COLORS.normal }}
            title={f.name}
          >
            <button
              type="button"
              className="favs-chip-main"
              onClick={() => onSelect(f.id)}
            >
              {f.image ? (
                <img src={f.image} alt={f.name} className="favs-chip-img" />
              ) : (
                <span className="favs-chip-fallback">?</span>
              )}
              <span className="favs-chip-name">{f.name}</span>
            </button>
            <button
              type="button"
              className="favs-chip-remove"
              aria-label={`Remove ${f.name}`}
              onClick={() => onRemove(f.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </section>
  );
};

export default FavoritesBar;
