"use strict";
/**
 * test-single-target.js — 随机格目标求解路径测试
 *
 * 模拟真实游戏场景：对每道题随机选一个空格作为目标格（和游戏一样），
 * 不刻意挑选步骤少的格子，验证求解器的实际推理能力。
 *
 * 每个难度 30 题，控制台输出统计 + 2 个代表性示例，完整结果写入文件。
 *
 * 执行：npm run build && node scripts/test-single-target.js
 */

const path = require("path");
const fs   = require("fs");

const { solve, formatCompactSteps, checkPuzzleIntuitiveSolvable } = require("../lib/solver.js");
const { SudokuGenerator }           = require("../lib/generator.js");

// ─── 工具 ─────────────────────────────────────────────────────────────────────
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

/** Fisher-Yates 洗牌 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 随机选一个空格作为目标（完全模拟游戏行为）。
 * 难度 5：模拟新的严格全盘验证逻辑（整道题废弃重生成）。
 * 返回 { r, c, result, answer, steps, keySteps, nonKeySteps, regenCount }
 */
function pickRandomTarget(puzzle, solution, diff) {
  const empty = [];
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++)
      if (!puzzle[r][c]) empty.push({ r, c });
  if (!empty.length) return null;

  // 随机取一个格子，尝试求解
  const idx = Math.floor(Math.random() * empty.length);
  const { r, c } = empty[idx];
  const result = solve(puzzle, r, c);
  return {
    r, c, result,
    answer:   solution[r][c],
    steps:    result.success ? result.steps.length : 0,
    keySteps: result.success ? result.steps.filter(s => s.affectsTarget).length : 0,
    nonKey:   result.success ? result.steps.filter(s => !s.affectsTarget).length : 0,
  };
}

/**
 * 为难度 5（严格全盘验证模式）生成并验证整道题。
 * 模拟 game.ts 的新逻辑：如果题目含链类技巧则废弃整题重生成。
 * 返回 { puzzle, solution, r, c, result, answer, steps, keySteps, nonKey, regenCount }
 */
function pickD5WithFullValidation(diff) {
  let regenCount = 0;
  const MAX_RETRY = 50;
  while (regenCount <= MAX_RETRY) {
    const gen = new SudokuGenerator(diff);
    const { puzzle, solution } = gen.generate();
    if (!checkPuzzleIntuitiveSolvable(puzzle)) {
      regenCount++;
      continue;
    }
    // 全直观可解：随机选格
    const empty = [];
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (!puzzle[r][c]) empty.push({ r, c });
    if (!empty.length) { regenCount++; continue; }
    const { r, c } = empty[Math.floor(Math.random() * empty.length)];
    const result = solve(puzzle, r, c);
    return {
      puzzle, solution, r, c, result,
      answer:   solution[r][c],
      steps:    result.success ? result.steps.length : 0,
      keySteps: result.success ? result.steps.filter(s => s.affectsTarget).length : 0,
      nonKey:   result.success ? result.steps.filter(s => !s.affectsTarget).length : 0,
      regenCount,
    };
  }
  // 超限降级：使用最后一次生成的题目
  const gen = new SudokuGenerator(diff);
  const { puzzle, solution } = gen.generate();
  const empty = [];
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++)
      if (!puzzle[r][c]) empty.push({ r, c });
  const { r, c } = empty[0];
  const result = solve(puzzle, r, c);
  return {
    puzzle, solution, r, c, result,
    answer: solution[r][c],
    steps:    result.success ? result.steps.length : 0,
    keySteps: result.success ? result.steps.filter(s => s.affectsTarget).length : 0,
    nonKey:   result.success ? result.steps.filter(s => !s.affectsTarget).length : 0,
    regenCount: MAX_RETRY + 1,
  };
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────
const lines_out = [];
function print(msg = "")     { lines_out.push(msg); console.log(msg); }
function fileOnly(msg = "")  { lines_out.push(msg); }

const SEP  = "=".repeat(68);
const LINE = "─".repeat(68);
const DIFF_NAMES  = { 1: "简单", 2: "较易", 3: "中等", 4: "中等+", 5: "困难" };
const SAMPLES     = 30;
const SHOW_EXAMPLES = 2;   // 每个难度控制台展示几个示例

print(SEP);
print("  数独求解路径测试（随机格 · 模拟真实游戏 · 30题×5难度）");
print(`  生成时间：${new Date().toLocaleString("zh-CN")}`);
print(SEP);

let globalOk = 0, globalChain = 0, globalFail = 0;

for (let diff = 1; diff <= 5; diff++) {
  print(`\n${LINE}`);
  print(`  难度 ${diff}（${DIFF_NAMES[diff]}）`);
  print(LINE);

  // 统计容器
  const stepDist = {};    // 总步骤数 → 题数
  const keyDist  = {};    // 关键步骤数 → 题数
  let okCount    = 0;
  let chainCount = 0;     // 超出推理范围（需链类技巧）
  let wrongAns   = 0;
  const allRecords = [];  // 用于选示例

  let totalRegenCount = 0;

  for (let i = 0; i < SAMPLES; i++) {
    let rec, puzzle;
    if (diff === 5) {
      // 模拟严格全盘验证：整道题废弃重生成直到全直观可解
      rec = pickD5WithFullValidation(diff);
      puzzle = rec.puzzle;
      totalRegenCount += (rec.regenCount || 0);
    } else {
      const gen = new SudokuGenerator(diff);
      const { puzzle: p, solution } = gen.generate();
      puzzle = p;
      rec = pickRandomTarget(p, solution, diff);
    }
    if (!rec) continue;
    if (!rec.puzzle) rec.puzzle = puzzle; // 仅 D1-D4 需要补充（D5 已包含）

    const { r, c, result, answer, steps, keySteps } = rec;

    if (!result.success) {
      chainCount++;
      globalChain++;
    } else if (result.answer !== answer) {
      wrongAns++;
      globalFail++;
    } else {
      okCount++;
      globalOk++;
      stepDist[steps]    = (stepDist[steps]    || 0) + 1;
      keyDist[keySteps]  = (keyDist[keySteps]  || 0) + 1;
      allRecords.push(rec);
    }
  }

  // ── 统计输出 ──
  const total = okCount + chainCount + wrongAns;
  let statLine = `  共 ${total} 题  |  ✅ 直观求解成功: ${okCount}  |  ⛔ 需链类技巧: ${chainCount}  |  ❌ 答案错误: ${wrongAns}`;
  if (diff === 5 && totalRegenCount > 0) {
    statLine += `  |  ♻️ 全盘废弃重生成: ${totalRegenCount} 次（平均 ${(totalRegenCount/SAMPLES).toFixed(1)} 次/题）`;
  }
  print(statLine);

  if (Object.keys(stepDist).length > 0) {
    print();
    print("  总步骤数分布：");
    for (const n of Object.keys(stepDist).map(Number).sort((a, b) => a - b)) {
      const bar = "█".repeat(stepDist[n]);
      print(`     ${String(n).padStart(2)} 步 ：${String(stepDist[n]).padStart(3)} 题  ${bar}`);
    }
    print();
    print("  其中关键步骤（直接影响候选数）分布：");
    for (const n of Object.keys(keyDist).map(Number).sort((a, b) => a - b)) {
      const bar = "█".repeat(keyDist[n]);
      print(`     ${String(n).padStart(2)} 个关键步：${String(keyDist[n]).padStart(3)} 题  ${bar}`);
    }
  }

  // ── 控制台示例（优先选多步/有铺垫步骤的，更具代表性）──
  const sortedForShow = [...allRecords].sort(
    (a, b) => b.steps - a.steps || b.nonKey - a.nonKey
  );
  const examples = sortedForShow.slice(0, SHOW_EXAMPLES);

  for (let k = 0; k < examples.length; k++) {
    const { r, c, result, answer, steps, keySteps, nonKey, puzzle } = examples[k];
    const tc = cellLabel(r, c);
    print(`\n  [示例${k + 1}] 目标格 ${tc}（答案${answer}）| 关键步 ${keySteps} | 铺垫步 ${nonKey} | 总 ${steps} 步`);
    print();
    print(renderBoard(puzzle, r, c));
    print();
    print(formatCompactSteps(result, tc));
    print(result.answer === answer ? "\n  ✅ 答案正确" : `\n  ❌ 答案错误（求解=${result.answer} 预期=${answer}）`);
  }

  // ── 全部记录写文件 ──
  fileOnly(`\n${"─".repeat(68)}`);
  fileOnly(`难度${diff} 全部${SAMPLES}题详情`);
  fileOnly("─".repeat(68));
  for (const rec of allRecords) {
    const { r, c, result, answer, steps, keySteps, nonKey, puzzle } = rec;
    const tc = cellLabel(r, c);
    fileOnly(`\n目标格 ${tc}（答案${answer}）| 关键步 ${keySteps} | 铺垫步 ${nonKey} | 总 ${steps} 步`);
    fileOnly(renderBoard(puzzle, r, c));
    fileOnly(formatCompactSteps(result, tc));
    fileOnly(result.answer === answer ? "✅ 正确" : `❌ 错误（求解=${result.answer}）`);
  }
}

// ── 全局汇总 ──
print(`\n${SEP}`);
print("  全局汇总（难度1-5 共150题）");
print(SEP);
print(`  ✅ 直观求解成功: ${globalOk}  |  ⛔ 需链类技巧: ${globalChain}  |  ❌ 答案错误: ${globalFail}`);
print(SEP);

const outPath = path.join(__dirname, "test-single-target.txt");
fs.writeFileSync(outPath, "\uFEFF" + lines_out.join("\n"), "utf-8");
console.log(`\n📄 完整报告已写入：${outPath}`);
