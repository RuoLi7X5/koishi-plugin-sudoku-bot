/**
 * test-difficulty.js — 分难度档位求解能力测试
 *
 * 使用方式：
 *   npm run build && node scripts/test-difficulty.js
 *
 * 功能：
 *   - 对 7 个难度档位各生成 30 道题，全量空格求解，验证解出率与正确性。
 *   - 追踪使用了 XY翼 / XYZ翼 / 单链着色 / XY链 / X链 才能解出的格子，
 *     并将首次出现的样例题目（盘面 + 目标格 + 解题路径）整理输出。
 */

"use strict";

const path = require("path");
const fs = require("fs");

const generatorPath = path.join(__dirname, "../lib/generator.js");
const solverPath = path.join(__dirname, "../lib/solver.js");

for (const p of [generatorPath, solverPath]) {
  if (!fs.existsSync(p)) {
    console.error(`❌ 找不到 ${p}，请先执行 npm run build`);
    process.exit(1);
  }
}

const { SudokuGenerator } = require(generatorPath);
const { solve, formatCompactSteps } = require(solverPath);

// ─── 工具 ────────────────────────────────────────────────────────
function rowLabel(r) { return String.fromCharCode(65 + r); }
function cellLabel(r, c) { return `${rowLabel(r)}${c + 1}`; }

/** 将 9×9 盘面格式化为可读字符串 */
function formatGrid(puzzle) {
  const lines = [];
  for (let r = 0; r < 9; r++) {
    let row = "";
    for (let c = 0; c < 9; c++) {
      if (c > 0 && c % 3 === 0) row += " │ ";
      else if (c > 0) row += " ";
      row += puzzle[r][c] === 0 ? "." : puzzle[r][c];
    }
    if (r > 0 && r % 3 === 0) lines.push("──────┼───────┼──────");
    lines.push(row);
  }
  return lines.map(l => "  " + l).join("\n");
}

const PUZZLES_PER_LEVEL = 40;
const DIFFICULTIES = [1, 2, 3, 4, 5, 6, 7];
const DIFF_NAMES = { 1:"简单", 2:"较易", 3:"中等", 4:"中等+", 5:"困难", 6:"困难+", 7:"极难" };

// 追踪"高级技巧"（L4+）：包含 XY翼/XYZ翼/N-Fish 系列以及新增链结构
// N-Fish 系列（L4，之前已实现）："X翼"=X-Wing，"剑鱼"=Swordfish
// 本次新增（L4-L5）："XYZ翼", "单链着色", "XY链", "X链"
const CHAIN_TECHNIQUES = new Set([
  "X翼", "剑鱼",           // N-Fish (L4，既有)
  "XY翼",                  // XY-Wing (L4，既有)
  "XYZ翼",                 // XYZ-Wing (L4，新增)
  "单链着色",              // Simple Coloring (L4，新增)
  "XY链",                  // XY-Chain (L5，新增)
  "X链",                   // X-Chain (L5，新增)
]);
const NEW_CHAIN_TECHNIQUES = new Set(["XYZ翼", "单链着色", "XY链", "X链"]); // 本次新增

const output = [];
function log(msg = "") { output.push(msg); }
function print(msg = "") { output.push(msg); console.log(msg); }

// ─── 主测试循环 ─────────────────────────────────────────────────
const sep = "=".repeat(68);
print(sep);
print(`数独求解能力 —— 分难度级别测试（每档 ${PUZZLES_PER_LEVEL} 道题）`);
print(`生成时间：${new Date().toLocaleString("zh-CN")}`);
print(sep);

const summary = [];

/**
 * 每个档位收集最多 MAX_SAMPLES 个"需要高级技巧"的样例
 * key: 技巧名, value: 样例列表
 */
const MAX_SAMPLES_PER_TECH = 2; // 每种技巧保留前2个样例

for (const diff of DIFFICULTIES) {
  const gen = new SudokuGenerator(diff);
  const diffName = DIFF_NAMES[diff] || diff;

  print();
  print(`${"─".repeat(68)}`);
  print(`难度 ${diff}（${diffName}）：生成 ${PUZZLES_PER_LEVEL} 道题，全量空格测试`);
  print(`${"─".repeat(68)}`);

  let totalCells = 0;
  let solvedCells = 0;
  let failedCells = 0;
  let wrongCells = 0;
  let totalGivens = 0;

  /** 链结构样例：techName → [{puzzleIdx, puzzle, targetRow, targetCol, expected, steps, text}] */
  const chainSamples = {};
  /** 解不出的格子样例 */
  const failedSamples = [];

  for (let i = 0; i < PUZZLES_PER_LEVEL; i++) {
    let puzzle, solution;
    try {
      ({ puzzle, solution } = gen.generate());
    } catch (err) {
      continue;
    }
    totalGivens += puzzle.flat().filter(v => v !== 0).length;

    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (puzzle[r][c] !== 0) continue;
        totalCells++;
        const expected = solution[r][c];
        const result = solve(puzzle, r, c);

        if (!result.success) {
          failedCells++;
          if (failedSamples.length < 3) {
            failedSamples.push({ puzzleIdx: i + 1, puzzle, targetRow: r, targetCol: c,
              expected, remainCands: result.remainingCands });
          }
          continue;
        }

        solvedCells++;
        if (result.answer !== expected) {
          wrongCells++;
          continue;
        }

        // 收集使用了高级技巧（L4+）的样例（仅针对难度 1-6）
        if (diff <= 6) {
          const usedTechs = result.steps
            .filter(s => CHAIN_TECHNIQUES.has(s.technique))
            .map(s => s.technique);
          const uniqueTechs = [...new Set(usedTechs)];
          for (const tech of uniqueTechs) {
            if (!chainSamples[tech]) chainSamples[tech] = [];
            if (chainSamples[tech].length < MAX_SAMPLES_PER_TECH) {
              // 标记是否为本次新增技巧
              const isNew = NEW_CHAIN_TECHNIQUES.has(tech);
              chainSamples[tech].push({
                puzzleIdx: i + 1,
                puzzle,
                targetRow: r,
                targetCol: c,
                expected,
                isNew,
                text: formatCompactSteps(result, cellLabel(r, c)),
              });
            }
          }
        }
      }
    }
  }

  const solvedPct = totalCells > 0 ? ((solvedCells / totalCells) * 100).toFixed(1) : "0.0";
  const avgGivens = (totalGivens / PUZZLES_PER_LEVEL).toFixed(1);

  print();
  print(`平均线索数：${avgGivens} 格`);
  print(`空格总数：${totalCells}  |  解出：${solvedCells}（${solvedPct}%）  |  超出范围：${failedCells}  |  答案错误：${wrongCells}`);

  // ── 高级技巧样例（难度 1-6） ──
  const techNames = Object.keys(chainSamples);
  if (techNames.length > 0) {
    const newTechs = techNames.filter(t => NEW_CHAIN_TECHNIQUES.has(t));
    const oldTechs = techNames.filter(t => !NEW_CHAIN_TECHNIQUES.has(t));
    print();
    print(`  ✦ 需要高级技巧（L4+）解出的格子样例：`);
    if (newTechs.length > 0) print(`    ★ 本次新增：${newTechs.join("、")}`);
    if (oldTechs.length > 0) print(`    · 既有技巧：${oldTechs.join("、")}`);
    // 先输出新增技巧样例，再输出既有技巧样例
    const order = [...newTechs, ...oldTechs];
    for (const tech of order) {
      const samples = chainSamples[tech];
      const tag = NEW_CHAIN_TECHNIQUES.has(tech) ? "★新增" : "·既有";
      print(`\n  ┌── [${tag}] ${tech} — ${samples.length} 个样例`);
      for (const s of samples) {
        const label = cellLabel(s.targetRow, s.targetCol);
        print(`  │ 第${s.puzzleIdx}道题  目标格 ${label}（答案=${s.expected}）`);
        print(`  │ 盘面：`);
        for (const line of formatGrid(s.puzzle).split("\n")) {
          print(`  │   ${line.trim()}`);
        }
        print(`  │ 解法：`);
        for (const line of s.text.split("\n")) {
          print(`  │   ${line}`);
        }
      }
      print(`  └${"─".repeat(60)}`);
    }
  } else if (diff <= 6) {
    print();
    print(`  ℹ  本批次所有格子均由 L1-L3 基础技巧解出，无需高级技巧（随机有差异，可重新运行）`);
  }

  // ── 解不出的格子样例（仅展示前3个，各难度均关心） ──
  if (failedSamples.length > 0) {
    const label_ = diff <= 6 ? "⚠ 超出推理范围（这是问题！难度1-6不应该有）" : "ℹ 超出推理范围（难度7预期）";
    print();
    print(`  ${label_}（${failedCells} 格，以下展示前3个样例）：`);
    for (const s of failedSamples) {
      const label = cellLabel(s.targetRow, s.targetCol);
      print(`\n  ┌── 第${s.puzzleIdx}道题  目标格 ${label}（答案=${s.expected}，候选数剩余：[${s.remainCands?.join(",")}]）`);
      print(`  │ 盘面：`);
      for (const line of formatGrid(s.puzzle).split("\n")) {
        print(`  │   ${line.trim()}`);
      }
      print(`  └${"─".repeat(60)}`);
    }
  }

  summary.push({ diff, diffName, totalCells, solvedCells, failedCells, wrongCells, solvedPct, avgGivens });
}

// ─── 汇总表格 ────────────────────────────────────────────────────
print();
print(sep);
print("📊  各难度档位求解能力汇总");
print(sep);
print("档位  | 名称   | 平均线索 | 总空格  | 解出率    | 超出范围 | 答案错误");
print("─".repeat(68));

for (const s of summary) {
  const mark = s.wrongCells > 0 ? "✗" : s.failedCells > 0 ? "⚠" : "✓";
  print(
    `  ${s.diff}   | ${s.diffName.padEnd(4)} | ${String(s.avgGivens).padEnd(8)} | ${String(s.totalCells).padEnd(7)} | ${(s.solvedPct + "%").padEnd(9)} | ${String(s.failedCells).padEnd(8)} | ${s.wrongCells} ${mark}`
  );
}

print();
if (summary.every(s => s.wrongCells === 0)) {
  print("✅  所有成功求解的格子答案均正确");
} else {
  const bad = summary.filter(s => s.wrongCells > 0).map(s => `难度${s.diff}(${s.wrongCells}个错误)`).join("、");
  print(`❌  存在错误答案：${bad}`);
}
const failLevels = summary.filter(s => s.failedCells > 0).map(s => `难度${s.diff}`);
if (failLevels.length === 0) {
  print("🎉  全部难度档位 100% 解出！");
} else {
  print(`ℹ   超出支持范围的档位：${failLevels.join("、")}`);
}

// ─── 写入文件 ────────────────────────────────────────────────────
const reportPath = path.join(__dirname, "test-difficulty-results.txt");
fs.writeFileSync(reportPath, output.join("\n"), "utf-8");
print();
print(`📄  完整报告已写入：${reportPath}`);
