/**
 * training/builder.ts
 *
 * 训练题目生成器
 *
 * D3~D6: 随机解 + 贪心移除（generate-and-filter 模式）
 * D7~D8: JE 种子定向构造（Construction with Intent 模式）
 *
 * JE（联合排除）构造流程：
 *   1. 扫描随机解，找到"天然的 JE 机会"（findJESeeds）
 *   2. 计算激活该 JE 所需清空的所有格（requiredEmpties）
 *   3. 先清空激活格，再做标准贪心移除（buildFromJESeed）
 *   4. 验证求解轨迹确实包含联合排除，且难度符合 D7/D8
 *
 * 难度 → 最大技巧层级映射：
 *   D3-D4: maxLevel=2（仅 L2：指向排除、区块行列法）
 *   D5-D8: maxLevel=3（L2+L3：显性/隐性数对、三数组）
 *   D7/D8 通过 classifyDifficulty 的联合排除检测与步骤数区分，而非 L4 技巧。
 */

import {
  trainingSolve,
  isExactlyOneDeducible,
  getDeducibleCells,
  TrainingTrace,
} from './solver';

// ═══════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════

/**
 * 各难度对应的最大技巧层级
 *
 * D3-D4: 仅 L2（指向排除、区块行列法）
 * D5-D8: L2+L3（显性/隐性数对/三数组）
 *
 * 注意：D7/D8 同样使用 maxLevel=3，通过"联合排除"复杂度由 classifyDifficulty 区分。
 * 不使用 maxLevel=4（naked quad），因为裸四数组在随机数独中极为罕见，无法可靠生成题库。
 */
export const DIFFICULTY_MAX_LEVEL: Record<number, number> = {
  3: 2, 4: 2, 5: 3, 6: 3, 7: 3, 8: 3,
};

/**
 * 各难度对应的最大尝试次数
 *
 * D7/D8 采用 JE 种子构造，成功率大幅高于随机，500 次足够。
 * D3~D6 仍靠随机贪心，需要更多次数。
 */
const MAX_ATTEMPTS: Record<number, number> = {
  3: 600, 4: 800, 5: 1000, 6: 1500, 7: 500, 8: 800,
};

/** 目标难度允许的容差（classified difficulty = target ± tolerance） */
const DIFFICULTY_TOLERANCE: Record<number, [number, number]> = {
  3: [3, 3], 4: [4, 4], 5: [5, 5], 6: [6, 6], 7: [7, 7], 8: [8, 9],
};

// ═══════════════════════════════════════════════════════════════
// 完整数独解生成（回溯法）
// ═══════════════════════════════════════════════════════════════

/** 随机打乱数组（Fisher-Yates） */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 生成一个完整的随机合法数独解（9×9，值 1-9） */
export function generateSolution(): number[][] {
  const board: number[][] = Array.from({ length: 9 }, () => Array(9).fill(0));

  function isValid(r: number, c: number, d: number): boolean {
    for (let j = 0; j < 9; j++) {
      if (board[r][j] === d || board[j][c] === d) return false;
    }
    const br = Math.floor(r / 3) * 3, bc = Math.floor(c / 3) * 3;
    for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
      if (board[br + dr][bc + dc] === d) return false;
    }
    return true;
  }

  function solve(idx: number): boolean {
    if (idx === 81) return true;
    const r = Math.floor(idx / 9), c = idx % 9;
    const digits = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const d of digits) {
      if (isValid(r, c, d)) {
        board[r][c] = d;
        if (solve(idx + 1)) return true;
        board[r][c] = 0;
      }
    }
    return false;
  }

  solve(0);
  return board;
}

// ═══════════════════════════════════════════════════════════════
// D7/D8 专用：联合排除（JE）种子定向构造
// ═══════════════════════════════════════════════════════════════

/**
 * JE 种子：描述一个可激活的"联合排除"结构。
 *
 * 结构说明：
 *   宫 B 内格子 C1, C2 的值分别为 d1, d2，构成 naked pair {d1,d2}。
 *   为使该 naked pair 成立，需要满足：
 *     - C1 能以 d2 为候选（d2 被 L1 逐出 C1 的途径全部清空）
 *     - C2 能以 d1 为候选（同上）
 *     - 来自 ≥2 个不同源宫的指向排除将多余候选从 C1/C2 中消除
 *   requiredEmpties 中包含实现以上条件所需清空的全部格坐标。
 */
interface JESeed {
  boxBr: number;
  boxBc: number;
  setCells: [[number, number], [number, number]];
  setDigits: [number, number];
  /** 激活此 JE 结构需要清空的所有格（含 C1, C2 以及各激活格） */
  requiredEmpties: [number, number][];
  /** 提供指向排除的不同源宫数量（越大越好） */
  sourceBoxCount: number;
}

/**
 * 在给定完整解中扫描所有可激活的 JE 种子。
 *
 * 原理：
 *   对于宫 B 内的任意两格 C1=(r1,c1)、C2=(r2,c2)，设 d1=sol[C1]、d2=sol[C2]：
 *   1. 计算使 d2 成为 C1 候选、d1 成为 C2 候选所需清空的格
 *   2. 在 C1 所在行（row r1）和 C2 所在行（row r2），于宫 B 之外寻找
 *      可产生指向排除的"源格"，来自不同源宫的指向各消除 C1/C2 的一个多余候选
 *   3. 若源宫数 ≥ 2，则记录为 JE 种子
 *
 * 每个候选的激活格集合同时包含：
 *   - 源格本身（pointing 激活）
 *   - 多余候选 e 在目标格所在列的格（消除列障碍）
 *   - 多余候选 e 在宫 B 内的格（消除宫障碍）
 */
function findJESeeds(solution: number[][]): JESeed[] {
  const seeds: JESeed[] = [];

  for (let br = 0; br < 9; br += 3) {
    for (let bc = 0; bc < 9; bc += 3) {
      for (let di = 0; di < 9; di++) {
        for (let dj = di + 1; dj < 9; dj++) {
          const r1 = br + Math.floor(di / 3), c1 = bc + (di % 3);
          const r2 = br + Math.floor(dj / 3), c2 = bc + (dj % 3);
          const d1 = solution[r1][c1], d2 = solution[r2][c2];

          const reqSet = new Set<string>();
          reqSet.add(`${r1},${c1}`);
          reqSet.add(`${r2},${c2}`);

          // ── 使 d2 成为 C1 的候选 ──────────────────────────────────────
          // d2 在 row r1（宫 B 外）→ 清空
          for (let c = 0; c < 9; c++) {
            if (c < bc || c >= bc + 3) {
              if (solution[r1][c] === d2) { reqSet.add(`${r1},${c}`); break; }
            }
          }
          // d2 在 col c1（非 C2 时）→ 清空
          for (let r = 0; r < 9; r++) {
            if (r !== r1 && solution[r][c1] === d2) {
              if (!(r === r2 && c1 === c2)) reqSet.add(`${r},${c1}`);
              break;
            }
          }

          // ── 使 d1 成为 C2 的候选 ──────────────────────────────────────
          // d1 在 row r2（宫 B 外）→ 清空
          for (let c = 0; c < 9; c++) {
            if (c < bc || c >= bc + 3) {
              if (solution[r2][c] === d1) { reqSet.add(`${r2},${c}`); break; }
            }
          }
          // d1 在 col c2（非 C1 时）→ 清空
          for (let r = 0; r < 9; r++) {
            if (r !== r2 && solution[r][c2] === d1) {
              if (!(r === r1 && c2 === c1)) reqSet.add(`${r},${c2}`);
              break;
            }
          }

          // ── 寻找 ≥2 个不同源宫的指向排除 ─────────────────────────────
          const sourceBoxes = new Set<string>();

          /**
           * 尝试将 (srcRow, srcCol) 加入为指向排除源。
           * tCol：目标格的列（excess digit 需要从该列的格中被清除，
           *        使 excess digit 成为目标格候选）。
           */
          const trySource = (srcRow: number, srcCol: number, tCol: number): boolean => {
            const e = solution[srcRow][srcCol];
            if (e === d1 || e === d2) return false;
            const bk = `${Math.floor(srcRow / 3) * 3},${Math.floor(srcCol / 3) * 3}`;
            if (sourceBoxes.has(bk)) return false;

            // 激活格 1：源格本身（pointing 激活）
            const act: string[] = [`${srcRow},${srcCol}`];

            // 激活格 2：e 在目标格所在列（使 e 能成为目标格的候选）
            for (let r = 0; r < 9; r++) {
              if (r !== srcRow && solution[r][tCol] === e) { act.push(`${r},${tCol}`); break; }
            }

            // 激活格 3：e 在宫 B 中的格（使 e 不被宫 B 排除）
            for (let dr = 0; dr < 3; dr++) {
              for (let dc = 0; dc < 3; dc++) {
                const rb = br + dr, cb = bc + dc;
                if ((rb === r1 && cb === c1) || (rb === r2 && cb === c2)) continue;
                if (solution[rb][cb] === e) { act.push(`${rb},${cb}`); }
              }
            }

            sourceBoxes.add(bk);
            for (const k of act) reqSet.add(k);
            return true;
          };

          // C1 的指向来源（row r1 上宫 B 外的格）
          for (let c = 0; c < 9; c++) {
            if (c >= bc && c < bc + 3) continue;
            if (trySource(r1, c, c1)) break;
          }
          // C2 的指向来源（row r2 上宫 B 外，来自不同于 C1 来源的宫）
          for (let c = 0; c < 9; c++) {
            if (c >= bc && c < bc + 3) continue;
            if (trySource(r2, c, c2)) break;
          }

          // 需要 ≥2 个不同源宫，且总激活格数在合理范围内
          if (sourceBoxes.size >= 2 && reqSet.size <= 24) {
            const requiredEmpties = [...reqSet].map(k => k.split(',').map(Number) as [number, number]);
            seeds.push({
              boxBr: br, boxBc: bc,
              setCells: [[r1, c1], [r2, c2]],
              setDigits: [d1, d2],
              requiredEmpties,
              sourceBoxCount: sourceBoxes.size,
            });
          }
        }
      }
    }
  }

  // 优先选源宫多（JE 更稳健）、激活格少（题目更紧凑）的种子
  seeds.sort((a, b) =>
    b.sourceBoxCount - a.sourceBoxCount || a.requiredEmpties.length - b.requiredEmpties.length,
  );
  return seeds.slice(0, 10); // 每个解保留前 10 个最优种子
}

/**
 * 基于 JE 种子做定向构建：
 *   1. 清空目标格
 *   2. 清空种子的所有激活格（激活 JE 结构）
 *   3. 验证目标格此时仍是唯一可推出格
 *   4. 标准贪心移除剩余格
 *   5. 验证求解轨迹难度符合 D7/D8
 */
function buildFromJESeed(
  solution: number[][],
  seed: JESeed,
  tr: number, tc: number,
  maxLevel: number, minDiff: number, maxDiff: number,
): BuildResult | null {
  // 目标格不能是 naked set 格（naked set 是推理中间步骤，不是答案）
  if (seed.setCells.some(([r, c]) => r === tr && c === tc)) return null;

  const puzzle = solution.map(row => [...row]);
  const answer = solution[tr][tc];
  puzzle[tr][tc] = 0;

  // 清空所有 JE 激活格
  for (const [r, c] of seed.requiredEmpties) {
    if (r === tr && c === tc) continue; // 目标格已清空
    puzzle[r][c] = 0;
  }

  // 验证：激活后目标格仍唯一可推
  if (!isExactlyOneDeducible(puzzle, tr, tc, maxLevel)) return null;

  // 贪心移除剩余已填格
  const remaining: [number, number][] = [];
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    if (puzzle[r][c] !== 0) remaining.push([r, c]);
  }
  shuffle(remaining);

  for (const [r, c] of remaining) {
    const saved = puzzle[r][c];
    puzzle[r][c] = 0;
    if (!isExactlyOneDeducible(puzzle, tr, tc, maxLevel)) {
      puzzle[r][c] = saved;
    }
  }

  // 验证推理轨迹与难度
  const trace = trainingSolve(puzzle, tr, tc, maxLevel);
  if (!trace) return null;
  if (trace.difficulty < minDiff || trace.difficulty > maxDiff) return null;

  // 验证目标格在低一层技巧下不可推出（确保 L3 是必要的）
  const lowerLevel = maxLevel - 1;
  if (lowerLevel >= 1) {
    const lowerDeducible = getDeducibleCells(puzzle, lowerLevel);
    if (lowerDeducible.has(`${tr},${tc}`)) return null;
  }

  return { puzzle, targetRow: tr, targetCol: tc, answer, trace };
}

/**
 * D7/D8 专用生成入口：JE 种子定向构造。
 * 不依赖大量随机重试，而是在每个解中主动寻找 JE 机会后定向构建。
 *
 * maxAttempts 表示最多尝试的"解"的数量（每个解内部尽力穷举所有种子×目标格组合）。
 * 注意：不能将每个 (种子, 目标格) 组合都计入 attempts，否则每个解的 810 次组合
 * 会立即耗尽上限，导致永远无法尝试第二个解。
 */
function generateD78Puzzle(
  difficulty: number,
  maxLevel: number,
  minDiff: number,
  maxDiff: number,
  maxAttempts: number,
): BuildResult {
  for (let solutionRoll = 0; solutionRoll < maxAttempts; solutionRoll++) {
    const solution = generateSolution();
    const seeds = findJESeeds(solution);
    if (seeds.length === 0) continue;

    // 随机顺序尝试目标格（每个解只生成一次，所有种子复用同一随机顺序）
    const targetCandidates: [number, number][] = [];
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) targetCandidates.push([r, c]);
    shuffle(targetCandidates);

    for (const seed of seeds) {
      for (const [tr, tc] of targetCandidates) {
        const result = buildFromJESeed(solution, seed, tr, tc, maxLevel, minDiff, maxDiff);
        if (result) return result;
      }
    }
  }

  throw new Error(`D${difficulty} JE 构造失败，已尝试 ${maxAttempts} 个解`);
}

// ═══════════════════════════════════════════════════════════════
// D3~D6 核心：贪心移除法构建题目
// ═══════════════════════════════════════════════════════════════

export interface BuildResult {
  puzzle: number[][];
  targetRow: number;
  targetCol: number;
  answer: number;
  trace: TrainingTrace;
}

/**
 * 尝试一次构建：
 *   solution  - 完整数独解
 *   tr, tc    - 目标格坐标
 *   maxLevel  - 最大技巧层级（2/3/4）
 *   minDiff   - 接受的最小难度
 *   maxDiff   - 接受的最大难度
 */
function buildOnce(
  solution: number[][],
  tr: number,
  tc: number,
  maxLevel: number,
  minDiff: number,
  maxDiff: number,
): BuildResult | null {
  const puzzle = solution.map(row => [...row]);
  const answer = solution[tr][tc];
  puzzle[tr][tc] = 0;

  // 确保目标格的答案在初始直接候选中存在（最基本的合法性）
  // 若直接 naked single，则此格太简单，需要通过移除使其变复杂

  // 随机排列其他所有格，尝试移除
  const allOther: [number, number][] = [];
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    if (r === tr && c === tc) continue;
    allOther.push([r, c]);
  }
  shuffle(allOther);

  // 贪心移除：每次移除后验证"唯一目标格可推"
  for (const [r, c] of allOther) {
    const saved = puzzle[r][c];
    if (saved === 0) continue; // 已经是空格（理论上不会，但防御性代码）
    puzzle[r][c] = 0;
    if (!isExactlyOneDeducible(puzzle, tr, tc, maxLevel)) {
      puzzle[r][c] = saved; // 撤销
    }
  }

  // 求解目标格，获取推理轨迹
  const trace = trainingSolve(puzzle, tr, tc, maxLevel);
  if (!trace) return null;

  // 难度检查
  if (trace.difficulty < minDiff || trace.difficulty > maxDiff) return null;

  // 对于 D3/D4（maxLevel=2），确认目标格在 L1 层级下不可推出
  // 对于 D5/D6（maxLevel=3），确认在 L2 层级下不可推出
  if (maxLevel >= 2 && minDiff >= 3) {
    const lowerLevel = maxLevel - 1;
    if (lowerLevel >= 1) {
      const lowerDeducible = getDeducibleCells(puzzle, lowerLevel);
      if (lowerDeducible.has(`${tr},${tc}`)) {
        // 目标格在低一级技巧下就能推出，难度不够
        return null;
      }
    }
  }

  return { puzzle, targetRow: tr, targetCol: tc, answer, trace };
}

// ═══════════════════════════════════════════════════════════════
// 公开接口：生成指定难度的训练题目
// ═══════════════════════════════════════════════════════════════

/**
 * 生成一道指定难度的训练题目。
 * difficulty: 3~8
 *
 * D7/D8 → JE 种子定向构造（保证联合排除出现）
 * D3~D6 → 随机解 + 贪心移除
 *
 * 返回 BuildResult 或抛出 Error（尝试次数耗尽）
 */
export function generateTrainingPuzzle(difficulty: number): BuildResult {
  const maxLevel = DIFFICULTY_MAX_LEVEL[difficulty] ?? 3;
  const [minDiff, maxDiff] = DIFFICULTY_TOLERANCE[difficulty] ?? [difficulty, difficulty];
  const maxAttempts = MAX_ATTEMPTS[difficulty] ?? 1000;

  // D7/D8 使用 JE 种子定向构造
  if (difficulty >= 7) {
    return generateD78Puzzle(difficulty, maxLevel, minDiff, maxDiff, maxAttempts);
  }

  // D3~D6 使用随机贪心生成
  let solutionAttempts = 0;
  const maxSolutionRolls = Math.ceil(maxAttempts / 5);

  for (let sa = 0; sa < maxSolutionRolls; sa++) {
    const solution = generateSolution();

    const candidates: [number, number][] = [];
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) candidates.push([r, c]);
    shuffle(candidates);

    for (const [tr, tc] of candidates) {
      solutionAttempts++;
      if (solutionAttempts > maxAttempts) break;

      const result = buildOnce(solution, tr, tc, maxLevel, minDiff, maxDiff);
      if (result) return result;
    }

    if (solutionAttempts > maxAttempts) break;
  }

  throw new Error(`训练题生成失败：难度${difficulty}，已尝试 ${maxAttempts} 次`);
}

/**
 * 批量生成训练题目（用于后台填充题目池）。
 * 每生成一道调用 onPuzzle 回调。
 * totalTarget: 总目标数量
 * onPuzzle: 回调，返回 false 可中止生成
 */
export async function batchGenerateTrainingPuzzles(
  difficulty: number,
  totalTarget: number,
  onPuzzle: (result: BuildResult) => Promise<boolean>,
): Promise<void> {
  let generated = 0;
  while (generated < totalTarget) {
    try {
      const result = generateTrainingPuzzle(difficulty);
      const shouldContinue = await onPuzzle(result);
      generated++;
      if (!shouldContinue) break;
    } catch {
      // 生成失败，稍等后重试
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // 让出事件循环，避免阻塞
    if (generated % 5 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
}
