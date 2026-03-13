/**
 * test-solver.js — 数独求解算法本地测试脚本
 *
 * 使用方式（在插件根目录下）：
 *   npm run test:solver
 * 或分步执行：
 *   npm run build
 *   node scripts/test-solver.js
 *
 * 输出：
 *   - 控制台（summary）
 *   - scripts/test-results.txt（完整报告）
 */

"use strict";

const path = require("path");
const fs = require("fs");

// 加载编译产物（需先 npm run build）
const solverPath = path.join(__dirname, "../lib/solver.js");
if (!fs.existsSync(solverPath)) {
  console.error("❌ 找不到编译产物 lib/solver.js，请先执行 npm run build");
  process.exit(1);
}
const { solve, formatCompactSteps } = require(solverPath);

// 加载测试题目
const puzzles = require("./test-puzzles.json").puzzles;

// ========================= 工具 =========================

const LEVEL_NAMES = ["", "入门(L1)", "基础(L2)", "中级(L3)", "进阶(L4)", "高阶(L5)"];
  const DIFFICULTY_DISPLAY = { easy: "简单", medium: "中等", hard: "困难", expert: "专家" };

function rowLabel(r) { return String.fromCharCode(65 + r); }
function cellLabel(r, c) { return `${rowLabel(r)}${c + 1}`; }

function renderPuzzle(puzzle) {
  const lines = [];
  for (let r = 0; r < 9; r++) {
    if (r === 3 || r === 6) lines.push("------+-------+------");
    const row = puzzle[r]
      .map((v, c) => {
        const s = v === 0 ? "." : String(v);
        return (c === 2 || c === 5) ? s + " |" : s;
      })
      .join(" ");
    lines.push(row);
  }
  return lines.join("\n");
}

/**
 * 紧凑格式化：只显示影响目标格的步骤，每步一行。
 * 直接调用 solver.js 导出的 formatCompactSteps()。
 */
function formatFullPath(result, targetRow, targetCol) {
  const tc = cellLabel(targetRow, targetCol);
  const compact = formatCompactSteps(result, tc);

  if (!result.success) {
    return compact;
  }

  // 在紧凑结果后附加统计信息（仅写文件，便于调试）
  const relevant = result.steps.filter(s => s.affectsTarget);
  const usedTechs = [...new Set(result.steps.filter(s => s.affectsTarget).map(s => s.technique))].join(" · ");
  const extra = [
    `技巧路径：${usedTechs || "初始消除"}`,
    `有效步骤：${relevant.length} 步（共 ${result.steps.length} 步内部推理）`,
  ];

  return compact + "\n" + extra.join("  |  ");
}

// ========================= 测试主流程 =========================

const output = [];
const sep = "=".repeat(62);

function log(msg = "") {
  output.push(msg);
  // 只在控制台打印摘要行（★ 标记的步骤 + 关键信息）
}

function print(msg = "") {
  output.push(msg);
  console.log(msg);
}

function logOnly(msg = "") {
  output.push(msg); // 只写文件，不打印控制台
}

print(`${"=".repeat(62)}`);
print(`数独求解算法测试报告`);
print(`生成时间：${new Date().toLocaleString("zh-CN")}`);
print(`${"=".repeat(62)}`);

let globalSolvedCount = 0;
let globalFailedCount = 0;
let globalWrongCount = 0;

for (const puzzle of puzzles) {
  print();
  print(sep);
  print(`题目 [${puzzle.id}]：${puzzle.name}（${DIFFICULTY_DISPLAY[puzzle.difficulty] || puzzle.difficulty}）`);
  print(sep);

  logOnly();
  logOnly("题目盘面（. = 空格）：");
  logOnly(renderPuzzle(puzzle.puzzle));

  // 收集所有空格
  const emptyCells = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (puzzle.puzzle[r][c] === 0) {
        emptyCells.push({ r, c, answer: puzzle.solution[r][c] });
      }
    }
  }

  // 对所有空格运行求解
  const stats = { byLevel: {}, failed: 0, verified: 0, wrong: 0 };
  const allResults = [];

  for (const cell of emptyCells) {
    const result = solve(puzzle.puzzle, cell.r, cell.c);
    allResults.push({ ...cell, result });

    if (result.success) {
      const lv = result.maxLevel;
      stats.byLevel[lv] = (stats.byLevel[lv] || 0) + 1;
      if (result.answer === cell.answer) {
        stats.verified++;
        globalSolvedCount++;
      } else {
        stats.wrong++;
        globalWrongCount++;
      }
    } else {
      stats.failed++;
      globalFailedCount++;
    }
  }

  // 打印摘要
  const total = emptyCells.length;
  const solved = total - stats.failed;
  print();
  print(`空格总数：${total}  |  成功求解：${solved}  |  验证正确：${stats.verified}  |  答案错误：${stats.wrong}  |  超出支持范围：${stats.failed}`);
  print();

  const levelOrder = [1, 2, 3, 4, 5].filter((lv) => stats.byLevel[lv] > 0);
  if (levelOrder.length > 0) {
    print("按层级分布：");
    for (const lv of levelOrder) {
      print(`  L${lv}（${LEVEL_NAMES[lv]}）：${stats.byLevel[lv]} 格`);
    }
  }
  if (stats.failed > 0) {
    print(`  超出范围：${stats.failed} 格（需更高阶技巧）`);
  }
  if (stats.wrong > 0) {
    print(`  ⚠️  有 ${stats.wrong} 格求解结果与已知答案不符，请检查算法！`);
  }

  // 打印所有格的简洁结果表
  logOnly();
  logOnly("--- 全部空格求解结果 ---");
  logOnly("格子  | 预期 | 求解 | 层级 | 步数 | 状态");
  logOnly("-".repeat(48));
  for (const { r, c, answer, result } of allResults) {
    const cell = cellLabel(r, c);
    if (result.success) {
      const correct = result.answer === answer ? "✓" : "✗答案错误";
      logOnly(`${cell.padEnd(5)} | ${answer}    | ${result.answer}    | L${result.maxLevel}   | ${String(result.steps.length).padEnd(4)} | ${correct}`);
    } else {
      logOnly(`${cell.padEnd(5)} | ${answer}    | -    | -     | -    | 超出L3`);
    }
  }

  // 为 spotlight 目标输出详细求解路径
  const spotlights = puzzle.spotlightTargets || [];
  if (spotlights.length > 0) {
    logOnly();
    logOnly("--- 重点格详细推理路径 ---");
    for (const target of spotlights) {
      const found = allResults.find((x) => x.r === target.row && x.c === target.col);
      if (!found) continue;

      logOnly();
      logOnly("─".repeat(52));
      logOnly(`详解：格 ${target.label}（行=${target.row + 1} 列=${target.col + 1}）  预期答案：${found.answer}`);
      logOnly("─".repeat(52));
      logOnly(formatFullPath(found.result, target.row, target.col));
    }
  }

  // 控制台额外输出：spotlight 紧凑推理路径
  if (spotlights.length > 0) {
    print();
    print("重点格紧凑推理路径：");
    for (const target of spotlights) {
      const found = allResults.find((x) => x.r === target.row && x.c === target.col);
      if (!found) continue;
      const r = found.result;
      print("");
      print(formatCompactSteps(r, target.label));
    }
  }
}

// 全局汇总
print();
print(sep);
print("全局测试汇总");
print(sep);
print(`总空格数：${globalSolvedCount + globalFailedCount + globalWrongCount}`);
print(`成功求解且答案正确：${globalSolvedCount}`);
print(`求解成功但答案错误：${globalWrongCount}`);
print(`超出当前支持范围：${globalFailedCount}`);
print(
  globalWrongCount === 0
    ? "✅ 所有成功求解的格子答案均正确"
    : `❌ 有 ${globalWrongCount} 格答案错误，算法存在问题！`
);

// 写出完整报告
const outPath = path.join(__dirname, "test-results.txt");
fs.writeFileSync(outPath, output.join("\n"), "utf-8");
console.log();
console.log(`📄 完整报告已写入：${outPath}`);
