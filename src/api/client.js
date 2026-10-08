// 统一 /api 请求封装(v2.3):JSON 解析、错误提取、401 事件一处收口。
// 渐进迁移——新代码一律走这里,存量视图在改动时顺手迁移。
//
// 用法:
//   const user = await api.get("/api/me");            // 失败抛 ApiError
//   await api.post("/api/battle/team", { cardIds });  // 4xx/5xx 都抛
//   const data = await api.get("/api/x", { soft: true }); // 失败返回 null
//
// 会话过期(401)会广播 `api-unauthorized` 事件,App 层监听后引导重登。

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function broadcastUnauthorized() {
  window.dispatchEvent(new Event("api-unauthorized"));
}

async function request(method, path, body, opts = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应(如 SPA fallback 的 HTML):按空处理 */
  }
  if (!res.ok) {
    if (res.status === 401) broadcastUnauthorized();
    const err = new ApiError(res.status, json?.message || `请求失败(${res.status})`, json?.error);
    if (opts.soft) {
      console.warn(`[api] ${method} ${path} failed:`, err.message);
      return null;
    }
    throw err;
  }
  return json;
}

export const api = {
  get: (path, opts) => request("GET", path, undefined, opts),
  post: (path, body, opts) => request("POST", path, body, opts),
  put: (path, body, opts) => request("PUT", path, body, opts),
  delete: (path, opts) => request("DELETE", path, undefined, opts),
};
