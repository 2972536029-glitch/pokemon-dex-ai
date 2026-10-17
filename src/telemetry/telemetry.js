// 自建 RUM 上报客户端(v2.4):零依赖、批量、Beacon 兜底。
//
// 为什么不用第三方统计:SaaS 需要注册账号且数据出站;这里需要的信号
// (web-vitals / JS 错误 / 行为埋点 / 页面浏览)一张自建事件表就能承载,
// 采样与字段完全自主。设计约束:
// - 观测永不影响业务:所有失败静默;队列有背压上限,内存不随事件增长。
// - 不阻塞主线程:10s 定时批量 flush;页面隐藏/关闭走 sendBeacon,
//   失败不回捞(beacon 排队失败时页面通常已在卸载,回捞没有意义)。
// - 错误上报双保险限流:单会话最多 10 条 + 同签名 10s 去重,防止
//   持续性异常把队列和遥测表打爆(自体攻击防线)。

const ENDPOINT = "/api/telemetry";
const QUEUE_LIMIT = 20;
const FLUSH_INTERVAL_MS = 10_000;
const MAX_ERROR_REPORTS_PER_SESSION = 10;

function uuid() {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  } catch {
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function readId(storage, key) {
  try {
    let id = storage.getItem(key);
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = uuid();
      storage.setItem(key, id);
    }
    return id;
  } catch {
    return uuid(); // localStorage 被禁用(隐私模式):退化为纯内存 id
  }
}

// 匿名设备 id(跨会话)+ 标签页会话 id(每次开标签刷新)。都是随机串,零 PII。
const anonId = readId(localStorage, "rum_anon");
const sessionId = readId(sessionStorage, "rum_sid");

export function telemetryIds() {
  return { anonId, sessionId };
}

const queue = [];
let errorReports = 0;
let lastErrorSig = "";
let lastErrorAt = 0;

function track(type, name, value, meta) {
  if (queue.length >= QUEUE_LIMIT) queue.shift(); // 背压:丢最旧,保内存上限
  queue.push({
    type,
    name: String(name ?? "").slice(0, 60),
    value: typeof value === "number" && Number.isFinite(value) ? value : undefined,
    meta,
    path: (window.location.hash || "#/home").slice(0, 120),
  });
}

/** 功能埋点:pull_ten / battle_win / chat_send / wiki_view … */
export function trackAction(name, meta) {
  track("usage", name, undefined, meta);
}

function reportError(message, err) {
  if (errorReports >= MAX_ERROR_REPORTS_PER_SESSION) return;
  const now = Date.now();
  if (message === lastErrorSig && now - lastErrorAt < 10_000) return;
  lastErrorSig = message;
  lastErrorAt = now;
  errorReports++;
  track("jserror", message ?? "unknown", undefined, {
    stack: String(err?.stack ?? "").slice(0, 700),
  });
}

let flushing = false;
async function flush(useBeacon = false) {
  if (flushing || queue.length === 0) return;
  const events = queue.splice(0, QUEUE_LIMIT);
  const payload = JSON.stringify({
    anonId,
    sessionId,
    href: window.location.href.slice(0, 200),
    events,
  });
  flushing = true;
  try {
    if (useBeacon && typeof navigator.sendBeacon === "function") {
      if (navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: "application/json" }))) return;
      // beacon 排队失败 → 落回 fetch keepalive,尽最后一点努力
    }
    await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true,
    });
  } catch {
    /* 遥测失败静默:观测层的任何问题都不能打扰用户 */
  } finally {
    flushing = false;
  }
}

let inited = false;

/** 安装全局采集。幂等(StrictMode 双跑安全),在 main.jsx 的 render 前调用。 */
export function initTelemetry() {
  if (inited) return;
  inited = true;

  // 页面浏览:hash 路由切换即 PV
  const pv = () => track("pageview", window.location.hash || "#/home");
  pv();
  window.addEventListener("hashchange", pv);

  // JS 错误:同步异常 + 未处理的 Promise 拒绝
  window.addEventListener("error", (e) => reportError(e.message, e.error));
  window.addEventListener("unhandledrejection", (e) =>
    reportError(e.reason?.message ?? String(e.reason), e.reason)
  );

  // web-vitals 动态 import:独立 chunk,不进首包(主包体积纪律)
  import("web-vitals").then(({ onLCP, onINP, onCLS, onFCP, onTTFB }) => {
    const report = (m) => track("webvital", m.name, Math.round(m.value), { rating: m.rating });
    onLCP(report);
    onINP(report);
    onCLS(report);
    onFCP(report);
    onTTFB(report);
  });

  setInterval(flush, FLUSH_INTERVAL_MS);
  window.addEventListener("pagehide", () => flush(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
  });
}
