// 对战竞技场:服务器权威结算,前端只渲染状态快照与按序播放的事件动画。
// 结构:编队检查 → 开战(选对手模式) → 竞技场(铭牌/立绘对峙/招式坞/日志)。
import { useEffect, useState } from "react";
import { useAuth } from "../state/auth.jsx";
import { artworkUrl } from "../shared/artwork.js";
import { effectiveness } from "../shared/typechart.js";
import { TYPE_COLORS, typeZh } from "../config/pokemon.js";

const RARITY_LABEL = { C: "C", R: "R", UR: "UR" };

const displayName = (mon) => (mon.zhName ? `${mon.zhName} (${mon.name})` : mon.name);

function HpBar({ mon }) {
  const pct = Math.max(0, Math.round((mon.hp / mon.maxHp) * 100));
  const cls = pct > 50 ? "hp-hi" : pct > 20 ? "hp-mid" : "hp-lo";
  return (
    <div className="hp-track">
      {/* ghost 条延迟跟落:掉血时红条先缩,白条缓缓跟上(格斗游戏手法) */}
      <div className="hp-ghost" style={{ width: `${pct}%` }} />
      <div className={`hp-fill ${cls}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** 游戏式血条铭牌:名字 + HP 双层条 + 属性 */
function Nameplate({ mon }) {
  return (
    <div className="plate">
      <div className="plate-row">
        <span className="plate-name">{displayName(mon)}</span>
        <span className={`rarity-badge rarity-${mon.rarity}`}>{RARITY_LABEL[mon.rarity] || mon.rarity}</span>
      </div>
      <HpBar mon={mon} />
      <div className="plate-nums">
        <span>
          {mon.hp}/{mon.maxHp}
        </span>
        <span className="plate-types">{mon.types.map(typeZh).join(" / ")}</span>
      </div>
    </div>
  );
}

/** 竞技场立绘:突进/受击动画 + 伤害数字 + 脚下光台(HP 只在铭牌显示,避免语义重复) */
function ArenaMon({ mon, side, lunging, hit, popup }) {
  return (
    <div className={`arena-mon arena-${side} ${lunging ? "is-lunging" : ""} ${hit ? "is-hit" : ""}`}>
      {popup && <div className={`dmg-popup ${popup.cls}`}>{popup.text}</div>}
      <div className="arena-platform" />
      <img className="arena-sprite" src={mon.artwork || mon.sprite} alt={mon.name} />
    </div>
  );
}

export default function BattleView({ onGoLogin, onGoCollection }) {
  const { me, refresh } = useAuth();
  const [teamIds, setTeamIds] = useState(null);
  const [teamMons, setTeamMons] = useState([]); // 编队预览数据
  const [battle, setBattle] = useState(null); // { battleId, state }
  // 回合动画编排:服务器一次返回全部事件,这里按顺序逐个播放
  const [playing, setPlaying] = useState(false);
  const [popup, setPopup] = useState(null); // {side, text, cls}
  const [lunge, setLunge] = useState(null); // "user"|"ai" 突进中
  const [hitFlash, setHitFlash] = useState(null); // 受击抖动
  const [stageImpact, setStageImpact] = useState(false);
  const [confetti, setConfetti] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reward, setReward] = useState(null);
  const [resumed, setResumed] = useState(false);

  useEffect(() => {
    if (!me) return;
    Promise.all([fetch("/api/battle/team"), fetch("/api/battle/active"), fetch("/api/collection")])
      .then(async ([tRes, aRes, cRes]) => {
        const tBody = await tRes.json();
        const aBody = await aRes.json();
        const cBody = await cRes.json();
        setTeamIds(tBody.cardIds ?? []);
        const ids = new Set(tBody.cardIds ?? []);
        setTeamMons((cBody.cards ?? []).filter((c) => ids.has(c.id)));
        if (aBody.battleId && aBody.state?.status === "active") {
          setBattle(aBody);
          setResumed(true);
        }
      })
      .catch(() => setError("加载战斗数据失败"));
  }, [me]);

  async function startBattle(mode) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setReward(null);
    setConfetti(false);
    try {
      const res = await fetch("/api/battle/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.message || "开战失败");
        return;
      }
      setBattle({ battleId: body.battleId, state: body.state });
    } finally {
      setBusy(false);
    }
  }

  async function forfeit() {
    if (!battle || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/battle/${battle.battleId}/forfeit`, { method: "POST" });
      if (res.ok) setBattle({ ...battle, state: { ...battle.state, status: "lost" } });
      else setError("投降失败,请重试");
    } catch {
      setError("网络异常,请重试");
    } finally {
      setBusy(false);
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function postAction(action) {
    if (!battle || busy || playing) return;
    setBusy(true);
    setPlaying(true);
    setConfetti(false);
    try {
      const res = await fetch(`/api/battle/${battle.battleId}/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.message || "行动失败");
        return;
      }
      await playEvents(body.events, body.state);
      setBattle({ battleId: battle.battleId, state: body.state });
      if (body.reward > 0) {
        setReward(body.reward);
        setConfetti(true);
        await refresh(); // wallet balance changed
      }
    } catch {
      setError("网络异常,请重试");
    } finally {
      setBusy(false);
    }
  }

  // ---- 回合动画编排器:逐个播放服务器事件 ----
  async function playEvents(events, finalState) {
    setPlaying(true);
    const view = JSON.parse(JSON.stringify(battle.state));

    for (const ev of events) {
      if (ev.kind === "move") {
        const actorSide = ev.actor;
        setLunge(actorSide);
        await sleep(380);
        setLunge(null);
        const defSide = actorSide === "user" ? "ai" : "user";
        setHitFlash(defSide);
        setStageImpact(true);
        setPopup({
          side: defSide,
          text: `-${ev.damage ?? 0}`,
          cls: ev.text.includes("效果绝佳") ? "pop-super" : ev.text.includes("没有效果") ? "pop-zero" : "pop-normal",
        });
        const defIdx = defSide === "user" ? view.activeUser : view.activeAi;
        const defMon = (defSide === "user" ? view.userTeam : view.aiTeam)[defIdx];
        defMon.hp = Math.max(0, defMon.hp - (ev.damage ?? 0));
        setBattle({ battleId: battle.battleId, state: { ...view, log: finalState.log } });
        await sleep(750);
        setPopup(null);
        setHitFlash(null);
        setStageImpact(false);
        await sleep(250);
      } else {
        setBattle({ battleId: battle.battleId, state: finalState });
        await sleep(900);
      }
    }
    setPlaying(false);
    setBattle({ battleId: battle.battleId, state: finalState });
  }

  // ---- 未登录 ----
  if (!me) {
    return (
      <div className="view-narrow">
        <div className="card-box center">
          <p>登录后才能编队和对战。</p>
          <button type="button" className="btn-primary" onClick={onGoLogin}>
            去登录
          </button>
        </div>
      </div>
    );
  }

  // ---- 战斗中:竞技场 ----
  if (battle) {
    const s = battle.state;
    const u = s.userTeam[s.activeUser];
    const a = s.aiTeam[s.activeAi];
    const finished = s.status !== "active";
    const bench = s.userTeam.map((m, i) => ({ m, i })).filter(({ m, i }) => i !== s.activeUser && m.hp > 0);
    const log = (s.log ?? []).slice(-14);
    const popupFor = (side) => (popup?.side === side ? popup : null);

    return (
      <div className="view-wide battle-view">
        <div
          className={`battle-arena ${finished ? "is-finished" : ""} ${s.status === "won" ? "is-won" : ""} ${hitFlash ? "is-shaking" : ""}`}
          style={{ "--tc-u": TYPE_COLORS[u.types?.[0]], "--tc-a": TYPE_COLORS[a.types?.[0]] }}
        >
          <div className="arena-plates">
            <Nameplate mon={u} side="user" />
            <div className="turn-badge">第 {s.turn} 回合</div>
            <Nameplate mon={a} side="ai" />
          </div>

          <div className="arena-floor">
            <div className={`arena-side arena-side-user ${lunge === "user" ? "is-lunging" : ""} ${hitFlash === "user" ? "is-hit" : ""}`}>
              <ArenaMon mon={u} side="user" popup={popupFor("user")} />
            </div>
            <div className="arena-vs">
              <span>VS</span>
            </div>
            <div className={`arena-side arena-side-ai ${lunge === "ai" ? "is-lunging" : ""} ${hitFlash === "ai" ? "is-hit" : ""}`}>
              <ArenaMon mon={a} side="ai" popup={popupFor("ai")} />
            </div>
            {s.status === "won" && confetti && (
              <div className="win-burst" aria-hidden="true">
                {Array.from({ length: 60 }, (_, i) => (
                  <span
                    key={i}
                    className="confetti"
                    style={{
                      left: `${(i * 17 + 5) % 100}%`,
                      background: ["#ffcb05", "#e3350d", "#2a75bb", "#35c26b", "#f4f6fa"][i % 5],
                      animationDelay: `${(i % 10) * 0.12}s`,
                      animationDuration: `${2.2 + (i % 5) * 0.3}s`,
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          {finished && (
            <div className="battle-verdict">
              {s.status === "won" ? "🏆 你赢得了战斗!" : "💫 AI 对手获得了胜利…"}
              {reward > 0 && <span className="verdict-reward">+{reward} 图鉴币已入账</span>}
            </div>
          )}
        </div>

        {!finished && (
          <div className="battle-dock">
            <div className="dock-moves">
              <div className="dock-label">招式</div>
              <div className="moves">
                {u.moves.map((m) => {
                  const eff = effectiveness(m.type, a.types);
                  const effTag = eff >= 2 ? "▲" : eff === 0 ? "✕" : eff < 1 ? "▼" : "";
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className="move-btn"
                      style={{ "--move-color": TYPE_COLORS[m.type] }}
                      disabled={busy || playing}
                      onClick={() => postAction({ kind: "move", moveId: m.id })}
                    >
                      <span className="move-name">{m.name}</span>
                      <span className="move-meta">
                        {typeZh(m.type)} · 威力{m.power} {effTag}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="dock-bench">
              <div className="dock-label">替补(换人消耗一回合)</div>
              {bench.map(({ m, i }) => (
                <button
                  key={m.cardId}
                  type="button"
                  className="bench-btn"
                  disabled={busy || playing}
                  onClick={() => postAction({ kind: "switch", index: i })}
                >
                  {displayName(m)} ({m.hp}/{m.maxHp})
                </button>
              ))}
              <button type="button" className="bench-btn is-forfeit" disabled={busy || playing} onClick={forfeit}>
                投降
              </button>
            </div>
          </div>
        )}

        {error && (
          <p className="form-error center" role="alert">
            {error}
          </p>
        )}

        <details className="battle-history">
          <summary>战斗日志</summary>
          <div className="battle-log">
            {log.map((e, i) =>
              e.kind === "reason" ? (
                <div key={i} className="log-line log-reason">
                  <span className="log-turn">T{e.turn} 🤖</span> AI 行动理由:{e.text}
                </div>
              ) : (
                <div key={i} className={`log-line log-${e.kind}`}>
                  <span className="log-turn">T{e.turn}</span>
                  <span className="log-text">{e.text}</span>
                </div>
              )
            )}
          </div>
        </details>
      </div>
    );
  }

  // ---- 开战前:编队就绪检查 + 预览 ----
  return (
    <div className="battle-view">
      <div className="battle-pregame">
        <div className="pregame-title">
          <span className="view-title">对战</span>
          <p className="hint">从你的收藏中编入 3 只宝可梦,与 AI 对手展开回合制对战。</p>
        </div>
        {teamIds === null ? (
          <p className="hint center">加载中…</p>
        ) : teamIds.length === 3 ? (
          <>
            <div className="pregame-squad">
              {teamMons.map((c) => (
                <div
                  key={c.id}
                  className="pregame-mon"
                  style={{ "--tc": TYPE_COLORS[c.types?.[0]] }}
                >
                  <span className="pregame-frame">
                    <img src={artworkUrl(c.id)} alt={c.name} />
                  </span>
                  <span>{c.zh_name || c.name}</span>
                </div>
              ))}
              <div className="pregame-vs">
                <span>VS</span>
              </div>
              <div className="pregame-mon is-mystery">
                <span className="mystery-mark" aria-hidden="true">
                  <span className="mystery-ball" />
                  <i>?</i>
                </span>
                <span>AI 对手</span>
              </div>
            </div>
            <div className="pregame-actions">
              <button type="button" className="btn-primary" onClick={() => startBattle("rule")} disabled={busy}>
                {busy ? "准备中…" : resumed ? "继续战斗" : "开始对战(规则对手)"}
              </button>
              <button type="button" className="btn-primary" onClick={() => startBattle("reasoned")} disabled={busy}>
                {busy ? "准备中…" : "开始对战(AI 推演)"}
              </button>
            </div>
            <div className="pregame-teamstrip">
              <span className="ts-item">
                队伍总 HP <b>{teamMons.reduce((n, c) => n + (c.stats?.hp ?? 0), 0)}</b>
              </span>
              <span className="ts-sep" aria-hidden="true" />
              <span className="ts-item">
                属性{" "}
                <b>{[...new Set(teamMons.flatMap((c) => c.types ?? []))].map(typeZh).join(" / ")}</b>
              </span>
              <span className="ts-sep" aria-hidden="true" />
              <button type="button" className="ts-link" onClick={onGoCollection}>
                调整编队 →
              </button>
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="hint center">还没有对战编队——先去收藏页选 3 只宝可梦编入队伍。</p>
            <button type="button" className="btn-primary" onClick={onGoCollection}>
              去收藏页编队
            </button>
          </>
        )}
      </div>
    </div>
  );
}
