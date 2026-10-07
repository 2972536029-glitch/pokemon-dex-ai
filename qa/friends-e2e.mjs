// Friends system E2E (v2.2). Run: node qa/friends-e2e.mjs  (server must be running)
// Covers F1–F12 from docs/updates/v2.2-friends.md.
const BASE = process.env.BASE ?? "http://127.0.0.1:5178";
const SUFFIX = Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 1296).toString(36).padStart(2, "0");
const U1 = `fr1${SUFFIX}`, U2 = `fr2${SUFFIX}`, U3 = `fr3${SUFFIX}`;

let pass = 0, fail = 0;
const jars = {};
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log(`PASS | ${name}`); }
  else { fail++; console.log(`FAIL | ${name} | ${extra}`); }
}
async function req(method, path, { jar = "u1", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (jars[jar]) headers.cookie = jars[jar];
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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

async function register(user, jar) {
  const r = await req("POST", "/api/auth/register", { jar, body: { username: user, password: "test123456" } });
  check(`${jar} 注册`, r.status === 200, r.text);
  return r;
}

/** Draw until uid owns at least n DISTINCT cards; returns the distinct ids. */
async function collectDistinct(user, jar, n) {
  for (let i = 0; i < 10; i++) {
    await req("POST", "/api/packs/basic/draw", { jar, body: { orderId: `fe-${jar}-${i}-${Math.random().toString(36).slice(2, 8)}` } });
    const col = await req("GET", "/api/collection", { jar });
    const ids = (col.json?.cards ?? []).map((c) => c.id);
    if (ids.length >= n) return ids;
  }
  const col = await req("GET", "/api/collection", { jar });
  return (col.json?.cards ?? []).map((c) => c.id);
}

async function balance(jar) {
  const r = await req("GET", "/api/me", { jar });
  return r.json?.user?.balance ?? r.json?.balance ?? null;
}

async function main() {
  await register(U1, "u1");
  await register(U2, "u2");
  await register(U3, "u3");

  // ---- F11 auth/validation basics -----------------------------------------
  check("F11 未登录拉好友列表 401", (await req("GET", "/api/friends", { jar: "anon" })).status === 401);
  check("F11 自己申请自己 400", (await req("POST", "/api/friends/request", { jar: "u1", body: { username: U1 } })).status === 400);
  check("F11 申请不存在的用户 404", (await req("POST", "/api/friends/request", { jar: "u1", body: { username: "no_such_user_xx" } })).status === 404);

  // ---- F1 mutual consent ----------------------------------------------------
  let r = await req("POST", "/api/friends/request", { jar: "u1", body: { username: U2 } });
  check("F1 u1→u2 申请成功", r.status === 200 && r.json?.friends === false, r.text);
  const inbox = await req("GET", "/api/friends", { jar: "u2" });
  const reqId = inbox.json?.incoming?.[0]?.id;
  check("F1 u2 收到申请", !!reqId, inbox.text);
  check("F1 未同意前互非好友", (await req("GET", "/api/friends", { jar: "u1" })).json?.friends?.length === 0);
  check("F1 同意", (await req("POST", `/api/friends/requests/${reqId}/accept`, { jar: "u2" })).status === 200);
  const f1list = await req("GET", "/api/friends", { jar: "u1" });
  check("F1 同意后互为好友", f1list.json?.friends?.some((f) => f.username === U2));
  r = await req("POST", "/api/friends/request", { jar: "u1", body: { username: U3 } });
  const inbox3 = await req("GET", "/api/friends", { jar: "u3" });
  await req("POST", `/api/friends/requests/${inbox3.json?.incoming?.[0]?.id}/decline`, { jar: "u3" });
  check("F1 拒绝后非好友", (await req("GET", "/api/friends", { jar: "u1" })).json?.friends?.every((f) => f.username !== U3));

  // ---- F2 auto-accept + duplicates ------------------------------------------
  await req("POST", "/api/friends/request", { jar: "u1", body: { username: U3 } });
  r = await req("POST", "/api/friends/request", { jar: "u3", body: { username: U1 } });
  check("F2 互发自动通过", r.json?.friends === true, r.text);
  check("F2 已是好友再申请 409", (await req("POST", "/api/friends/request", { jar: "u1", body: { username: U3 } })).status === 409);
  check("F2 重复 pending 409", await (async () => {
    // u1 and u2 are friends; use a fresh pair: u2→u3 then u2→u3 again
    await req("POST", "/api/friends/request", { jar: "u2", body: { username: U3 } });
    return (await req("POST", "/api/friends/request", { jar: "u2", body: { username: U3 } })).status === 409;
  })());

  // ---- cards for trades/battles ---------------------------------------------
  const u1cards = await collectDistinct(U1, "u1", 4);
  const u2cards = await collectDistinct(U2, "u2", 4);
  check("u1 收藏≥3 种", u1cards.length >= 3, `got ${u1cards.length}`);
  check("u2 收藏≥3 种", u2cards.length >= 3, `got ${u2cards.length}`);
  const col1 = await req("GET", "/api/collection", { jar: "u1" });
  const cardDetail = (id) => (col1.json?.cards ?? []).find((c) => c.id === id);
  // a duplicate (count>=2) if any, else just use a card NOT in u1's team
  const dup = (col1.json?.cards ?? []).find((c) => c.count >= 2);

  // ---- F5 last-copy-in-team protection --------------------------------------
  const teamIds = u1cards.slice(0, 3);
  check("u1 设置编队", (await req("POST", "/api/battle/team", { jar: "u1", body: { cardIds: teamIds } })).status === 200);
  // gift a team card that is the ONLY copy → rejected
  const teamOnlyCard = teamIds[0];
  if (!dup || dup.id !== teamOnlyCard) {
    r = await req("POST", `/api/friends/${(await req("GET", "/api/friends", { jar: "u1" })).json.friends.find((f) => f.username === U2).id}/trades`,
      { jar: "u1", body: { kind: "gift", cardId: teamOnlyCard } });
    // u1 owns it once (count 1) and it is in the team → must be rejected
    check("F5 编队中唯一一张不可赠", r.status === 409, r.text);
  }
  if (dup) {
    const f2id = (await req("GET", "/api/friends", { jar: "u1" })).json.friends.find((f) => f.username === U2).id;
    r = await req("POST", `/api/friends/${f2id}/trades`, { jar: "u1", body: { kind: "gift", cardId: dup.id } });
    check("F5 重复卡可赠", r.status === 200, r.text);
  }

  // ---- F4 gift flow (use a non-team card if no dup; else the dup set above) --
  const f2id = (await req("GET", "/api/friends", { jar: "u1" })).json.friends.find((f) => f.username === U2).id;
  const spare = dup ? dup.id : u1cards[3];
  if (!(dup && (await req("GET", "/api/friends/trades", { jar: "u2" })).json.incoming?.length)) {
    r = await req("POST", `/api/friends/${f2id}/trades`, { jar: "u1", body: { kind: "gift", cardId: spare } });
    check("F4 赠送发起", r.status === 200, r.text);
  }
  const giftIn = (await req("GET", "/api/friends/trades", { jar: "u2" })).json.incoming?.find((t) => t.kind === 1);
  check("F4 u2 收到赠送请求", !!giftIn, "no incoming");
  const before1 = (await req("GET", "/api/collection", { jar: "u1" })).json.cards;
  r = await req("POST", `/api/trades/${giftIn.id}/accept`, { jar: "u2" });
  check("F4 接受赠送", r.status === 200, r.text);
  const after1 = (await req("GET", "/api/collection", { jar: "u1" })).json.cards;
  const after2 = (await req("GET", "/api/collection", { jar: "u2" })).json.cards;
  const giver = after1.find((c) => c.id === giftIn.card_id);
  const got = after2.find((c) => c.id === giftIn.card_id);
  check("F4 发送方份数-1", (giver?.count ?? 0) === ((before1.find((c) => c.id === giftIn.card_id)?.count ?? 0) - 1), JSON.stringify({ giver }));
  check("F4 接收方获得该卡", (got?.count ?? 0) >= 1);

  // ---- F6 ask flow -----------------------------------------------------------
  const askCard = after2.find((c) => c.id === giftIn.card_id)?.id ?? u2cards[0];
  r = await req("POST", `/api/friends/${f2id}/trades`, { jar: "u1", body: { kind: "ask", cardId: askCard } });
  check("F6 索要发起(u1 向 u2 要)", r.status === 200, r.text);
  const askIn = (await req("GET", "/api/friends/trades", { jar: "u2" })).json.incoming?.find((t) => t.kind === 2);
  check("F6 u2 收到索要", !!askIn);
  r = await req("POST", `/api/trades/${askIn.id}/accept`, { jar: "u2" });
  check("F6 接受索要", r.status === 200, r.text);
  check("F6 交割方向正确(u1 拿到)", ((await req("GET", "/api/collection", { jar: "u1" })).json.cards.find((c) => c.id === askCard)?.count ?? 0) >= 1);

  // ---- F10 idempotency --------------------------------------------------------
  const g2card = (after1.find((c) => c.count >= 2) ?? after1.find((c) => !teamIds.includes(c.id)))?.id;
  if (g2card) {
    await req("POST", `/api/friends/${f2id}/trades`, { jar: "u1", body: { kind: "gift", cardId: g2card } });
    const t2 = (await req("GET", "/api/friends/trades", { jar: "u2" })).json.incoming?.[0];
    await req("POST", `/api/trades/${t2.id}/accept`, { jar: "u2" });
    r = await req("POST", `/api/trades/${t2.id}/accept`, { jar: "u2" });
    check("F10 重复接受 409", r.status === 409, r.text);
  }

  // ---- F3 unfriend + pending cleanup -----------------------------------------
  // u1↔u3 are friends (F2). u1 sends u3 a gift, then u1 deletes u3.
  const f3id = (await req("GET", "/api/friends", { jar: "u1" })).json.friends.find((f) => f.username === U3).id;
  const spare3 = after1.find((c) => !teamIds.includes(c.id))?.id ?? after1[after1.length - 1].id;
  await req("POST", `/api/friends/${f3id}/trades`, { jar: "u1", body: { kind: "gift", cardId: spare3 } });
  check("F3 删除好友", (await req("DELETE", `/api/friends/${f3id}`, { jar: "u1" })).status === 200);
  check("F3 删除后列表消失", (await req("GET", "/api/friends", { jar: "u1" })).json.friends.every((f) => f.username !== U3));
  check("F3 对方也消失", (await req("GET", "/api/friends", { jar: "u3" })).json.friends.every((f) => f.username !== U1));
  const u3trades = (await req("GET", "/api/friends/trades", { jar: "u3" })).json.incoming ?? [];
  check("F3 挂起 trade 已拒绝", u3trades.length === 0, JSON.stringify(u3trades.length));

  // ---- F7 non-friend blocked ---------------------------------------------------
  check("F7 非好友交易 403", (await req("POST", `/api/friends/${f3id}/trades`, { jar: "u1", body: { kind: "gift", cardId: spare3 } })).status === 403);

  // ---- F9 unowned cards rejected ------------------------------------------------
  check("F9 挑战含未持有卡 403", (await req("POST", `/api/friends/${f2id}/challenge`, { jar: "u1", body: { cardIds: [999999, 999998, 999997] } })).status === 403);

  // ---- F8 friend battle ----------------------------------------------------------
  const b1 = await req("POST", `/api/friends/${f2id}/challenge`, { jar: "u1", body: { cardIds: teamIds } });
  check("F8 下战书", b1.status === 200, b1.text);
  const bins = (await req("GET", "/api/friends/battles", { jar: "u2" })).json.incoming ?? [];
  const bid = bins[0]?.id;
  check("F8 u2 收到战书", !!bid);
  const bal2a = await balance("u2");
  const bal1a = await balance("u1");
  r = await req("POST", `/api/friend-battles/${bid}/accept`, { jar: "u2", body: { cardIds: u2cards.slice(0, 3) } });
  check("F8 应战模拟完成", r.status === 200 && Array.isArray(r.json?.log) && r.json.log.length > 0, r.text.slice(0, 200));
  const bal1b = await balance("u1"), bal2b = await balance("u2");
  const d1 = bal1b - bal1a, d2 = bal2b - bal2a;
  const payout = new Set([d1, d2].filter((x) => x > 0).sort((a, b) => b - a));
  check("F8 奖励为 100/20 或平 50", payout.size === 0 || (payout.has(100) && payout.has(20)) || (payout.size === 1 && payout.has(50)), `d1=${d1} d2=${d2}`);
  check("F8 winnerUid 与 winner 视角一致",
    (r.json.winner === null) === (r.json.winnerUid === null) &&
    (r.json.winner !== "challenger" || r.json.draw === false), r.text.slice(0, 120));
  const report = await req("GET", `/api/friend-battles/${bid}`, { jar: "u1" });
  check("F8 战报双方可查", report.status === 200 && !!report.json.battle?.battle_log);
  const reportDenied = await req("GET", `/api/friend-battles/${bid}`, { jar: "u3" });
  check("F8 无关者看不了战报 403", reportDenied.status === 403);

  // F10 for battles: second accept of the same battle → 409
  r = await req("POST", `/api/friend-battles/${bid}/accept`, { jar: "u2", body: { cardIds: u2cards.slice(0, 3) } });
  check("F10 重复应战 409", r.status === 409, r.text);

  // ---- F8 daily reward cap ---------------------------------------------------------
  let capped = false;
  let prev1 = bal1b, prev2 = bal2b;
  for (let i = 0; i < 14 && !capped; i++) {
    const ch = await req("POST", `/api/friends/${f2id}/challenge`, { jar: "u1", body: { cardIds: teamIds } });
    if (ch.status !== 200) break;
    const bId = (await req("GET", "/api/friends/battles", { jar: "u2" })).json.incoming?.[0]?.id;
    const acc = await req("POST", `/api/friend-battles/${bId}/accept`, { jar: "u2", body: { cardIds: u2cards.slice(0, 3) } });
    if (acc.status !== 200) break;
    const x1 = await balance("u1"), x2 = await balance("u2");
    // 逐场边际差:这一场的净入账(相对上一场,而非相对基线——累计差永远非零)
    const marg = new Set([x1 - prev1, x2 - prev2].filter((v) => v !== 0));
    if (i >= 10 && marg.size === 0) capped = true;
    prev1 = x1;
    prev2 = x2;
  }
  check("F8 每日奖励 10 场封顶", capped, "11th+ battle still paid");

  console.log(`\n=== FRIENDS E2E: PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
