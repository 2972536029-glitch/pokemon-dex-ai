// Pack shop: disclosed rates, coin prices, idempotent draws.
// The buy button generates one UUID per click; a retry with the same UUID
// replays the same card server-side instead of charging twice.
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../state/auth.jsx";

const RARITY_LABEL = { C: "常见 (C)", R: "稀有 (R)", UR: "超稀有 (UR)" };

export default function PacksView() {
  const { me, refresh } = useAuth();
  const [packs, setPacks] = useState(null);
  const [drawing, setDrawing] = useState(null); // pack id being drawn
  const [result, setResult] = useState(null); // { card, replay } | { error }
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [dailyBonus, setDailyBonus] = useState(50);
  // Idempotency key is bound to the PURCHASE INTENT, not the click: if the
  // response is lost after the server recorded the order, retrying the same
  // intent replays the same card instead of charging twice (QA-005).
  const intentIds = useRef({});

  useEffect(() => {
    fetch("/api/packs")
      .then((r) => r.json())
      .then((body) => {
        setPacks(body);
        setDailyBonus(body.dailyBonus ?? 50);
      })
      .catch(() => setPacks({ packs: [] }));
  }, []);

  async function draw(packId) {
    if (!me || busy) return;
    setBusy(true);
    setDrawing(packId);
    setResult(null);
    try {
      // key generation inside try: on insecure contexts randomUUID can throw
      if (!intentIds.current[packId]) intentIds.current[packId] = crypto.randomUUID();
      const res = await fetch(`/api/packs/${packId}/draw`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: intentIds.current[packId] }),
      });
      const body = await res.json();
      if (!res.ok) {
        setResult({ error: body?.message || "抽卡失败" });
      } else {
        setResult({ card: body.card, replay: body.replay });
        // Order settled — rotate the key so the NEXT purchase is a new order.
        delete intentIds.current[packId];
        await refresh(); // wallet balance changed
      }
    } catch {
      setResult({ error: "网络异常,请重试(同一订单重试不会重复扣费)" });
      // keep intentId: the retry after a network error must stay idempotent
    } finally {
      setBusy(false);
      setDrawing(null);
    }
  }

  async function claimDaily() {
    if (!me || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/wallet/daily", { method: "POST" });
      const body = await res.json();
      await refresh();
      setNotice(body.granted ? `已领取今日奖励 +${dailyBonus}` : "今天的奖励已经领过了,明天再来");
    } catch {
      setNotice("领取失败,请重试");
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
          每日登录奖励 +{dailyBonus}
        </button>
      </div>
      {notice && (
        <p className="hint center" role="status">
          {notice}
        </p>
      )}

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
