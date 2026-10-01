// 卡包商店:概率公示、价格、幂等抽取,购买触发开包仪式动画。
// 幂等键绑定购买意图(QA-005):响应丢失后重试同一意图不会重复扣费。
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../state/auth.jsx";
import { artworkUrl } from "../shared/artwork.js";
import { TYPE_COLORS, TYPE_ZH } from "../config/pokemon.js";

const RARITY_LABEL = { C: "常见 (C)", R: "稀有 (R)", UR: "超稀有 (UR)" };
const RARITY_DOT = { C: "#98a4b0", R: "#2a75bb", UR: "#d4af37" };

// 每个卡包的产品化视觉
const PACK_ART = {
  basic: { grad: "linear-gradient(150deg, #e3350d 0%, #ff7a50 55%, #ffcb05 100%)", ball: "#ffcb05" },
  advanced: { grad: "linear-gradient(150deg, #2a75bb 0%, #5fa8e0 55%, #d4af37 100%)", ball: "#ffcb05" },
  legend: { grad: "linear-gradient(150deg, #431f52 0%, #7a3fa0 50%, #d4af37 100%)", ball: "#f1d475" },
};

export default function PacksView() {
  const { me, refresh } = useAuth();
  const [packs, setPacks] = useState(null);
  const [drawing, setDrawing] = useState(null); // pack id being drawn
  const [result, setResult] = useState(null); // { card, replay } | { error }
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [dailyBonus, setDailyBonus] = useState(50);
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

  const intentIds = useRef({}); // 幂等键:绑定购买意图(QA-005)

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
    <div className="view-wide packs-view">
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

      {!me && <p className="hint center">登录后才能抽卡。未登录时可以浏览各卡包的概率公示。</p>}

      <div className="packs-grid">
        {(packs?.packs ?? []).map((p) => {
          const art = PACK_ART[p.id] ?? PACK_ART.basic;
          return (
            <div key={p.id} className="card-box pack-card">
              <div className="pack-art" style={{ background: art.grad }}>
                <div className="pack-shine" />
                <div className={`pack-ball ${p.id === "legend" ? "is-legend" : ""}`} />
                <span className="pack-tag">{p.id === "legend" ? "限定" : p.id === "advanced" ? "进阶" : "入门"}</span>
              </div>
              <div className="pack-body">
                <div className="pack-name-row">
                  <span className="pack-name">{p.name}</span>
                  <span className="pack-price">{p.price} 币</span>
                </div>
                <div className="rates-list">
                  {Object.entries(p.rates)
                    .filter(([, w]) => w > 0)
                    .map(([r, w]) => (
                      <div key={r} className="rate-row">
                        <span className="rate-label">
                          <span className="rate-dot" style={{ background: RARITY_DOT[r] }} />
                          {RARITY_LABEL[r]}
                        </span>
                        <span className="rate-track">
                          <span className="rate-fill" style={{ width: `${w * 100}%`, background: RARITY_DOT[r] }} />
                        </span>
                        <span className="rate-pct">{Math.round(w * 100)}%</span>
                      </div>
                    ))}
                </div>
                <button
                  type="button"
                  className={p.id === "legend" ? "btn-gold" : "btn-primary"}
                  disabled={!me || busy}
                  onClick={() => draw(p.id)}
                >
                  {drawing === p.id ? "开包中…" : me ? "购买并抽取" : "登录后可购买"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="hint center" style={{ marginTop: 14 }}>
        每包必得 1 张卡,概率如表所示;同一订单重试不会重复扣费。
      </p>

      {result?.error && (
        <p className="form-error center" role="alert">
          {result.error}
        </p>
      )}

      {stage && (
        <div className={`pack-stage stage-${stage}`} role="status">
          {(stage === "pack" || stage === "burst") && (
            <div
              className={`pack-visual ${stage === "burst" ? "is-burst" : "is-shaking"}`}
              style={{ background: (PACK_ART[drawing] ?? PACK_ART.basic).grad }}
            >
              <div className="pack-top" />
              <div className="pack-bottom" />
              <div className="pack-btn" />
            </div>
          )}
          {/* 放射光放在包体外面:包体 overflow:hidden 会把内嵌光芒裁掉 */}
          {stage === "burst" && <div className="pack-rays" aria-hidden="true" />}
          {stage === "burst" && (
            <>
              <div className="pack-flash" />
              <div className="pack-shockwave" aria-hidden="true" />
            </>
          )}
          {stage === "reveal" && result?.card && (
            <div className="pack-reveal-wrap">
              {result.card.rarity === "UR" && <div className="ur-rays" aria-hidden="true" />}
              {result.card.rarity === "UR" && <div className="ur-burst" />}
              {(() => {
                const c = result.card;
                const g = (c.types ?? []).map((x) => TYPE_COLORS[x] ?? "#98a4b0");
                const headBg =
                  g.length > 1
                    ? `linear-gradient(120deg, ${g[0]}, ${g[1]})`
                    : `linear-gradient(120deg, ${g[0] ?? "#98a4b0"}, ${g[0] ?? "#98a4b0"}cc)`;
                return (
                  <div className={`tcard tcard-r-${c.rarity} pack-reveal-card`}>
                    <div className="tcard-head" style={{ background: headBg }}>
                      <span className="tcard-name">{c.zh_name || c.name}</span>
                      <span className="tcard-hp">{c.stats?.hp ?? "--"}</span>
                    </div>
                    <div className="tcard-art" style={{ "--tc": TYPE_COLORS[c.types?.[0]] }}>
                      <img src={artworkUrl(c.id)} alt={c.name} />
                    </div>
                    <div className="tcard-foot">
                      <div className="tcard-types">
                        {(c.types ?? []).map((x) => (
                          <span key={x} className="type-chip" style={{ background: TYPE_COLORS[x] ?? "#98a4b0" }}>
                            {TYPE_ZH[x] ?? x}
                          </span>
                        ))}
                      </div>
                      <span className={`rarity-ribbon r${c.rarity}`}>{RARITY_LABEL[c.rarity]}</span>
                    </div>
                  </div>
                );
              })()}
              {result.replay && <p className="hint">同一订单重放,未重复扣费</p>}
              <button type="button" className="btn-gold pack-continue" onClick={() => setStage(null)}>
                收下卡牌
              </button>
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
