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

// ---- E: LLM token 预算与熔断(v3.2,ROADMAP-NEXT T2)----
// 前置约定:server 以 LLM_USER_DAILY_TOKENS=20000(小值)启动(CI 与本地一致),
// 全局预算 LLM_GLOBAL_DAILY_TOKENS 保持大值——单用户压满不该误伤别人。
// E1-E3:单用户压满 → 降级(200 + notice,绝不是 500)且 notice 带 reason;
// E4:用量与熔断次数出现在 flush payload(pokemon.llm.tokens{feature:chat});
// E5-E6:全局熔断(合成行压满全局桶)→ 任何用户降级;清理合成行后恢复。

// v3.2.1(QA-045)防呆:E1 的大请求在非 mock 服务器上是 ~28k token 的真实
// 外呼,E7/E9 也有真实小外呼。以 /api/health 的 mock 标志设防——启动约定
// (MOCK_LLM=1)不能当保险,脚本自己挡在钱前面。
let health = null;
try {
  health = await (await fetch(BASE + "/api/health")).json();
} catch {}
if (health?.mock !== true) {
  console.log("SKIP | E0-E9 服务器非 mock 模式(health.mock!==true):E 段会产生真实 LLM 外呼。以 MOCK_LLM=1 重启服务器后再跑。");
} else {
  // SSE 帮手:POST /api/chat 并把事件流解析成数组(与 useChat 的手写 SSE 解析同纪律)
  async function chat(body, cookie) {
    const res = await fetch(BASE + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const events = [];
    for (const block of text.split("\n\n")) {
      const name = (block.match(/^event:\s*(.+)$/m) ?? [])[1]?.trim() ?? "message";
      const dataLine = (block.match(/^data:\s*(.+)$/m) ?? [])[1];
      if (dataLine !== undefined) {
        try { events.push({ event: name, data: JSON.parse(dataLine) }); } catch {}
      }
    }
    return { status: res.status, events, text };
  }
  const hasEvent = (r, name) => r.events.some((e) => e.event === name);
  const noticeOf = (r) => r.events.find((e) => e.event === "notice")?.data?.message ?? "";

  // 15×4000 ASCII 字符 ≈ 28k token(字符/2 口径)> 20k 上限:一发压满个人桶,
  // 第二发必被闸住。ASCII 是刻意的:3900 个汉字就是 12KB UTF-8,轻松顶爆 64KB
  // body 上限,拿不到"压满却 200"的断言点。
  const maxedMessages = [
    { role: "user", content: "皮卡丘" },
    ...Array.from({ length: 14 }, () => ({ role: "user", content: "a".repeat(4000) })),
  ];

  const U2 = `qallm${SUFFIX}`;
  r = await req("POST", "/api/auth/register", { body: { username: U2, password: "qa123456" } });
  check("E0 预算测试用户注册", Boolean(r.json?.user), r.text);

  const chat1 = await chat({ messages: maxedMessages }, jar);
  check(
    "E1 首发大请求正常完成(mock/真实皆可,usage 已入账)",
    chat1.status === 200 && hasEvent(chat1, "done") && !hasEvent(chat1, "error") && !hasEvent(chat1, "notice"),
    chat1.text.slice(0, 150)
  );

  const chat2 = await chat({ messages: maxedMessages }, jar);
  check(
    "E2 压满后降级而非 500:200 + notice 带 reason + 仍出 done",
    chat2.status === 200 && hasEvent(chat2, "notice") && hasEvent(chat2, "done") && !hasEvent(chat2, "error"),
    chat2.text.slice(0, 150)
  );
  check("E3 降级 reason 行说明额度(历史教训:降级不许哑)", /额度/.test(noticeOf(chat2)), noticeOf(chat2));

  // flush 鉴权:CI 用 CRON_SECRET;本地回落 x-seed-key(D 段已读出 seedKey)
  const cronSecret = process.env.CRON_SECRET || "";
  const flushHeaders = cronSecret
    ? { authorization: `Bearer ${cronSecret}` }
    : seedKey
      ? { "x-seed-key": seedKey }
      : null;
  if (!flushHeaders) {
    console.log("SKIP | E4 无 CRON_SECRET/GLM_API_KEY,flush 指标断言无法执行");
  } else {
    r = await req("GET", "/api/metrics/flush", { headers: flushHeaders });
    const fl = r.json;
    const llmTokens = (fl?.metrics ?? []).find(
      (m) => m.metric === "pokemon.llm.tokens" && (m.tags ?? []).includes("feature:chat")
    );
    const llmCapped = (fl?.metrics ?? []).find(
      (m) => m.metric === "pokemon.llm.capped" && (m.tags ?? []).includes("feature:chat")
    );
    check("E4 flush 暴露 pokemon.llm.tokens{feature:chat} ≥ 28000", Boolean(llmTokens) && Number(llmTokens.value) >= 28_000, JSON.stringify(fl?.metrics?.filter((m) => m.metric.startsWith("pokemon.llm"))));
    check("E5 flush 暴露 pokemon.llm.capped ≥ 1", Boolean(llmCapped) && Number(llmCapped.value) >= 1, JSON.stringify(llmCapped));
  }

  // 全局熔断:直连 DB 插入合成用量行压满全局桶(不污染任何真实用户桶)。
  // 验证用户必须是个人桶干净的新用户——否则降级可能只是个人桶触发的,
  // 证明不了全局熔断。测试必须自清理,否则全站 LLM 一直处于熔断态。
  let dbUrl = process.env.DATABASE_URL || "";
  if (!dbUrl) {
    try {
      const envText = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
      const m = envText.match(/^DATABASE_URL=(.+?)\s*$/m);
      if (m) dbUrl = m[1];
    } catch {}
  }
  if (!dbUrl) {
    console.log("SKIP | E6-E8 无 DATABASE_URL,全局熔断断言无法执行");
  } else {
    const U3 = `qallmr${SUFFIX}`;
    r = await req("POST", "/api/auth/register", { body: { username: U3, password: "qa123456" } });
    const jarU3 = jar;
    check("E6 熔断验证用户注册", Boolean(r.json?.user), r.text);

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO llm_usage (feature, ident, tokens) VALUES ('chat', 'qa-synthetic-global', 999999999)`
      );
      const capped = await chat({ messages: [{ role: "user", content: "你好" }] }, jarU3);
      check(
        "E7 全局熔断:个人桶干净的新用户同样被降级",
        capped.status === 200 && hasEvent(capped, "notice") && hasEvent(capped, "done") && !hasEvent(capped, "error"),
        capped.text.slice(0, 150)
      );
      check("E8 全局熔断的 reason 与个人额度不同", /全网/.test(noticeOf(capped)), noticeOf(capped));
    } finally {
      await client.query(`DELETE FROM llm_usage WHERE ident = 'qa-synthetic-global'`);
      await client.end();
    }

    const recovered = await chat({ messages: [{ role: "user", content: "你好" }] }, jarU3);
    check(
      "E9 清理合成行后同一用户立即恢复(无 notice,正常 done)",
      recovered.status === 200 && hasEvent(recovered, "done") && !hasEvent(recovered, "notice") && !hasEvent(recovered, "error"),
      recovered.text.slice(0, 150)
    );
  }

}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
