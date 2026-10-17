// Auth state: one provider, one hook. /api/me on mount decides logged-in vs
// guest; login/register/logout all funnel through refresh() so the header,
// shop and collection views never disagree about who is signed in.
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { trackAction } from "../telemetry/telemetry.js";

/** @typedef {{id:number, username:string, balance:number}} Me */

const AuthContext = createContext(null);

async function jsonOrThrow(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message || `请求失败 (${res.status})`);
  return body;
}

export function AuthProvider({ children }) {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const body = await jsonOrThrow(await fetch("/api/me"));
      setMe(body.user);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (username, password) => {
    await jsonOrThrow(
      await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      })
    );
    trackAction("login");
    await refresh();
  }, [refresh]);

  const register = useCallback(async (username, password) => {
    await jsonOrThrow(
      await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      })
    );
    trackAction("register");
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    // 服务端会话销毁失败也先本地登出(cookie 过期后服务端会话自然失效);
    // 静默失败会让用户"点了退出却还是登录态"且无任何提示(审计 P2-18)
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* 网络异常:本地态已清,服务端会话 7 天后自然过期 */
    }
    setMe(null);
  }, []);

  return (
    <AuthContext.Provider value={{ me, loading, refresh, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
