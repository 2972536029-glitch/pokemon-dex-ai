// Pack shop: disclosed rates, coin prices, idempotent draws.
// The buy button generates one UUID per click; a retry with the same UUID
// replays the same card server-side instead of charging twice.
import { useEffect, useState } from "react";
import { useAuth } from "../state/auth.jsx";

const RARITY_LABEL = { C: "常见 (C)", R: "稀有 (R)", UR: "超稀有 (UR)" };

function orderId() {
  return crypto.randomUUID();
}

export default function PacksView() {
  const { me, refresh } = useAuth();
  const [packs, setPacks] = useState(null);
  const [drawing, setDrawing] = useState(null); // pack id being drawn
  const [result, setResult] = useState(null); // { card, replay } | { error }
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/packs")
      .then((r) => r.json())
      .then(setPacks)
      .catch(() => setPacks({ packs: [] }));
  }, []);

  async function draw(packId) {
    if (!me || busy) return;
    setBusy(true);
    setDrawing(packId);
    setResult(null);
    try {
      const res = await fetch(`/api/packs/${packId}/draw`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: orderId() }),
      });
      const body = await res.json();
      if (!res.ok) {
        setResult({ error: body?.message || "抽卡失败" });
      } else {
        setResult({ card: body.card, replay: body.replay });
        await refresh(); // wallet balance changed
      }
    } catch {
      setResult({ error: "网络异常,请重试" });
    } finally {
      setBusy(false);
      setDrawing(null);
    }
  }

  async function claimDaily() {
    if (!me || busy) return;
    setBusy(true);
    try {
      await fetch("/api/wallet/daily", { method: "POST" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view-wide">
      <div className="wallet-bar">
        <span>
          我的余额:<b>{me ? `${me.balance}` : "—"}</b> 图鉴币
        </span>
        <button type="button" className="btn-ghost" onClick={claimDaily} disabled={!me || busy}>
          每日登录奖励 +50
        </button>
      </div>

      {!me && (
        <p className="hint center">登录后才能抽卡。未登录时可以浏览各卡包的概率公示。</p>
      )}

      <div className="packs-grid">
        {(packs?.packs ?? []).map((p) => (
          <div key={p.id} className="card-box pack-card">
            <h3>{p.name}</h3>
            <div className="pack-price">{p.price} 币/包</div>
            <table className="rates-table">
              <thead>
                <tr>
                  <th>稀有度</th>
                  <th>概率(公示)</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(p.rates)
                  .filter(([, w]) => w > 0)
                  .map(([r, w]) => (
                    <tr key={r}>
                      <td>{RARITY_LABEL[r]}</td>
                      <td>{Math.round(w * 100)}%</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <button
              type="button"
              className="btn-primary"
              disabled={!me || busy}
              onClick={() => draw(p.id)}
            >
              {drawing === p.id ? "开包中…" : me ? "购买并抽取" : "登录后可购买"}
            </button>
          </div>
        ))}
      </div>

      {result?.error && (
        <p className="form-error center" role="alert">
          {result.error}
        </p>
      )}

      {result?.card && (
        <div className="card-reveal" role="status">
          <img src={result.card.sprite} alt={result.card.name} />
          <div>
            <div className={`rarity-badge rarity-${result.card.rarity}`}>
              {RARITY_LABEL[result.card.rarity]}
            </div>
            <div className="reveal-name">
              {result.card.name}
              {result.replay && <span className="ai-note">(同一订单重放,未重复扣费)</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
