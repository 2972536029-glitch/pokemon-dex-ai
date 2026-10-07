// 卡包商店:概率公示、价格、幂等抽取,购买触发开包仪式动画。
// 幂等键绑定购买意图(QA-005):响应丢失后重试同一意图不会重复扣费。
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../state/auth.jsx";
import { artworkUrl } from "../shared/artwork.js";
import { TYPE_COLORS, TYPE_ZH } from "../config/pokemon.js";

const RARITY_LABEL = { C: "常见 (C)", R: "稀有 (R)", UR: "超稀有 (UR)" };
const RARITY_DOT = { C: "#98a4b0", R: "#2a75bb", UR: "#d4af37" };
const RARITY_RANK = { C: 0, R: 1, UR: 2 };

// 十连揭示元数据:按稀有度升序(悬念保留到 UR 压轴),同稀有度保持抽到的原序
function buildTenMeta(cards) {
  const order = cards
    .map((_, i) => i)
    .sort((a, b) => RARITY_RANK[cards[a].rarity] - RARITY_RANK[cards[b].rarity] || a - b);
  const top = cards.some((c) => c.rarity === "UR")
    ? "UR"
    : cards.some((c) => c.rarity === "R")
      ? "R"
      : "C";
  return { order, top };
}

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
  const [pity, setPity] = useState(null); // { [packId]: {since_ur, remaining, limit} }
  const [tenResult, setTenResult] = useState(null); // {cards, shortfall}
  const [txOpen, setTxOpen] = useState(false);
  const [txList, setTxList] = useState(null); // 钱包流水(懒加载:展开才请求)
  // 开包动画状态机: null → "pack"(摇晃) → "burst"(炸开) → 单抽 "converge"/"reveal" · 十连 "ten-reveal"
  const [stage, setStage] = useState(null);
  const [armed, setArmed] = useState(false); // 摇晃完毕,等待玩家点击拆包
  const [tenMode, setTenMode] = useState(false); // 本轮仪式是否为十连(pack/burst 与单抽共享)
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
    setTenMode(false); // 单抽走 converge 分支
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

  // 方舟式交互:玩家点击推进仪式。pack(武装完成)→ burst;burst 后按模式分流;converge → reveal;
  // ten-reveal 阶段点击 = 立刻翻开下一张(加速)
  function advanceCeremony() {
    if (!stage || busy) return;
    if (stage === "pack" && armed) {
      setArmed(false);
      setStage("burst");
      setTimeout(() => {
        if (skipRef.current) return;
        setStage(tenMode ? "ten-reveal" : "converge");
      }, 650);
    } else if (stage === "converge" && result?.card) {
      setStage("reveal");
    } else if (stage === "ten-reveal") {
      revealNext();
    }
  }

  // 十连揭示引擎:每翻一张按"下一张的稀有度"决定停顿——UR 前心跳停顿拉高悬念
  useEffect(() => {
    if (stage !== "ten-reveal" || !tenResult) return;
    const { cards, order, revealed } = tenResult;
    if (revealed >= cards.length) return;
    const next = cards[order[revealed]];
    const delay = next?.rarity === "UR" ? 1000 : next?.rarity === "R" ? 500 : 380;
    const t = setTimeout(() => {
      setTenResult((p) => p && { ...p, revealed: p.revealed + 1 });
    }, delay);
    return () => clearTimeout(t);
  }, [stage, tenResult]);

  function revealNext() {
    setTenResult((p) => (p && p.revealed < p.cards.length ? { ...p, revealed: p.revealed + 1 } : p));
  }

  function flipAllTen() {
    setTenResult((p) => (p ? { ...p, revealed: p.cards.length, bulk: true } : p));
  }

  async function handleTenPull(packId) {
    if (!me || busy) return;
    setBusy(true);
    setDrawing(packId);
    setNotice(null);
    let base = intentIds.current[packId + "-t10"];
    if (!base) {
      try { base = crypto.randomUUID(); } catch { base = `t10-${Date.now()}-${Math.floor(Math.random() * 1e6)}`; }
      intentIds.current[packId + "-t10"] = base;
    }
    // 仪式与请求并行(与单抽一致):点下十连立刻出包摇晃,数据在路上
    setTenResult(null);
    setTenMode(true);
    setStage("pack");
    setArmed(false);
    skipRef.current = false;
    const choreography = sleep(1300).then(() => {
      if (!skipRef.current) setArmed(true);
    });
    const request = (async () => {
      try {
        const res = await fetch(`/api/packs/${packId}/tenpull`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderId: base }),
        });
        const body = await res.json();
        return { ok: res.ok, body };
      } catch {
        return { ok: false, body: null };
      }
    })();
    const [, outcome] = await Promise.all([choreography, request]);
    try {
      if (!outcome.ok || !outcome.body) {
        setNotice(outcome.body?.message || "十连失败,请重试(同一订单重试不会重复扣费)");
        setStage(null);
        setTenMode(false);
        return;
      }
      const cards = outcome.body.cards ?? [];
      if (!cards.length) {
        // 余额为 0 时服务端返回空卡组:没有可揭示的内容,直接提示,不进仪式
        setNotice("余额不足,十连一张也没抽成(每日登录 +50)");
        setStage(null);
        setTenMode(false);
        return;
      }
      const { order, top } = buildTenMeta(cards);
      const skipped = skipRef.current; // 摇晃中就按了跳过:数据到了直接全开
      setTenResult({
        cards,
        order,
        top,
        shortfall: outcome.body.shortfall ?? 0,
        replay: outcome.body.replay,
        revealed: skipped ? cards.length : 0,
        bulk: skipped,
      });
      if (skipped) setStage("ten-reveal");
      await refresh();
      fetch("/api/packs/pity").then((r) => (r.ok ? r.json() : null)).then((d) => setPity(d)).catch(() => {});
    } finally {
      delete intentIds.current[packId + "-t10"];
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
                {me && pity?.[p.id] && (
                  <div className="pity-mini" role="status">
                    <div className="pity-mini-head">
                      <span>UR 保底 {pity[p.id].limit} 抽</span>
                      <span>
                        已垫 <b>{pity[p.id].since_ur}</b> 抽
                      </span>
                    </div>
                    <div className="pity-mini-track">
                      <div
                        className="pity-mini-fill"
                        style={{ width: `${Math.min(100, (pity[p.id].since_ur / pity[p.id].limit) * 100)}%` }}
                      />
                    </div>
                  </div>
                )}
                <div className="pack-btn-row">
                  <button
                    type="button"
                    className={p.id === "legend" ? "btn-gold" : "btn-primary"}
                    disabled={!me || busy}
                    onClick={() => draw(p.id)}
                  >
                    {drawing === p.id ? "开包中…" : me ? "购买并抽取" : "登录后可购买"}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost pack-ten-btn"
                    disabled={!me || busy}
                    onClick={() => handleTenPull(p.id)}
                    title={`十连价 ${p.price * 10} 币`}
                  >
                    {drawing === p.id ? "…" : "十连"}
                  </button>
                </div>
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

      {stage && (() => {
        // 仪式染色:单抽用抽到的卡;十连用本包最高稀有度。pack 摇晃段保持中性不剧透
        const ceremonyRarity = tenMode ? tenResult?.top ?? null : result?.card?.rarity ?? null;
        const themed = ceremonyRarity && stage !== "pack" ? `ark-r-${ceremonyRarity}` : "";
        const lastIdx = stage === "ten-reveal" && tenResult && tenResult.revealed > 0 ? tenResult.order[tenResult.revealed - 1] : -1;
        const lastIsUR = lastIdx >= 0 && tenResult?.cards[lastIdx]?.rarity === "UR";
        return (
      <div
        className={`pack-stage stage-${stage} ${themed} ${stage === "pack" && armed ? "is-armed" : ""} ${lastIsUR ? "ten-ur-hit" : ""}`}
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
                    // 粒子颜色吃稀有度染色变量:C 蓝白 / R 亮青 / UR 金
                    background: i % 2 ? "var(--ark-core)" : "var(--ark-glow)",
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
          {/* 十连第三幕:卡背阵列落地 → 按稀有度升序逐张翻开,UR 压轴 */}
          {stage === "ten-reveal" && tenResult?.cards && (() => {
            const total = tenResult.cards.length;
            const rankOf = new Map(tenResult.order.map((idx, rank) => [idx, rank]));
            const allIn = tenResult.revealed >= total;
            return (
              <>
                {lastIsUR && <div key={tenResult.revealed} className="ten-ur-flash" aria-hidden="true" />}
                <div className="ten-wrap">
                <p className="ten-title">
                  {tenResult.shortfall > 0
                    ? `金币只够 ${total} 抽,已入账 · `
                    : tenResult.replay
                      ? "十连重放(未重复扣费) · "
                      : ""}
                  {allIn ? `最佳 ${RARITY_LABEL[tenResult.top]}` : `翻开中 ${tenResult.revealed}/${total}`}
                </p>
                <div className="ten-grid">
                  {tenResult.cards.map((c, i) => {
                    const rank = rankOf.get(i);
                    const isUp = rank < tenResult.revealed;
                    const isFresh = tenResult.bulk ? isUp : i === lastIdx;
                    return (
                      <div
                        key={`${c.id}-${i}`}
                        className={`ten-cell ten-cell-${c.rarity} ${isUp ? "is-up" : "is-down"} ${isFresh ? "is-fresh" : ""} ${i === lastIdx && c.rarity === "UR" ? "is-ur-hit" : ""}`}
                        style={tenResult.bulk && isFresh ? { animationDelay: `${rank * 45}ms` } : undefined}
                      >
                        {isUp ? (
                          <>
                            <img
                              src={`https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/other/official-artwork/${c.id}.png`}
                              alt={c.name}
                              loading="lazy"
                            />
                            <span className="ten-cell-rarity">{c.rarity}</span>
                          </>
                        ) : (
                          <div className="ten-card-back" aria-hidden="true" />
                        )}
                      </div>
                    );
                  })}
                </div>
                {!allIn && <p className="ten-hint">轻触任意处加速翻开 · 最高稀有度压轴</p>}
                {allIn ? (
                  <button
                    type="button"
                    className="btn-gold pack-continue"
                    onClick={(e) => { e.stopPropagation(); setTenResult(null); setTenMode(false); setStage(null); }}
                  >
                    收下
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-ghost pack-continue"
                    onClick={(e) => { e.stopPropagation(); flipAllTen(); }}
                  >
                    全部翻开 »
                  </button>
                )}
                </div>
              </>
            );
          })()}
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
            <button
              type="button"
              className="btn-ghost pack-skip"
              onClick={(e) => {
                e.stopPropagation();
                skipRef.current = true;
                setArmed(false);
                if (tenMode) {
                  // 卡组数据未到时先记 skipRef,数据到达直接全开;已到则立即全开
                  if (tenResult) {
                    setTenResult((p) => (p ? { ...p, revealed: p.cards.length, bulk: true } : p));
                    setStage("ten-reveal");
                  }
                } else {
                  setStage("reveal");
                }
              }}
            >
              跳过动画 »
            </button>
          )}
        </div>
      );
      })()}
    </div>
  );
}
