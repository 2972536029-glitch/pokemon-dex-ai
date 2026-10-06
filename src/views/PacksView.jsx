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

// converge 阶段的兜底推进:玩家 7 秒未点击则自动揭示
function ArkAutoReveal({ onFire }) {
  useEffect(() => {
    const t = setTimeout(onFire, 7000);
    return () => clearTimeout(t);
  }, []);
  return null;
}

export default function PacksView() {
  const { me, refresh } = useAuth();
  const [packs, setPacks] = useState(null);
  const [drawing, setDrawing] = useState(null); // pack id being drawn
  const [result, setResult] = useState(null); // { card, replay } | { error }
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [dailyBonus, setDailyBonus] = useState(50);
  const [pity, setPity] = useState(null); // {since_ur, remaining, limit}
  const [txOpen, setTxOpen] = useState(false);
  const [txList, setTxList] = useState(null); // 钱包流水(懒加载:展开才请求)
  // 开包动画状态机: null → "pack"(摇晃) → "burst"(炸开) → "reveal"(揭晓)
  const [stage, setStage] = useState(null);
  const [armed, setArmed] = useState(false); // 摇晃完毕,等待玩家点击拆包
  const skipRef = useRef(false);

  useEffect(() => {
    if (me) fetch("/api/packs/pity").then((r) => (r.ok ? r.json() : null)).then((d) => setPity(d)).catch(() => {});
    fetch("/api/packs")
      .then((r) => r.json())
      .then((body) => {
        setPacks(body);
        setDailyBonus(body.dailyBonus ?? 50);
      })
      .catch(() => setPacks({ packs: [] }));
  }, []);

  // 流水懒加载:第一次展开才请求
  useEffect(() => {
    if (!txOpen || !me || txList) return;
    fetch("/api/wallet/tx")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((b) => setTxList(b.transactions ?? []))
      .catch(() => setTxList([]));
  }, [txOpen, me, txList]);

  const KIND_LABEL = { signup: "注册奖励", daily: "每日登录", gacha: "抽卡", battle: "对战奖励" };

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
    // 方舟式节奏:摇晃后停在"待拆"状态,等玩家点;converge 停在光缝,等玩家点揭示
    const choreography = (async () => {
      await sleep(1300);
      if (!skipRef.current) setArmed(true); // 摇晃完毕,可点击拆包
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
      // 交互式仪式:reveal 由玩家点击推进(或 7s 兜底);只有跳过才直接揭晓
      if (skipRef.current) setStage("reveal");
      // Order settled — rotate the key so the NEXT purchase is a new order.
      delete intentIds.current[packId];
      await refresh(); // wallet balance changed
      fetch("/api/packs/pity").then((r) => (r.ok ? r.json() : null)).then((d) => setPity(d)).catch(() => {});
    }
    setBusy(false);
    setDrawing(null);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // 方舟式交互:玩家点击推进仪式。pack(武装完成)→ burst;converge → reveal
  function advanceCeremony() {
    if (!stage || busy) return;
    if (stage === "pack" && armed) {
      setArmed(false);
      setStage("burst");
      setTimeout(() => {
        if (!skipRef.current) setStage("converge");
      }, 650);
    } else if (stage === "converge" && result?.card) {
      setStage("reveal");
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

      {me && pity && (
        <div className="pity-bar card-box" role="status">
          <div className="pity-head">
            <span className="pity-title">UR 保底进度</span>
            <span className="pity-nums">
              已垫 <b>{pity.since_ur}</b> 抽 · 还剩 <b>{pity.remaining}</b> 抽必出 UR
            </span>
          </div>
          <div className="pity-track">
            <div
              className="pity-fill"
              style={{ width: `${Math.min(100, (pity.since_ur / pity.limit) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {me && (
        <button type="button" className="wallet-tx-toggle" onClick={() => setTxOpen((v) => !v)}>
          {txOpen ? "收起明细 ▲" : "钱包明细 ▼"}
        </button>
      )}
      {txOpen && me && (
        <div className="wallet-tx card-box" role="list">
          {txList === null && <p className="hint center">加载中…</p>}
          {txList !== null && txList.length === 0 && <p className="hint center">还没有流水记录。</p>}
          {(txList ?? []).slice(0, 20).map((t) => (
            <div key={t.id ?? t.created_at} className="wallet-tx-row">
              <span className={`tx-kind tx-kind-${t.kind}`}>{KIND_LABEL[t.kind] ?? t.kind}</span>
              <span className="tx-detail">{t.detail}</span>
              <span className={`tx-amount ${t.amount >= 0 ? "is-plus" : "is-minus"}`}>
                {t.amount >= 0 ? "+" : ""}
                {t.amount}
              </span>
            </div>
          ))}
        </div>
      )}

      {!me && <p className="hint center">登录后才能抽卡。未登录时可以浏览各卡包的概率公示。</p>}

      {packs === null && (
        <div className="packs-grid" aria-hidden="true">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="skeleton-card skeleton-pack" />
          ))}
        </div>
      )}

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
        <div
          className={`pack-stage stage-${stage} ${result?.card && (stage === "converge" || stage === "reveal") ? `ark-r-${result.card.rarity}` : ""} ${stage === "pack" && armed ? "is-armed" : ""}`}
          role="status"
          onClick={advanceCeremony}
        >
          {stage === "pack" && armed && (
            <button type="button" className="ark-tap-hint" onClick={advanceCeremony}>
              点击拆开
            </button>
          )}
          {stage === "converge" && result?.card && (
            <button type="button" className="ark-tap-hint" onClick={advanceCeremony}>
              轻触屏幕 · 揭示卡牌
            </button>
          )}
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
          {stage === "burst" && (
            <>
              <div className="pack-rays" aria-hidden="true" />
              <div className="pack-half pack-half-top" aria-hidden="true" style={{ background: (PACK_ART[drawing] ?? PACK_ART.basic).grad }} />
              <div className="pack-half pack-half-bottom" aria-hidden="true" style={{ background: (PACK_ART[drawing] ?? PACK_ART.basic).grad }} />
              {Array.from({ length: 14 }, (_, i) => (
                <span
                  key={i}
                  className="pack-spark"
                  aria-hidden="true"
                  style={{
                    "--angle": `${i * (360 / 14) + 8}deg`,
                    "--dist": `${140 + (i % 4) * 48}px`,
                    "--delay": `${i * 12}ms`,
                    background: i % 2 ? "#ffd75e" : "#ffffff",
                  }}
                />
              ))}
            </>
          )}
          {stage === "burst" && (
            <>
              <div className="pack-flash" />
              <div className="pack-shockwave" aria-hidden="true" />
            </>
          )}
          {/* 方舟式暗场汇聚:扫描线掠过 → 竖直光缝绽开 → 粒子向心汇聚 */}
          {stage === "converge" && (
            <>
              <div className="ark-scanline" aria-hidden="true" />
              <ArkAutoReveal onFire={() => setStage("reveal")} />
              <div className="ark-slit" aria-hidden="true" />
              {Array.from({ length: 18 }, (_, i) => (
                <span
                  key={i}
                  className="ark-mote"
                  aria-hidden="true"
                  style={{
                    "--from-x": `${(i % 2 ? 1 : -1) * (120 + (i * 53) % 200)}px`,
                    "--from-y": `${((i * 37) % 240) - 120}px`,
                    "--delay": `${i * 55}ms`,
                  }}
                />
              ))}
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
            <button type="button" className="btn-ghost pack-skip" onClick={() => { skipRef.current = true; setArmed(false); setStage("reveal"); }}>
              跳过动画 »
            </button>
          )}
        </div>
      )}
    </div>
  );
}
