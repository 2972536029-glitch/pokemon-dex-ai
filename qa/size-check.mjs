// 包体预算检查(ROADMAP-NEXT T1)。Run: node qa/size-check.mjs [--update]
//
// 基线 qa/size-baseline.json 记录每个 dist/assets 产物的字节数。红线:
//   1. 基线里的文件从产物中消失(改名/拆分要显式更新基线,不许静默);
//   2. 任一产物超基线 +10%(主包混进大依赖的典型信号);
//   3. 新出现的文件 > 50KB(新 chunk 偷偷长肉);
//   4. 总量超基线 +10%。
// 立基线/确认有意变更:node qa/size-check.mjs --update(构建之后跑)。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const assetsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "assets");
const baselinePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "size-baseline.json");
const GROWTH_TOLERANCE = 0.1; // +10% 红
const NEW_FILE_LIMIT = 50 * 1024; // 新文件 50KB 红

const FAILURES = [];
let pass = 0;
const ok = (name) => {
  pass++;
  console.log(`PASS | ${name}`);
};

if (process.argv.includes("--update")) {
  const baseline = {};
  let total = 0;
  for (const f of fs.readdirSync(assetsDir)) {
    const size = fs.statSync(path.join(assetsDir, f)).size;
    baseline[f] = size;
    total += size;
  }
  fs.writeFileSync(baselinePath, JSON.stringify({ generatedAt: new Date().toISOString(), total, files: baseline }, null, 2) + "\n");
  console.log(`baseline updated: ${Object.keys(baseline).length} files, total ${total} bytes`);
  process.exit(0);
}

if (!fs.existsSync(assetsDir)) {
  console.error("dist/assets 不存在——先 npm run build 再跑包体检查");
  process.exit(1);
}
if (!fs.existsSync(baselinePath)) {
  console.error("qa/size-baseline.json 不存在——先 node qa/size-check.mjs --update 立基线");
  process.exit(1);
}

const { total: baseTotal, files: baseFiles } = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const actual = new Map();
let actualTotal = 0;
for (const f of fs.readdirSync(assetsDir)) {
  const size = fs.statSync(path.join(assetsDir, f)).size;
  actual.set(f, size);
  actualTotal += size;
}

// 1) 基线文件必须在;2) 超基线 +10% 红
for (const [name, baseSize] of Object.entries(baseFiles)) {
  if (!actual.has(name)) {
    FAILURES.push(`基线产物消失: ${name}(拆分/改名后请 --update 基线)`);
    continue;
  }
  const size = actual.get(name);
  if (size > baseSize * (1 + GROWTH_TOLERANCE)) {
    FAILURES.push(`超预算: ${name} ${size}B > 基线 ${baseSize}B +10%`);
  } else {
    ok(`${name}: ${size}B ≤ ${baseSize}B+10%`);
  }
}

// 3) 新文件限额
for (const [name, size] of actual) {
  if (!(name in baseFiles)) {
    if (size > NEW_FILE_LIMIT) {
      FAILURES.push(`新产物过大: ${name} ${size}B > ${NEW_FILE_LIMIT}B(确认有意后 --update 基线)`);
    } else {
      ok(`新产物: ${name} ${size}B`);
    }
  }
}

// 4) 总量预算
if (actualTotal > baseTotal * (1 + GROWTH_TOLERANCE)) {
  FAILURES.push(`总量超预算: ${actualTotal}B > 基线 ${baseTotal}B +10%`);
} else {
  ok(`总量: ${actualTotal}B ≤ ${baseTotal}B+10%`);
}

if (FAILURES.length > 0) {
  console.error(`\n=== SIZE BUDGET: FAIL ===`);
  for (const f of FAILURES) console.error(`FAIL | ${f}`);
  process.exit(1);
}
console.log(`\n=== SIZE BUDGET: PASS (${pass} checks) ===`);
