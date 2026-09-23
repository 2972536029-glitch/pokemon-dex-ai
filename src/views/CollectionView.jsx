// My collection: cards the logged-in user owns, sorted by base stat total.
import { useEffect, useState } from "react";
import { useAuth } from "../state/auth.jsx";

const RARITY_LABEL = { C: "C", R: "R", UR: "UR" };

export default function CollectionView({ onGoLogin }) {
  const { me } = useAuth();
  const [cards, setCards] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!me) return;
    let cancelled = false; // stale-response guard across account switches
    setError(null);
    fetch("/api/collection")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.message || "加载失败");
        if (!cancelled) setCards(body.cards);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [me]);

  if (!me) {
    return (
      <div className="view-narrow">
        <div className="card-box center">
          <p>登录后可以看到你的卡牌收藏。</p>
          <button type="button" className="btn-primary" onClick={onGoLogin}>
            去登录
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="view-wide">
      <h2 className="view-title">我的收藏({cards ? cards.length : "…"} 种)</h2>
      {error && <p className="form-error">{error}</p>}
      {cards && cards.length === 0 && (
        <p className="hint center">
          还没有卡牌——去卡包商店抽一包吧。
        </p>
      )}
      <div className="collection-grid">
        {(cards ?? []).map((c) => (
          <div key={c.id} className={`mini-card rarity-border-${c.rarity}`}>
            <img src={c.sprite} alt={c.name} loading="lazy" />
            <div className="mini-card-name">
              {c.zh_name ? `${c.zh_name} (${c.name})` : c.name}
            </div>
            <div className="mini-card-meta">
              <span className={`rarity-badge rarity-${c.rarity}`}>
                {RARITY_LABEL[c.rarity]}
              </span>
              {c.count > 1 && <span className="ai-note">×{c.count}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
