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
  // 开包动画状态机: null → "pack"(摇晃) → "burst"(炸开) → "reveal"(揭晓)
  const [stage, setStage] = useState(null);
  const skipRef = useRef(false);

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
    setStage("pack");
    skipRef.current = false;

    // Idempotency key bound to the purchase intent (QA-005).
    try {
      if (!intentIds.current[packId]) intentIds.current[packId] = crypto.randomUUID();
    } catch {
      intentIds.current[packId] = `intent-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    }

    // 动画编排与请求并行:先摇晃 1.5s 再炸开,请求完成 + 动画播完才揭晓
    const choreography = (async () => {
      await sleep(1500);
      if (!skipRef.current) setStage("burst");
      await sleep(500);
      if (!skipRef.current) setStage("reveal");
    })();

    const request = (async () => {
      try {
        const res = await fetch(`/api/packs/${packId}/draw`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderId: intentIds.current[packId] }),
        });
        const body = await res.json();
        if (!res.ok) return { error: body?.message || "抽卡失败" };
        return { card: body.card, replay: body.replay };
      } catch {
        return { error: "网络异常,请重试(同一订单重试不会重复扣费)" };
      }
    })();

    const [, outcome] = await Promise.all([choreography, request]);

    if (outcome.error) {
      setResult({ error: outcome.error });
      setStage(null);
    } else {
      setResult(outcome);
      setStage("reveal");
      // Order settled — rotate the key so the NEXT purchase is a new order.
      delete intentIds.current[packId];
      await refresh(); // wallet balance changed
    }
    setBusy(false);
    setDrawing(null);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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

      {stage && (
        <div className={`pack-stage stage-${stage}`} role="status">
          {(stage === "pack" || stage === "burst") && (
            <div className={`pack-visual ${stage === "burst" ? "is-burst" : "is-shaking"}`}>
              <div className="pack-top" />
              <div className="pack-bottom" />
              <div className="pack-btn" />
            </div>
          )}
          {stage === "burst" && <div className="pack-flash" />}
          {stage === "reveal" && result?.card && (
            <div className={`tcard tcard-r-${result.card.rarity} pack-reveal-card`}>
              {result.card.rarity === "UR" && <div className="ur-burst" />}
              <div className="tcard-head" style={{ background: "linear-gradient(120deg, #2a75bb, #5fa8e0)" }}>
                <span className="tcard-name">{result.card.zhName || result.card.name}</span>
                <span className="tcard-hp">{result.card.stats?.hp ?? "--"}</span>
              </div>
              <div className="tcard-art">
                <img src={artworkUrl(result.card.id)} alt={result.card.name} />
              </div>
              <div className="tcard-foot">
                <span className={`rarity-ribbon r${result.card.rarity}`}>
                  {RARITY_LABEL[result.card.rarity]}
                </span>
                {result.replay && <span className="ai-note">同一订单重放,未重复扣费</span>}
              </div>
            </div>
          )}
          {stage === "pack" && (
            <button type="button" className="btn-ghost pack-skip" onClick={() => (skipRef.current = true)}>
              跳过动画 »
            </button>
          )}
        </div>
      )}
    </div>
  );
}
