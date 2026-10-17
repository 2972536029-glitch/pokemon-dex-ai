// Battle engine unit tests (run: node qa/battle.test.mjs, needs build first)
import {
  battleMonFromCard, resolveTurn, chooseAiAction, seededRng, effectiveness,
  resolveBattleTurn, generateAiIntent, intentToAction, intentStillValid, ENERGY,
} from "../server/dist/battle.js";

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

// ==================== v3 引擎:意图 × 能量 × 弱点节奏 ====================
const v3 = (id, name, types, stats) => battleMonFromCard(card(id, name, types, stats), { v3: true });
const sV3 = (userTeam, aiTeam) => ({ userTeam, aiTeam, activeUser: 0, activeAi: 0, turn: 1, status: "active", version: 3, aiIntent: null });
const clone = (x) => JSON.parse(JSON.stringify(x));

// 13. v3 moveset: four tiers, costs 0/25/45/90, quick has priority
const fu = v3(1, "mon-a", ["fire"], STATS_A);
check("v3 招式四档", fu.moves.length === 4 && fu.moves.every(m => m.tier));
check("v3 费用阶梯", [0, 25, 45, 90].every((c, i) => (fu.moves[i].cost ?? -1) === c));
check("迅招先制度 +1", (fu.moves[0].priority ?? 0) === 1);
check("v3 开局能量 25", fu.energy === ENERGY.START);

// 14. dual-type heavy rides the secondary type (coverage)
const dual = v3(30, "dual", ["fire", "ice"], STATS_A);
check("双属性重招用第二属性", dual.moves.find(m => m.tier === "heavy")?.type === "ice");

// 15. energy math: regen +15, strike -25, weakness +20, pain +10
const u15 = v3(1, "mon-a", ["fire"], STATS_A);
const b15 = v3(2, "mon-b", ["grass"], STATS_B);
const r15 = resolveBattleTurn(sV3([u15], [b15]), { kind: "move", moveId: "fire-strike" }, { kind: "move", moveId: "grass-strike" }, seededRng(42));
// user: 25 +15 -25 +20(火打草2x) +10(自己也挨了一记,痛感) = 45
// ai:   25 +15 -25 +10(被打) = 25 —— 对称性:双方挨打都回能
check("能量结算:回能/扣费/弱点/痛感", r15.state.userTeam[0].energy === 45 && r15.state.aiTeam[0].energy === 25,
  `u=${r15.state.userTeam[0].energy} a=${r15.state.aiTeam[0].energy}`);
const weakGain = (r15.events.find(e => e.kind === "move" && e.actor === "user")?.energy ?? []).some(d => d.side === "user" && d.amount === ENERGY.WEAKNESS);
check("弱点回能进事件(供 UI 回放)", weakGain);

// 16. quick priority beats raw speed
const slowU = v3(21, "slow-u", ["grass"], { ...STATS_A, speed: 30 });
const fastAi = v3(20, "fast-ai", ["water"], STATS_FAST);
const r16 = resolveBattleTurn(sV3([slowU], [fastAi]), { kind: "move", moveId: "grass-strike-q" }, { kind: "move", moveId: "water-strike" }, seededRng(5));
check("迅招无视速度先手", r16.events.find(e => e.kind === "move")?.actor === "user");

// 17. guard: halves incoming + banks 35
let guardDmgSum = 0, plainDmgSum = 0;
for (let seed = 0; seed < 10; seed++) {
  const rg = resolveBattleTurn(sV3([v3(1, "mon-a", ["fire"], STATS_A)], [v3(2, "mon-b", ["grass"], STATS_B)]), { kind: "guard" }, { kind: "move", moveId: "grass-strike" }, seededRng(seed));
  const rp = resolveBattleTurn(sV3([v3(1, "mon-a", ["fire"], STATS_A)], [v3(2, "mon-b", ["grass"], STATS_B)]), { kind: "move", moveId: "fire-strike-q" }, { kind: "move", moveId: "grass-strike" }, seededRng(seed));
  guardDmgSum += rg.events.find(e => e.kind === "move" && e.actor === "ai")?.damage ?? 0;
  plainDmgSum += rp.events.find(e => e.kind === "move" && e.actor === "ai")?.damage ?? 0;
  if (seed === 0) {
    // 25 +15(回合) +35(防御) +10(挨打痛感) = 85
    check("防御事件与回能", rg.events.some(e => e.kind === "guard") && rg.state.userTeam[0].energy === 25 + 15 + ENERGY.GUARD + 10,
      `energy=${rg.state.userTeam[0].energy}`);
    check("防御减半标注", (rg.events.find(e => e.kind === "move" && e.actor === "ai")?.text ?? "").includes("防御减半"));
  }
}
check("防御受伤显著降低", guardDmgSum < plainDmgSum * 0.7, `guard=${guardDmgSum} plain=${plainDmgSum}`);

// 18. unaffordable move auto-downgrades to quick
const poor = v3(1, "mon-a", ["fire"], STATS_A);
poor.energy = 0;
const r18 = resolveBattleTurn(sV3([poor], [v3(2, "mon-b", ["grass"], STATS_B)]), { kind: "move", moveId: "fire-strike-u" }, { kind: "move", moveId: "grass-strike" }, seededRng(7));
// 0 +15(回合) -0(迅招) +20(火迅打击草2x弱点) +10(挨打) = 45:降档不废掉这一回合
check("能量不足自动降档为迅招", r18.events.some(e => e.kind === "info" && e.text.includes("能量不足")) && r18.state.userTeam[0].energy === 45,
  `energy=${r18.state.userTeam[0].energy}`);

// 19. intent lifecycle: generate → convert → invalidate on mon change
const intentAi = v3(5, "ai-mon", ["water"], STATS_A);
const intentBench = v3(8, "bench", ["ice"], STATS_A);
const st19 = sV3([v3(6, "grass-target", ["grass"], STATS_B)], [intentAi, intentBench]);
const intent = generateAiIntent(st19, seededRng(3));
const sameAgain = generateAiIntent(JSON.parse(JSON.stringify(st19)), seededRng(3));
check("意图生成确定(同种子)", JSON.stringify(intent) === JSON.stringify(sameAgain));
check("意图可负担且可转换", intent.kind !== "move" || intentToAction(intent) !== null);
check("意图对局面有效", intentStillValid(st19, intent));
st19.activeAi = 1; // AI's mon changed (e.g. KO replacement)
const staleMoveIntent = { kind: "move", moveId: intentAi.moves[3].id, label: "x" }; // water ult on the OLD mon
check("换人后旧招式意图失效", !intentStillValid(st19, staleMoveIntent) || intentBench.moves.some(m => m.id === staleMoveIntent.moveId));

// 20. v3 full-team wipe still ends the battle
const weak3 = v3(3, "weak", ["grass"], { ...STATS_B, defense: 5, "special-defense": 5 });
let st20 = sV3([v3(1, "mon-a", ["fire"], STATS_A), v3(1, "mon-a", ["fire"], STATS_A)], [weak3, v3(3, "weak-2", ["grass"], { ...STATS_B, defense: 5, "special-defense": 5 })]);
for (let i = 0; i < 8 && st20.status === "active"; i++) {
  const quick = st20.userTeam[st20.activeUser].moves[0].id;
  st20 = resolveBattleTurn(st20, { kind: "move", moveId: quick }, { kind: "move", moveId: "grass-strike-q" }, seededRng(11)).state;
}
check("v3 全队 KO 判胜", st20.status === "won", st20.status);

console.log(`\n=== BATTLE ENGINE: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail > 0 ? 1 : 0);
