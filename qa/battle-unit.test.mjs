// 战斗核心纯函数表驱动单测(ROADMAP-NEXT T4)。Run: node qa/battle-unit.test.mjs
// 前置:npm run build(与 qa/battle.test.mjs 同样直 import server/dist)。
//
// 与既有 battle.test.mjs 的分工:那边是引擎回归(整回合场景端到端),
// 这边把 v3 经济系统的每一项常数钉成字面量断言——任何人改 ENERGY/V3_TIERS
// 的一个数字,这里先红,不用等 e2e 间接暴露。零 DB、零 mock。
import test from "node:test";
import assert from "node:assert/strict";
import {
  battleMonFromCard, resolveBattleTurn, effectiveness, seededRng, ENERGY,
} from "../server/dist/battle.js";

const card = (id, name, types, stats) => ({ id, name, types, stats, zh_name: null, rarity: "C" });
const STATS = { hp: 60, attack: 100, defense: 60, "special-attack": 50, "special-defense": 50, speed: 80 };
const v3 = (id, name, types, stats = STATS) => battleMonFromCard(card(id, name, types, stats), { v3: true });
const state = (u, a) => ({ userTeam: u, aiTeam: a, activeUser: 0, activeAi: 0, turn: 1, status: "active", version: 3, aiIntent: null });
const clone = (x) => JSON.parse(JSON.stringify(x));
const moveEvents = (r) => r.events.filter((e) => e.kind === "move");

// ---- 1. 常数与派生表:改任何一个数字必红(工程常数要有测试锚点) ----------
test("ENERGY 常数表", () => {
  assert.equal(ENERGY.START, 25);
  assert.equal(ENERGY.REGEN_ACTIVE, 15);
  assert.equal(ENERGY.REGEN_BENCH, 5);
  assert.equal(ENERGY.GUARD, 35);
  assert.equal(ENERGY.SWITCH_IN, 10);
  assert.equal(ENERGY.PAIN, 10);
  assert.equal(ENERGY.WEAKNESS, 20);
  assert.equal(ENERGY.CAP, 100);
});

test("四档招式派生表(费用/威力/先制度)", () => {
  const costs = [0, 25, 45, 90];
  const powers = [40, 65, 95, 135];
  const priorities = [1, 0, 0, 0];
  for (const types of [["fire"], ["water", "grass"], ["normal"]]) {
    const moves = v3(1, "mon", types).moves;
    assert.deepEqual(moves.map((m) => m.cost), costs, `types=${types}`);
    assert.deepEqual(moves.map((m) => m.power), powers, `types=${types}`);
    assert.deepEqual(moves.map((m) => m.priority), priorities, `types=${types}`);
    assert.deepEqual(moves.map((m) => m.tier), ["quick", "strike", "heavy", "ult"], `types=${types}`);
  }
});

// ---- 2. 克制乘法表(属性相性的唯一真源是 CHART) ---------------------------
test("克制乘法表", () => {
  const table = [
    ["fire", ["grass"], 2],
    ["fire", ["water"], 0.5],
    ["fire", ["fire"], 0.5],
    ["electric", ["ground"], 0],
    ["fire", ["grass", "ice"], 4], // 双弱点乘算
    ["normal", ["ghost"], 0],
    ["fighting", ["ghost"], 0],
    ["normal", ["steel"], 0.5],
    ["fairy", ["normal"], 1], // 图上无条目 = 1x
  ];
  for (const [atk, def, expected] of table) {
    assert.equal(effectiveness(atk, def), expected, `${atk} vs ${def}`);
  }
});

// ---- 3. 回合回能:在场 +15,替补 +5,倒下的替补不回能 ----------------------
test("回合回能表:在场+15 替补+5", () => {
  // 双方都换人 → 本回合无出招,能量变动只剩回能,算术最干净
  const u = [v3(1, "a", ["fire"]), v3(2, "b", ["water"])];
  const x = [v3(3, "x", ["grass"]), v3(4, "y", ["electric"])];
  const r = resolveBattleTurn(state(clone(u), clone(x)), { kind: "switch", index: 1 }, { kind: "switch", index: 1 }, seededRng(1));
  // 用户侧:A(原在场)25+15=40;B(替补)25+5=30,换上 +10 → 40
  assert.equal(r.state.userTeam[0].energy, 40, "原在场 +15");
  assert.equal(r.state.userTeam[1].energy, 25 + 5 + ENERGY.SWITCH_IN, "替补 +5 再 +10 动量");
  assert.equal(r.state.aiTeam[0].energy, 40);
  assert.equal(r.state.aiTeam[1].energy, 40);
});

test("倒下的替补不回能", () => {
  const u = [v3(1, "a", ["fire"])];
  const bench = v3(2, "dead", ["water"]);
  bench.hp = 0;
  const x = [v3(3, "x", ["grass"])];
  resolveBattleTurn(state(u, x), { kind: "move", moveId: "fire-strike-q" }, { kind: "move", moveId: "grass-strike-q" }, seededRng(2));
  assert.equal(bench.energy, ENERGY.START, "hp=0 的替补不参与回能");
});

// ---- 4. 弱点 +20 / 痛感 +10 / 上限 100 ------------------------------------
test("弱点命中 +20、挨打痛感 +10、CAP=100 封顶", () => {
  const u = v3(1, "a", ["fire"]); // 火 vs 草 = 2x
  const x = v3(3, "x", ["grass"]);
  const r = resolveBattleTurn(state([u], [x]), { kind: "move", moveId: "fire-strike-q" }, { kind: "move", moveId: "grass-strike-q" }, seededRng(3));
  // 用户:25 +15(回合)-0(迅招)+20(弱点)+10(自己挨了一记)= 70
  assert.equal(r.state.userTeam[0].energy, 70, `got ${r.state.userTeam[0].energy}`);
  // AI:25 +15 +10(挨打,无弱点加成)= 50
  assert.equal(r.state.aiTeam[0].energy, 50, `got ${r.state.aiTeam[0].energy}`);

  // 封顶:95 + 20 弱点 = 115 → 夹到 100
  const u2 = v3(1, "a", ["fire"]);
  u2.energy = 95;
  const r2 = resolveBattleTurn(state([u2], [v3(3, "x", ["grass"])]), { kind: "move", moveId: "fire-strike-q" }, { kind: "move", moveId: "grass-strike-q" }, seededRng(4));
  assert.equal(r2.state.userTeam[0].energy, ENERGY.CAP);
});

// ---- 5. 防御:+35 回能 + 受伤恰好减半(向上取整) ---------------------------
test("防御蓄力 +35 且受伤恰为 ceil(原伤/2)", () => {
  // 能量链:25 +15(回合)+35(防御)+10(挨打痛感)= 85
  const u = [v3(1, "a", ["fire"])];
  const x = [v3(3, "x", ["grass"])];
  const rg = resolveBattleTurn(state(clone(u), clone(x)), { kind: "guard" }, { kind: "move", moveId: "grass-strike-q" }, seededRng(5));
  assert.equal(rg.state.userTeam[0].energy, 85, `got ${rg.state.userTeam[0].energy}`);

  // 减半必须逐点精确:两条场景消费同样的 RNG 流——飞行系那一击拿到的都是
  // 第 1 个随机数。三个对齐条件缺一不可:攻击方极速(排序走速度分支,不掷
  // 先手币——掷币本身也消耗随机数);无防御场景的 AI 用地面迅招打飞行用户
  // (0x 免疫:不消费随机数、不产生伤害)。
  const flying = v3(18, "f", ["flying"], { ...STATS, speed: 999 });
  const ground = v3(31, "g", ["ground"]);
  const rPlain = resolveBattleTurn(state([clone(flying)], [clone(ground)]), { kind: "move", moveId: "flying-strike-q" }, { kind: "move", moveId: "ground-strike-q" }, seededRng(6));
  const rGuard = resolveBattleTurn(state([clone(flying)], [clone(ground)]), { kind: "move", moveId: "flying-strike-q" }, { kind: "guard" }, seededRng(6));
  const dmgPlain = moveEvents(rPlain).find((e) => e.actor === "user")?.damage ?? 0;
  const dmgGuard = moveEvents(rGuard).find((e) => e.actor === "user")?.damage ?? 0;
  assert.ok(dmgPlain > 0, "基线伤害必须为正");
  assert.equal(dmgGuard, Math.ceil(dmgPlain / 2), `guard=${dmgGuard} plain=${dmgPlain}`);
  assert.ok((moveEvents(rGuard).find((e) => e.actor === "user")?.text ?? "").includes("防御减半"));
});

// ---- 6. 行动顺序:先制度 > 速度 > 掷随机 ----------------------------------
test("迅招先制度压过极限速度差", () => {
  const slow = v3(1, "slow", ["grass"], { ...STATS, speed: 1 });
  const fast = v3(20, "fast", ["water"], { ...STATS, speed: 255 });
  // 慢者出迅招(pri 1)对快者出极招(pri 0):先制度优先
  const r = resolveBattleTurn(state([slow], [fast]), { kind: "move", moveId: "grass-strike-q" }, { kind: "move", moveId: "water-strike-u" }, seededRng(7));
  assert.equal(moveEvents(r)[0].actor, "user");

  // 反向:快者迅招 vs 慢者极招 → 快者先手
  const r2 = resolveBattleTurn(state([clone(fast)], [clone(slow)]), { kind: "move", moveId: "water-strike-q" }, { kind: "move", moveId: "grass-strike-u" }, seededRng(8));
  assert.equal(moveEvents(r2)[0].actor, "user", "快者迅招先手");
});

test("同优先级按速度裁定;同速同优先级由种子掷定且确定", () => {
  const slow = v3(1, "slow", ["grass"], { ...STATS, speed: 30 });
  const fast = v3(20, "fast", ["water"], { ...STATS, speed: 120 });
  const r = resolveBattleTurn(state([clone(slow)], [clone(fast)]), { kind: "move", moveId: "grass-strike" }, { kind: "move", moveId: "water-strike" }, seededRng(9));
  assert.equal(moveEvents(r)[0].actor, "ai", "同优先级,速度快者先手");

  // 同速同优先级:换人/guard 之外的两个出招动作 → 掷随机,但同种子必须可复现
  const a = v3(1, "a", ["fire"], { ...STATS, speed: 80 });
  const b = v3(20, "b", ["water"], { ...STATS, speed: 80 });
  const r1 = resolveBattleTurn(state([clone(a)], [clone(b)]), { kind: "move", moveId: "fire-strike" }, { kind: "move", moveId: "water-strike" }, seededRng(10));
  const r2 = resolveBattleTurn(state(clone([a]), clone([b])), { kind: "move", moveId: "fire-strike" }, { kind: "move", moveId: "water-strike" }, seededRng(10));
  assert.equal(moveEvents(r1)[0].actor, moveEvents(r2)[0].actor, "同种子掷定结果一致");
});

// ---- 7. 能量不足:自动降档为迅招(免费),回合不作废 -----------------------
test("能量不足自动降档为迅招", () => {
  const poor = v3(1, "a", ["fire"]);
  poor.energy = 0; // 注意:回合回能 +15 在结算前发生,15 < 25 才真正付不起 strike
  // AI 必须后手(慢速 + 同优先级):若 AI 迅招先手,痛感 +10 会恰好把用户
  // 补到 25 能量付得起原招,降档根本不会触发(首版测试就栽在这)
  const x = v3(3, "x", ["water"], { ...STATS, speed: 40 }); // 火打水 0.5x:无弱点加成,算术干净
  const r = resolveBattleTurn(state([poor], [x]), { kind: "move", moveId: "fire-strike" }, { kind: "move", moveId: "water-strike" }, seededRng(11));
  const info = r.events.find((e) => e.kind === "info");
  assert.ok(info && info.text.includes("能量不足"), JSON.stringify(r.events));
  // 用户:0 +15(回合)-0(降档迅招免费)+10(挨打)= 25
  assert.equal(r.state.userTeam[0].energy, 25, `got ${r.state.userTeam[0].energy}`);
});

test("格挡/换人不存在降档(非出招动作不进降档分支)", () => {
  const u = v3(1, "a", ["fire"]);
  u.energy = 0;
  const x = v3(3, "x", ["water"]);
  const rg = resolveBattleTurn(state([u], [clone(x)]), { kind: "guard" }, { kind: "move", moveId: "water-strike-q" }, seededRng(12));
  // 防御不花钱:0 +15 +35 +10 = 60
  assert.equal(rg.state.userTeam[0].energy, 60, `got ${rg.state.userTeam[0].energy}`);
  assert.ok(!rg.events.some((e) => e.kind === "info"));
});
