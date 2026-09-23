// Auth state: one provider, one hook. /api/me on mount decides logged-in vs
// guest; login/register/logout all funnel through refresh() so the header,
// shop and collection views never disagree about who is signed in.
import { createContext, useCallback, useContext, useEffect, useState } from "react";

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
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
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
