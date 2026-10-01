// Battle engine unit tests (run: node qa/battle.test.mjs, needs build first)
import { battleMonFromCard, resolveTurn, chooseAiAction, seededRng, effectiveness } from "../server/dist/battle.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("PASS |", name); }
  else { fail++; console.log("FAIL |", name, "|", detail); }
};

const card = (id, name, types, stats) => ({ id, name, types, stats, zh_name: null, rarity: "C" });
const STATS_A = { hp: 60, attack: 100, defense: 60, "special-attack": 50, "special-defense": 50, speed: 80 };
const STATS_B = { hp: 80, attack: 60, defense: 100, "special-attack": 60, "special-defense": 60, speed: 50 };
const STATS_FAST = { hp: 40, attack: 70, defense: 40, "special-attack": 70, "special-defense": 40, speed: 120 };

// 1. HP formula: maxHp = hp stat + 60
const a = battleMonFromCard(card(1, "mon-a", ["fire"], STATS_A));
check("HP 公式 = 种族值+60", a.maxHp === 120 && a.hp === 120);

// 2. moves: tackle + up to 2 type moves
check("招式 = 撞击 + 属性招", a.moves.length === 2 && a.moves.some(m => m.id === "fire-strike"));

// 3. effectiveness: fire vs grass = 2, vs water = 0.5, vs fire-type = 0.5
check("克制 2x", effectiveness("fire", ["grass"]) === 2);
check("抗性 0.5x", effectiveness("fire", ["water"]) === 0.5);
check("免疫 0x", effectiveness("electric", ["ground"]) === 0);
check("双属性乘算", effectiveness("fire", ["grass", "ice"]) === 4);

// 4. damage determinism with seeded RNG
const b = battleMonFromCard(card(2, "mon-b", ["grass"], STATS_B));
const s1 = { userTeam: [a], aiTeam: [b], activeUser: 0, activeAi: 0, turn: 1, status: "active" };
const s2 = JSON.parse(JSON.stringify(s1));
const rng = seededRng(42);
const r1 = resolveTurn(s1, { kind: "move", moveId: "fire-strike" }, { kind: "move", moveId: "grass-strike" }, rng);
const r2 = resolveTurn(s2, { kind: "move", moveId: "fire-strike" }, { kind: "move", moveId: "grass-strike" }, seededRng(42));
check("同种子结算确定性一致", JSON.stringify(r1) === JSON.stringify(r2));

// 5. fire vs grass is 2x and STAB applies for fire attacker
const dmgEvents = r1.events.filter(e => e.kind === "move" && e.actor === "user");
check("用户先手(速度80>50)", dmgEvents.length >= 1);
const ev = JSON.stringify(r1.events);
check("克制文案出现", ev.includes("效果绝佳"));

// 6. A is faster, so B's HP dropped by A's hit before B acted
const bAfter = r1.state.aiTeam[0];
const userDmg = 120 - bAfter.hp;
check("伤害为正数", userDmg > 0, `dmg=${userDmg}`);

// 7. KO → next mon sent; wiping the whole team across turns → won
const weak = battleMonFromCard(card(3, "weak", ["grass"], { ...STATS_B, defense: 5, "special-defense": 5 }));
const s3 = { userTeam: [a, battleMonFromCard(card(1, "mon-a", ["fire"], STATS_A))], aiTeam: [weak, battleMonFromCard(card(3, "weak-2", ["grass"], { ...STATS_B, defense: 5, "special-defense": 5 }))], activeUser: 0, activeAi: 0, turn: 1, status: "active" };
let st = s3;
let sawKo = false, sawSend = false;
for (let i = 0; i < 5 && st.status === "active"; i++) {
  const rr = resolveTurn(st, { kind: "move", moveId: "fire-strike" }, { kind: "move", moveId: "tackle" }, seededRng(7));
  st = rr.state;
  if (rr.events.some(e => e.kind === "ko")) sawKo = true;
  if (rr.events.some(e => e.kind === "switch")) sawSend = true;
}
check("KO 后自动派下一只", sawKo && sawSend);
check("全队 KO 后判胜", st.status === "won", st.status);

// 8. switching: free action, new mon takes the hit
const s4 = { userTeam: [a, battleMonFromCard(card(4, "tank", ["rock"], STATS_B))], aiTeam: [b], activeUser: 0, activeAi: 0, turn: 1, status: "active" };
const r4 = resolveTurn(s4, { kind: "switch", index: 1 }, { kind: "move", moveId: "tackle" }, seededRng(3));
check("换人后新 Mon 承受攻击", r4.state.userTeam[1].hp < r4.state.userTeam[1].maxHp && r4.state.activeUser === 1);

// 9. invalid switch (dead/same/oot) rejected
const s5 = { userTeam: [a], aiTeam: [b], activeUser: 0, activeAi: 0, turn: 1, status: "active" };
const r5 = resolveTurn(s5, { kind: "switch", index: 0 }, { kind: "move", moveId: "tackle" }, seededRng(1));
check("非法换人被拒(仍攻击或忽略)", r5.state.activeUser === 0);

// 10. AI rule mode: picks the move with the highest power × effectiveness
const aiMon = battleMonFromCard(card(5, "ai-mon", ["water"], STATS_A));
const userMon = battleMonFromCard(card(6, "grass-target", ["grass"], STATS_B));
const s6 = { userTeam: [userMon], aiTeam: [aiMon], activeUser: 0, activeAi: 0, turn: 1, status: "active" };
const act = chooseAiAction(s6);
check("AI 选克制招(水打草)", act.kind === "move" && act.moveId === "water-strike", JSON.stringify(act));

// 11. low HP → switches to a bench mon with a better matchup
const lowHp = battleMonFromCard(card(7, "low", ["water"], { ...STATS_A, hp: 10 }));
lowHp.hp = 10;
const strongBench = battleMonFromCard(card(8, "bench", ["ice"], STATS_A));
const badBench = battleMonFromCard(card(9, "badbench", ["grass"], STATS_B));
const s7 = { userTeam: [userMon], aiTeam: [lowHp, strongBench, badBench], activeUser: 0, activeAi: 0, turn: 1, status: "active" };
const act2 = chooseAiAction(s7);
check("残血且有更好克制 bench 时换人", act2.kind === "switch" && act2.index === 1, JSON.stringify(act2));

// 12. immovable: 0x move deals 0, defender not KO'd
const ghostDef = battleMonFromCard(card(10, "ghost-mon", ["ghost"], STATS_B));
const normalAtk = battleMonFromCard(card(11, "normal-atk", ["normal"], STATS_A));
const s8 = { userTeam: [normalAtk], aiTeam: [ghostDef], activeUser: 0, activeAi: 0, turn: 1, status: "active" };
const r8 = resolveTurn(s8, { kind: "move", moveId: "tackle" }, { kind: "move", moveId: "tackle" }, seededRng(9));
check("免疫属性伤害为 0", r8.state.aiTeam[0].hp === ghostDef.maxHp);

console.log(`\n=== BATTLE ENGINE: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail > 0 ? 1 : 0);
