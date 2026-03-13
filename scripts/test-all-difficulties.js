"use strict";
/**
 * test-all-difficulties.js — 全难度双重测试
 *
 * 【第一部分】难度评估：D1-D6 各30题全盘验证
 *   - 弃题率（含链比例）
 *   - 平均空格数（线索密度）
 *   - 目标格求解步骤分布（平均/最大）
 *
 * 【第二部分】求解输出：D1-D6 各10题详细步骤
 *   - 全盘验证，含链整题废弃重生成
 *   - 展示盘面 + 完整求解路径（模拟玩家收到的答案格式）
 *
 * 执行：node scripts/test-all-difficulties.js
 */

const path = require("path");
const fs   = require("fs");

const { solve, formatCompactSteps, checkPuzzleIntuitiveSolvable } =
  require("../lib/solver.js");
const { SudokuGenerator } = require("../lib/generator.js");

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function rowLabel(r) { return String.fromCharCode(65 + r); }
function cellLabel(r, c) { return rowLabel(r) + (c + 1); }

function renderBoard(puzzle, tr, tc) {
  const lines = ["     1 2 3   4 5 6   7 8 9"];
  for (let r = 0; r < 9; r++) {
    if (r === 3 || r === 6) lines.push("     ------+-------+------");
    const row = puzzle[r].map((v, c) => {
      const s = v === 0 ? (r === tr && c === tc ? "*" : ".") : String(v);
      return (c === 2 || c === 5) ? s + " |" : s;
    }).join(" ");
    lines.push("  " + rowLabel(r) + "  " + row);
  }
  return lines.join("\n");
}

/**
 * 生成一道全直观可解的题目（整道题含链则废弃重生成）。
 * 返回 { puzzle, solution, attempts }，attempts = 本题生成总次数
 */
function generateIntuitiveFullPuzzle(diff) {
  let attempts = 0;
  while (true) {
    attempts++;
    const gen = new SudokuGenerator(diff);
    const { puzzle, solution } = gen.generate();
    if (checkPuzzleIntuitiveSolvable(puzzle)) {
      return { puzzle, solution, attempts };
    }
  }
}

/**
 * 随机选一个空格作为目标格并求解，返回求解结果
 */
function solveRandomTarget(puzzle, solution) {
  const empty = [];
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++)
      if (!puzzle[r][c]) empty.push({ r, c });
  if (!empty.length) return null;

  const { r, c } = empty[Math.floor(Math.random() * empty.length)];
  const result = solve(puzzle, r, c);
  return {
    r, c,
    answer:   solution[r][c],
    result,
    steps:    result.success ? result.steps.length : 0,
    keySteps: result.success ? result.steps.filter(s => s.affectsTarget).length : 0,
    nonKey:   result.success ? result.steps.filter(s => !s.affectsTarget).length : 0,
  };
}

// ─── 输出管理 ─────────────────────────────────────────────────────────────────

const lines_out = [];
function print(msg = "")    { lines_out.push(msg); console.log(msg); }
function fileOnly(msg = "") { lines_out.push(msg); }

const SEP  = "═".repeat(72);
const LINE = "─".repeat(72);

const DIFF_NAMES = {
  1: "D1 简单       (sudoku-gen easy)",
  2: "D2 较易       (sudoku-gen medium)",
  3: "D3 中等       (forfuns level-1)",
  4: "D4 中等+      (sudoku-gen hard)",
  5: "D5 困难       (forfuns level-2)",
  6: "D6 困难+      (sudoku-gen expert)",
};

print(SEP);
print("  数独全难度测试（D1-D6 · 全盘验证 · 含链整题废弃 · 第二轮50题/难度）");
print(`  生成时间：${new Date().toLocaleString("zh-CN")}`);
print(SEP);

// ═══════════════════════════════════════════════════════════════════════
// 第一部分：难度评估（30题/难度）
// ═══════════════════════════════════════════════════════════════════════

print("\n【第一部分】难度评估 — D1-D6 各50题全盘验证");
print(LINE);

const EVAL_COUNT = 50;
const evalResults = {};

for (let diff = 1; diff <= 6; diff++) {
  let totalAttempts = 0;   // 总生成次数（含被弃题）
  let totalEmpty  = 0;     // 空格总数
  let totalSteps  = 0;
  let maxSteps    = 0;
  let totalKey    = 0;
  let maxKey      = 0;
  let successCount = 0;
  const stepDist  = {};

  for (let i = 0; i < EVAL_COUNT; i++) {
    const { puzzle, solution, attempts } = generateIntuitiveFullPuzzle(diff);
    totalAttempts += attempts;

    // 空格计数
    let empty = 0;
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (!puzzle[r][c]) empty++;
    totalEmpty += empty;

    // 随机目标格求解
    const rec = solveRandomTarget(puzzle, solution);
    if (rec && rec.result.success) {
      successCount++;
      totalSteps += rec.steps;
      maxSteps    = Math.max(maxSteps, rec.steps);
      totalKey   += rec.keySteps;
      maxKey      = Math.max(maxKey, rec.keySteps);
      stepDist[rec.steps] = (stepDist[rec.steps] || 0) + 1;
    }
  }

  const rejectCount = totalAttempts - EVAL_COUNT;
  const rejectPct   = (rejectCount / totalAttempts * 100).toFixed(1);
  const avgEmpty    = (totalEmpty / EVAL_COUNT).toFixed(1);
  const avgSteps    = successCount > 0 ? (totalSteps / successCount).toFixed(1) : "N/A";
  const avgKey      = successCount > 0 ? (totalKey   / successCount).toFixed(1) : "N/A";

  evalResults[diff] = {
    rejectCount, rejectPct, avgEmpty,
    avgSteps, maxSteps, avgKey, maxKey,
    successCount, stepDist,
  };
}

// 输出评估表格
print("  档位 | 名称                              | 弃题  |空格数| 均步 | 峰步 | 均关键 | 峰关键");
print("  ─────┼───────────────────────────────────┼───────┼──────┼──────┼──────┼────────┼───────");
for (let diff = 1; diff <= 6; diff++) {
  const d = evalResults[diff];
  const name  = DIFF_NAMES[diff].padEnd(33);
  const rej   = `${d.rejectCount}/${d.rejectCount + EVAL_COUNT}`.padStart(5);
  const empty = String(d.avgEmpty).padStart(4);
  const avgs  = String(d.avgSteps).padStart(4);
  const maxs  = String(d.maxSteps).padStart(4);
  const avgk  = String(d.avgKey).padStart(6);
  const maxk  = String(d.maxKey).padStart(5);
  print(`  D${diff}   | ${name} | ${rej} | ${empty} | ${avgs} | ${maxs} | ${avgk} | ${maxk}`);
}

print(LINE);
print("  说明：弃题 = 含链被废弃的题目数/总生成数  空格数 = 平均未给定格数量");
print("        均步 = 随机目标格求解平均总步骤     峰步 = 最大总步骤数");
print("        均关键/峰关键 = 直接影响目标格候选数的关键步骤");

// 步骤分布详情（写入文件）
fileOnly(`\n${"─".repeat(72)}`);
fileOnly("第一部分 — 各难度步骤分布详情");
fileOnly("─".repeat(72));
for (let diff = 1; diff <= 6; diff++) {
  const d = evalResults[diff];
  fileOnly(`\n  ${DIFF_NAMES[diff]}`);
  fileOnly(`  弃题 ${d.rejectCount}/${d.rejectCount + EVAL_COUNT}（${d.rejectPct}%）  平均空格 ${d.avgEmpty}  均步 ${d.avgSteps}  峰步 ${d.maxSteps}`);
  const distKeys = Object.keys(d.stepDist).map(Number).sort((a, b) => a - b);
  const maxBar = Math.max(...Object.values(d.stepDist));
  for (const n of distKeys) {
    const cnt = d.stepDist[n];
    const bar = "█".repeat(Math.ceil(cnt / maxBar * 20));
    fileOnly(`     ${String(n).padStart(3)} 步：${String(cnt).padStart(3)} 题  ${bar}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 第二部分：详细求解输出（10题/难度）
// ═══════════════════════════════════════════════════════════════════════

print(`\n\n【第二部分】详细求解输出 — D1-D6 各10题（模拟游戏场景）`);
print(SEP);

const DETAIL_COUNT = 10;

for (let diff = 1; diff <= 6; diff++) {
  print(`\n${LINE}`);
  print(`  ${DIFF_NAMES[diff]}`);
  print(LINE);

  let regenTotal = 0;

  for (let i = 0; i < DETAIL_COUNT; i++) {
    const { puzzle, solution, attempts } = generateIntuitiveFullPuzzle(diff);
    regenTotal += attempts - 1; // 额外生成次数

    // 随机选目标格
    const empty = [];
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (!puzzle[r][c]) empty.push({ r, c });
    const { r, c } = empty[Math.floor(Math.random() * empty.length)];

    const result  = solve(puzzle, r, c);
    const tc      = cellLabel(r, c);
    const answer  = solution[r][c];
    const steps   = result.success ? result.steps.length : 0;
    const keySteps = result.success ? result.steps.filter(s => s.affectsTarget).length : 0;
    const nonKey   = steps - keySteps;

    const header = `  [第${i+1}题] 目标格 ${tc}（答案 ${answer}）| 关键步 ${keySteps} | 铺垫步 ${nonKey} | 总 ${steps} 步`;
    print(header);
    print();
    print(renderBoard(puzzle, r, c));
    print();

    if (result.success) {
      print(formatCompactSteps(result, tc));
      const correct = result.answer === answer;
      print(correct ? "  ✅ 答案正确" : `  ❌ 答案错误（求解=${result.answer} 预期=${answer}）`);
    } else {
      print(`  ⛔ 求解失败（超出直观技巧范围，不应出现）`);
    }
    print();
  }

  if (regenTotal > 0) {
    print(`  ♻️ 本难度额外废弃 ${regenTotal} 次含链题目`);
  }
}

// ─── 全局汇总 ──────────────────────────────────────────────────────────────────

print(`\n${SEP}`);
print("  全局汇总");
print(SEP);
print("  档位 | 弃题率  | 均步数 | 最大步 | 评估");
print("  ─────┼─────────┼────────┼────────┼───────────────────");
const verdicts = [
  "基础排除即可",
  "需少量前置推导",
  "需多步前置推导",
  "需较多前置推导",
  "前置推导链较长",
  "前置推导链最长",
];
for (let diff = 1; diff <= 6; diff++) {
  const d = evalResults[diff];
  const rej = `${d.rejectPct}%`.padStart(7);
  const avg = String(d.avgSteps).padStart(6);
  const max = String(d.maxSteps).padStart(6);
  print(`  D${diff}   | ${rej} | ${avg} | ${max} | ${verdicts[diff-1]}`);
}
print(SEP);

// ─── 写文件 ───────────────────────────────────────────────────────────────────

const outPath = path.join(__dirname, "test-all-difficulties.txt");
// 写入 UTF-8 with BOM，确保中文字符在 Windows 工具中正确显示
const BOM = "\uFEFF";
fs.writeFileSync(outPath, BOM + lines_out.join("\n"), "utf-8");
console.log(`\n报告已写入：${outPath}`);
