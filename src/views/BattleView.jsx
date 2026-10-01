// Battle view: squad check → start → turn-based battle vs the rule-mode AI.
// The server owns all math; this component only renders state snapshots and
// posts actions (server-authoritative design).
import { useEffect, useState } from "react";
import { useAuth } from "../state/auth.jsx";
import { effectiveness } from "../shared/typechart.js";

const RARITY_LABEL = { C: "C", R: "R", UR: "UR" };

const displayName = (mon) => (mon.zhName ? `${mon.zhName} (${mon.name})` : mon.name);

function HpBar({ mon }) {
  const pct = Math.max(0, Math.round((mon.hp / mon.maxHp) * 100));
  const cls = pct > 50 ? "hp-hi" : pct > 20 ? "hp-mid" : "hp-lo";
  return (
    <div className="hp-wrap">
      <div className="hp-track">
        <div className={`hp-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="hp-text">
        {mon.hp}/{mon.maxHp}
      </span>
    </div>
  );
}

const ActiveMon = ({ mon, side }) => (
  <div className={`battle-mon battle-${side}`}>
    <img src={mon.sprite} alt={mon.name} />
    <div className="battle-mon-name">
      {displayName(mon)} <span className={`rarity-badge rarity-${mon.rarity}`}>{RARITY_LABEL[mon.rarity] || mon.rarity}</span>
    </div>
    <HpBar mon={mon} />
    <div className="battle-types">
      {mon.types.map((t) => (
        <span key={t} className="type-chip">
          {t}
        </span>
      ))}
    </div>
  </div>
);

export default function BattleView({ onGoLogin, onGoCollection }) {
  const { me, refresh } = useAuth();
  const [teamIds, setTeamIds] = useState(null);
  const [battle, setBattle] = useState(null); // { battleId, state }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reward, setReward] = useState(null);
  const [resumed, setResumed] = useState(false);

  useEffect(() => {
    if (!me) return;
    Promise.all([fetch("/api/battle/team"), fetch("/api/battle/active")])
      .then(async ([tRes, aRes]) => {
        const tBody = await tRes.json();
        const aBody = await aRes.json();
        setTeamIds(tBody.cardIds ?? []);
        if (aBody.battleId && aBody.state?.status === "active") {
          setBattle(aBody);
          setResumed(true);
        }
      })
      .catch(() => setError("加载战斗数据失败"));
  }, [me]);

  async function startBattle() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setReward(null);
    try {
      const res = await fetch("/api/battle/start", { method: "POST" });
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

  async function postAction(action) {
    if (!battle || busy) return;
    setBusy(true);
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
      setBattle({ battleId: battle.battleId, state: body.state });
      if (body.reward > 0) {
        setReward(body.reward);
        await refresh(); // wallet balance changed
      }
    } catch {
      setError("网络异常,请重试");
    } finally {
      setBusy(false);
    }
  }

  async function forfeit() {
    if (!battle || busy) return;
    setBusy(true);
    try {
      await fetch(`/api/battle/${battle.battleId}/forfeit`, { method: "POST" });
      setBattle({ ...battle, state: { ...battle.state, status: "lost" } });
    } finally {
      setBusy(false);
    }
  }

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

  // ---- battle screen ----
  if (battle) {
    const s = battle.state;
    const u = s.userTeam[s.activeUser];
    const a = s.aiTeam[s.activeAi];
    const bench = s.userTeam
      .map((m, i) => ({ m, i }))
      .filter(({ m, i }) => i !== s.activeUser && m.hp > 0);
    const finished = s.status !== "active";
    const log = (s.log ?? []).slice(-14);

    return (
      <div className="view-wide">
        <h2 className="view-title">
          对战 · 第 {s.turn} 回合
          {finished && (
            <span className={`battle-result ${s.status === "won" ? "win" : "lose"}`}>
              {s.status === "won" ? `🏆 胜利!奖励 +${reward ?? 100} 图鉴币` : " 💧 战败…"}
            </span>
          )}
        </h2>

        <div className="battle-stage">
          <ActiveMon mon={u} side="user" />
          <div className="battle-vs">VS</div>
          <ActiveMon mon={a} side="ai" />
        </div>

        {!finished && (
          <div className="battle-actions">
            <div className="moves">
              {u.moves.map((m) => {
                const eff = effectiveness(m.type, a.types);
                const effTag = eff >= 2 ? "▲" : eff === 0 ? "✕" : eff < 1 ? "▼" : "";
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`move-btn type-${m.type}`}
                    disabled={busy}
                    onClick={() => postAction({ kind: "move", moveId: m.id })}
                  >
                    {m.name}
                    <span className="move-meta">
                      {m.type} · 威力{m.power} {effTag}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="bench">
              <div className="bench-label">替补(换人消耗一回合)</div>
              {bench.map(({ m, i }) => (
                <button
                  key={m.cardId}
                  type="button"
                  className="bench-btn"
                  disabled={busy}
                  onClick={() => postAction({ kind: "switch", index: i })}
                >
                  {displayName(m)} ({m.hp}/{m.maxHp})
                </button>
              ))}
            </div>
            <button type="button" className="btn-ghost forfeit" onClick={forfeit} disabled={busy}>
              投降
            </button>
          </div>
        )}

        {error && (
          <p className="form-error center" role="alert">
            {error}
          </p>
        )}

        <div className="battle-log">
          {log.map((e, i) => (
            <div key={i} className={`log-line log-${e.kind}`}>
              <span className="log-turn">T{e.turn}</span> {e.text}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ---- pre-battle: squad status ----
  return (
    <div className="view-narrow">
      <div className="card-box center">
        <h3 className="view-title">对战</h3>
        {teamIds === null ? (
          <p>加载中…</p>
        ) : teamIds.length === 3 ? (
          <>
            <p>你的编队已就绪,和 AI 对手来一场回合制对战吧。</p>
            <p className="hint">胜利奖励 +100 图鉴币;战斗由服务器权威结算,数据全部来自真实图鉴。</p>
            <button type="button" className="btn-primary" onClick={startBattle} disabled={busy}>
              {busy ? "准备中…" : resumed ? "继续上一次战斗" : "开始对战"}
            </button>
          </>
        ) : (
          <>
            <p className="hint">还没有对战编队——先去收藏页选 3 只宝可梦编入队伍。</p>
            <button type="button" className="btn-primary" onClick={onGoCollection}>
              去收藏页编队
            </button>
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
