import { useEffect, useState } from "react";
import { TYPE_COLORS, STAT_ZH, typeZh , statColor } from "../config/pokemon.js";

// 中文名/分类/图鉴说明来自 species 接口(PokeAPI 本体不含中文名)。
// 模块级缓存:左右翻卡来回切不重复请求。
const zhCache = new Map();

async function fetchSpeciesZh(speciesUrl) {
  if (zhCache.has(speciesUrl)) return zhCache.get(speciesUrl);
  const res = await fetch(speciesUrl);
  if (!res.ok) throw new Error("species fetch " + res.status);
  const data = await res.json();
  const out = {
    name:
      (data.names ?? []).find((n) => n.language.name.toLowerCase() === "zh-hans")?.name ??
      null,
    genus:
      (data.genera ?? []).find((g) => g.language.name.toLowerCase() === "zh-hans")?.genus ??
      null,
    flavor:
      (data.flavor_text_entries ?? [])
        .filter((f) => f.language.name.toLowerCase() === "zh-hans")
        .slice(-1)[0]
        ?.flavor_text?.replace(/\s+/g, " ") ?? null,
  };
  zhCache.set(speciesUrl, out);
  return out;
}


const PokemonCard = ({ pokemon, isFavorite, onToggleFavorite }) => {
  const { id, name, height, weight, types, stats, species } = pokemon;
  const image =
    pokemon.sprites?.other?.["official-artwork"]?.front_default ||
    pokemon.sprites?.front_default;

  const primaryType = types[0]?.type?.name ?? "normal";
  const typeColor = TYPE_COLORS[primaryType] || "#888";

  // 中文名异步补齐:英文先渲染,中文到了再换,不阻塞卡片
  const [zh, setZh] = useState(null);
  useEffect(() => {
    if (!species?.url) return undefined;
    let cancelled = false;
    fetchSpeciesZh(species.url)
      .then((info) => {
        if (!cancelled) setZh(info);
      })
      .catch(() => {
        /* 拿不到中文名就保持英文,不算错误 */
      });
    return () => {
      cancelled = true;
    };
  }, [species?.url]);

  return (
    <div
      className="pkmn-card"
      style={{ "--type-color": typeColor }}
    >
      <div className="pkmn-card-id">No.{String(id).padStart(4, "0")}</div>

      <div className="pkmn-card-image-wrap">
        {image ? (
          <img className="pkmn-card-image" src={image} alt={name} />
        ) : (
          <div className="pkmn-card-image-placeholder">?</div>
        )}
      </div>

      <div className="pkmn-card-name-row">
        <h2 className="pkmn-card-name">{zh?.name ?? name}</h2>
        <button
          type="button"
          className={`pkmn-fav-btn ${isFavorite ? "is-fav" : ""}`}
          onClick={onToggleFavorite}
          aria-pressed={isFavorite}
          aria-label={isFavorite ? "移出收藏" : "加入收藏"}
          title={isFavorite ? "移出收藏" : "加入收藏"}
        >
          {isFavorite ? "❤️" : "🤍"}
        </button>
      </div>
      <p className="pkmn-card-sub">
        {zh?.genus && <span className="pkmn-card-genus">{zh.genus}</span>}
        <span className="pkmn-card-name-en">{name}</span>
      </p>

      <div className="pkmn-card-types">
        {types.map(({ type }) => (
          <span
            key={type.name}
            className="pkmn-type-badge"
            style={{ background: TYPE_COLORS[type.name] || "#888" }}
          >
            {typeZh(type.name)}
          </span>
        ))}
      </div>

      {zh?.flavor && <p className="pkmn-flavor">「{zh.flavor}」</p>}

      <div className="pkmn-card-basics">
        <div>
          <span className="muted">身高</span> {(height / 10).toFixed(1)} m
        </div>
        <div>
          <span className="muted">体重</span> {(weight / 10).toFixed(1)} kg
        </div>
      </div>

      <div className="pkmn-card-stats">
        {stats.map((s) => (
          <div key={s.stat.name} className="pkmn-stat">
            <span className="pkmn-stat-label">
              {STAT_ZH[s.stat.name] || s.stat.name}
            </span>
            <div className="pkmn-stat-bar">
              <div
                className="pkmn-stat-fill"
                style={{
                  width: `${Math.min(100, (s.base_stat * 100) / 200)}%`,
                  background: `linear-gradient(90deg, ${statColor(
                    s.base_stat
                  )}88, ${statColor(s.base_stat)})`,
                  boxShadow: `0 0 10px ${statColor(s.base_stat)}66`,
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
