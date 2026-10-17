// v2.4 可观测性 E2E:telemetry 批量采集、feedback 20h upsert、metrics 聚合、
// 管理员准入(401/403/200 三态)。Run: node qa/telemetry-e2e.mjs
// 前置:本地 Postgres(docker compose up -d)+ server(npm run dev:ai)。
// 自 suffix 用户名 → 可在持久库上重复执行。
import { execSync } from "node:child_process";

const BASE = process.env.BASE ?? "http://127.0.0.1:5178";
const SUFFIX = Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 1296).toString(36).padStart(2, "0");
const U1 = `qatelem${SUFFIX}`;

let pass = 0;
let fail = 0;
let jar = "";

async function req(method, path, { body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth && jar) headers.cookie = jar;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    const v = setCookie.split(";")[0];
    if (v.startsWith("dex_session=") && v.length > 20) jar = v;
  }
  // 假绿防线(历史教训):SPA fallback 会把未知端点包成 200 HTML,
  // 一律先 text 后 JSON,断言前确保拿到的是 JSON。
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`PASS | ${name}`);
  } else {
    fail++;
    console.log(`FAIL | ${name} | ${String(detail).slice(0, 200)}`);
  }
}

const ids = { anonId: `anon-${SUFFIX}-aaaa`, sessionId: `sess-${SUFFIX}-bbbb` };
const ev = (type, name, value, meta) => ({ type, name, value, meta });

// ---- A: 采集端点 ----
let r = await req("POST", "/api/telemetry", {
  body: {
    ...ids,
    events: [
      ev("webvital", "LCP", 1234, { rating: "good" }),
      ev("usage", "pull_ten", undefined, { pack: "basic", count: 10 }),
      ev("pageview", "#/packs"),
      ev("jserror", "TypeError: qa intentionally broken", undefined, { stack: "Error: x\n  at qa" }),
    ],
  },
});
check("T1 匿名批量上报 204", r.status === 204, r.text);

r = await req("POST", "/api/telemetry", { body: { ...ids, events: [] } });
check("T2 空 events 400", r.status === 400, r.text);

r = await req("POST", "/api/telemetry", {
  body: { ...ids, events: Array.from({ length: 26 }, () => ev("pageview", "#/home")) },
});
check("T3 超 25 条 400", r.status === 400, r.text);

r = await req("POST", "/api/telemetry", { body: { ...ids, events: [ev("hack", "x")] } });
check("T4 未知类型 400", r.status === 400, r.text);

r = await req("POST", "/api/telemetry", { body: { ...ids, events: [ev("webvital", "LCP", "abc")] } });
check("T5 非数值 value 400", r.status === 400, r.text);

r = await req("POST", "/api/telemetry", { body: { ...ids, anonId: "bad id with space!", events: [ev("pageview", "#/home")] } });
// 设计契约:脏 anonId 消毒降级为匿名(事件不丢),只有结构性错误才 400——
// 采集端点对元数据脏值宽容、对载荷非法严格,是 ingest 类端点的工业惯例
check("T6 非法 anonId 消毒为匿名仍 204", r.status === 204, r.text);

// ---- B: 反馈 upsert ----
r = await req("POST", "/api/feedback", { body: { context: "battle", score: 5, comment: "打的爽", ...ids } });
check("F1 首次反馈 inserted", r.json?.ok === true && r.json?.updated === false, r.text);

r = await req("POST", "/api/feedback", { body: { context: "battle", score: 2, comment: "其实一般", ...ids } });
check("F2 20h 内改口 upsert", r.json?.ok === true && r.json?.updated === true, r.text);

r = await req("POST", "/api/feedback", { body: { context: "pack_open", score: 4, ...ids } });
check("F3 不同场景独立", r.json?.ok === true && r.json?.updated === false, r.text);

r = await req("POST", "/api/feedback", { body: { context: "battle", score: 9, ...ids } });
check("F4 越界评分 400", r.status === 400, r.text);

r = await req("POST", "/api/feedback", { body: { context: "nope", score: 3, ...ids } });
check("F5 未知场景 400", r.status === 400, r.text);

// ---- C: 登录用户上报(身份归因) ----
r = await req("POST", "/api/auth/register", { body: { username: U1, password: "qa123456" } });
check("C1 注册成功", r.json?.user?.balance === 300, r.text);

r = await req("POST", "/api/telemetry", {
  auth: true,
  body: { ...ids, events: [ev("usage", "battle_win"), ev("webvital", "INP", 88, { rating: "good" })] },
});
check("C2 登录态上报 204", r.status === 204, r.text);

// ---- D: 看板准入三态 ----
r = await req("GET", "/api/metrics/overview?days=7");
check("D1 匿名 401", r.status === 401, r.text);

r = await req("GET", "/api/metrics/overview?days=7", { auth: true });
check("D2 非管理员 403", r.status === 403 && r.json?.error === "forbidden", r.text);

// SQL 升管理员(仅本地 Docker;生产走 schema 内的 123456 回填)
try {
  execSync(
    `docker compose exec -T db psql -U dex -d pokemon_dex -c "UPDATE users SET is_admin = true WHERE username = '${U1}'"`,
    { stdio: "pipe" }
  );
} catch (e) {
  console.log("SKIP | D3 前置:docker psql 不可用,后续看板断言无法执行");
  console.log(`\n${pass} passed, ${fail} failed (skipped dashboard section)`);
  process.exit(fail > 0 ? 1 : 0);
}

r = await req("GET", "/api/metrics/overview?days=7", { auth: true });
check("D3 管理员 200", r.status === 200, r.text);

const ov = r.json;
check("D4 响应是 JSON 聚合(非 SPA fallback)", ov && typeof ov === "object" && Array.isArray(ov.api?.daily), r.text.slice(0, 120));
check("D5 API 日报有数据(计时中间件生效)", ov.api.daily.length >= 1 && ov.api.total >= 1, JSON.stringify(ov.api.daily));
check("D6 端点聚合含 telemetry 之外的真实路由", Array.isArray(ov.api.endpoints) && ov.api.endpoints.some((e) => String(e.endpoint).startsWith("/api/")), JSON.stringify(ov.api.endpoints));
check("D7 vitals 含 LCP", (ov.vitals ?? []).some((v) => v.name === "LCP" && Number(v.samples) >= 1), JSON.stringify(ov.vitals));
check("D8 usage 含 pull_ten 与 battle_win", (ov.usage ?? []).some((u) => u.action === "pull_ten") && (ov.usage ?? []).some((u) => u.action === "battle_win"), JSON.stringify(ov.usage));
check("D9 jserror 进错误 Top", (ov.errors.top ?? []).some((e) => e.message.includes("qa intentionally broken")), JSON.stringify(ov.errors.top));
check("D10 crash-free 口径字段存在", typeof ov.errors.sessionsTotal === "number" && typeof ov.errors.sessionsErrored === "number", JSON.stringify(ov.errors));
// 聚合是 7 天窗口、库是持久库(套件可重复执行),绝对计数会被历史 run 抬高——
// 只做结构性断言;本轮 upsert 的正确性由 F1/F2 的 updated 标志 + D12 首条边际证明
const distSum = Object.values(ov.feedback.dist ?? {}).reduce((s, n) => s + Number(n), 0);
check(
  "D11 反馈聚合结构自洽(计数=分布和,均分∈[1,5])",
  ov.feedback.responses >= 2 &&
    distSum === ov.feedback.responses &&
    Number(ov.feedback.avg) >= 1 &&
    Number(ov.feedback.avg) <= 5,
  JSON.stringify(ov.feedback)
);
const top = ov.feedback.recent?.[0];
check(
  "D12 本轮改口在 recent 首条(battle→2 分)",
  top?.context === "battle" && Number(top?.score) === 2 && top?.comment === "其实一般",
  JSON.stringify(ov.feedback.recent)
);
check("D13 DAU ≥ 1", (ov.audience.daily ?? []).some((d) => Number(d.dau) >= 1), JSON.stringify(ov.audience.daily));
check("D14 注册计数 ≥ 1", Number(ov.audience.registrations) >= 1, ov.audience.registrations);

r = await req("GET", "/api/metrics/overview?days=30", { auth: true });
check("D15 days=30 合法", r.status === 200 && r.json?.days === 30, r.text.slice(0, 120));

r = await req("GET", "/api/metrics/overview?days=hack", { auth: true });
check("D16 非法 days 回退 7", r.status === 200 && r.json?.days === 7, r.text.slice(0, 120));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
