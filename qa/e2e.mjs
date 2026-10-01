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

// ---- v1.2: battle flow ----
// draw down to have 3+ cards (qatest has 1-2 from earlier draws; draw 2 more)
r = await req("POST", "/api/packs/basic/draw", { body: { orderId: oid(21) } });
r = await req("POST", "/api/packs/basic/draw", { body: { orderId: oid(22) } });
let cards = [];
r = await req("GET", "/api/collection");
cards = r.json?.cards ?? [];
check("V1 收藏至少3种可编队", cards.length >= 3, `have ${cards.length}`);

// invalid team: duplicated ids (3 slots but not 3 DISTINCT pokemon)
r = await req("POST", "/api/battle/team", { body: { cardIds: [cards[0].id, cards[0].id, cards[0].id] } });
check("V2 编队重复卡 → 400", r.status === 400, r.text);
// unowned card
r = await req("POST", "/api/battle/team", { body: { cardIds: [999999, 999998, 999997] } });
check("V3 编队未拥有 → 403", r.status === 403, r.text);
// valid team
const teamIds = cards.slice(0, 3).map(c => c.id);
r = await req("POST", "/api/battle/team", { body: { cardIds: teamIds } });
check("V4 编队保存", r.json?.team?.length === 3, r.text);
// start
r = await req("POST", "/api/battle/start");
const battleId = r.json?.battleId;
check("V5 开战返回状态", Boolean(battleId) && r.json?.state?.userTeam?.length === 3, r.text);
check("V6 AI 阵容 3 只", r.json?.state?.aiTeam?.length === 3, r.text);
// resume: second start returns the same battle
r = await req("POST", "/api/battle/start");
check("V7 重复 start 复用同一战斗", r.json?.battleId === battleId && r.json?.resumed === true, r.text);
// state
r = await req("GET", `/api/battle/${battleId}/state`);
check("V8 状态快照", r.json?.state?.turn >= 1, r.text);
// play a turn (move of active mon)
const activeMoves = r.json?.state?.userTeam?.[r.json.state.activeUser]?.moves ?? [];
r = await req("POST", `/api/battle/${battleId}/turn`, { body: { action: { kind: "move", moveId: activeMoves[0]?.id } } });
check("V9 回合结算有事件", Array.isArray(r.json?.events) && r.json.events.length > 0, r.text);
check("V10 战斗仍激活或已结束", ["active","won","lost"].includes(r.json?.state?.status), r.text);
// other user cannot see this battle
r = await req("GET", `/api/battle/${battleId}/state`, { jar: "u2" });
check("V11 越权查看 → 404", r.status === 404, r.text);
// invalid action
r = await req("POST", `/api/battle/${battleId}/turn`, { body: { action: { kind: "move", moveId: "no-such" } } });
check("V12 非法招式也结算(回退普招)或 400", r.status === 400 || Array.isArray(r.json?.events), r.text);
// forfeit
r = await req("POST", `/api/battle/${battleId}/forfeit`);
check("V13 投降成功", r.json?.ok === true, r.text);
r = await req("GET", `/api/battle/${battleId}/state`);
check("V14 投降后状态 lost", r.json?.state?.status === "lost", r.text);
// battle vs unauthenticated
r = await req("POST", "/api/battle/start", { jar: "none" });
check("V15 未登录开战 401", r.status === 401, r.text);

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
