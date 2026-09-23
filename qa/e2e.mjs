// Phase 1 runtime E2E suite. Run: node qa/e2e.mjs  (server must be running)
// Self-suffixing usernames → repeatable on a persistent DB.
const BASE = process.env.BASE ?? "http://127.0.0.1:5178";
const SUFFIX = Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 1296).toString(36).padStart(2, "0");
const U1 = `qatest1${SUFFIX}`;
const U2 = `qatest2${SUFFIX}`;

let pass = 0;
let fail = 0;
const jars = { u1: "", u2: "" };

async function req(method, path, { jar = "u1", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (jars[jar]) headers.cookie = jars[jar];
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    const v = setCookie.split(";")[0];
    if (v.startsWith("dex_session=") && v.length > 20) jars[jar] = v;
  }
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
    console.log(`FAIL | ${name} | ${String(detail).slice(0, 160)}`);
  }
}

// ---- A/B: auth ----
let r = await req("POST", "/api/auth/register", { body: { username: U1, password: "qa123456" } });
check("B2 注册送300", r.json?.user?.balance === 300, r.text);
r = await req("POST", "/api/wallet/daily");
check("C1 每日+50首次", r.json?.granted === true && r.json?.balance === 350, r.text);
r = await req("POST", "/api/wallet/daily");
check("C1 每日重复不加", r.json?.granted === false && r.json?.balance === 350, r.text);
r = await req("GET", "/api/me");
check("B7 会话有效", r.json?.user?.username === U1, r.text);
r = await req("GET", "/api/packs");
check("D1 卡包概率公示", Array.isArray(r.json?.packs) && r.json.packs.length === 3, r.text);

// ---- D: gacha ----
const oid = (n) => `${SUFFIX}-order-${n}`;
r = await req("POST", "/api/packs/basic/draw", { body: { orderId: oid(1) } });
const firstCard = r.json?.card;
check("D2 抽卡成功", r.json?.replay === false && Boolean(firstCard), r.text);
r = await req("POST", "/api/packs/basic/draw", { body: { orderId: oid(1) } });
check("D3 重放同卡", r.json?.card?.id === firstCard?.id && r.json?.replay === true, r.text);
r = await req("POST", "/api/packs/nope/draw", { body: { orderId: oid(9) } });
check("D6 不存在卡包404", r.status === 404, r.text);
r = await req("POST", "/api/packs/basic/draw", { body: { orderId: "short" } });
check("D5 非法orderId 400", r.status === 400 && r.text.includes("invalid order id"), r.text);
r = await req("GET", "/api/collection");
check("E 收藏含已抽卡", (r.json?.cards ?? []).some((c) => c.id === firstCard?.id), r.text);

// ---- D4: draw legend packs until insufficient ----
let saw402 = false;
for (let i = 10; i < 40; i++) {
  r = await req("POST", "/api/packs/legend/draw", { body: { orderId: oid(i) } });
  if (r.status === 402) {
    saw402 = true;
    break;
  }
}
check("D4 余额不足402", saw402 && r.json?.message?.includes("货币不足"), r.text);
r = await req("GET", "/api/wallet/tx");
check("C2 流水", Array.isArray(r.json?.transactions) && r.json.transactions.length > 0, r.text);

// ---- E1: cross-user isolation ----
r = await req("POST", "/api/auth/register", { jar: "u2", body: { username: U2, password: "qa123456" } });
check("B 注册第二用户", r.json?.user?.balance === 300, r.text);
r = await req("GET", "/api/collection", { jar: "u2" });
check("E1 跨用户隔离", Array.isArray(r.json?.cards) && r.json.cards.length === 0, r.text);

// ---- B5/B7/A4: failures ----
r = await req("POST", "/api/auth/login", { body: { username: U1, password: "wrong-pass" } });
check("B5 错误密码统一话术", r.status === 401 && r.json?.message === "用户名或密码错误", r.text);
r = await req("POST", "/api/packs/basic/draw", { jar: "none", body: { orderId: oid(99) } });
check("A4 未登录401", r.status === 401, r.text);
r = await req("GET", "/api/me", { jar: "none" });
check("B7 无cookie me为null", r.json?.user === null, r.text);
r = await req("POST", "/api/auth/register", { body: { username: "x", password: "1" } });
check("B1 非法用户名400", r.status === 400 && r.text.includes("3-20 位"), r.text);

console.log(`\n=== SUMMARY: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail > 0 ? 1 : 0);
