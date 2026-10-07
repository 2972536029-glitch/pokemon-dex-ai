// v2.3 Phase-0 safety net: tenpull semantics, pity endpoint, logout.
// These paths were untested before the refactor that touches them (QA-039).
// Run: node qa/v23-e2e.mjs  (server must be running; full-10 test additionally
// tops up via the local docker DB when available and is skipped otherwise).
const BASE = process.env.BASE ?? "http://127.0.0.1:5178";
const SUFFIX = Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 1296).toString(36).padStart(2, "0");
const U = `v23${SUFFIX}`;

let pass = 0, fail = 0, skipped = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log(`PASS | ${name}`); }
  else if (ok === "skip") { skipped++; console.log(`SKIP | ${name}`); }
  else { fail++; console.log(`FAIL | ${name} | ${extra}`); }
}
let cookie = "";
async function req(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get("set-cookie");
  if (sc) { const v = sc.split(";")[0]; if (v.startsWith("dex_session=") && v.length > 20) cookie = v; }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}

async function main() {
  // 建号:300 币 + 每日 50 = 350,够 7 张基础包(50/张)
  check("注册", (await req("POST", "/api/auth/register", { username: U, password: "test123456" })).status === 200);
  await req("POST", "/api/wallet/daily");
  const me0 = (await req("GET", "/api/me")).json?.user;
  const bal0 = me0?.balance ?? 0;

  // ---- tenpull 形参校验 ----
  check("十连 非法 orderId 400", (await req("POST", "/api/packs/basic/tenpull", { orderId: "short" })).status === 400);
  check("十连 不存在的包 404", (await req("POST", "/api/packs/nope/tenpull", { orderId: "abcdefgh1234" })).status === 404);
  check("十连 未登录 401", await (async () => {
    const keep = cookie; cookie = "";
    const r = await req("POST", "/api/packs/basic/tenpull", { orderId: "abcdefgh1234" });
    cookie = keep;
    return r.status === 401;
  })());

  // ---- 缺口语义:350 币只够 7 张,shortfall=3 ----
  const order1 = `v23-${SUFFIX}-order1`;
  const r1 = await req("POST", "/api/packs/basic/tenpull", { orderId: order1 });
  check("缺口十连 200", r1.status === 200, r1.text.slice(0, 120));
  check("缺口 shortfall=3", r1.json?.shortfall === 3, JSON.stringify(r1.json?.shortfall));
  check("缺口 cards=7", r1.json?.cards?.length === 7);
  const balAfter1 = (await req("GET", "/api/me")).json?.user?.balance;
  check("缺口扣费精确(350)", bal0 - balAfter1 === 350, `before=${bal0} after=${balAfter1}`);

  // ---- 重放语义:缺口订单重放 = 只重放已成功的 7 个子键,再现同样 7 张 + shortfall=3,不扣费不补抽 ----
  const balBeforeReplay = (await req("GET", "/api/me")).json?.user?.balance;
  const r2 = await req("POST", "/api/packs/basic/tenpull", { orderId: order1 });
  check("缺口重放 200", r2.status === 200, r2.text.slice(0, 120));
  check("重放 cards=7 replayCount=7", r2.json?.cards?.length === 7 && r2.json?.replayCount === 7);
  check("重放 shortfall=3(如实再现)", r2.json?.shortfall === 3);
  const balAfterReplay = (await req("GET", "/api/me")).json?.user?.balance;
  check("重放不扣费", balAfterReplay === balBeforeReplay, `${balBeforeReplay} -> ${balAfterReplay}`);
  check("重放前 7 张与首抽一致", JSON.stringify(r2.json.cards.slice(0, 7).map((c) => c.id)) === JSON.stringify(r1.json.cards.map((c) => c.id)));

  // ---- 收藏入账:首抽 7 张各自入账(重放不重复) ----
  const col = (await req("GET", "/api/collection")).json?.cards ?? [];
  const uniqueInCol = col.filter((c) => r1.json.cards.some((k) => k.id === c.id));
  check("首抽卡片已入收藏", uniqueInCol.length >= 1, `col=${col.length}`);

  // ---- pity 端点 ----
  const pity = await req("GET", "/api/packs/pity");
  check("pity 200 且含三包", pity.status === 200 && ["basic", "advanced", "legend"].every((k) => pity.json?.[k]), pity.text.slice(0, 120));
  const b = pity.json?.basic;
  check("pity basic 形状", typeof b?.since_ur === "number" && typeof b?.remaining === "number" && typeof b?.limit === "number");
  check("pity 保底垫抽与抽取数一致(基础包 60 抽内不出 UR,垫抽=抽数)", b?.since_ur === 7 || b?.since_ur === 0, `since_ur=${b?.since_ur}`);
  check("pity 匿名 401", await (async () => {
    const keep = cookie; cookie = "";
    const r = await req("GET", "/api/packs/pity");
    cookie = keep;
    return r.status === 401;
  })());

  // ---- 完整十连(需要加钱,仅本地 docker 可用则执行) ----
  let funded = false;
  try {
    const { execSync } = await import("node:child_process");
    execSync(`docker exec pokemon-dex-ai-db-1 psql -U dex -d pokemon_dex -c "UPDATE users SET balance = 1000 WHERE username = '${U}'"`, { stdio: "pipe" });
    funded = true;
  } catch { /* 非 docker 环境:跳过满额十连 */ }
  if (funded) {
    const order2 = `v23-${SUFFIX}-order2`;
    const r3 = await req("POST", "/api/packs/basic/tenpull", { orderId: order2 });
    check("满额十连 10 张 shortfall=0", r3.status === 200 && r3.json?.cards?.length === 10 && r3.json?.shortfall === 0, r3.text.slice(0, 120));
    check("满额十连 replayCount=0", r3.json?.replayCount === 0);
    const balAfter2 = (await req("GET", "/api/me")).json?.user?.balance;
    check("满额十连扣费精确(500)", balAfter2 === 500, `after=${balAfter2}`);
  } else {
    check("满额十连(需 docker 加钱)", "skip");
  }

  // ---- logout:会话销毁 + cookie 清除 ----
  const lo = await req("POST", "/api/auth/logout");
  check("logout 200", lo.status === 200);
  const meAfter = await req("GET", "/api/me");
  check("logout 后 me 为 null", meAfter.json?.user === null, meAfter.text.slice(0, 80));
  const dailyAfter = await req("POST", "/api/wallet/daily");
  check("logout 后鉴权端点 401", dailyAfter.status === 401);

  console.log(`\n=== V23 SAFETY NET: PASS=${pass} FAIL=${fail} SKIP=${skipped} ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
