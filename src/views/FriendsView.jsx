// 好友页(v2.2):双向同意的好友关系、赠送/索要、异步好友对战。
// 计划书:docs/updates/v2.2-friends.md。所有动作完成后 bumpFriends() 刷新导航红点。
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../state/auth.jsx";
import { bumpFriends } from "../hooks/useFriendPending.js";
import { artworkUrl } from "../shared/artwork.js";

const RARITY_LABEL = { C: "C", R: "R", UR: "UR" };
const RARITY_CLS = { C: "fr-chip-c", R: "fr-chip-r", UR: "fr-chip-ur" };

export default function FriendsView() {
  const { me, refresh } = useAuth();
  const [data, setData] = useState(null); // {friends, incoming, outgoing}
  const [trades, setTrades] = useState(null); // {incoming, outgoing}
  const [battles, setBattles] = useState(null); // {incoming, outgoing, finished}
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [addName, setAddName] = useState("");
  // 卡片选择器:{mode:'gift'|'ask'|'battle'|'defend', uid, name, title, cards, onPick}
  const [picker, setPicker] = useState(null);
  const [pickerIds, setPickerIds] = useState([]);
  // 战报弹窗:{title, winnerText, log, won}
  const [report, setReport] = useState(null);

  const load = useCallback(async () => {
    if (!me) return;
    try {
      const [a, b, c] = await Promise.all([
        fetch("/api/friends").then((r) => (r.ok ? r.json() : Promise.reject(new Error("好友列表加载失败")))),
        fetch("/api/friends/trades").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/friends/battles").then((r) => (r.ok ? r.json() : null)),
      ]);
      setData(a);
      setTrades(b ?? { incoming: [], outgoing: [] });
      setBattles(c ?? { incoming: [], outgoing: [], finished: [] });
      bumpFriends();
    } catch (e) {
      setError(e?.message || "加载失败,请重试");
    }
  }, [me?.id]);

  useEffect(() => {
    load();
  }, [load]);

  // 只发请求并回填提示;busy 的开关统一由外层 act() 管理
  const call = useCallback(async (method, path, body) => {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.message || "操作失败,请重试");
        return false;
      }
      if (json?.message) setNotice(json.message);
      return json;
    } catch {
      setError("网络异常,请重试");
      return false;
    }
  }, []);

  const act = async (fn) => {
    setBusy(true);
    try {
      await fn();
      await load();
      await refresh?.();
    } finally {
      setBusy(false);
    }
  };

  if (!me) {
    return (
      <div className="view-narrow">
        <p className="hint center">登录后才能使用好友系统。</p>
      </div>
    );
  }

  // ---- 选择器:选 1 张(赠送/索要)或 3 张(出战) ------------------------------
  function openPicker(mode, uid, name) {
    setNotice(null);
    setError(null);
    if (mode === "gift" || mode === "battle") {
      fetch("/api/collection")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("收藏加载失败"))))
        .then((body) => {
          const cards = (body?.cards ?? []).filter((c) => c.count >= 1);
          if (!cards.length) {
            setError("你还没有收藏任何宝可梦");
            return;
          }
          setPickerIds(mode === "battle" ? [] : []);
          setPicker({
            mode,
            uid,
            name,
            title: mode === "gift" ? `选择要送给 ${name} 的宝可梦` : "选择出战编队(3 只)",
            cards,
            multi: mode === "battle",
          });
        })
        .catch((e) => setError(e?.message || "加载失败"));
    } else {
      fetch(`/api/friends/${uid}/cards`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("对方卡池加载失败"))))
        .then((body) => {
          const cards = body?.cards ?? [];
          if (!cards.length) {
            setError(`${name} 还没有收藏任何宝可梦`);
            return;
          }
          setPickerIds([]);
          setPicker({ mode: "ask", uid, name, title: `选择想向 ${name} 索要的宝可梦`, cards, multi: false });
        })
        .catch((e) => setError(e?.message || "加载失败"));
    }
  }

  async function confirmPicker() {
    if (!picker) return;
    const { mode, uid } = picker;
    if (mode === "battle") {
      if (pickerIds.length !== 3) {
        setError("需要恰好 3 只不同的宝可梦");
        return;
      }
      const picked = [...pickerIds];
      setPicker(null);
      await act(async () => {
        const r = await call("POST", `/api/friends/${uid}/challenge`, { cardIds: picked });
        if (r) setNotice(`战书已发出,等 ${picker.name} 应战`);
      });
      return;
    }
    if (pickerIds.length !== 1) {
      setError(mode === "gift" ? "选择一张要赠送的宝可梦" : "选择一张想索要的宝可梦");
      return;
    }
    const cardId = pickerIds[0];
    const kind = mode === "gift" ? "gift" : "ask";
    const name = picker.name;
    setPicker(null);
    await act(async () => {
      const r = await call("POST", `/api/friends/${uid}/trades`, { kind, cardId });
      if (r) setNotice(kind === "gift" ? `赠送请求已发给 ${name}` : `已向 ${name} 发出索要`);
    });
  }

  function togglePick(id, multi) {
    setPickerIds((prev) => {
      if (!multi) return prev.length === 1 && prev[0] === id ? [] : [id];
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 3) return prev;
      return [...prev, id];
    });
  }

  async function acceptBattle(b) {
    // 应战:先选编队,选完立即模拟并弹战报
    fetch("/api/collection")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("收藏加载失败"))))
      .then((body) => {
        const cards = (body?.cards ?? []).filter((c) => c.count >= 1);
        if (cards.length < 3) {
          setError("收藏不足 3 只,无法应战");
          return;
        }
        setPickerIds([]);
        setPicker({ mode: "defend", uid: b.id, name: b.challenger_name, title: `应战 ${b.challenger_name}:选择出战编队`, cards, multi: true });
      })
      .catch((e) => setError(e?.message || "加载失败"));
  }

  async function confirmDefend() {
    if (pickerIds.length !== 3) {
      setError("需要恰好 3 只不同的宝可梦");
      return;
    }
    const battleId = picker.uid;
    const picked = [...pickerIds];
    setPicker(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/friend-battles/${battleId}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cardIds: picked }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.message || "应战失败");
        return;
      }
      setReport({
        title: `对战 ${json.draw ? "平局" : json.isWinner ? "胜利!" : "惜败"}`,
        won: json.isWinner,
        draw: !!json.draw,
        log: json.log ?? [],
      });
      await load();
      await refresh?.();
    } catch {
      setError("网络异常,请重试");
    } finally {
      setBusy(false);
    }
  }

  async function openReport(id) {
    setBusy(true);
    try {
      const res = await fetch(`/api/friend-battles/${id}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.message || "战报加载失败");
        return;
      }
      const b = json.battle;
      setReport({
        title: `${b.challenger_name} vs ${b.target_name}`,
        won: b.winner_uid != null && (b.winner_uid === me.id),
        draw: b.winner_uid == null,
        challengerName: b.challenger_name,
        targetName: b.target_name,
        log: b.battle_log ?? [],
      });
    } finally {
      setBusy(false);
    }
  }

  const friendCount = data?.friends?.length ?? 0;
  const defLines = (log) =>
    (log ?? []).slice(0, 200).map((l, i) => (
      <li key={i}>
        <span className="fr-log-turn">T{l.turn}</span> {l.text}
      </li>
    ));

  return (
    <div className="view-wide friends-view">
      <div className="fr-head card-box">
        <div>
          <h2 className="fr-title">好友</h2>
          <p className="hint">好友需要双方同意;可以互赠宝可梦、索要卡牌、下战书对战。</p>
        </div>
        <span className="fr-count" role="status">
          {friendCount}/50
        </span>
      </div>

      {(notice || error) && (
        <p className={error ? "form-error center" : "hint center"} role="status">
          {error || notice}
        </p>
      )}

      <div className="fr-add card-box">
        <input
          className="fr-add-input"
          placeholder="输入对方用户名,发送好友申请"
          value={addName}
          maxLength={20}
          onChange={(e) => setAddName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && addName.trim()) {
              act(async () => {
                const r = await call("POST", "/api/friends/request", { username: addName.trim() });
                if (r) setAddName("");
              });
            }
          }}
        />
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !addName.trim()}
          onClick={() =>
            act(async () => {
              const r = await call("POST", "/api/friends/request", { username: addName.trim() });
              if (r) setAddName("");
            })
          }
        >
          发送申请
        </button>
      </div>

      {/* 收到的好友申请 */}
      {(data?.incoming?.length ?? 0) > 0 && (
        <section className="fr-section card-box">
          <h3 className="fr-section-title">收到的好友申请({data.incoming.length})</h3>
          {data.incoming.map((r) => (
            <div key={r.id} className="fr-row">
              <span className="fr-user">
                <span className="avatar-bubble" aria-hidden="true">{r.username.slice(0, 1).toUpperCase()}</span>
                {r.username}
              </span>
              <span className="fr-row-actions">
                <button type="button" className="btn-primary btn-sm" disabled={busy}
                  onClick={() => act(() => call("POST", `/api/friends/requests/${r.id}/accept`))}>
                  同意
                </button>
                <button type="button" className="btn-ghost btn-sm" disabled={busy}
                  onClick={() => act(() => call("POST", `/api/friends/requests/${r.id}/decline`))}>
                  拒绝
                </button>
              </span>
            </div>
          ))}
        </section>
      )}

      {/* 好友列表 */}
      <section className="fr-section card-box">
        <h3 className="fr-section-title">我的好友</h3>
        {(data?.friends?.length ?? 0) === 0 && <p className="hint">还没有好友,先发一个申请吧。</p>}
        {(data?.friends ?? []).map((f) => (
          <div key={f.id} className="fr-row">
            <span className="fr-user">
              <span className="avatar-bubble" aria-hidden="true">{f.username.slice(0, 1).toUpperCase()}</span>
              {f.username}
            </span>
            <span className="fr-row-actions">
              <button type="button" className="btn-gold btn-sm" disabled={busy} onClick={() => openPicker("battle", f.id, f.username)}>
                挑战
              </button>
              <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => openPicker("gift", f.id, f.username)}>
                赠送
              </button>
              <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => openPicker("ask", f.id, f.username)}>
                索要
              </button>
              <button
                type="button"
                className="nav-link ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`删除好友 ${f.username}?挂起的赠送/索要/战书会一并取消。`)) {
                    act(() => call("DELETE", `/api/friends/${f.id}`));
                  }
                }}
              >
                删除
              </button>
            </span>
          </div>
        ))}
      </section>

      {/* 收到的赠送/索要 */}
      <section className="fr-section card-box">
        <h3 className="fr-section-title">赠送与索要</h3>
        {(trades?.incoming?.length ?? 0) === 0 && (trades?.outgoing?.length ?? 0) === 0 && (
          <p className="hint">没有进行中的赠送/索要。</p>
        )}
        {(trades?.incoming ?? []).map((t) => (
          <div key={t.id} className="fr-trade-row">
            <img className="fr-card-img" src={artworkUrl(t.card_id)} alt={t.zh_name || t.name} loading="lazy" />
            <span className="fr-trade-text">
              <b>{t.kind === 1 ? `${t.from_name} 送你` : `你向 ${t.from_name} 索要`}</b>
              <span className={`fr-chip ${RARITY_CLS[t.rarity] ?? ""}`}>{RARITY_LABEL[t.rarity] ?? t.rarity}</span>
              {t.zh_name || t.name}
              {t.kind === 1 && (t.holder_count ?? 0) === 1 && <span className="fr-warn">唯一一张</span>}
            </span>
            <span className="fr-row-actions">
              <button type="button" className="btn-primary btn-sm" disabled={busy}
                onClick={() => act(async () => { const r = await call("POST", `/api/trades/${t.id}/accept`); if (r) await refresh?.(); })}>
                接受
              </button>
              <button type="button" className="btn-ghost btn-sm" disabled={busy}
                onClick={() => act(() => call("POST", `/api/trades/${t.id}/decline`))}>
                拒绝
              </button>
            </span>
          </div>
        ))}
        {(trades?.outgoing ?? []).map((t) => (
          <div key={`o-${t.id}`} className="fr-trade-row">
            <img className="fr-card-img" src={artworkUrl(t.card_id)} alt={t.zh_name || t.name} loading="lazy" />
            <span className="fr-trade-text">
              <b>{t.kind === 1 ? `你送给 ${t.to_name}` : `${t.to_name} 持有`}</b>
              <span className={`fr-chip ${RARITY_CLS[t.rarity] ?? ""}`}>{RARITY_LABEL[t.rarity] ?? t.rarity}</span>
              {t.zh_name || t.name}
              <span className="fr-mut">待对方处理</span>
            </span>
            <span className="fr-row-actions">
              <button type="button" className="btn-ghost btn-sm" disabled={busy}
                onClick={() => act(() => call("POST", `/api/trades/${t.id}/cancel`))}>
                撤销
              </button>
            </span>
          </div>
        ))}
      </section>

      {/* 好友对战 */}
      <section className="fr-section card-box">
        <h3 className="fr-section-title">好友对战</h3>
        {(battles?.incoming?.length ?? 0) === 0 && (battles?.outgoing?.length ?? 0) === 0 && (battles?.finished?.length ?? 0) === 0 && (
          <p className="hint">在好友行点「挑战」下战书;对方应战后立即模拟整场,双方看同一场战报。</p>
        )}
        {(battles?.incoming ?? []).map((b) => (
          <div key={`bi-${b.id}`} className="fr-row">
            <span className="fr-user">
              ⚔️ <b>{b.challenger_name}</b> 向你下战书
            </span>
            <span className="fr-row-actions">
              <button type="button" className="btn-gold btn-sm" disabled={busy} onClick={() => acceptBattle(b)}>
                应战
              </button>
              <button type="button" className="btn-ghost btn-sm" disabled={busy}
                onClick={() => act(() => call("POST", `/api/friend-battles/${b.id}/decline`))}>
                拒绝
              </button>
            </span>
          </div>
        ))}
        {(battles?.outgoing ?? []).map((b) => (
          <div key={`bo-${b.id}`} className="fr-row">
            <span className="fr-user">
              📨 你已向 <b>{b.target_name}</b> 下战书
            </span>
            <span className="fr-row-actions">
              <button type="button" className="btn-ghost btn-sm" disabled={busy}
                onClick={() => act(() => call("POST", `/api/friend-battles/${b.id}/cancel`))}>
                撤销
              </button>
            </span>
          </div>
        ))}
        {(battles?.finished ?? []).slice(0, 8).map((b) => (
          <div key={`bf-${b.id}`} className="fr-row">
            <span className="fr-user">
              {b.winner_uid == null ? "🤝" : b.winner_uid === me.id ? "🏆" : "💀"} {b.challenger_name} vs {b.target_name}
            </span>
            <span className="fr-row-actions">
              <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => openReport(b.id)}>
                看战报
              </button>
            </span>
          </div>
        ))}
      </section>

      {/* 卡片选择器弹窗 */}
      {picker && (
        <div className="fr-modal" role="dialog" aria-label={picker.title} onClick={() => setPicker(null)}>
          <div className="fr-modal-box" onClick={(e) => e.stopPropagation()}>
            <h3 className="fr-section-title">{picker.title}</h3>
            <div className="fr-pick-grid">
              {picker.cards.map((c) => {
                const picked = pickerIds.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`fr-pick-cell ${picked ? "is-picked" : ""}`}
                    onClick={() => togglePick(c.id, picker.multi)}
                  >
                    <img src={artworkUrl(c.id)} alt={c.zh_name || c.name} loading="lazy" />
                    <span className="fr-pick-name">{c.zh_name || c.name}</span>
                    <span className={`fr-chip ${RARITY_CLS[c.rarity] ?? ""}`}>{RARITY_LABEL[c.rarity] ?? c.rarity}</span>
                    {(c.count ?? 1) > 1 && <span className="fr-pick-count">×{c.count}</span>}
                  </button>
                );
              })}
            </div>
            <div className="fr-modal-foot">
              <span className="hint">
                {picker.multi ? `已选 ${pickerIds.length}/3` : pickerIds.length === 1 ? "已选 1 张" : "未选择"}
              </span>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setPicker(null)}>
                取消
              </button>
              <button type="button" className="btn-gold" disabled={busy} onClick={picker.mode === "defend" ? confirmDefend : confirmPicker}>
                {picker.mode === "defend" ? "应战!" : picker.mode === "battle" ? "下战书" : "确定"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 战报弹窗 */}
      {report && (
        <div className="fr-modal" role="dialog" aria-label="战报" onClick={() => setReport(null)}>
          <div className="fr-modal-box" onClick={(e) => e.stopPropagation()}>
            <h3 className={`fr-section-title ${report.draw ? "" : report.won ? "fr-win" : "fr-lose"}`}>
              {report.draw ? "🤝 平局" : report.won ? "🏆 胜利!" : "💀 惜败"} · {report.title}
            </h3>
            <ol className="fr-log">{defLines(report.log)}</ol>
            <div className="fr-modal-foot">
              <button type="button" className="btn-gold" onClick={() => setReport(null)}>
                收下战报
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
