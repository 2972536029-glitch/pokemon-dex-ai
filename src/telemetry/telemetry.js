// 观测上报客户端(v2.5):Datadog RUM 为主,自建管线为业务数据源,双轨职责切分。
//
// 职责边界(面试可讲:自建与 SaaS 不是二选一,是各取所长):
// - Datadog RUM(env 门控,生产注入 VITE_DD_*):Web Vitals、JS 错误、视图、
//   会话级明细——平台现成的看板/告警/留存,自建没法比。
// - 自建管线(telemetry_events 表):usage 行为事件与 CSAT 反馈——这是业务
//   数据源(评语必须落库,每日 cron 从这里聚合业务 KPI 推给 Datadog)。
// - RUM 未配置(本地开发/未注入 env)时,自建管线全量兜底,行为不变。
//
// 设计约束不变:观测永不影响业务(失败静默)、队列背压上限、错误上报双保险限流。

const ENDPOINT = "/api/telemetry";
const QUEUE_LIMIT = 20;
const FLUSH_INTERVAL_MS = 10_000;
const MAX_ERROR_REPORTS_PER_SESSION = 10;

// RUM 配置全部走构建期环境变量;缺任一关键字段则整体降级为自建兜底
const RUM_CONFIG = {
  clientToken: import.meta.env?.VITE_DD_CLIENT_TOKEN,
  applicationId: import.meta.env?.VITE_DD_APPLICATION_ID,
  site: import.meta.env?.VITE_DD_SITE || "datadoghq.com",
  env: import.meta.env?.VITE_DD_ENV || "prod",
  sessionSampleRate: Number(import.meta.env?.VITE_DD_SESSION_SAMPLE_RATE ?? 100),
};
const RUM_ENABLED = Boolean(RUM_CONFIG.clientToken && RUM_CONFIG.applicationId);

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
let rumReady = false;

function ddRum() {
  return rumReady ? window.DD_RUM : null;
}

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

/** 功能埋点:双轨——RUM addAction(会话上下文)+ 自建 usage(每日 KPI 数据源) */
export function trackAction(name, meta) {
  ddRum()?.addAction(name, meta ?? {});
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

  // 视图:hash 路由。RUM 接管时用 startView(init 里已记首屏),否则自建 pageview
  const onRouteChange = () => {
    const route = window.location.hash || "#/home";
    if (RUM_ENABLED) {
      if (rumReady) ddRum()?.startView({ name: route });
    } else {
      track("pageview", route);
    }
  };
  onRouteChange();
  window.addEventListener("hashchange", onRouteChange);

  if (RUM_ENABLED) {
    // RUM 原生采集错误/LongTask/Web Vitals,自建的这三类停发(避免双份)
    import("@datadog/browser-rum").then(({ datadogRum }) => {
      datadogRum.init({
        applicationId: RUM_CONFIG.applicationId,
        clientToken: RUM_CONFIG.clientToken,
        site: RUM_CONFIG.site,
        service: "pokemon-dex-ai",
        env: RUM_CONFIG.env,
        sessionSampleRate: RUM_CONFIG.sessionSampleRate,
        sessionReplaySampleRate: 0, // 游戏站不需要回放,省会话配额
        trackLongTasks: true,
        trackUserInteractions: true,
      });
      datadogRum.startView({ name: window.location.hash || "#/home" });
      rumReady = true;
    });
  } else {
    // 自建兜底:JS 错误(同步异常 + 未处理拒绝)+ web-vitals 独立 chunk
    window.addEventListener("error", (e) => reportError(e.message, e.error));
    window.addEventListener("unhandledrejection", (e) =>
      reportError(e.reason?.message ?? String(e.reason), e.reason)
    );
    import("web-vitals").then(({ onLCP, onINP, onCLS, onFCP, onTTFB }) => {
      const report = (m) => track("webvital", m.name, Math.round(m.value), { rating: m.rating });
      onLCP(report);
      onINP(report);
      onCLS(report);
      onFCP(report);
      onTTFB(report);
    });
  }

  setInterval(flush, FLUSH_INTERVAL_MS);
  window.addEventListener("pagehide", () => flush(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
  });
}
