/**
 * test-questions.js — 模拟完整出题流程测试
 *
 * 难度 1-4：随机选目标格（无需验证），但仍输出所用技巧供检查
 * 难度 5-6：打乱后验证，只选直观技巧可解的格子
 *
 * 每个难度各出 30 题，输出每题：目标格坐标、答案、技巧列表、是否合规
 */
"use strict";

const path = require("path");
const fs   = require("fs");

const { SudokuGenerator }  = require(path.join(__dirname, "../lib/generator"));
const { solve, formatCompactSteps } = require(path.join(__dirname, "../lib/solver"));

// ─── 非直观技巧（与 game.ts 保持一致） ────────────────────────────────────
const NON_INTUITIVE = new Set([
  "X翼", "剑鱼",    // N-Fish
  "XY翼",           // XY-Wing
  "XYZ翼",          // XYZ-Wing
  "单链着色",       // Simple Coloring
  "XY链",           // XY-Chain
  "X链",            // X-Chain
]);

// ─── 工具 ─────────────────────────────────────────────────────────────────
function cellLabel(r, c) { return String.fromCharCode(65 + r) + (c + 1); }

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 验证目标格 → 仅直观技巧可解时返回 {ok, techs, solveText}，否则返回 {ok:false} */
function check(puzzle, r, c) {
  const res = solve(puzzle, r, c);
  if (!res.success) return { ok: false, reason: "无法求解" };
  const techs = [...new Set(res.steps.map(s => s.technique))];
  const bad   = techs.filter(t => NON_INTUITIVE.has(t));
  if (bad.length > 0) return { ok: false, reason: `含非直观技巧: ${bad.join("、")}`, techs };
  return { ok: true, techs, solveText: formatCompactSteps(res, cellLabel(r, c)) };
}

/** 选目标格：难度5-6验证，其余随机 */
function pickTarget(puzzle, solution, difficulty) {
  const cells = [];
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++)
      if (puzzle[r][c] === 0 && solution[r][c] !== 0)
        cells.push([r, c]);

  if (difficulty === 5 || difficulty === 6) {
    shuffle(cells);
    for (const [r, c] of cells) {
      const v = check(puzzle, r, c);
      if (v.ok) return { row: r, col: c, techs: v.techs, solveText: v.solveText, skipped: cells.indexOf([r,c]) };
    }
    return null; // 无直观格（极罕见，触发重新生成）
  } else {
    const [r, c] = cells[Math.floor(Math.random() * cells.length)];
    const v = check(puzzle, r, c);
    return { row: r, col: c, techs: v.techs || [], ok: v.ok, reason: v.reason };
  }
}

// ─── 主测试 ───────────────────────────────────────────────────────────────
const PUZZLES_PER_DIFF = 30;
const DIFF_NAMES = { 1:"简单", 2:"较易", 3:"中等", 4:"中等+", 5:"困难", 6:"困难+" };

const lines = [];   // 文件输出
function p(s = "") { lines.push(s); console.log(s); }

p("=".repeat(70));
p(`出题流程模拟测试 — 难度 1-6，每档 ${PUZZLES_PER_DIFF} 题`);
p(`生成时间：${new Date().toLocaleString("zh-CN")}`);
p("=".repeat(70));

/** 汇总行 */
const summary = [];

for (const diff of [1, 2, 3, 4, 5, 6]) {
  const gen     = new SudokuGenerator(diff);
  const needVal = diff === 5 || diff === 6;
  const name    = DIFF_NAMES[diff];

  p();
  p("─".repeat(70));
  p(`难度 ${diff}（${name}）${ needVal ? "  ← 已启用直观技巧验证" : "" }`);
  p("─".repeat(70));
  p(`${"编号".padEnd(4)} ${"目标格".padEnd(5)} ${"答案".padEnd(3)} ${"合规".padEnd(4)} 所用技巧`);
  p("-".repeat(70));

  let pass = 0, fail = 0, regen = 0;
  // 统计各技巧出现次数
  const techCount = {};

  for (let i = 1; i <= PUZZLES_PER_DIFF; i++) {
    let puzzle, solution, q;
    // 重新生成最多5次（应对极罕见的"全盘无直观格"情况）
    let attempts = 0;
    while (attempts < 5) {
      attempts++;
      try { ({ puzzle, solution } = gen.generate()); }
      catch { continue; }
      q = pickTarget(puzzle, solution, diff);
      if (q) break;
      regen++;
    }

    if (!q) {
      p(`  ${String(i).padStart(2)}   无法找到合规目标格（已重试 5 次）`);
      fail++;
      continue;
    }

    const label  = cellLabel(q.row, q.col);
    const answer = solution[q.row][q.col];
    const techs  = q.techs || [];
    const ok     = q.ok !== false; // 难度5-6的 ok 来自 check，难度1-4也有

    // 统计技巧
    for (const t of techs) techCount[t] = (techCount[t] || 0) + 1;

    const techStr = techs.length ? techs.join("、") : "（直接确定）";
    const okMark  = ok ? "✓" : "✗";

    p(`  ${String(i).padStart(2)}.  ${label.padEnd(4)} ${String(answer).padEnd(3)} ${okMark.padEnd(4)} ${techStr}`);

    ok ? pass++ : fail++;
  }

  // 本档统计
  p();
  p(`  ✦ 统计：合规 ${pass}／${PUZZLES_PER_DIFF}，不合规 ${fail}，触发重新生成 ${regen} 次`);
  if (fail > 0) p(`  ⚠ 存在 ${fail} 题不合规！`);

  // 技巧频次
  const sorted = Object.entries(techCount).sort((a,b)=>b[1]-a[1]);
  if (sorted.length) {
    p(`  技巧频次：`);
    for (const [t, cnt] of sorted) {
      const bar = "█".repeat(Math.min(cnt, 30));
      p(`    ${t.padEnd(14)} ${String(cnt).padStart(3)} ${bar}`);
    }
  }

  summary.push({ diff, name, pass, fail, regen });
}

// ─── 总汇总 ───────────────────────────────────────────────────────────────
p();
p("=".repeat(70));
p("📊  汇总表");
p("=".repeat(70));
p(`${"档位".padEnd(3)} ${"名称".padEnd(5)} ${"合规".padEnd(5)} ${"不合规".padEnd(5)} 重新生成`);
p("-".repeat(40));
let totalFail = 0;
for (const s of summary) {
  const mark = s.fail > 0 ? "❌" : "✅";
  p(`  ${s.diff}   ${s.name.padEnd(4)} ${String(s.pass).padEnd(5)} ${String(s.fail).padEnd(6)} ${s.regen}  ${mark}`);
  totalFail += s.fail;
}
p();
p(totalFail === 0
  ? "✅  全部 " + (PUZZLES_PER_DIFF * 6) + " 题目标格均符合直观技巧要求！"
  : `❌  共 ${totalFail} 题目标格使用了非直观技巧，请检查！`);

const out = path.join(__dirname, "test-questions-results.txt");
fs.writeFileSync(out, lines.join("\n"), "utf-8");
p();
p(`📄  完整报告：${out}`);
