// 图鉴词条页:官方数据(种族值/属性)+ AI 小传(数值守卫,服务端缓存)。
// 数据来自 PokeAPI 与 /api/lore,零新后端表。
import { useEffect, useState } from "react";
import { TYPE_COLORS, typeZh , STAT_LABELS_ZH, statColor } from "../config/pokemon.js";





async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

export default function WikiView({ param, go }) {
  const [poke, setPoke] = useState(null);
  const [error, setError] = useState(null);
  const [lore, setLore] = useState(null); // {lore, checked, warnings}

  useEffect(() => {
    let cancelled = false;
    setPoke(null);
    setError(null);
    setLore(null);
    fetchJson(`https://pokeapi.co/api/v2/pokemon/${param}`)
      .then((d) => {
        if (cancelled) return;
        const sp = d.species?.url;
        fetchJson(sp)
          .then((species) => {
            if (cancelled) return;
            setPoke({
              id: d.id,
              name: d.name,
              types: (d.types ?? []).map((t) => t.type.name),
              stats: d.stats ?? [],
              heightM: (d.height ?? 0) / 10,
              weightKg: (d.weight ?? 0) / 10,
              artwork:
                d.sprites?.other?.["official-artwork"]?.front_default ??
                d.sprites?.front_default,
              zhName:
                (species.names ?? []).find((n) => n.language.name === "zh-hans")?.name ?? null,
              genus:
                (species.genera ?? []).find((g) => g.language.name === "zh-Hans")?.genus ?? null,
              flavor:
                (species.flavor_text_entries ?? [])
                  .filter((f) => f.language.name === "zh-Hans")
                  .slice(-1)[0]?.flavor_text?.replace(/\s+/g, " ") ?? null,
            });
          })
          .catch(() => {});
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [param]);

  useEffect(() => {
    if (!poke || lore) return undefined;
    let cancelled = false;
    fetch(`/api/lore/${poke.id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (!cancelled) setLore(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [poke && poke.id]);

  if (error) {
    return (
      <div className="view-narrow">
        <div className="card-box center">
          <p>词条加载失败:{error}</p>
          <button type="button" className="btn-primary" onClick={() => go("#/dex")}>
            回图鉴
          </button>
        </div>
      </div>
    );
  }

  if (!poke) {
    return (
      <div className="view-narrow">
        <div className="card-box center">
          <p>加载中…</p>
        </div>
      </div>
    );
  }

  const primaryType = poke.types[0] ?? "normal";
  const tint = TYPE_COLORS[primaryType] ?? "#888";

  return (
    <div className="view-narrow wiki-view">
      <div className="card-box wiki-card" style={{ "--tint": tint }}>
        <div className="wiki-head">
          <span className="wiki-no">No.{String(poke.id).padStart(4, "0")}</span>
          <h1 className="wiki-name">{poke.zhName ?? poke.name}</h1>
          <span className="wiki-en">{poke.name}</span>
          {poke.genus && <span className="wiki-genus">{poke.genus}</span>}
        </div>
        <div className="wiki-art">
          <img src={poke.artwork} alt={poke.name} />
        </div>
        <div className="wiki-types">
          {poke.types.map((t) => (
            <span key={t} className="type-chip" style={{ background: TYPE_COLORS[t] ?? "#888" }}>
              {typeZh(t)}
            </span>
          ))}
        </div>
        {poke.flavor && <p className="wiki-flavor">「{poke.flavor}」</p>}
        <div className="wiki-basics">
          <span className="muted">身高</span> {(poke.height ?? 0) / 10} m
          <span className="muted" style={{ marginLeft: 16 }}>体重</span> {(poke.weight ?? 0) / 10} kg
        </div>
        <div className="wiki-stats">
          {poke.stats.map((s) => (
            <div key={s.stat.name} className="wiki-stat-row">
              <span className="ws-label">{STAT_LABELS_ZH[s.stat.name] ?? s.stat.name}</span>
              <div className="ws-track">
                <div
                  className="ws-fill"
                  style={{
                    width: `${Math.min(100, (s.base_stat / 200) * 100)}%`,
                    background: statColor(s.base_stat),
                  }}
                />
              </div>
              <span className="ws-num">{s.base_stat}</span>
            </div>
          ))}
        </div>
        <div className="wiki-actions">
          <button type="button" className="btn-primary" onClick={() => go("#/dex")}>
            回图鉴
          </button>
          <button type="button" className="btn-gold" onClick={() => go("#/battle")}>
            去编队对战
          </button>
        </div>
      </div>
    </div>
  );
}
