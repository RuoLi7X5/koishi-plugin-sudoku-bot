/**
 * solver.ts — 数独逻辑推理求解器
 *
 * 支持技巧层级（按用户分类，不分高下，选最高效路线）：
 *  L1：宫排除（Box Elimination）、隐性唯余-宫（Hidden Single in Box）
 *  L2：行列排除（Row/Column Elimination）、隐性唯余-行列（Hidden Single in Row/Col）、
 *       区块排除（Pointing Pairs/Triples）
 *  L3：显性唯余（Naked Single）、显性数对/数组（Naked Pair/Triple）、
 *       隐性数对/数组（Hidden Pair/Triple）
 *  L4/L5：预留，当前返回 unsolvable
 *
 * 不使用回溯/试探法，只进行纯逻辑推导。
 */

// ========================= 类型定义 =========================

export type SolveStep = {
  technique: string;       // 技巧名称
  level: number;           // 技巧层级 1~5
  affectsTarget: boolean;  // 是否直接改变了目标格的候选数
  description: string;     // 完整可读说明（保留用于调试）
  shortDesc: string;       // 紧凑单行说明（用于用户展示）
  targetBefore: number[];  // 目标格本步前的候选数
  targetAfter: number[];   // 目标格本步后的候选数
  eliminated: number[];    // 本步从目标格排除的候选数
};

export type SolveResult =
  | { success: true;  steps: SolveStep[]; maxLevel: number; answer: number }
  | { success: false; reason: string; partialSteps: SolveStep[]; remainingCands: number[] };

// 候选数网格：9x9，每格一个 Set
type CandGrid = Set<number>[][];

// ========================= 工具函数 =========================

function rowLabel(r: number): string {
  return String.fromCharCode(65 + r); // A-I
}

function cellLabel(r: number, c: number): string {
  return `${rowLabel(r)}${c + 1}`;
}

function sortedArr(s: Set<number> | number[]): number[] {
  return (s instanceof Set ? [...s] : [...s]).sort((a, b) => a - b);
}

function arrEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.join() === b.join();
}

function boxOrigin(r: number, c: number): [number, number] {
  return [Math.floor(r / 3) * 3, Math.floor(c / 3) * 3];
}

function boxNumber(r: number, c: number): number {
  // 1-based: 宫1=左上，宫9=右下，行优先
  return Math.floor(r / 3) * 3 + Math.floor(c / 3) + 1;
}

function boxCellList(r: number, c: number): Array<[number, number]> {
  const [br, bc] = boxOrigin(r, c);
  const cells: Array<[number, number]> = [];
  for (let dr = 0; dr < 3; dr++) {
    for (let dc = 0; dc < 3; dc++) {
      cells.push([br + dr, bc + dc]);
    }
  }
  return cells;
}

/** 获取全部 27 个单元（9行 + 9列 + 9宫） */
function getAllUnits(): Array<{ name: string; cells: Array<[number, number]> }> {
  const units: Array<{ name: string; cells: Array<[number, number]> }> = [];
  for (let i = 0; i < 9; i++) {
    units.push({ name: `第${rowLabel(i)}行`, cells: Array.from({ length: 9 }, (_, c) => [i, c] as [number, number]) });
    units.push({ name: `第${i + 1}列`,      cells: Array.from({ length: 9 }, (_, r) => [r, i] as [number, number]) });
  }
  for (let br = 0; br < 9; br += 3) {
    for (let bc = 0; bc < 9; bc += 3) {
      units.push({ name: `第${boxNumber(br, bc)}宫`, cells: boxCellList(br, bc) });
    }
  }
  return units;
}

// ========================= 候选数初始化 =========================

function initCandidates(puzzle: number[][]): CandGrid {
  const grid: CandGrid = Array.from({ length: 9 }, () =>
    Array.from({ length: 9 }, () => new Set<number>([1, 2, 3, 4, 5, 6, 7, 8, 9]))
  );
  // 已填格只保留其值
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (puzzle[r][c] !== 0) {
        grid[r][c] = new Set([puzzle[r][c]]);
      }
    }
  }
  // 基础消除：已填格的值从同行/同列/同宫的空格中删除
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (puzzle[r][c] !== 0) {
        eliminatePeers(grid, r, c, puzzle[r][c]);
      }
    }
  }
  return grid;
}

/** 从 (r,c) 的同行、同列、同宫中删除候选数 v */
function eliminatePeers(grid: CandGrid, r: number, c: number, v: number): void {
  for (let i = 0; i < 9; i++) {
    if (i !== c) grid[r][i].delete(v);
    if (i !== r) grid[i][c].delete(v);
  }
  const [br, bc] = boxOrigin(r, c);
  for (let dr = 0; dr < 3; dr++) {
    for (let dc = 0; dc < 3; dc++) {
      if (br + dr !== r || bc + dc !== c) {
        grid[br + dr][bc + dc].delete(v);
      }
    }
  }
}

/** 确定一个格子的值：更新候选数网格和工作盘 */
function assignCell(grid: CandGrid, work: number[][], r: number, c: number, v: number): void {
  grid[r][c] = new Set([v]);
  work[r][c] = v;
  eliminatePeers(grid, r, c, v);
}

// ========================= L1：宫内隐性唯余 =========================

/**
 * 在指定单元格列表中，寻找某候选数只出现在唯一一个未确定格的情况。
 * 用于 L1（宫）或 L2（行/列）的隐性唯余检测。
 */
function findHiddenSingleInUnit(
  grid: CandGrid,
  work: number[][],
  unitCells: Array<[number, number]>,
): { r: number; c: number; v: number } | null {
  const vPos = new Map<number, Array<[number, number]>>();
  for (const [r, c] of unitCells) {
    if (work[r][c] !== 0) continue; // 已确定，跳过
    for (const v of grid[r][c]) {
      if (!vPos.has(v)) vPos.set(v, []);
      vPos.get(v)!.push([r, c]);
    }
  }
  for (const [v, positions] of vPos) {
    if (positions.length === 1 && grid[positions[0][0]][positions[0][1]].size > 1) {
      return { r: positions[0][0], c: positions[0][1], v };
    }
  }
  return null;
}

// ========================= L2：区块排除（Pointing Pairs） =========================

/**
 * 区块排除：若某宫内某候选数只出现在同一行/列，则该行/列宫外其他格可消除该候选数。
 * 返回第一个发现的消除结果。
 */
function applyPointingPairs(
  grid: CandGrid,
  work: number[][],
): { desc: string; shortDescBase: string; elimCells: Array<[number, number]> } | null {
  for (let br = 0; br < 9; br += 3) {
    for (let bc = 0; bc < 9; bc += 3) {
      for (let v = 1; v <= 9; v++) {
        const rows = new Set<number>();
        const cols = new Set<number>();
        const cells: Array<[number, number]> = [];
        for (let dr = 0; dr < 3; dr++) {
          for (let dc = 0; dc < 3; dc++) {
            const r = br + dr, c = bc + dc;
            if (work[r][c] === 0 && grid[r][c].has(v)) {
              rows.add(r);
              cols.add(c);
              cells.push([r, c]);
            }
          }
        }
        if (cells.length < 2) continue;
        const bNum = boxNumber(br, bc);

        // 同一行
        if (rows.size === 1) {
          const row = [...rows][0];
          const elimCells: Array<[number, number]> = [];
          for (let c = 0; c < 9; c++) {
            if ((c < bc || c >= bc + 3) && work[row][c] === 0 && grid[row][c].delete(v)) {
              elimCells.push([row, c]);
            }
          }
          if (elimCells.length > 0) {
            return {
              desc: `数字 ${v} 在第 ${bNum} 宫内只出现于第 ${rowLabel(row)} 行（共 ${cells.length} 格），` +
                    `故第 ${rowLabel(row)} 行宫外的 ${elimCells.length} 格排除候选数 ${v}`,
              shortDescBase: `第${bNum}宫数字${v}仅限第${rowLabel(row)}行（区块排除）`,
              elimCells,
            };
          }
        }

        // 同一列
        if (cols.size === 1) {
          const col = [...cols][0];
          const elimCells: Array<[number, number]> = [];
          for (let r = 0; r < 9; r++) {
            if ((r < br || r >= br + 3) && work[r][col] === 0 && grid[r][col].delete(v)) {
              elimCells.push([r, col]);
            }
          }
          if (elimCells.length > 0) {
            return {
              desc: `数字 ${v} 在第 ${bNum} 宫内只出现于第 ${col + 1} 列（共 ${cells.length} 格），` +
                    `故第 ${col + 1} 列宫外的 ${elimCells.length} 格排除候选数 ${v}`,
              shortDescBase: `第${bNum}宫数字${v}仅限第${col + 1}列（区块排除）`,
              elimCells,
            };
          }
        }
      }
    }
  }
  return null;
}

// ========================= L3：显性数对/数组（Naked Pair/Triple） =========================

/**
 * 在单元中寻找 N 个格共享 N 个候选数（N=2 或 3）的情况，
 * 并从同单元其他格中消除这些候选数。
 */
function applyNakedSet(
  grid: CandGrid,
  work: number[][],
  unitCells: Array<[number, number]>,
  setSize: 2 | 3,
): { desc: string; shortDescBase: string; elimCells: Array<[number, number]> } | null {
  const candidates = unitCells
    .filter(([r, c]) => work[r][c] === 0 && grid[r][c].size >= 2 && grid[r][c].size <= setSize)
    .map(([r, c]) => ({ r, c, vals: sortedArr(grid[r][c]) }));

  // 穷举 setSize 个格的组合
  const combos = combinations(candidates, setSize);
  for (const combo of combos) {
    const union = new Set<number>();
    for (const cell of combo) cell.vals.forEach((v) => union.add(v));
    if (union.size !== setSize) continue;

    // 从同单元其他格中消除这些值
    const vals = [...union].sort((a, b) => a - b);
    const elimCells: Array<[number, number]> = [];
    for (const [r, c] of unitCells) {
      if (combo.some((x) => x.r === r && x.c === c)) continue;
      if (work[r][c] !== 0) continue;
      let changed = false;
      for (const v of vals) {
        if (grid[r][c].delete(v)) changed = true;
      }
      if (changed) elimCells.push([r, c]);
    }
    if (elimCells.length > 0) {
      const cellNames = combo.map((x) => cellLabel(x.r, x.c)).join(",");
      const typeName = setSize === 2 ? "显性数对" : "显性数组";
      return {
        desc: `格 ${cellNames} 候选数集合为 [${vals.join(",")}]（${typeName}），` +
              `同单元 ${elimCells.length} 格排除候选数 ${vals.join(",")}`,
        shortDescBase: `${cellNames}=[${vals.join(",")}]`,
        elimCells,
      };
    }
  }
  return null;
}

// ========================= L3：隐性数对/数组（Hidden Pair/Triple） =========================

/**
 * 在单元中寻找 N 个候选数只出现在相同的 N 个格（N=2 或 3），
 * 并清除这 N 个格中的其他候选数。
 */
function applyHiddenSet(
  grid: CandGrid,
  work: number[][],
  unitCells: Array<[number, number]>,
  setSize: 2 | 3,
): { desc: string; shortDescBase: string; elimCells: Array<[number, number]> } | null {
  // 统计每个候选数在本单元中出现的格子
  const vPos = new Map<number, Array<[number, number]>>();
  for (const [r, c] of unitCells) {
    if (work[r][c] !== 0) continue;
    for (const v of grid[r][c]) {
      if (!vPos.has(v)) vPos.set(v, []);
      vPos.get(v)!.push([r, c]);
    }
  }

  // 筛选出恰好出现 setSize 次（或更少）的候选数
  const candidates = [...vPos.entries()]
    .filter(([, pos]) => pos.length >= 2 && pos.length <= setSize)
    .map(([v, pos]) => ({ v, pos }));

  const combos = combinations(candidates, setSize);
  for (const combo of combos) {
    // 检查这 setSize 个候选数是否共享相同的 setSize 个格子
    const allCells = new Map<string, [number, number]>();
    for (const { pos } of combo) {
      for (const [r, c] of pos) {
        allCells.set(`${r},${c}`, [r, c]);
      }
    }
    if (allCells.size !== setSize) continue;

    // 清除这些格中不属于该组的候选数
    const keepVals = new Set(combo.map((x) => x.v));
    const elimCells: Array<[number, number]> = [];
    for (const [r, c] of allCells.values()) {
      let changed = false;
      for (const v of [...grid[r][c]]) {
        if (!keepVals.has(v)) {
          grid[r][c].delete(v);
          changed = true;
        }
      }
      if (changed) elimCells.push([r, c]);
    }
    if (elimCells.length > 0) {
      const vals = combo.map((x) => x.v).sort((a, b) => a - b);
      const cellNames = [...allCells.values()].map(([r, c]) => cellLabel(r, c)).join(",");
      const typeName = setSize === 2 ? "隐性数对" : "隐性数组";
      return {
        desc: `数字 ${vals.join(",")} 在本单元中只出现于格 ${cellNames}（${typeName}），` +
              `这 ${setSize} 格排除其余候选数`,
        shortDescBase: `数字${vals.join(",")}仅限${cellNames}`,
        elimCells,
      };
    }
  }
  return null;
}

// ========================= 工具：组合生成 =========================

function combinations<T>(arr: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (arr.length < size) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, size - 1).map((c) => [first, ...c]);
  const withoutFirst = combinations(rest, size);
  return [...withFirst, ...withoutFirst];
}

// ========================= L4：N-Fish（X翼/剑鱼） =========================

/**
 * N-Fish（X翼 n=2，剑鱼 n=3）：
 * 若候选数 v 在 N 行（或列）中各最多出现在 N 个位置，
 * 且这些位置恰好只占 N 列（或行），则可从那 N 列（或行）的其他行（或列）中消除 v。
 */
function applyNFish(
  grid: CandGrid,
  work: number[][],
  n: 2 | 3,
): { desc: string; shortDescBase: string; elimCells: Array<[number, number]> } | null {
  type Line = { lineIdx: number; positions: number[] };

  for (const useRows of [true, false]) {
    for (let v = 1; v <= 9; v++) {
      const validLines: Line[] = [];
      for (let i = 0; i < 9; i++) {
        const positions: number[] = [];
        for (let j = 0; j < 9; j++) {
          const [r, c] = useRows ? [i, j] : [j, i];
          if (work[r][c] === 0 && grid[r][c].has(v)) positions.push(j);
        }
        if (positions.length >= 2 && positions.length <= n) {
          validLines.push({ lineIdx: i, positions });
        }
      }
      if (validLines.length < n) continue;

      for (const combo of combinations(validLines, n)) {
        const allPos = new Set<number>();
        for (const line of combo) for (const p of line.positions) allPos.add(p);
        if (allPos.size !== n) continue;

        const usedIdx = new Set(combo.map(l => l.lineIdx));
        const posArr = [...allPos].sort((a, b) => a - b);
        const elimCells: Array<[number, number]> = [];

        for (let i = 0; i < 9; i++) {
          if (usedIdx.has(i)) continue;
          for (const j of posArr) {
            const [r, c] = useRows ? [i, j] : [j, i];
            if (work[r][c] === 0 && grid[r][c].delete(v)) elimCells.push([r, c]);
          }
        }

        if (elimCells.length > 0) {
          const techName = n === 2 ? 'X翼' : '剑鱼';
          const dirA = useRows ? '行' : '列';
          const dirB = useRows ? '列' : '行';
          const lineLabels = combo.map(l =>
            useRows ? rowLabel(l.lineIdx) : String(l.lineIdx + 1)).join(',');
          const posLabels = posArr.map(j =>
            useRows ? String(j + 1) : rowLabel(j)).join(',');
          return {
            desc: `${techName}：数字 ${v} 在第 ${lineLabels} ${dirA}中仅出现于第 ${posLabels} ${dirB}，` +
                  `故第 ${posLabels} ${dirB}的其他 ${dirA}可消除 ${v}`,
            shortDescBase: `${techName}（数字${v}，第${lineLabels}${dirA}→第${posLabels}${dirB}）`,
            elimCells,
          };
        }
      }
    }
  }
  return null;
}

// ========================= L4：XY翼（XY-Wing） =========================

/**
 * XY翼：枢轴格[A,B]，翼格[A,C]和[B,C]，三格互相可见（与枢轴）。
 * 从同时能看到两个翼格的其他格中消除候选数 C。
 */
function applyXYWing(
  grid: CandGrid,
  work: number[][],
): { desc: string; shortDescBase: string; elimCells: Array<[number, number]> } | null {
  function sees(r1: number, c1: number, r2: number, c2: number): boolean {
    return r1 === r2 || c1 === c2 ||
      (Math.floor(r1 / 3) === Math.floor(r2 / 3) && Math.floor(c1 / 3) === Math.floor(c2 / 3));
  }

  const biCells: Array<{ r: number; c: number; cands: number[] }> = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (work[r][c] === 0 && grid[r][c].size === 2) {
        biCells.push({ r, c, cands: sortedArr(grid[r][c]) });
      }
    }
  }

  for (const pivot of biCells) {
    const [A, B] = pivot.cands;
    for (const wing1 of biCells) {
      if (wing1.r === pivot.r && wing1.c === pivot.c) continue;
      if (!sees(pivot.r, pivot.c, wing1.r, wing1.c)) continue;
      if (!wing1.cands.includes(A)) continue;
      const C = wing1.cands.find(v => v !== A)!;
      if (C === B) continue;

      for (const wing2 of biCells) {
        if (wing2.r === pivot.r && wing2.c === pivot.c) continue;
        if (wing2.r === wing1.r && wing2.c === wing1.c) continue;
        if (!sees(pivot.r, pivot.c, wing2.r, wing2.c)) continue;
        if (!wing2.cands.includes(B) || !wing2.cands.includes(C)) continue;

        const elimCells: Array<[number, number]> = [];
        for (let r = 0; r < 9; r++) {
          for (let c = 0; c < 9; c++) {
            if (work[r][c] !== 0) continue;
            if (r === wing1.r && c === wing1.c) continue;
            if (r === wing2.r && c === wing2.c) continue;
            if (!sees(r, c, wing1.r, wing1.c)) continue;
            if (!sees(r, c, wing2.r, wing2.c)) continue;
            if (grid[r][c].delete(C)) elimCells.push([r, c]);
          }
        }

        if (elimCells.length > 0) {
          const pl = cellLabel(pivot.r, pivot.c);
          const w1l = cellLabel(wing1.r, wing1.c);
          const w2l = cellLabel(wing2.r, wing2.c);
          return {
            desc: `XY翼：枢轴${pl}[${A},${B}]，翼${w1l}[${A},${C}]和${w2l}[${B},${C}]，` +
                  `从公共可见格消除候选数${C}`,
            shortDescBase: `XY翼（${pl}[${A},${B}]→${w1l}/${w2l}，排除${C}）`,
            elimCells,
          };
        }
      }
    }
  }
  return null;
}

// ========================= L4c：XYZ翼（XYZ-Wing） =========================

/**
 * XYZ翼：枢轴格[A,B,C]（3候选数），翼格[A,C]和[B,C]（各2候选数），均与枢轴可见。
 * 消除所有同时能看到三格（枢轴+两翼）的格子中的候选数 C。
 * 比 XY翼多了枢轴本身也含 C，因此消除范围更严格（必须看到全部三格）。
 */
function applyXYZWing(
  grid: CandGrid,
  work: number[][],
): { desc: string; shortDescBase: string; elimCells: Array<[number, number]> } | null {
  function sees(r1: number, c1: number, r2: number, c2: number): boolean {
    return r1 === r2 || c1 === c2 ||
      (Math.floor(r1 / 3) === Math.floor(r2 / 3) && Math.floor(c1 / 3) === Math.floor(c2 / 3));
  }

  const triCells: Array<{ r: number; c: number; cands: number[] }> = [];
  const biCells: Array<{ r: number; c: number; cands: number[] }> = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (work[r][c] !== 0) continue;
      const sz = grid[r][c].size;
      const cands = sortedArr(grid[r][c]);
      if (sz === 3) triCells.push({ r, c, cands });
      else if (sz === 2) biCells.push({ r, c, cands });
    }
  }

  for (const pivot of triCells) {
    for (const C of pivot.cands) {
      const others = pivot.cands.filter(v => v !== C);
      for (const wing1 of biCells) {
        if (!sees(pivot.r, pivot.c, wing1.r, wing1.c)) continue;
        if (!wing1.cands.includes(C)) continue;
        const w1Other = wing1.cands.find(v => v !== C)!;
        if (!others.includes(w1Other)) continue;
        const w2Need = others.find(v => v !== w1Other)!;

        for (const wing2 of biCells) {
          if (wing2.r === wing1.r && wing2.c === wing1.c) continue;
          if (!sees(pivot.r, pivot.c, wing2.r, wing2.c)) continue;
          if (!wing2.cands.includes(C) || !wing2.cands.includes(w2Need)) continue;

          const elimCells: Array<[number, number]> = [];
          for (let r = 0; r < 9; r++) {
            for (let c = 0; c < 9; c++) {
              if (work[r][c] !== 0) continue;
              if (r === pivot.r && c === pivot.c) continue;
              if (r === wing1.r && c === wing1.c) continue;
              if (r === wing2.r && c === wing2.c) continue;
              if (!sees(r, c, pivot.r, pivot.c)) continue;
              if (!sees(r, c, wing1.r, wing1.c)) continue;
              if (!sees(r, c, wing2.r, wing2.c)) continue;
              if (grid[r][c].delete(C)) elimCells.push([r, c]);
            }
          }

          if (elimCells.length > 0) {
            const pl = cellLabel(pivot.r, pivot.c);
            const w1l = cellLabel(wing1.r, wing1.c);
            const w2l = cellLabel(wing2.r, wing2.c);
            return {
              desc: `XYZ翼：枢轴${pl}[${pivot.cands}]，翼${w1l}[${wing1.cands}]和${w2l}[${wing2.cands}]，` +
                    `从三格公共可见区消除候选数${C}`,
              shortDescBase: `XYZ翼（${pl}[${pivot.cands}]→${w1l}/${w2l}，排除${C}）`,
              elimCells,
            };
          }
        }
      }
    }
  }
  return null;
}

// ========================= L4d：单链着色（Simple Coloring / X-Chain） =========================

/**
 * 单链着色（Simple Coloring）：
 * 对候选数 v，在共轭对（某单元恰好2格有v）上构建交替染色链。
 *   规则1（矛盾色）：若同色两格互相可见 → 该颜色均不能填 v，整链消除。
 *   规则2（双色可见）：若某格同时看到两种颜色的格 → 该格排除 v。
 */
function applySimpleColoring(
  grid: CandGrid,
  work: number[][],
): { desc: string; shortDescBase: string; elimCells: Array<[number, number]> } | null {
  function sees(r1: number, c1: number, r2: number, c2: number): boolean {
    return r1 === r2 || c1 === c2 ||
      (Math.floor(r1 / 3) === Math.floor(r2 / 3) && Math.floor(c1 / 3) === Math.floor(c2 / 3));
  }

  const cellKey = (r: number, c: number) => r * 9 + c;
  const keyToRC = (k: number): [number, number] => [Math.floor(k / 9), k % 9];

  for (let v = 1; v <= 9; v++) {
    // 收集共轭对（行/列/宫中恰好含 v 的 2 个空格）
    const adj = new Map<number, Set<number>>();
    const addEdge = (a: [number, number], b: [number, number]) => {
      const ka = cellKey(...a), kb = cellKey(...b);
      if (!adj.has(ka)) adj.set(ka, new Set());
      if (!adj.has(kb)) adj.set(kb, new Set());
      adj.get(ka)!.add(kb);
      adj.get(kb)!.add(ka);
    };

    for (let i = 0; i < 9; i++) {
      const rowV: Array<[number, number]> = [];
      const colV: Array<[number, number]> = [];
      for (let j = 0; j < 9; j++) {
        if (work[i][j] === 0 && grid[i][j].has(v)) rowV.push([i, j]);
        if (work[j][i] === 0 && grid[j][i].has(v)) colV.push([j, i]);
      }
      if (rowV.length === 2) addEdge(rowV[0], rowV[1]);
      if (colV.length === 2) addEdge(colV[0], colV[1]);
    }
    for (let br = 0; br < 9; br += 3) {
      for (let bc = 0; bc < 9; bc += 3) {
        const boxV: Array<[number, number]> = [];
        for (let dr = 0; dr < 3; dr++)
          for (let dc = 0; dc < 3; dc++) {
            const r = br + dr, c = bc + dc;
            if (work[r][c] === 0 && grid[r][c].has(v)) boxV.push([r, c]);
          }
        if (boxV.length === 2) addEdge(boxV[0], boxV[1]);
      }
    }

    if (adj.size < 2) continue;

    // BFS 染色，每个连通分量单独处理
    const color = new Map<number, 0 | 1>();
    for (const startKey of adj.keys()) {
      if (color.has(startKey)) continue;

      const queue: number[] = [startKey];
      color.set(startKey, 0);
      const component: number[] = [];

      while (queue.length > 0) {
        const cur = queue.shift()!;
        component.push(cur);
        for (const nb of adj.get(cur) ?? []) {
          if (!color.has(nb)) {
            color.set(nb, color.get(cur) === 0 ? 1 : 0);
            queue.push(nb);
          }
        }
      }

      if (component.length < 2) continue;

      const cells0 = component.filter(k => color.get(k) === 0).map(keyToRC);
      const cells1 = component.filter(k => color.get(k) === 1).map(keyToRC);

      // 规则 1：同色格互相可见 → 整链该颜色消除
      const conflictElim = (badCells: Array<[number, number]>): boolean => {
        for (let i = 0; i < badCells.length; i++)
          for (let j = i + 1; j < badCells.length; j++)
            if (sees(...badCells[i], ...badCells[j])) return true;
        return false;
      };

      for (const [badCells, label] of [[cells0, "0色"], [cells1, "1色"]] as const) {
        if (conflictElim(badCells)) {
          const elimCells: Array<[number, number]> = [];
          for (const [r, c] of badCells)
            if (grid[r][c].delete(v)) elimCells.push([r, c]);
          if (elimCells.length > 0) {
            const sample = badCells.slice(0, 3).map(([r, c]) => cellLabel(r, c)).join(",");
            return {
              desc: `单链着色：数字${v}的链中${label}格互相可见（矛盾），消除${label}中的 ${v}`,
              shortDescBase: `单链着色（数字${v}，矛盾色${sample}排除）`,
              elimCells,
            };
          }
        }
      }

      // 规则 2：外部格同时可见两种颜色 → 排除 v
      const elimCells: Array<[number, number]> = [];
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          if (work[r][c] !== 0 || !grid[r][c].has(v)) continue;
          if (color.has(cellKey(r, c))) continue;
          const sees0 = cells0.some(([r2, c2]) => sees(r, c, r2, c2));
          const sees1 = cells1.some(([r2, c2]) => sees(r, c, r2, c2));
          if (sees0 && sees1 && grid[r][c].delete(v)) elimCells.push([r, c]);
        }
      }
      if (elimCells.length > 0) {
        const s0 = cells0.slice(0, 2).map(([r, c]) => cellLabel(r, c)).join(",");
        const s1 = cells1.slice(0, 2).map(([r, c]) => cellLabel(r, c)).join(",");
        return {
          desc: `单链着色：数字${v}，外部格同时可见${s0}（0色）和${s1}（1色），排除${v}`,
          shortDescBase: `单链着色（数字${v}，双色可见排除）`,
          elimCells,
        };
      }
    }
  }
  return null;
}

// ========================= L5a：X链（X-Chain，单值交替推断链） =========================

/**
 * X链：对单一候选数 v，在"强链"（宫/行/列恰好2个v）和"弱链"（两格含v且互相可见）之间交替构建推断链。
 * 证明：A=无v → B=有v（通过强链） → ... → Z=有v（通过强链）
 * 因此 A 和 Z 中至少有一个是 v，同时能看到 A 和 Z 的格子可排除 v。
 * 覆盖：Skyscraper / 双弦风筝 / 其他 X链模式。
 */
function applyXChain(
  grid: CandGrid,
  work: number[][],
): { desc: string; shortDescBase: string; elimCells: Array<[number, number]> } | null {
  function sees(r1: number, c1: number, r2: number, c2: number): boolean {
    return (r1 === r2 || c1 === c2 ||
      (Math.floor(r1 / 3) === Math.floor(r2 / 3) && Math.floor(c1 / 3) === Math.floor(c2 / 3))) &&
      !(r1 === r2 && c1 === c2);
  }

  const MAX_DEPTH = 5; // 最多 5 个强链步骤

  for (let v = 1; v <= 9; v++) {
    // 构建所有共轭对（强链）：某行/列/宫中 v 恰好出现在 2 格
    type Cell = [number, number];
    const conjugates: Array<[Cell, Cell]> = [];
    const seenPairs = new Set<number>();
    const addConjPair = (a: Cell, b: Cell) => {
      const key = Math.min(a[0] * 9 + a[1], b[0] * 9 + b[1]) * 100 +
                  Math.max(a[0] * 9 + a[1], b[0] * 9 + b[1]);
      if (!seenPairs.has(key)) { seenPairs.add(key); conjugates.push([a, b]); }
    };

    for (let i = 0; i < 9; i++) {
      const rowV: Cell[] = [], colV: Cell[] = [];
      for (let j = 0; j < 9; j++) {
        if (work[i][j] === 0 && grid[i][j].has(v)) rowV.push([i, j]);
        if (work[j][i] === 0 && grid[j][i].has(v)) colV.push([j, i]);
      }
      if (rowV.length === 2) addConjPair(rowV[0], rowV[1]);
      if (colV.length === 2) addConjPair(colV[0], colV[1]);
    }
    for (let br = 0; br < 9; br += 3) {
      for (let bc = 0; bc < 9; bc += 3) {
        const boxV: Cell[] = [];
        for (let dr = 0; dr < 3; dr++)
          for (let dc = 0; dc < 3; dc++) {
            const r = br + dr, c = bc + dc;
            if (work[r][c] === 0 && grid[r][c].has(v)) boxV.push([r, c]);
          }
        if (boxV.length === 2) addConjPair(boxV[0], boxV[1]);
      }
    }
    if (conjugates.length < 2) continue;

    // 每个格子的共轭对伙伴列表
    const conjPartners = new Map<number, Cell[]>();
    const ck = ([r, c]: Cell) => r * 9 + c;
    for (const [a, b] of conjugates) {
      if (!conjPartners.has(ck(a))) conjPartners.set(ck(a), []);
      if (!conjPartners.has(ck(b))) conjPartners.set(ck(b), []);
      conjPartners.get(ck(a))!.push(b);
      conjPartners.get(ck(b))!.push(a);
    }

    // 所有含 v 的空格
    const vCells: Cell[] = [];
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (work[r][c] === 0 && grid[r][c].has(v)) vCells.push([r, c]);

    // DFS：offStart=链起始的"OFF"格（链导致它不含v），curON=当前"ON"格
    // 逻辑：offStart=无v → curON=有v。消除：看到 offStart 和 curON 的格可排除 v
    const visited = new Uint8Array(81);
    const onMask  = new Uint8Array(81); // 仅标记链中的 ON 格（有 v）

    /**
     * DFS 延伸链：
     * curON = 当前确定"有 v"的格（ON），offStart = 初始假设"无 v"的格（OFF）。
     * onMask 记录本次路径上所有 ON 格，消除检查时必须跳过它们。
     */
    function dfs(curON: Cell, offStart: Cell, depth: number): Array<[number, number]> | null {
      // ── 消除检查：链证明 offStart=无v → curON=有v ──
      // 任何能看到 offStart（OFF）和 curON（ON）的格，且该格含 v，可消除 v。
      // 注意：必须跳过所有链中 ON 格（onMask=1），防止错误消除链中有 v 的格。
      const elimCells: Array<[number, number]> = [];
      for (const [r, c] of vCells) {
        if (!grid[r][c].has(v)) continue;
        if (onMask[r * 9 + c]) continue;           // 跳过链中 ON 格
        if (r === offStart[0] && c === offStart[1]) continue; // 跳过 offStart
        if (sees(r, c, curON[0], curON[1]) && sees(r, c, offStart[0], offStart[1])) {
          if (grid[r][c].delete(v)) elimCells.push([r, c]);
        }
      }
      if (elimCells.length > 0) return elimCells;

      if (depth >= MAX_DEPTH) return null;

      // ── 延伸链：curON=ON --弱链--> C=OFF --强链--> D=ON ──
      for (const [r, c] of vCells) {
        if (visited[r * 9 + c]) continue;
        if (!sees(r, c, curON[0], curON[1])) continue;
        // (r,c) 为 OFF 格（弱链：curON=v → 此格≠v）
        const partners = conjPartners.get(r * 9 + c);
        if (!partners) continue;
        for (const [pr, pc] of partners) {
          if (visited[pr * 9 + pc]) continue;
          if (pr === offStart[0] && pc === offStart[1]) continue;
          // (pr,pc) 为新 ON 格
          visited[r * 9 + c] = 1;
          visited[pr * 9 + pc] = 1;
          onMask[pr * 9 + pc] = 1;
          const res = dfs([pr, pc], offStart, depth + 1);
          visited[r * 9 + c] = 0;
          visited[pr * 9 + pc] = 0;
          onMask[pr * 9 + pc] = 0;
          if (res !== null) return res;
        }
      }
      return null;
    }

    for (const [A, B] of conjugates) {
      // ── 尝试 A=OFF → B=ON ──
      visited[ck(A)] = 1; onMask[ck(A)] = 0;
      visited[ck(B)] = 1; onMask[ck(B)] = 1;
      const r1 = dfs(B, A, 1);
      visited[ck(A)] = 0;
      visited[ck(B)] = 0; onMask[ck(B)] = 0;
      if (r1) {
        return {
          desc: `X链：候选数${v}，从${cellLabel(A[0], A[1])}出发的交替推断链消除`,
          shortDescBase: `X链（数字${v}，${cellLabel(A[0], A[1])}→排除）`,
          elimCells: r1,
        };
      }
      // ── 尝试 B=OFF → A=ON ──
      visited[ck(A)] = 1; onMask[ck(A)] = 1;
      visited[ck(B)] = 1; onMask[ck(B)] = 0;
      const r2 = dfs(A, B, 1);
      visited[ck(A)] = 0; onMask[ck(A)] = 0;
      visited[ck(B)] = 0;
      if (r2) {
        return {
          desc: `X链：候选数${v}，从${cellLabel(B[0], B[1])}出发的交替推断链消除`,
          shortDescBase: `X链（数字${v}，${cellLabel(B[0], B[1])}→排除）`,
          elimCells: r2,
        };
      }
    }
  }
  return null;
}

// ========================= L5：XY链（XY-Chain） =========================

/**
 * XY链：双值格组成的交替推断链。
 * 链：C0={v,a} - C1={a,b} - C2={b,c} - ... - Cn={z,v}
 * 推导：假设 C0≠v → C0=a → C1≠a → C1=b → ... → Cn=v
 * 即 C0≠v 蕴含 Cn=v，故 C0 和 Cn 中必有一个是 v，
 * 所有同时能看到 C0 和 Cn 的格子可以排除候选数 v。
 */
function applyXYChain(
  grid: CandGrid,
  work: number[][],
): { desc: string; shortDescBase: string; elimCells: Array<[number, number]> } | null {
  function sees(r1: number, c1: number, r2: number, c2: number): boolean {
    return (r1 === r2 || c1 === c2 ||
      (Math.floor(r1 / 3) === Math.floor(r2 / 3) && Math.floor(c1 / 3) === Math.floor(c2 / 3))) &&
      !(r1 === r2 && c1 === c2);
  }

  // 收集所有双值格
  const biCells: Array<{ r: number; c: number; v0: number; v1: number; idx: number }> = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (work[r][c] !== 0 || grid[r][c].size !== 2) continue;
      const [v0, v1] = sortedArr(grid[r][c]);
      biCells.push({ r, c, v0, v1, idx: biCells.length });
    }
  }
  if (biCells.length < 3) return null;

  const MAX_DEPTH = 9; // 链最大长度（含起始格）

  /** DFS：从 curCell 出发，当前链末尾传递的值是 linkVal，起始格端点含 startV */
  function dfs(
    curCell: typeof biCells[0],
    linkVal: number,
    startV: number,
    startCell: typeof biCells[0],
    depth: number,
    visited: Uint8Array,
  ): Array<[number, number]> | null {
    if (depth > MAX_DEPTH) return null;

    for (const next of biCells) {
      if (visited[next.idx]) continue;
      if (!sees(curCell.r, curCell.c, next.r, next.c)) continue;

      // next 必须包含 linkVal
      let nextLinkVal: number;
      if (next.v0 === linkVal) nextLinkVal = next.v1;
      else if (next.v1 === linkVal) nextLinkVal = next.v0;
      else continue;

      // next 的"另一个值"即 nextLinkVal
      // 若 nextLinkVal === startV，说明找到了有效终端 Cn={linkVal, startV}
      if (nextLinkVal === startV) {
        // startCell 和 next 都含 startV → 找互相可见的格子消除 startV
        // 且为了排除 XY翼（depth=2 且 startCell 和 next 互相可见），跳过trivial情况
        if (depth === 2 && sees(startCell.r, startCell.c, next.r, next.c)) continue;

        const elimCells: Array<[number, number]> = [];
        for (let r = 0; r < 9; r++) {
          for (let c = 0; c < 9; c++) {
            if (work[r][c] !== 0 || !grid[r][c].has(startV)) continue;
            if (r === startCell.r && c === startCell.c) continue;
            if (r === next.r && c === next.c) continue;
            if (sees(r, c, startCell.r, startCell.c) && sees(r, c, next.r, next.c)) {
              if (grid[r][c].delete(startV)) elimCells.push([r, c]);
            }
          }
        }
        if (elimCells.length > 0) return elimCells;
        continue; // 该 nextLinkVal===startV 但无可消除
      }

      // 继续延伸链
      visited[next.idx] = 1;
      const res = dfs(next, nextLinkVal, startV, startCell, depth + 1, visited);
      visited[next.idx] = 0;
      if (res !== null) {
        // 成功：需要返回整个链的信息，但我们只需要 elimCells，先简单返回
        return res;
      }
    }
    return null;
  }

  const visited = new Uint8Array(biCells.length);

  for (const startCell of biCells) {
    for (const startV of [startCell.v0, startCell.v1]) {
      const linkVal = startV === startCell.v0 ? startCell.v1 : startCell.v0;
      visited[startCell.idx] = 1;
      const elimCells = dfs(startCell, linkVal, startV, startCell, 2, visited);
      visited[startCell.idx] = 0;
      if (elimCells && elimCells.length > 0) {
        const sl = cellLabel(startCell.r, startCell.c);
        return {
          desc: `XY链：起点${sl}[${startV},${linkVal}]的交替推断链，排除候选数${startV}`,
          shortDescBase: `XY链（起点${sl}，排除${startV}）`,
          elimCells,
        };
      }
    }
  }
  return null;
}

// ========================= 主求解函数 =========================

/**
 * 对给定盘面，通过纯逻辑推理确定目标格 (targetRow, targetCol) 的值。
 * 使用 L1-L4 技巧（X翼、剑鱼、XY翼），不使用回溯。
 * 技巧选择原则：选最高效路线，不以难度分高下。
 */
export function solve(
  puzzle: number[][],
  targetRow: number,
  targetCol: number,
): SolveResult {
  const work = puzzle.map((row) => [...row]);
  const grid = initCandidates(puzzle);
  const steps: SolveStep[] = [];
  let maxLevel = 0;

  const tc = cellLabel(targetRow, targetCol);
  const getCur = (): number[] => sortedArr(grid[targetRow][targetCol]);

  // 候选数为空 → 题目有误
  if (grid[targetRow][targetCol].size === 0) {
    return { success: false, reason: "invalid_puzzle", partialSteps: [], remainingCands: [] };
  }

  // ---- 记录初始消除步骤（基础行/列/宫排除）----
  const initState = getCur();
  const rowElim = puzzle[targetRow].filter((v, c) => v !== 0 && c !== targetCol);
  const colElim = Array.from({ length: 9 }, (_, r) => puzzle[r][targetCol])
    .filter((v, i) => v !== 0 && i !== targetRow);
  const [br0, bc0] = boxOrigin(targetRow, targetCol);
  const boxElim: number[] = [];
  for (let dr = 0; dr < 3; dr++) {
    for (let dc = 0; dc < 3; dc++) {
      const r = br0 + dr, c = bc0 + dc;
      if ((r !== targetRow || c !== targetCol) && puzzle[r][c] !== 0) {
        boxElim.push(puzzle[r][c]);
      }
    }
  }

  // 详细描述（调试用）
  const descLines = [`${tc} 格基础消除：`];
  if (rowElim.length > 0) descLines.push(`  行排除 → 第 ${rowLabel(targetRow)} 行已有 [${[...new Set(rowElim)].sort((a,b)=>a-b).join(",")}]`);
  if (colElim.length > 0) descLines.push(`  列排除 → 第 ${targetCol + 1} 列已有 [${[...new Set(colElim)].sort((a,b)=>a-b).join(",")}]`);
  if (boxElim.length > 0) descLines.push(`  宫排除 → 第 ${boxNumber(targetRow, targetCol)} 宫已有 [${[...new Set(boxElim)].sort((a,b)=>a-b).join(",")}]`);
  descLines.push(`  → 候选数剩余: [${initState.join(",")}]`);

  // 紧凑描述（用户展示用）
  const rStr = rowElim.length > 0 ? `行:${[...new Set(rowElim)].sort((a,b)=>a-b).join(",")}` : '';
  const cStr = colElim.length > 0 ? `列:${[...new Set(colElim)].sort((a,b)=>a-b).join(",")}` : '';
  const bStr = boxElim.length > 0 ? `宫:${[...new Set(boxElim)].sort((a,b)=>a-b).join(",")}` : '';
  const elimParts = [rStr, cStr, bStr].filter(s => s.length > 0);
  const initShortDesc = elimParts.length > 0
    ? `基础消除（${elimParts.join(" ")}）→ 候选数 [${initState.join(",")}]`
    : `基础消除 → 候选数 [${initState.join(",")}]`;

  steps.push({
    technique: "基础消除（行/列/宫）",
    level: 2,
    affectsTarget: true,
    description: descLines.join("\n"),
    shortDesc: initShortDesc,
    targetBefore: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    targetAfter: initState,
    eliminated: [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(v => !initState.includes(v)),
  });
  maxLevel = 2;

  // 初始化就解决了
  if (grid[targetRow][targetCol].size === 1) {
    return { success: true, steps, maxLevel, answer: initState[0] };
  }

  const allUnits = getAllUnits();

  // ========================= 主循环 =========================
  for (let iter = 0; iter < 1000; iter++) {
    const before = getCur();
    let progress = false;

    // ---- L1：宫内隐性唯余 ----
    for (let br = 0; br < 9 && !progress; br += 3) {
      for (let bc = 0; bc < 9 && !progress; bc += 3) {
        const cells = boxCellList(br, bc);
        const hs = findHiddenSingleInUnit(grid, work, cells);
        if (hs) {
          assignCell(grid, work, hs.r, hs.c, hs.v);
          const after = getCur();
          const affects = !arrEqual(before, after);
          const elim = before.filter(v => !after.includes(v));
          const trigger = `${cellLabel(hs.r, hs.c)}=${hs.v}（第${boxNumber(br, bc)}宫隐性唯余）`;
          steps.push({
            technique: "隐性唯余（宫）",
            level: 1,
            affectsTarget: affects,
            description: `第 ${boxNumber(br, bc)} 宫中，数字 ${hs.v} 只能填入 ${cellLabel(hs.r, hs.c)}（宫内其余格已排除 ${hs.v}）` +
              (affects ? `\n  → 目标格 ${tc}：[${before.join(",")}] → [${after.join(",")}]` : ""),
            shortDesc: affects
              ? `${trigger} → 排除${elim.join(",")} → [${after.join(",")}]`
              : trigger,
            targetBefore: before,
            targetAfter: after,
            eliminated: elim,
          });
          maxLevel = Math.max(maxLevel, 1);
          progress = true;
        }
      }
    }
    if (progress) { if (grid[targetRow][targetCol].size === 1) break; continue; }

    // ---- L2a：行/列内隐性唯余 ----
    for (let i = 0; i < 9 && !progress; i++) {
      // 行
      const rowCells: Array<[number, number]> = Array.from({ length: 9 }, (_, c) => [i, c]);
      const hsRow = findHiddenSingleInUnit(grid, work, rowCells);
      if (hsRow) {
        assignCell(grid, work, hsRow.r, hsRow.c, hsRow.v);
        const after = getCur();
        const affects = !arrEqual(before, after);
        const elim = before.filter(v => !after.includes(v));
        const trigger = `${cellLabel(hsRow.r, hsRow.c)}=${hsRow.v}（第${rowLabel(i)}行隐性唯余）`;
        steps.push({
          technique: "隐性唯余（行）",
          level: 2,
          affectsTarget: affects,
          description: `第 ${rowLabel(i)} 行中，数字 ${hsRow.v} 只能填入 ${cellLabel(hsRow.r, hsRow.c)}` +
            (affects ? `\n  → 目标格 ${tc}：[${before.join(",")}] → [${after.join(",")}]` : ""),
          shortDesc: affects
            ? `${trigger} → 排除${elim.join(",")} → [${after.join(",")}]`
            : trigger,
          targetBefore: before,
          targetAfter: after,
          eliminated: elim,
        });
        maxLevel = Math.max(maxLevel, 2);
        progress = true;
      }
      if (!progress) {
        // 列
        const colCells: Array<[number, number]> = Array.from({ length: 9 }, (_, r) => [r, i]);
        const hsCol = findHiddenSingleInUnit(grid, work, colCells);
        if (hsCol) {
          assignCell(grid, work, hsCol.r, hsCol.c, hsCol.v);
          const after = getCur();
          const affects = !arrEqual(before, after);
          const elim = before.filter(v => !after.includes(v));
          const trigger = `${cellLabel(hsCol.r, hsCol.c)}=${hsCol.v}（第${i + 1}列隐性唯余）`;
          steps.push({
            technique: "隐性唯余（列）",
            level: 2,
            affectsTarget: affects,
            description: `第 ${i + 1} 列中，数字 ${hsCol.v} 只能填入 ${cellLabel(hsCol.r, hsCol.c)}` +
              (affects ? `\n  → 目标格 ${tc}：[${before.join(",")}] → [${after.join(",")}]` : ""),
            shortDesc: affects
              ? `${trigger} → 排除${elim.join(",")} → [${after.join(",")}]`
              : trigger,
            targetBefore: before,
            targetAfter: after,
            eliminated: elim,
          });
          maxLevel = Math.max(maxLevel, 2);
          progress = true;
        }
      }
    }
    if (progress) { if (grid[targetRow][targetCol].size === 1) break; continue; }

    // ---- L2b：区块排除（Pointing Pairs） ----
    const pp = applyPointingPairs(grid, work);
    if (pp) {
      const after = getCur();
      const affects = pp.elimCells.some(([r, c]) => r === targetRow && c === targetCol) || !arrEqual(before, after);
      const elim = before.filter(v => !after.includes(v));
      steps.push({
        technique: "区块排除（指向数对）",
        level: 2,
        affectsTarget: affects,
        description: pp.desc +
          (affects ? `\n  → 目标格 ${tc}：[${before.join(",")}] → [${after.join(",")}]` : ""),
        shortDesc: affects
          ? `${pp.shortDescBase} → 排除${elim.join(",")} → [${after.join(",")}]`
          : pp.shortDescBase,
        targetBefore: before,
        targetAfter: after,
        eliminated: elim,
      });
      maxLevel = Math.max(maxLevel, 2);
      progress = true;
    }
    if (progress) { if (grid[targetRow][targetCol].size === 1) break; continue; }

    // ---- L3a：显性唯余（Naked Single） ----
    const ns = findNakedSingle(grid, work);
    if (ns) {
      assignCell(grid, work, ns.r, ns.c, ns.v);
      const after = getCur();
      const affects = !arrEqual(before, after);
      const elim = before.filter(v => !after.includes(v));
      const trigger = `${cellLabel(ns.r, ns.c)}=${ns.v}（显性唯余）`;
      steps.push({
        technique: "显性唯余（唯一候选数）",
        level: 3,
        affectsTarget: affects,
        description: `格 ${cellLabel(ns.r, ns.c)} 经行/列/宫排除后候选数仅剩 ${ns.v}，确定填入` +
          (affects ? `\n  → 目标格 ${tc}：[${before.join(",")}] → [${after.join(",")}]` : ""),
        shortDesc: affects
          ? `${trigger} → 排除${elim.join(",")} → [${after.join(",")}]`
          : trigger,
        targetBefore: before,
        targetAfter: after,
        eliminated: elim,
      });
      maxLevel = Math.max(maxLevel, 3);
      progress = true;
    }
    if (progress) { if (grid[targetRow][targetCol].size === 1) break; continue; }

    // ---- L3b：显性数对/数组（Naked Pair/Triple） ----
    for (const unit of allUnits) {
      for (const sz of [2, 3] as const) {
        const np = applyNakedSet(grid, work, unit.cells, sz);
        if (np) {
          const after = getCur();
          const affects = np.elimCells.some(([r, c]) => r === targetRow && c === targetCol) || !arrEqual(before, after);
          const elim = before.filter(v => !after.includes(v));
          const typeName = sz === 2 ? "显性数对" : "显性数组";
          const fullBase = `${np.shortDescBase}（${unit.name}${typeName}）`;
          steps.push({
            technique: sz === 2 ? "显性数对" : "显性数组",
            level: 3,
            affectsTarget: affects,
            description: `【${unit.name}】${np.desc}` +
              (affects ? `\n  → 目标格 ${tc}：[${before.join(",")}] → [${after.join(",")}]` : ""),
            shortDesc: affects
              ? `${fullBase} → 排除${elim.join(",")} → [${after.join(",")}]`
              : fullBase,
            targetBefore: before,
            targetAfter: after,
            eliminated: elim,
          });
          maxLevel = Math.max(maxLevel, 3);
          progress = true;
          break;
        }
      }
      if (progress) break;
    }
    if (progress) { if (grid[targetRow][targetCol].size === 1) break; continue; }

    // ---- L3c：隐性数对/数组（Hidden Pair/Triple） ----
    for (const unit of allUnits) {
      for (const sz of [2, 3] as const) {
        const hp = applyHiddenSet(grid, work, unit.cells, sz);
        if (hp) {
          const after = getCur();
          const affects = hp.elimCells.some(([r, c]) => r === targetRow && c === targetCol) || !arrEqual(before, after);
          const elim = before.filter(v => !after.includes(v));
          const typeName = sz === 2 ? "隐性数对" : "隐性数组";
          const fullBase = `${hp.shortDescBase}（${unit.name}${typeName}）`;
          steps.push({
            technique: sz === 2 ? "隐性数对" : "隐性数组",
            level: 3,
            affectsTarget: affects,
            description: `【${unit.name}】${hp.desc}` +
              (affects ? `\n  → 目标格 ${tc}：[${before.join(",")}] → [${after.join(",")}]` : ""),
            shortDesc: affects
              ? `${fullBase} → 排除${elim.join(",")} → [${after.join(",")}]`
              : fullBase,
            targetBefore: before,
            targetAfter: after,
            eliminated: elim,
          });
          maxLevel = Math.max(maxLevel, 3);
          progress = true;
          break;
        }
      }
      if (progress) break;
    }
    if (progress) { if (grid[targetRow][targetCol].size === 1) break; continue; }

    // ---- L4a：N-Fish（X翼 n=2, 剑鱼 n=3）----
    for (const n of [2, 3] as const) {
      if (progress) break;
      const nf = applyNFish(grid, work, n);
      if (nf) {
        const after = getCur();
        const affects = nf.elimCells.some(([r, c]) => r === targetRow && c === targetCol) || !arrEqual(before, after);
        const elim = before.filter(v => !after.includes(v));
        steps.push({
          technique: n === 2 ? "X翼" : "剑鱼",
          level: 4,
          affectsTarget: affects,
          description: nf.desc +
            (affects ? `\n  → 目标格 ${tc}：[${before.join(",")}] → [${after.join(",")}]` : ""),
          shortDesc: affects
            ? `${nf.shortDescBase} → 排除${elim.join(",")} → [${after.join(",")}]`
            : nf.shortDescBase,
          targetBefore: before,
          targetAfter: after,
          eliminated: elim,
        });
        maxLevel = Math.max(maxLevel, 4);
        progress = true;
      }
    }
    if (progress) { if (grid[targetRow][targetCol].size === 1) break; continue; }

    // ---- L4b：XY翼 ----
    const xy = applyXYWing(grid, work);
    if (xy) {
      const after = getCur();
      const affects = xy.elimCells.some(([r, c]) => r === targetRow && c === targetCol) || !arrEqual(before, after);
      const elim = before.filter(v => !after.includes(v));
      steps.push({
        technique: "XY翼",
        level: 4,
        affectsTarget: affects,
        description: xy.desc +
          (affects ? `\n  → 目标格 ${tc}：[${before.join(",")}] → [${after.join(",")}]` : ""),
        shortDesc: affects
          ? `${xy.shortDescBase} → 排除${elim.join(",")} → [${after.join(",")}]`
          : xy.shortDescBase,
        targetBefore: before,
        targetAfter: after,
        eliminated: elim,
      });
      maxLevel = Math.max(maxLevel, 4);
      progress = true;
    }
    if (progress) { if (grid[targetRow][targetCol].size === 1) break; continue; }

    // ---- L4c：XYZ翼 ----
    const xyz = applyXYZWing(grid, work);
    if (xyz) {
      const after = getCur();
      const affects = xyz.elimCells.some(([r, c]) => r === targetRow && c === targetCol) || !arrEqual(before, after);
      const elim = before.filter(v => !after.includes(v));
      steps.push({
        technique: "XYZ翼",
        level: 4,
        affectsTarget: affects,
        description: xyz.desc +
          (affects ? `\n  → 目标格 ${tc}：[${before.join(",")}] → [${after.join(",")}]` : ""),
        shortDesc: affects
          ? `${xyz.shortDescBase} → 排除${elim.join(",")} → [${after.join(",")}]`
          : xyz.shortDescBase,
        targetBefore: before,
        targetAfter: after,
        eliminated: elim,
      });
      maxLevel = Math.max(maxLevel, 4);
      progress = true;
    }
    if (progress) { if (grid[targetRow][targetCol].size === 1) break; continue; }

    // ---- L4d：单链着色（Simple Coloring） ----
    const sc = applySimpleColoring(grid, work);
    if (sc) {
      const after = getCur();
      const affects = sc.elimCells.some(([r, c]) => r === targetRow && c === targetCol) || !arrEqual(before, after);
      const elim = before.filter(v => !after.includes(v));
      steps.push({
        technique: "单链着色",
        level: 4,
        affectsTarget: affects,
        description: sc.desc +
          (affects ? `\n  → 目标格 ${tc}：[${before.join(",")}] → [${after.join(",")}]` : ""),
        shortDesc: affects
          ? `${sc.shortDescBase} → 排除${elim.join(",")} → [${after.join(",")}]`
          : sc.shortDescBase,
        targetBefore: before,
        targetAfter: after,
        eliminated: elim,
      });
      maxLevel = Math.max(maxLevel, 4);
      progress = true;
    }
    if (progress) { if (grid[targetRow][targetCol].size === 1) break; continue; }

    // ---- L5a：X链（单值交替推断链）----
    const xch = applyXChain(grid, work);
    if (xch) {
      const after = getCur();
      const affects = xch.elimCells.some(([r, c]) => r === targetRow && c === targetCol) || !arrEqual(before, after);
      const elim = before.filter(v => !after.includes(v));
      steps.push({
        technique: "X链",
        level: 5,
        affectsTarget: affects,
        description: xch.desc +
          (affects ? `\n  → 目标格 ${tc}：[${before.join(",")}] → [${after.join(",")}]` : ""),
        shortDesc: affects
          ? `${xch.shortDescBase} → 排除${elim.join(",")} → [${after.join(",")}]`
          : xch.shortDescBase,
        targetBefore: before,
        targetAfter: after,
        eliminated: elim,
      });
      maxLevel = Math.max(maxLevel, 5);
      progress = true;
    }
    if (progress) { if (grid[targetRow][targetCol].size === 1) break; continue; }

    // ---- L5：XY链 ----
    const xyc = applyXYChain(grid, work);
    if (xyc) {
      const after = getCur();
      const affects = xyc.elimCells.some(([r, c]) => r === targetRow && c === targetCol) || !arrEqual(before, after);
      const elim = before.filter(v => !after.includes(v));
      steps.push({
        technique: "XY链",
        level: 5,
        affectsTarget: affects,
        description: xyc.desc +
          (affects ? `\n  → 目标格 ${tc}：[${before.join(",")}] → [${after.join(",")}]` : ""),
        shortDesc: affects
          ? `${xyc.shortDescBase} → 排除${elim.join(",")} → [${after.join(",")}]`
          : xyc.shortDescBase,
        targetBefore: before,
        targetAfter: after,
        eliminated: elim,
      });
      maxLevel = Math.max(maxLevel, 5);
      progress = true;
    }
    if (progress) { if (grid[targetRow][targetCol].size === 1) break; continue; }

    // 所有已知技巧均无进展 → 卡住
    break;
  }

  // ========================= 结果 =========================
  if (grid[targetRow][targetCol].size === 1) {
    const answer = getCur()[0];
    return { success: true, steps, maxLevel, answer };
  }

  return {
    success: false,
    reason: "stuck",
    partialSteps: steps,
    remainingCands: getCur(),
  };
}

// ========================= 显性唯余（Naked Single） =========================

/** 找到任意一个候选数只剩 1 个的未确定格 */
function findNakedSingle(
  grid: CandGrid,
  work: number[][],
): { r: number; c: number; v: number } | null {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (work[r][c] === 0 && grid[r][c].size === 1) {
        return { r, c, v: [...grid[r][c]][0] };
      }
    }
  }
  return null;
}

// ========================= 紧凑格式化输出 =========================

const STEP_NUMS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮'];

/**
 * 将求解结果格式化为紧凑的 4-5 行输出。
 * 只展示真正影响目标格候选数的步骤（affectsTarget=true）。
 *
 * @param result   solve() 的返回结果
 * @param targetLabel  目标格标签，如 "A3"
 */
export function formatCompactSteps(result: SolveResult, targetLabel: string): string {
  if (!result.success) {
    const remaining = result.remainingCands;
    const lines = [`【${targetLabel}】超出当前支持的推理范围`];
    const partial = result.partialSteps.filter(s => s.affectsTarget);
    if (partial.length > 0) {
      const lastAfter = partial[partial.length - 1].targetAfter;
      lines.push(`候选数已缩减至 [${lastAfter.join(",")}]，仍需更高阶技巧推断`);
    } else {
      lines.push(`候选数 [${remaining.join(",")}]，无法进一步推断`);
    }
    return lines.join('\n');
  }

  const relevant = result.steps.filter(s => s.affectsTarget);
  if (relevant.length === 0) {
    return `【${targetLabel}】答案：${result.answer}（初始消除直接确定）`;
  }

  const lines: string[] = [`【${targetLabel}】答案：${result.answer}`];
  relevant.forEach((step, idx) => {
    const num = STEP_NUMS[idx] ?? `(${idx + 1})`;
    const isFinal = idx === relevant.length - 1;
    lines.push(`${num} ${step.shortDesc}${isFinal ? ' ✓' : ''}`);
  });

  return lines.join('\n');
}
