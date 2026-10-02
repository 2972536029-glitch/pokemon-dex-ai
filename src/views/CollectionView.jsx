// My collection + battle team builder.
// Select up to 3 owned cards for the battle squad; the saved squad is what
// /api/battle uses. Selection state seeds from the server-saved team.
import { useEffect, useState } from "react";
import { useAuth } from "../state/auth.jsx";
import { artworkUrl } from "../shared/artwork.js";
import { TYPE_COLORS, typeZh } from "../config/pokemon.js";

const RARITY_LABEL = { C: "C", R: "R", UR: "UR" };
const TEAM_SIZE = 3;

const TYPE_LIST = [
  "fire", "water", "grass", "electric", "ice", "fighting", "poison", "ground",
  "flying", "psychic", "bug", "rock", "ghost", "dragon", "dark", "steel", "fairy", "normal",
];

export default function CollectionView({ onGoLogin, onGoBattle }) {
  const { me } = useAuth();
  const [cards, setCards] = useState(null);
  const [error, setError] = useState(null);
  const [team, setTeam] = useState([]); // card ids chosen for battle
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [typeFilter, setTypeFilter] = useState(null); // null = 全部
  const [sortBy, setSortBy] = useState("bst"); // bst | name

  useEffect(() => {
    if (!me) return;
    let cancelled = false; // stale-response guard across account switches
    setError(null);
    Promise.all([fetch("/api/collection"), fetch("/api/battle/team")])
      .then(async ([cRes, tRes]) => {
        const cBody = await cRes.json();
        const tBody = await tRes.json();
        if (!cRes.ok) throw new Error(cBody?.message || "加载失败");
        if (!cancelled) {
          setCards(cBody.cards);
          setTeam((tBody.cardIds ?? []).filter((id) => cBody.cards.some((c) => c.id === id)));
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [me]);

  function toggle(id) {
    setTeam((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= TEAM_SIZE) return prev;
      return [...prev, id];
    });
    setSaved(false);
  }

  async function saveTeam() {
    if (saving || team.length !== TEAM_SIZE) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/battle/team", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cardIds: team }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.message || "保存失败,请重试");
        return;
      }
      setSaved(true);
    } catch {
      setError("网络异常,请重试");
    } finally {
      setSaving(false);
    }
  }

  if (!me) {
    return (
      <div className="view-narrow">
        <div className="card-box center">
          <p>登录后可以看到你的卡牌收藏并编组对战队伍。</p>
          <button type="button" className="btn-primary" onClick={onGoLogin}>
            去登录
          </button>
        </div>
      </div>
    );
  }

  const shown = (cards ?? [])
    .filter((c) => !typeFilter || (c.types ?? []).includes(typeFilter))
    .sort((a, b) => (sortBy === "name" ? a.name.localeCompare(b.name) : b.bst - a.bst));

  return (
    <div className="view-wide">
      <h2 className="view-title">我的收藏({cards ? cards.length : "…"} 种)</h2>
      {error && <p className="form-error">{error}</p>}

      <div className="team-preview">
        <span className="team-preview-label">对战编队</span>
        <div className="team-preview-slots">
          {[0, 1, 2].map((i) => {
            const c = (cards ?? []).find((x) => x.id === team[i]);
            return (
              <span key={i} className={`team-slot ${c ? "filled" : ""}`} title={c ? c.name : "空位"}>
                {c ? <img src={c.sprite} alt={c.name} /> : i + 1}
              </span>
            );
          })}
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={saveTeam}
          disabled={team.length !== TEAM_SIZE || saving}
        >
          {saving ? "保存中…" : "保存编队"}
        </button>
        {saved && team.length === TEAM_SIZE && (
          <button type="button" className="btn-ghost" onClick={onGoBattle}>
            去对战 →
          </button>
        )}
      </div>

      <div className="coll-toolbar">
        <div className="filter-chips">
          <button
            type="button"
            className={`filter-chip ${typeFilter === null ? "is-on" : ""}`}
            onClick={() => setTypeFilter(null)}
          >
            全部
          </button>
          {TYPE_LIST.map((ty) => (
            <button
              key={ty}
              type="button"
              className={`filter-chip ${typeFilter === ty ? "is-on" : ""}`}
              style={{ "--chip-c": TYPE_COLORS[ty] }}
              onClick={() => setTypeFilter(typeFilter === ty ? null : ty)}
            >
              {typeZh(ty)}
            </button>
          ))}
        </div>
      </div>

      {cards && cards.length === 0 && <p className="hint center">还没有卡牌——去卡包商店抽一包吧。</p>}
      {cards === null && (
        <div className="collection-grid" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="skeleton-card" />
          ))}
        </div>
      )}
      <div className="collection-grid">
        {shown.map((c) => {
          const picked = team.includes(c.id);
          const types = c.types ?? [];
          const g = types.map((x) => TYPE_COLORS[x] ?? "#98a4b0");
          const headBg =
            g.length > 1
              ? `linear-gradient(120deg, ${g[0]}, ${g[1]})`
              : `linear-gradient(120deg, ${g[0] ?? "#98a4b0"}, ${g[0] ?? "#98a4b0"}cc)`;
          return (
            <button
              key={c.id}
              type="button"
              className={`tcard tcard-r-${c.rarity} selectable ${picked ? "is-picked" : ""}`}
              onClick={() => toggle(c.id)}
              title={picked ? "点击移出编队" : "点击编入对战队伍"}
            >
              <div className="tcard-head" style={{ background: headBg }}>
                <span className="tcard-name">{c.zh_name || c.name}</span>
                <span className="tcard-hp">{c.stats?.hp ?? "--"}</span>
              </div>
              <div className="tcard-art" style={{ "--tc": TYPE_COLORS[types[0]] }}>
                <img src={artworkUrl(c.id)} alt={c.name} loading="lazy" />
              </div>
              <div className="tcard-foot">
                <div className="tcard-types">
                  {types.map((x) => (
                    <span key={x} className="type-chip" style={{ background: TYPE_COLORS[x] ?? "#98a4b0" }}>
                      {typeZh(x)}
                    </span>
                  ))}
                </div>
                <span className={`rarity-ribbon r${c.rarity}`}>{RARITY_LABEL[c.rarity]}</span>
                {c.count > 1 && <span className="ai-note">×{c.count}</span>}
              </div>
              {picked && <span className="picked-tag">编队 {team.indexOf(c.id) + 1}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
