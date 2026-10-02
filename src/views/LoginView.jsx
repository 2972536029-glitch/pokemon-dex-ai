// 登录/注册:左侧品牌叙事,右侧表单。未登录访客的第一站。
import { useState } from "react";
import { artworkUrl } from "../shared/artwork.js";
import { useAuth } from "../state/auth.jsx";

export default function LoginView({ onDone }) {
  const { login, register } = useAuth();
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await login(username, password);
      else await register(username, password);
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-split">
      <div className="login-brand">
        <img className="brand-float brand-float-1" src={artworkUrl(6)} alt="" aria-hidden="true" />
        <img className="brand-float brand-float-2" src={artworkUrl(25)} alt="" aria-hidden="true" />
        <span className="brand-logo">
          宝可梦图鉴 <b>AI</b>
        </span>
        <h2>
          开启你的
          <br />
          宝可梦冒险
        </h2>
        <div className="brand-points">
          <span className="brand-point">
            <span className="pt-ico">🔍</span> AI 图鉴问答——每句回答都经数据核对
          </span>
          <span className="brand-point">
            <span className="pt-ico">🎴</span> 卡牌收藏——概率全公示,抽取必入账
          </span>
          <span className="brand-point">
            <span className="pt-ico">⚔️</span> AI 对战——真实数值的回合制推演
          </span>
        </div>
      </div>

      <form className="login-form" onSubmit={submit}>
        <div className="tabs">
          <button
            type="button"
            className={mode === "login" ? "tab is-active" : "tab"}
            onClick={() => setMode("login")}
          >
            登录
          </button>
          <button
            type="button"
            className={mode === "register" ? "tab is-active" : "tab"}
            onClick={() => setMode("register")}
          >
            注册
          </button>
        </div>

        <label className="field">
          <span>用户名</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="3-20 位字母、数字或下划线"
            autoComplete="username"
            maxLength={20}
          />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 6 位"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            maxLength={100}
          />
        </label>

        {mode === "register" && (
          <p className="hint">注册赠送 300 图鉴币,每日登录再领 50,用来抽卡包。</p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn-primary" disabled={busy || !username || !password}>
          {busy ? "处理中…" : mode === "login" ? "登录" : "注册并登录"}
        </button>
      </form>
    </div>
  );
}
