// v2.5 可观测性 E2E:telemetry 批量采集、feedback 20h upsert、每日指标推送
// 端点(/api/metrics/flush)鉴权与聚合。Run: node qa/telemetry-e2e.mjs
// 前置:本地 Postgres(docker compose up -d)+ server(npm run dev:ai)。
// 自 suffix 用户名 → 可在持久库上重复执行。

const BASE = process.env.BASE ?? "http://127.0.0.1:5178";
const SUFFIX = Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 1296).toString(36).padStart(2, "0");
const U1 = `qatelem${SUFFIX}`;

let pass = 0;
let fail = 0;
let jar = "";

async function req(method, path, { body, auth = false, headers: extra = {} } = {}) {
  const headers = { ...extra };
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
// ---- D: 每日指标推送端点(Vercel Cron 调用面) ----
r = await req("GET", "/api/metrics/flush");
check("D1 无钥匙 403", r.status === 403, r.text);

r = await req("GET", "/api/metrics/flush", { headers: { authorization: "Bearer wrong-secret" } });
check("D2 错误 Bearer 403", r.status === 403, r.text);

// 本地无 CRON_SECRET:回落 x-seed-key(与 /api/admin/seed 同款运维钥匙)
const fs = await import("node:fs");
let seedKey = "";
try {
  const envText = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^GLM_API_KEY=(.+?)\s*$/);
    if (m) seedKey = m[1];
  }
} catch {}

if (!seedKey) {
  console.log("SKIP | D3+ 本地无 GLM_API_KEY,flush 聚合断言无法执行");
} else {
  r = await req("GET", "/api/metrics/flush", { headers: { "x-seed-key": seedKey } });
  check("D3 钥匙通过 200", r.status === 200, r.text.slice(0, 200));
  const fl = r.json;
  const byName = Object.fromEntries((fl.metrics ?? []).map((m) => [m.metric, m.value]));
  check("D4 响应是 JSON 聚合(非 SPA fallback)", Boolean(fl) && Array.isArray(fl.metrics) && fl.window === "24h", r.text.slice(0, 120));
  check("D5 核心指标齐全", ["pokemon.dau", "pokemon.api.requests", "pokemon.api.errors", "pokemon.api.p95_ms", "pokemon.feedback.avg_score", "pokemon.feedback.count"].every((k) => k in byName), JSON.stringify(byName));
  check("D6 业务指标齐全(pull_ten/battle_win)", "pokemon.usage.pull_ten" in byName && "pokemon.usage.battle_win" in byName, JSON.stringify(byName));
  check("D7 API 请求 ≥ 1(计时中间件生效)", Number(byName["pokemon.api.requests"]) >= 1, byName["pokemon.api.requests"]);
  check("D8 反馈均分 ∈ [1,5] 且条数 ≥ 2", Number(byName["pokemon.feedback.avg_score"]) >= 1 && Number(byName["pokemon.feedback.avg_score"]) <= 5 && Number(byName["pokemon.feedback.count"]) >= 2, JSON.stringify(byName));
  check("D9 DAU ≥ 1", Number(byName["pokemon.dau"]) >= 1, byName["pokemon.dau"]);
  check("D10 Datadog 推送结果为布尔(本地缺 key 应 false)", typeof fl.dd?.pushed === "boolean", JSON.stringify(fl.dd));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
