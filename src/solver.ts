/**
 * solver.ts — 数独逻辑推理求解器
 *
 * 支持技巧层级（按用户分类，不分高下，选最高效路线）：
 *  L1：宫排除（Box Elimination）、隐性唯余-宫（Hidden Single in Box）
 *  L2：行列排除（Row/Column Elimination）、隐性唯余-行列（Hidden Single in Row/Col）、
 *       区块排除（Pointing Pairs/Triples）
 *  L3：显性唯余（Naked Single）、显性数对/数组（Naked Pair/Triple）、
 *       隐性数对/数组（Hidden Pair/Triple）
 *  L4：N-Fish（X翼/剑鱼）、XY翼、XYZ翼、单链着色（Simple Coloring）
 *  L5：X链（X-Chain）、XY链（XY-Chain）
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
  prereqCells?: string[];  // 使能本步的前置格坐标（如 ["D3","F8","B4"]），用于过滤▸先推导
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

// ========================= 辅助：全量扫描各类赋值步骤 =========================

/** 扫描全盘所有可用的宫隐性唯余步骤 */
function findAllBoxHiddenSingles(
  grid: CandGrid,
  work: number[][],
): Array<{ br: number; bc: number; r: number; c: number; v: number }> {
  const result: Array<{ br: number; bc: number; r: number; c: number; v: number }> = [];
  for (let br = 0; br < 9; br += 3) {
    for (let bc = 0; bc < 9; bc += 3) {
      const cells = boxCellList(br, bc);
      const empty = cells.filter(([r, c]) => work[r][c] === 0);
      for (let v = 1; v <= 9; v++) {
        const cands = empty.filter(([r, c]) => grid[r][c].has(v));
        if (cands.length === 1) result.push({ br, bc, r: cands[0][0], c: cands[0][1], v });
      }
    }
  }
  return result;
}

/** 扫描全盘所有可用的行隐性唯余步骤 */
function findAllRowHiddenSingles(
  grid: CandGrid,
  work: number[][],
): Array<{ row: number; r: number; c: number; v: number }> {
  const result: Array<{ row: number; r: number; c: number; v: number }> = [];
  for (let i = 0; i < 9; i++) {
    const rowEmpty = (Array.from({ length: 9 }, (_, c) => [i, c]) as Array<[number, number]>)
      .filter(([r, c]) => work[r][c] === 0);
    for (let v = 1; v <= 9; v++) {
      const cands = rowEmpty.filter(([r, c]) => grid[r][c].has(v));
      if (cands.length === 1) result.push({ row: i, r: cands[0][0], c: cands[0][1], v });
    }
  }
  return result;
}

/** 扫描全盘所有可用的列隐性唯余步骤 */
function findAllColHiddenSingles(
  grid: CandGrid,
  work: number[][],
): Array<{ col: number; r: number; c: number; v: number }> {
  const result: Array<{ col: number; r: number; c: number; v: number }> = [];
  for (let i = 0; i < 9; i++) {
    const colEmpty = (Array.from({ length: 9 }, (_, r) => [r, i]) as Array<[number, number]>)
      .filter(([r, c]) => work[r][c] === 0);
    for (let v = 1; v <= 9; v++) {
      const cands = colEmpty.filter(([r, c]) => grid[r][c].has(v));
      if (cands.length === 1) result.push({ col: i, r: cands[0][0], c: cands[0][1], v });
    }
  }
  return result;
}

/** 扫描全盘所有可用的显性唯余（naked single）步骤 */
function findAllNakedSingles(
  grid: CandGrid,
  work: number[][],
): Array<{ r: number; c: number; v: number }> {
  const result: Array<{ r: number; c: number; v: number }> = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (work[r][c] === 0 && grid[r][c].size === 1) result.push({ r, c, v: [...grid[r][c]][0] });
    }
  }
  return result;
}

// ========================= DP 最优路径规划 =========================

/**
 * DP 代价表：dp[r][c][v-1] = 从初始盘面出发，用纯逻辑至少需要几步赋值可确定 (r,c)=v。
 * 已知格代价为 0；不可达格代价为 Infinity。
 */
type DPTable = number[][][];

/**
 * Bellman-Ford 迭代法计算全盘 DP 最小代价表。
 *
 * 递归定义（四种证明方式取最小值）：
 *  cost(r,c,v) = 1 + min{
 *    宫隐性唯余：∑ blockers B in box  → minElimCost(B, v, 宫外行/列同格)
 *    行隐性唯余：∑ blockers B in row  → minElimCost(B, v, 同列/同宫非行格)
 *    列隐性唯余：∑ blockers B in col  → minElimCost(B, v, 同行/同宫非列格)
 *    显性唯余：  ∑ other cands u      → minElimCost((r,c), u, 所有邻格)
 *  }
 *  minElimCost(B, v, peers) = min over P∈peers of cost(P, v)
 */
function computeDPCosts(puzzle: number[][], grid: CandGrid): DPTable {
  const dp: DPTable = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (_, c) => {
      const arr = new Array(9).fill(Infinity);
      if (puzzle[r][c] !== 0) arr[puzzle[r][c] - 1] = 0;
      return arr;
    }),
  );

  let changed = true;
  let iters = 0;
  while (changed && iters < 400) {
    changed = false;
    iters++;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (puzzle[r][c] !== 0) continue;
        for (let vi = 0; vi < 9; vi++) {
          const v = vi + 1;
          if (!grid[r][c].has(v)) continue;
          const best = _dpBestCost(r, c, v, dp, grid, puzzle);
          if (best < dp[r][c][vi]) {
            dp[r][c][vi] = best;
            changed = true;
          }
        }
      }
    }
  }
  return dp;
}

/**
 * 计算单个 (r,c,v) 的最优 DP 代价（五种证明方式取最小值）。
 *
 * 相比旧版新增两项优化：
 *  - minElim Option B：阻塞格 (er,ec) 可通过自身赋值 u≠v 来自我消除（而非只靠邻格赋值 v）
 *  - Method 4 数对占位免费排除：若目标格单元中已存在包含干扰候选数 u 的裸数对，
 *    则排除 u 的代价为 0，路径更短
 */
function _dpBestCost(
  r: number, c: number, v: number,
  dp: DPTable, grid: CandGrid, puzzle: number[][],
): number {
  const [br0, bc0] = boxOrigin(r, c);
  const boxCells = boxCellList(br0, bc0);
  let best = Infinity;

  /**
   * 扩展版最小消除代价：求将候选数 v 从阻塞格 (er,ec) 中排除的最低代价。
   *  Option A（原有）：找同单元某邻格赋值 v，直接将 v 从 (er,ec) 中消除。
   *  Option B（新增）：将 (er,ec) 自身赋为某个 u≠v，格子已确定，v 自动排除。
   */
  const minElim = (er: number, ec: number, peers: Array<[number, number]>): number => {
    if (!grid[er][ec].has(v) || puzzle[er][ec] !== 0) return 0;
    let m = Infinity;
    // Option A: 同单元某格赋值 v → 从 (er,ec) 消除 v
    for (const [pr, pc] of peers) {
      const cv = dp[pr][pc][v - 1];
      if (cv < m) m = cv;
    }
    // Option B: (er,ec) 自身赋为 u≠v → 阻塞格自我消除
    for (let ui = 0; ui < 9; ui++) {
      if (ui === v - 1 || !grid[er][ec].has(ui + 1)) continue;
      const cv = dp[er][ec][ui];
      if (cv < m) m = cv;
    }
    return m;
  };

  // Method 1：宫隐性唯余
  {
    let cost = 1;
    for (const [br, bc] of boxCells) {
      if (puzzle[br][bc] !== 0 || (br === r && bc === c) || !grid[br][bc].has(v)) continue;
      const peers: Array<[number, number]> = [];
      for (let c2 = 0; c2 < 9; c2++) if (Math.floor(c2 / 3) * 3 !== bc0) peers.push([br, c2]);
      for (let r2 = 0; r2 < 9; r2++) if (Math.floor(r2 / 3) * 3 !== br0) peers.push([r2, bc]);
      const e = minElim(br, bc, peers);
      cost += e;
      if (cost >= best) break;
    }
    if (cost < best) best = cost;
  }

  // Method 2：行隐性唯余
  {
    let cost = 1;
    for (let c2 = 0; c2 < 9; c2++) {
      if (c2 === c || !grid[r][c2].has(v) || puzzle[r][c2] !== 0) continue;
      const [bR2, bC2] = boxOrigin(r, c2);
      const peers: Array<[number, number]> = [];
      for (let r2 = 0; r2 < 9; r2++) if (r2 !== r) peers.push([r2, c2]);
      for (let rr = bR2; rr < bR2 + 3; rr++)
        for (let cc = bC2; cc < bC2 + 3; cc++)
          if (rr !== r) peers.push([rr, cc]);
      const e = minElim(r, c2, peers);
      cost += e;
      if (cost >= best) break;
    }
    if (cost < best) best = cost;
  }

  // Method 3：列隐性唯余
  {
    let cost = 1;
    for (let r2 = 0; r2 < 9; r2++) {
      if (r2 === r || !grid[r2][c].has(v) || puzzle[r2][c] !== 0) continue;
      const [bR2, bC2] = boxOrigin(r2, c);
      const peers: Array<[number, number]> = [];
      for (let c2 = 0; c2 < 9; c2++) if (c2 !== c) peers.push([r2, c2]);
      for (let rr = bR2; rr < bR2 + 3; rr++)
        for (let cc = bC2; cc < bC2 + 3; cc++)
          if (cc !== c) peers.push([rr, cc]);
      const e = minElim(r2, c, peers);
      cost += e;
      if (cost >= best) break;
    }
    if (cost < best) best = cost;
  }

  // Method 4：显性唯余（naked single）—— 含数对占位免费排除
  {
    // 预构建目标格的三个单元列表，用于裸数对检测
    const unitLists: Array<Array<[number, number]>> = [
      Array.from({ length: 9 }, (_, c2): [number, number] => [r, c2]),
      Array.from({ length: 9 }, (_, r2): [number, number] => [r2, c]),
      boxCells,
    ];
    let cost = 1;
    for (const u of grid[r][c]) {
      if (u === v) continue;
      let minU = Infinity;
      // 常规：找代价最低的邻格赋值来排除干扰数 u
      for (let c2 = 0; c2 < 9; c2++) if (c2 !== c) { const cv = dp[r][c2][u - 1]; if (cv < minU) minU = cv; }
      for (let r2 = 0; r2 < 9; r2++) if (r2 !== r) { const cv = dp[r2][c][u - 1]; if (cv < minU) minU = cv; }
      for (const [r2, c2] of boxCells) if (r2 !== r || c2 !== c) { const cv = dp[r2][c2][u - 1]; if (cv < minU) minU = cv; }
      // 数对占位免费排除：若目标格单元中已存在包含 u 的裸数对（两格均为 size=2 且候选数相同），
      // 则 u 被锁定在该数对，将被免费从目标格消除，排除代价为 0。
      if (minU > 0) {
        outer: for (const unitCells of unitLists) {
          const pairCands = unitCells.filter(([r2, c2]) =>
            puzzle[r2][c2] === 0 && !(r2 === r && c2 === c) &&
            grid[r2][c2].size === 2 && grid[r2][c2].has(u),
          );
          for (let i = 0; i < pairCands.length - 1; i++) {
            const p1v = sortedArr(grid[pairCands[i][0]][pairCands[i][1]]);
            for (let j = i + 1; j < pairCands.length; j++) {
              if (arrEqual(sortedArr(grid[pairCands[j][0]][pairCands[j][1]]), p1v)) {
                minU = 0;   // 裸数对已存在，排除免费
                break outer;
              }
            }
          }
        }
      }
      cost += minU;
      if (cost >= best) break;
    }
    if (cost < best) best = cost;
  }

  return best;
}

/**
 * 快速前向求解（不记录步骤），仅用于发现目标格的正确答案值。
 * 这是 DP 证明树计算的预处理步骤——需要先知道答案才能构建最优证明树。
 */
function quickSolveForAnswer(
  puzzle: number[][],
  initGrid: CandGrid,
  tr: number,
  tc: number,
): number {
  const g = initGrid.map((row) => row.map((s) => new Set(s)));
  const w = puzzle.map((row) => [...row]);
  const units = getAllUnits();

  for (let iter = 0; iter < 1000; iter++) {
    if (g[tr][tc].size === 1) break;
    let progress = false;

    // L1/L2a：全单元隐性唯余
    for (const unit of units) {
      const hs = findHiddenSingleInUnit(g, w, unit.cells);
      if (hs) { assignCell(g, w, hs.r, hs.c, hs.v); progress = true; break; }
    }
    if (progress) continue;

    // L2b：区块排除
    if (applyPointingPairs(g, w)) { progress = true; continue; }

    // L3a：显性唯余
    const ns = findAllNakedSingles(g, w);
    if (ns.length > 0) { assignCell(g, w, ns[0].r, ns[0].c, ns[0].v); progress = true; continue; }

    // L3b/c：数对/数组
    for (const unit of units) {
      for (const sz of [2, 3] as const) {
        if (applyNakedSet(g, w, unit.cells, sz)) { progress = true; break; }
      }
      if (progress) break;
    }
    if (progress) continue;
    for (const unit of units) {
      for (const sz of [2, 3] as const) {
        if (applyHiddenSet(g, w, unit.cells, sz)) { progress = true; break; }
      }
      if (progress) break;
    }
    if (progress) continue;

    // L4：N-Fish、翼类、链类
    for (const n of [2, 3] as const) { if (applyNFish(g, w, n)) { progress = true; break; } }
    if (progress) continue;
    if (applyXYWing(g, w)) { progress = true; continue; }
    if (applyXYZWing(g, w)) { progress = true; continue; }
    if (applySimpleColoring(g, w)) { progress = true; continue; }
    if (applyXYChain(g, w)) { progress = true; continue; }
    if (applyXChain(g, w)) { progress = true; continue; }

    break;
  }

  return g[tr][tc].size === 1 ? [...g[tr][tc]][0] : -1;
}

/**
 * 检查数独题目是否可以完全用直观技巧（无链/无鱼/无翼）解决。
 *
 * 允许使用的技巧（L1-L3）：
 *   - 隐性唯余（行/列/宫 Hidden Single）
 *   - 区块排除（Pointing Pairs/Triples）
 *   - 显性唯余（Naked Single）
 *   - 显性数对/数组（Naked Pair/Triple）
 *   - 隐性数对/数组（Hidden Pair/Triple）
 *
 * 禁止使用的技巧（链类/鱼类/翼类）：
 *   X翼、剑鱼、XY翼、XYZ翼、单链着色、XY链、X链
 *
 * @param puzzle 9×9 数独盘面（0 表示空格）
 * @returns true = 全盘可用直观技巧完全解决；false = 至少一格需要链类技巧
 */
export function checkPuzzleIntuitiveSolvable(puzzle: number[][]): boolean {
  const grid = initCandidates(puzzle);
  const work = puzzle.map((row) => [...row]);
  const units = getAllUnits();

  for (let iter = 0; iter < 5000; iter++) {
    let progress = false;

    // L1/L2a：隐性唯余（全单元扫描）
    for (const unit of units) {
      const hs = findHiddenSingleInUnit(grid, work, unit.cells);
      if (hs) {
        assignCell(grid, work, hs.r, hs.c, hs.v);
        progress = true;
        break;
      }
    }
    if (progress) continue;

    // L2b：区块排除（Pointing Pairs/Triples）
    if (applyPointingPairs(grid, work)) { progress = true; continue; }

    // L3a：显性唯余（Naked Single）
    const ns = findAllNakedSingles(grid, work);
    if (ns.length > 0) {
      assignCell(grid, work, ns[0].r, ns[0].c, ns[0].v);
      progress = true;
      continue;
    }

    // L3b/c：显性数对 / 显性数组
    for (const unit of units) {
      for (const sz of [2, 3] as const) {
        if (applyNakedSet(grid, work, unit.cells, sz)) { progress = true; break; }
      }
      if (progress) break;
    }
    if (progress) continue;

    // L3d/e：隐性数对 / 隐性数组
    for (const unit of units) {
      for (const sz of [2, 3] as const) {
        if (applyHiddenSet(grid, work, unit.cells, sz)) { progress = true; break; }
      }
      if (progress) break;
    }
    if (progress) continue;

    // 无法继续（需要链类/鱼类技巧才能推进）→ 退出
    break;
  }

  // 检查所有初始空格是否已全部填满
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (puzzle[r][c] === 0 && work[r][c] === 0) {
        return false; // 存在无法直观解出的格
      }
    }
  }
  return true;
}

/**
 * 从目标 (tr,tc,answer) 出发，反向展开 DP 最优证明树，
 * 返回所有"必须推导"的 "(r,c,v)" 键集合。
 *
 * 主求解循环中只有该集合内的格才会以最高优先级被应用，
 * 确保执行路径与 DP 计算的理论最短路径完全一致。
 */
function extractProofTree(
  puzzle: number[][],
  grid: CandGrid,
  dp: DPTable,
  tr: number,
  tc: number,
  answer: number,
): Set<string> {
  const needed = new Set<string>();
  const visiting = new Set<string>();

  function expand(r: number, c: number, v: number): void {
    const key = `${r},${c},${v}`;
    if (needed.has(key) || visiting.has(key)) return;
    if (puzzle[r][c] !== 0) return; // 已知格：证明树叶节点，无需继续展开
    visiting.add(key);
    needed.add(key);
    const prereqs = _findOptimalPrereqs(r, c, v, dp, grid, puzzle);
    for (const p of prereqs) expand(p.r, p.c, p.v);
    visiting.delete(key);
  }

  expand(tr, tc, answer);
  return needed;
}

/**
 * 根据 DP 代价表，找出推导 (r,c)=v 所需的最优前置格列表。
 * 遍历五种证明方式，返回代价与 targetCost 匹配的那种方式的前置格。
 *
 * 相比旧版新增：
 *  - bestElimPeer Option B：阻塞格自身赋值 u≠v 也是合法的消除前置格
 *  - Method 4：裸数对已存在时排除代价为 0，无需前置格
 */
function _findOptimalPrereqs(
  r: number, c: number, v: number,
  dp: DPTable, grid: CandGrid, puzzle: number[][],
): Array<{ r: number; c: number; v: number }> {
  const targetCost = dp[r][c][v - 1];
  if (!isFinite(targetCost) || targetCost <= 0) return [];

  const [br0, bc0] = boxOrigin(r, c);
  const boxCells = boxCellList(br0, bc0);

  /**
   * 扩展版最优消除来源：求消除阻塞格 (er,ec) 中候选数 v 的最优前置格。
   *  Option A（原有）：同单元某邻格赋值 v，直接消除 (er,ec) 的 v。
   *  Option B（新增）：(er,ec) 自身赋为 u≠v，格子已确定，v 自动排除。
   * 返回值含 v 字段（Option B 时为 u，Option A 时为原 v）。
   */
  const bestElimPeer = (
    er: number, ec: number,
    peers: Array<[number, number]>,
  ): { r: number; c: number; v: number; cost: number } | null => {
    if (!grid[er][ec].has(v) || puzzle[er][ec] !== 0) return null;
    let minCost = Infinity;
    let best: { r: number; c: number; v: number } | null = null;
    // Option A: 同单元某格赋值 v
    for (const [pr, pc] of peers) {
      const cv = dp[pr][pc][v - 1];
      if (cv < minCost) { minCost = cv; best = { r: pr, c: pc, v }; }
    }
    // Option B: (er,ec) 自身赋值 u≠v
    for (let ui = 0; ui < 9; ui++) {
      if (ui === v - 1 || !grid[er][ec].has(ui + 1)) continue;
      const cv = dp[er][ec][ui];
      if (cv < minCost) { minCost = cv; best = { r: er, c: ec, v: ui + 1 }; }
    }
    return best ? { ...best, cost: minCost } : null;
  };

  // Method 1：宫隐性唯余
  {
    let cost = 1;
    const prereqs: Array<{ r: number; c: number; v: number }> = [];
    let valid = true;
    for (const [br, bc] of boxCells) {
      if (puzzle[br][bc] !== 0 || (br === r && bc === c) || !grid[br][bc].has(v)) continue;
      const peers: Array<[number, number]> = [];
      for (let c2 = 0; c2 < 9; c2++) if (Math.floor(c2 / 3) * 3 !== bc0) peers.push([br, c2]);
      for (let r2 = 0; r2 < 9; r2++) if (Math.floor(r2 / 3) * 3 !== br0) peers.push([r2, bc]);
      const ep = bestElimPeer(br, bc, peers);
      if (ep) { cost += ep.cost; prereqs.push({ r: ep.r, c: ep.c, v: ep.v }); }
      else { valid = false; break; }
    }
    if (valid && Math.abs(cost - targetCost) <= 1) return prereqs;
  }

  // Method 2：行隐性唯余
  {
    let cost = 1;
    const prereqs: Array<{ r: number; c: number; v: number }> = [];
    let valid = true;
    for (let c2 = 0; c2 < 9; c2++) {
      if (c2 === c || !grid[r][c2].has(v) || puzzle[r][c2] !== 0) continue;
      const [bR2, bC2] = boxOrigin(r, c2);
      const peers: Array<[number, number]> = [];
      for (let r2 = 0; r2 < 9; r2++) if (r2 !== r) peers.push([r2, c2]);
      for (let rr = bR2; rr < bR2 + 3; rr++)
        for (let cc = bC2; cc < bC2 + 3; cc++)
          if (rr !== r) peers.push([rr, cc]);
      const ep = bestElimPeer(r, c2, peers);
      if (ep) { cost += ep.cost; prereqs.push({ r: ep.r, c: ep.c, v: ep.v }); }
      else { valid = false; break; }
    }
    if (valid && Math.abs(cost - targetCost) <= 1) return prereqs;
  }

  // Method 3：列隐性唯余
  {
    let cost = 1;
    const prereqs: Array<{ r: number; c: number; v: number }> = [];
    let valid = true;
    for (let r2 = 0; r2 < 9; r2++) {
      if (r2 === r || !grid[r2][c].has(v) || puzzle[r2][c] !== 0) continue;
      const [bR2, bC2] = boxOrigin(r2, c);
      const peers: Array<[number, number]> = [];
      for (let c2 = 0; c2 < 9; c2++) if (c2 !== c) peers.push([r2, c2]);
      for (let rr = bR2; rr < bR2 + 3; rr++)
        for (let cc = bC2; cc < bC2 + 3; cc++)
          if (cc !== c) peers.push([rr, cc]);
      const ep = bestElimPeer(r2, c, peers);
      if (ep) { cost += ep.cost; prereqs.push({ r: ep.r, c: ep.c, v: ep.v }); }
      else { valid = false; break; }
    }
    if (valid && Math.abs(cost - targetCost) <= 1) return prereqs;
  }

  // Method 4：显性唯余（naked single）—— 含数对占位免费排除
  {
    const unitLists: Array<Array<[number, number]>> = [
      Array.from({ length: 9 }, (_, c2): [number, number] => [r, c2]),
      Array.from({ length: 9 }, (_, r2): [number, number] => [r2, c]),
      boxCells,
    ];
    let cost = 1;
    const prereqs: Array<{ r: number; c: number; v: number }> = [];
    let valid = true;
    for (const u of grid[r][c]) {
      if (u === v) continue;
      let minCost = Infinity;
      let bestCell: { r: number; c: number } | null = null;
      for (let c2 = 0; c2 < 9; c2++) if (c2 !== c) { const cv = dp[r][c2][u - 1]; if (cv < minCost) { minCost = cv; bestCell = { r, c: c2 }; } }
      for (let r2 = 0; r2 < 9; r2++) if (r2 !== r) { const cv = dp[r2][c][u - 1]; if (cv < minCost) { minCost = cv; bestCell = { r: r2, c }; } }
      for (const [r2, c2] of boxCells) if (r2 !== r || c2 !== c) { const cv = dp[r2][c2][u - 1]; if (cv < minCost) { minCost = cv; bestCell = { r: r2, c: c2 }; } }
      // 数对占位免费排除：裸数对已存在则排除代价为 0，无需前置格
      let nakedPairFree = false;
      if (minCost > 0) {
        outer: for (const unitCells of unitLists) {
          const pairCands = unitCells.filter(([r2, c2]) =>
            puzzle[r2][c2] === 0 && !(r2 === r && c2 === c) &&
            grid[r2][c2].size === 2 && grid[r2][c2].has(u),
          );
          for (let i = 0; i < pairCands.length - 1; i++) {
            const p1v = sortedArr(grid[pairCands[i][0]][pairCands[i][1]]);
            for (let j = i + 1; j < pairCands.length; j++) {
              if (arrEqual(sortedArr(grid[pairCands[j][0]][pairCands[j][1]]), p1v)) {
                nakedPairFree = true;
                minCost = 0;
                bestCell = null;
                break outer;
              }
            }
          }
        }
      }
      if (!nakedPairFree) {
        if (bestCell && isFinite(minCost)) {
          prereqs.push({ r: bestCell.r, c: bestCell.c, v: u });
        } else {
          valid = false; break;
        }
      }
      cost += minCost;
      if (!isFinite(cost)) { valid = false; break; }
    }
    if (valid && Math.abs(cost - targetCost) <= 1) return prereqs;
  }

  return []; // 无法匹配（回退，通常不会发生）
}

/**
 * 基础启发式评分（不含 DP 证明树加成）。
 *
 * 得分层级（由高到低）：
 *   1_000_000：直接赋值到目标格（立即解决）
 *   100_000+ ：v 在目标格候选数中，且 (r,c) 是同行/列/宫邻格（直接消除目标候选）
 *   50_000+  ：赋值后经级联消除使目标格候选数减少
 *   40_000   ：赋值后使目标格产生新的隐性唯余（二步前瞻）
 *   1_000    ：仅是邻格，无即时影响
 *   20_000   ：Blocker 直接消除
 *   5_000    ：Blocker 精化
 *   10       ：v 在目标格候选数中（潜在相关）
 *   1        ：其他（通用进度）
 */
function _scoreBaseHeuristic(
  r: number,
  c: number,
  v: number,
  grid: CandGrid,
  work: number[][],
  tr: number,
  tc: number,
): number {
  if (r === tr && c === tc) return 1_000_000;

  const bTr = Math.floor(tr / 3) * 3;
  const bTc = Math.floor(tc / 3) * 3;
  const isPeer =
    r === tr || c === tc || (Math.floor(r / 3) * 3 === bTr && Math.floor(c / 3) * 3 === bTc);

  if (isPeer && grid[tr][tc].has(v)) {
    return 100_000 + (10 - grid[tr][tc].size) * 1_000;
  }

  if (isPeer) {
    // 模拟赋值，检查目标格候选的级联变化
    const sg = grid.map((row) => row.map((s) => new Set(s)));
    const sw = work.map((row) => [...row]);
    assignCell(sg, sw, r, c, v);

    const newSize = sg[tr][tc].size;
    if (newSize < grid[tr][tc].size) {
      return 50_000 + (10 - newSize) * 1_000;
    }

    // 二步前瞻：赋值后目标格是否产生新的隐性唯余？
    const [br, bc] = boxOrigin(tr, tc);
    for (const val of sg[tr][tc]) {
      const boxEmp = boxCellList(br, bc).filter(([r2, c2]) => sw[r2][c2] === 0 && sg[r2][c2].has(val));
      if (boxEmp.length === 1) return 40_000;
      const rowEmp = (Array.from({ length: 9 }, (_, c2) => [tr, c2]) as Array<[number, number]>)
        .filter(([r2, c2]) => sw[r2][c2] === 0 && sg[r2][c2].has(val));
      if (rowEmp.length === 1) return 40_000;
      const colEmp = (Array.from({ length: 9 }, (_, r2) => [r2, tc]) as Array<[number, number]>)
        .filter(([r2, c2]) => sw[r2][c2] === 0 && sg[r2][c2].has(val));
      if (colEmp.length === 1) return 40_000;
    }

    return 1_000;
  }

  // === Blocker 定向奖励 ===
  // 目标格某宫/行/列的隐性唯余 blockers 数量越少、或本步越能推进 blocker 的消除，得分越高。
  // 分为两层：
  //   A. 直接消除：步骤的值 v === V（目标候选），且 (r,c) 与某 blocker 同单元 → 20000/blockers数
  //   B. 间接精化：步骤的值 v !== V，但 (r,c) 与某 blocker 同单元，消除 blocker 中 v 候选 → 5000/(blockers数×blocker候选数)
  //      这使 blocker 更快成为显性唯余，继而间接消除 V
  let blockerBonus = 0;
  const boxCellsT = boxCellList(bTr, bTc);
  const rowCellsT = Array.from({ length: 9 }, (_, c2) => [tr, c2]) as Array<[number, number]>;
  const colCellsT = Array.from({ length: 9 }, (_, r2) => [r2, tc]) as Array<[number, number]>;

  for (const V of grid[tr][tc]) {
    for (const unitCells of [boxCellsT, rowCellsT, colCellsT]) {
      const blockers = unitCells.filter(
        ([r2, c2]) => work[r2][c2] === 0 && (r2 !== tr || c2 !== tc) && grid[r2][c2].has(V),
      );
      if (blockers.length === 0 || blockers.length > 5) continue;
      for (const [br, bc] of blockers) {
        const bPeer =
          r === br ||
          c === bc ||
          (Math.floor(r / 3) * 3 === Math.floor(br / 3) * 3 &&
            Math.floor(c / 3) * 3 === Math.floor(bc / 3) * 3);
        if (!bPeer) continue;
        if (v === V) {
          // A: 直接消除目标值
          blockerBonus = Math.max(blockerBonus, Math.floor(20_000 / blockers.length));
        } else if (grid[br][bc].has(v)) {
          // B: 精化 blocker（消除 blocker 中某候选，使其更快达到唯余）
          const bSize = grid[br][bc].size;
          blockerBonus = Math.max(blockerBonus, Math.floor(5_000 / (blockers.length * bSize)));
        }
      }
    }
  }
  if (blockerBonus > 0) return blockerBonus;

  if (grid[tr][tc].has(v)) return 10;
  return 1;
}

/**
 * 对赋值步骤（将值 v 填入格 (r,c)）按与目标格 (tr,tc) 的关联度打分，得分越高越优先。
 *
 * 融合基础启发式评分与 DP 证明树软加成：
 *   - 基础启发式（100,000+）：直接目标消除，始终保持最高优先级
 *   - DP 证明树加成（25,000~34,999）：只作为软提升，不覆盖高分直接消除
 *   - 其余：基础启发式得分
 *
 * 这确保：直接消除 > 级联/前瞻 > 证明树前置格 > 一般 Blocker 工作
 */
function scoreAssignmentForTarget(
  r: number,
  c: number,
  v: number,
  grid: CandGrid,
  work: number[][],
  tr: number,
  tc: number,
  dpTable?: DPTable,
  proofTreeCells?: Set<string>,
): number {
  const base = _scoreBaseHeuristic(r, c, v, grid, work, tr, tc);

  // DP 证明树软加成：加成范围 25k-34k
  //   - 高于普通 Blocker 工作（约 20k）：证明树格优先于无关的 Blocker
  //   - 低于二步前瞻（约 40k）：允许级联捷径（外部两步推导）超越证明树
  //   - 远低于直接目标消除（100k+）：关键直接消除永远不被覆盖
  //
  // 注：若某目标格在随机测试中需要链类技巧，生产环境的 validateTargetNoChain
  // 会使用同一 solve() 检测到该结果，自动拒绝并换格重试（自洽验证）。
  // 因此软加成足以保证 D5 的链类安全性，同时保留 D4 级联捷径（D4 max ~35 vs 硬覆盖的 47）。
  if (proofTreeCells && dpTable) {
    const key = `${r},${c},${v}`;
    if (proofTreeCells.has(key)) {
      const dpCost = dpTable[r][c][v - 1];
      const dpBoost = 25_000 + Math.floor(9_000 / (dpCost + 1));
      return Math.max(base, dpBoost);
    }
  }

  return base;
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

  // 紧凑描述（用户展示用）— 统一格式：基础行列宫排除 → 剩余候选数 [...]
  const initShortDesc = `基础行列宫排除 → 剩余候选数 [${initState.join(",")}]`;

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

  // DP 最优路径预计算：
  // 1. 快速前向求解发现目标格答案（不记录步骤）
  // 2. 计算全盘 DP 代价表（Bellman-Ford）
  // 3. 反向展开证明树，得到恰好需要的格子集合
  // 主循环中证明树内的格拥有最高优先级，确保执行顺序与理论最短路径一致。
  const _dpAnswer = quickSolveForAnswer(puzzle, grid, targetRow, targetCol);
  const _dpTable: DPTable | undefined = _dpAnswer > 0 ? computeDPCosts(puzzle, grid) : undefined;
  const _proofTree: Set<string> = (_dpAnswer > 0 && _dpTable)
    ? extractProofTree(puzzle, grid, _dpTable, targetRow, targetCol, _dpAnswer)
    : new Set<string>();

  const allUnits = getAllUnits();

  // 预计算按目标格相关度排序的单元列表，用于 L3b/L3c 数对/数组优先策略：
  // 含目标格的单元 > 与目标格同行/列/宫的单元 > 其他单元
  // 确保找到最短路径所需的数对时，优先选取与目标最相关的那个。
  const [_bTr, _bTc] = [Math.floor(targetRow / 3) * 3, Math.floor(targetCol / 3) * 3];
  const allUnitsSortedForPairs = [...allUnits].sort((ua, ub) => {
    const unitScore = (u: typeof allUnits[0]): number => {
      for (const [r, c] of u.cells) {
        if (r === targetRow && c === targetCol) return 3;
      }
      for (const [r, c] of u.cells) {
        if (r === targetRow || c === targetCol ||
            (Math.floor(r / 3) * 3 === _bTr && Math.floor(c / 3) * 3 === _bTc)) return 1;
      }
      return 0;
    };
    return unitScore(ub) - unitScore(ua);
  });

  // ========================= 主循环 =========================
  for (let iter = 0; iter < 1000; iter++) {
    const before = getCur();
    let progress = false;

    // ---- 统一赋值选步（L1 宫排除 / L2a 行列排除 / L3a 显性唯余）：最优优先 ----
    // 收集全盘所有可用赋值步骤，按与目标格的关联度打分，优先应用最相关的一步。
    // 这确保路径尽可能短：先处理能直接影响目标格的步骤，而非任意从宫0开始顺序扫描。
    {
      type CandA =
        | { type: 'box'; br: number; bc: number; r: number; c: number; v: number; score: number }
        | { type: 'row'; row: number; r: number; c: number; v: number; score: number }
        | { type: 'col'; col: number; r: number; c: number; v: number; score: number }
        | { type: 'naked'; r: number; c: number; v: number; score: number };

      const allCA: CandA[] = [
        ...findAllBoxHiddenSingles(grid, work).map((s) => ({
          type: 'box' as const, ...s,
          score: scoreAssignmentForTarget(s.r, s.c, s.v, grid, work, targetRow, targetCol, _dpTable, _proofTree),
        })),
        ...findAllRowHiddenSingles(grid, work).map((s) => ({
          type: 'row' as const, ...s,
          score: scoreAssignmentForTarget(s.r, s.c, s.v, grid, work, targetRow, targetCol, _dpTable, _proofTree),
        })),
        ...findAllColHiddenSingles(grid, work).map((s) => ({
          type: 'col' as const, ...s,
          score: scoreAssignmentForTarget(s.r, s.c, s.v, grid, work, targetRow, targetCol, _dpTable, _proofTree),
        })),
        ...findAllNakedSingles(grid, work).map((s) => ({
          type: 'naked' as const, ...s,
          score: scoreAssignmentForTarget(s.r, s.c, s.v, grid, work, targetRow, targetCol, _dpTable, _proofTree),
        })),
      ];

      if (allCA.length > 0) {
        // 得分相同时技巧级别低者优先：宫(L1) > 行列(L2a) > 显性唯余(L3a)
        allCA.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          const lvl = (x: CandA) => (x.type === 'box' ? 0 : x.type === 'naked' ? 2 : 1);
          return lvl(a) - lvl(b);
        });

        const best = allCA[0];

        if (best.type === 'box') {
          const exclInfo = boxHiddenSingleExclusionInfo(puzzle, work, grid, best.br, best.bc, best.r, best.c, best.v);
          const cellBox = cellLabel(best.r, best.c);
          const boxN = boxNumber(best.br, best.bc);
          assignCell(grid, work, best.r, best.c, best.v);
          const after = getCur();
          const affects = !arrEqual(before, after);
          const elim = before.filter((v) => !after.includes(v));
          const baseBox = exclInfo.complete
            ? `${exclInfo.desc}的${best.v}对第${boxN}宫排除，仅${cellBox}可填`
            : `第${boxN}宫：仅${cellBox}可填${best.v}`;
          steps.push({
            technique: '隐性唯余（宫）',
            level: 1,
            affectsTarget: affects,
            prereqCells: exclInfo.complete ? exclInfo.cells : undefined,
            description:
              `第 ${boxN} 宫中，数字 ${best.v} 只能填入 ${cellBox}（${exclInfo.desc}${exclInfo.complete ? '' : '等约束'}含${best.v}）` +
              (affects ? `\n  → 目标格 ${tc}：[${before.join(',')}] → [${after.join(',')}]` : ''),
            shortDesc: affects
              ? `${baseBox} → 排除${elim.join(',')} → [${after.join(',')}]`
              : `${baseBox} → ${cellBox}=${best.v}`,
            targetBefore: before,
            targetAfter: after,
            eliminated: elim,
          });
          maxLevel = Math.max(maxLevel, 1);
          progress = true;

        } else if (best.type === 'row') {
          const exclRow = rowHiddenSingleExclusionDesc(work, best.row, best.c, best.v);
          const cellRow = cellLabel(best.r, best.c);
          assignCell(grid, work, best.r, best.c, best.v);
          const after = getCur();
          const affects = !arrEqual(before, after);
          const elim = before.filter((v) => !after.includes(v));
          const baseRow = `${rowLabel(best.row)}行：${exclRow}含${best.v}，仅${cellRow}可填`;
          steps.push({
            technique: '隐性唯余（行）',
            level: 2,
            affectsTarget: affects,
            description:
              `第 ${rowLabel(best.row)} 行中，数字 ${best.v} 只能填入 ${cellRow}（${exclRow}含${best.v}）` +
              (affects ? `\n  → 目标格 ${tc}：[${before.join(',')}] → [${after.join(',')}]` : ''),
            shortDesc: affects
              ? `${baseRow} → 排除${elim.join(',')} → [${after.join(',')}]`
              : `${baseRow} → ${cellRow}=${best.v}`,
            targetBefore: before,
            targetAfter: after,
            eliminated: elim,
          });
          maxLevel = Math.max(maxLevel, 2);
          progress = true;

        } else if (best.type === 'col') {
          const exclCol = colHiddenSingleExclusionDesc(work, best.col, best.r, best.v);
          const cellCol = cellLabel(best.r, best.c);
          assignCell(grid, work, best.r, best.c, best.v);
          const after = getCur();
          const affects = !arrEqual(before, after);
          const elim = before.filter((v) => !after.includes(v));
          const baseCol = `第${best.col + 1}列：${exclCol}含${best.v}，仅${cellCol}可填`;
          steps.push({
            technique: '隐性唯余（列）',
            level: 2,
            affectsTarget: affects,
            description:
              `第 ${best.col + 1} 列中，数字 ${best.v} 只能填入 ${cellCol}（${exclCol}含${best.v}）` +
              (affects ? `\n  → 目标格 ${tc}：[${before.join(',')}] → [${after.join(',')}]` : ''),
            shortDesc: affects
              ? `${baseCol} → 排除${elim.join(',')} → [${after.join(',')}]`
              : `${baseCol} → ${cellCol}=${best.v}`,
            targetBefore: before,
            targetAfter: after,
            eliminated: elim,
          });
          maxLevel = Math.max(maxLevel, 2);
          progress = true;

        } else {
          // naked single
          const trigger = `${cellLabel(best.r, best.c)}=${best.v}（显性唯余）`;
          assignCell(grid, work, best.r, best.c, best.v);
          const after = getCur();
          const affects = !arrEqual(before, after);
          const elim = before.filter((v) => !after.includes(v));
          steps.push({
            technique: '显性唯余（唯一候选数）',
            level: 3,
            affectsTarget: affects,
            description:
              `格 ${cellLabel(best.r, best.c)} 经行/列/宫排除后候选数仅剩 ${best.v}，确定填入` +
              (affects ? `\n  → 目标格 ${tc}：[${before.join(',')}] → [${after.join(',')}]` : ''),
            shortDesc: affects
              ? `${trigger} → 排除${elim.join(',')} → [${after.join(',')}]`
              : trigger,
            targetBefore: before,
            targetAfter: after,
            eliminated: elim,
          });
          maxLevel = Math.max(maxLevel, 3);
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

    // ---- L3b：显性数对/数组（Naked Pair/Triple） ----
    // 使用按目标格相关度预排序的单元列表，优先选取能直接影响目标格的数对
    for (const unit of allUnitsSortedForPairs) {
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
    // 同样使用按目标格相关度预排序的单元列表
    for (const unit of allUnitsSortedForPairs) {
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

// ========================= 排除源描述辅助函数 =========================

/**
 * 计算"宫内隐性唯余"的排除来源：
 * 对宫内除目标格外每个空格，找出是哪个具体格（宫外行/列已填 v）导致该格被排除。
 * 若某格的排除无法用"行/列已有 v"解释（说明是指向数对等候选消除技巧所为），
 * 则 complete = false，调用方应回退到全量展示前置步骤。
 *
 * 返回 { desc, cells, complete }
 *  - desc / cells：可追溯的具体格坐标（如 "B4·D3·F8"）
 *  - complete：false 表示还有候选消除约束无法单靠 work 解释，不应过滤前置步骤
 */
function boxHiddenSingleExclusionInfo(
  puzzle: number[][],
  work: number[][],
  grid: CandGrid,
  br: number, bc: number,
  targetR: number, targetC: number,
  v: number,
): { desc: string; cells: string[]; complete: boolean } {
  const srcCells = new Set<string>();
  const rowsDone = new Set<number>();
  const colsDone = new Set<number>();
  let complete = true;

  for (let r = br; r < br + 3; r++) {
    for (let c = bc; c < bc + 3; c++) {
      if (r === targetR && c === targetC) continue;
      // 只跳过初始盘面中已填入的格。若该格是求解器中间步骤填入的（初始为空），
      // 则仍需尝试寻找直接行/列来源；找不到时设 complete=false，避免说明不完整。
      if (puzzle[r][c] !== 0) continue;
      // 注：对有效的隐性唯余，宫内其他空格一定不含 v 作为候选；此 has(v) 检查用于防御
      if (grid[r][c].has(v)) continue;

      // --- 此格不含 v，需要找排除来源 ---

      // 1. 若该行已被解释，直接跳过
      if (rowsDone.has(r)) continue;

      // 2. 尝试行来源（宫外同行已填 v）
      let foundCol = -1;
      for (let j = 0; j < 9; j++) {
        if (j >= bc && j < bc + 3) continue;
        if (work[r][j] === v) { foundCol = j; break; }
      }
      if (foundCol >= 0) {
        srcCells.add(cellLabel(r, foundCol));
        rowsDone.add(r);
        continue;
      }

      // 3. 若该列已被解释，直接跳过
      if (colsDone.has(c)) continue;

      // 4. 尝试列来源（宫外同列已填 v）
      let foundRow = -1;
      for (let i = 0; i < 9; i++) {
        if (i >= br && i < br + 3) continue;
        if (work[i][c] === v) { foundRow = i; break; }
      }
      if (foundRow >= 0) {
        srcCells.add(cellLabel(foundRow, c));
        colsDone.add(c);
        continue;
      }

      // 5. 行列均未填 v，说明 v 由候选消除技巧（如区块排除）从此格移除
      //    此时无法单靠 work 给出完整解释
      complete = false;
    }
  }

  const cells = [...srcCells].sort();
  const desc = cells.join('·');
  // 若排除来源为空（宫内其他格已填满，或候选数由区块排除等间接移除），
  // 降级为简单描述，避免输出 "?"
  return { desc, cells, complete: complete && cells.length > 0 };
}

/**
 * 计算"行内隐性唯余"的排除来源：
 * 找出是哪些列或哪些宫已含该数字，导致该行其余格不能填入该数字。
 * 格式如 "第1宫·第3宫·5列·8列"。
 */
function rowHiddenSingleExclusionDesc(
  work: number[][],
  row: number,
  targetC: number,
  v: number,
): string {
  const cols  = new Set<number>();
  const boxes = new Set<number>();
  for (let c = 0; c < 9; c++) {
    if (c === targetC) continue;
    let colHasV = false;
    for (let i = 0; i < 9; i++) { if (work[i][c] === v) { colHasV = true; break; } }
    if (colHasV) { cols.add(c); continue; }
    const br = Math.floor(row / 3) * 3;
    const bc = Math.floor(c   / 3) * 3;
    for (let r = br; r < br + 3; r++) {
      for (let cc = bc; cc < bc + 3; cc++) {
        if (work[r][cc] === v) { boxes.add(boxNumber(br, bc)); break; }
      }
    }
  }
  const parts: string[] = [];
  if (boxes.size > 0) parts.push([...boxes].sort((a, b) => a - b).map(b => `第${b}宫`).join('·'));
  if (cols.size  > 0) parts.push([...cols ].sort((a, b) => a - b).map(c => `${c + 1}列`).join('·'));
  return parts.join('·') || '列/宫';
}

/**
 * 计算"列内隐性唯余"的排除来源：
 * 找出是哪些行或哪些宫已含该数字，导致该列其余格不能填入该数字。
 * 格式如 "第1宫·第4宫·B行·E行"。
 */
function colHiddenSingleExclusionDesc(
  work: number[][],
  col: number,
  targetR: number,
  v: number,
): string {
  const rows  = new Set<number>();
  const boxes = new Set<number>();
  for (let r = 0; r < 9; r++) {
    if (r === targetR) continue;
    let rowHasV = false;
    for (let j = 0; j < 9; j++) { if (work[r][j] === v) { rowHasV = true; break; } }
    if (rowHasV) { rows.add(r); continue; }
    const br = Math.floor(r   / 3) * 3;
    const bc = Math.floor(col / 3) * 3;
    for (let rr = br; rr < br + 3; rr++) {
      for (let cc = bc; cc < bc + 3; cc++) {
        if (work[rr][cc] === v) { boxes.add(boxNumber(br, bc)); break; }
      }
    }
  }
  const parts: string[] = [];
  if (boxes.size > 0) parts.push([...boxes].sort((a, b) => a - b).map(b => `第${b}宫`).join('·'));
  if (rows.size  > 0) parts.push([...rows ].sort((a, b) => a - b).map(r => rowLabel(r) + '行').join('·'));
  return parts.join('·') || '行/宫';
}

const STEP_NUMS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮'];

/**
 * 将非目标格铺垫步骤转为"G3唯余出4"样式的简短标签。
 */
function prereqStepLabel(step: SolveStep): string {
  // 单格赋值：shortDesc 中含 "[A-I][1-9]=[1-9]"
  const cellMatch = step.shortDesc.match(/([A-I]\d)=([1-9])/);
  if (cellMatch) return `${cellMatch[1]}唯余出${cellMatch[2]}`;
  // 消除类步骤：取技巧名缩写
  const t = step.technique;
  if (t.includes('区块')) return '[区块排除]';
  if (t.includes('显性') && t.includes('数')) return '[显性数组]';
  if (t.includes('隐性') && t.includes('数')) return '[隐性数组]';
  if (t.includes('X翼') || t.includes('剑鱼')) return '[鱼类]';
  if (t.includes('XY翼') || t.includes('XYZ翼')) return '[翼类]';
  if (t.includes('XY链') || t.includes('X链') || t.includes('着色')) return '[链类]';
  return '[消除]';
}

/**
 * 将求解结果格式化为完整可追溯的路径文本。
 *
 * 格式规则：
 *  ① 候选数 [X,Y,Z] → 行列宫排除
 *  ② 排除X → [余] → [铺垫格唯余出V。]主要原因 → 中间格为X
 *  ⑥ 唯余X ✓ → [铺垫格唯余出V。]主要原因 → 目标格为X
 *
 * @param result       solve() 的返回结果
 * @param targetLabel  目标格标签，如 "F4"
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

  const allSteps = result.steps;
  const relevant = allSteps.filter(s => s.affectsTarget);
  const answer = result.answer;

  if (relevant.length === 0) {
    return `【${targetLabel}】答案：${answer}（初始消除直接确定）`;
  }

  const lines: string[] = [`【${targetLabel}】答案：${answer}`];

  let affectIdx = 0;
  const pendingSteps: SolveStep[] = [];

  // 构建铺垫格前缀字符串，如 "G3唯余出4。F2唯余出2。"
  const buildPrereqPrefix = (nextStep?: SolveStep): string => {
    if (pendingSteps.length === 0) return '';
    let stepsToShow: SolveStep[];
    if (nextStep?.prereqCells && nextStep.prereqCells.length > 0) {
      const prereqSet = new Set(nextStep.prereqCells);
      stepsToShow = pendingSteps.filter(s => {
        const m = s.shortDesc.match(/([A-I]\d)=[1-9]/);
        return m ? prereqSet.has(m[1]) : false;
      });
    } else {
      stepsToShow = pendingSteps;
    }
    if (stepsToShow.length === 0) return '';
    return stepsToShow.map(prereqStepLabel).join('。') + '。';
  };

  // 从 shortDesc 中提取可读原因及尾部结论格
  // 返回 { reason, trailingCell }，其中 trailingCell 形如 "A7为7"
  const extractDesc = (
    step: SolveStep,
    isFinal: boolean,
  ): { reason: string; trailingCell: string | null } => {
    const sd = step.shortDesc;

    // 显性唯余（naked single）："[cell]=V（显性唯余）..."
    const nakedMatch = sd.match(/^([A-I]\d+)=([1-9])（显性唯余）/);
    if (nakedMatch) {
      const [, cell, val] = nakedMatch;
      if (cell === targetLabel && isFinal) {
        // 目标格本身为显性唯余时，直接显示 唯余V ✓ 即可
        return { reason: '', trailingCell: null };
      }
      // 非末步：将"XY唯余出V"改为尾部结论格式"→ XY为V"，明确因果关系
      return { reason: '', trailingCell: `${cell}为${val}` };
    }

    // 去掉尾部 "→ 排除X → [余]" 或 "→ [余]" 得到原因部分
    const stripped = sd
      .replace(/\s*→\s*排除[\d,]+\s*→\s*\[[\d,]+\]\s*$/, '')
      .replace(/\s*→\s*剩余候选数\s*\[[\d,]+\]\s*$/, '')
      .replace(/\s*→\s*\[[\d,]+\]\s*$/, '')
      .trim();

    // 最常见模式："...，仅[cell]可填"
    const hiddenWithComma = stripped.match(/^(.*?)，仅([A-I]\d+)可填$/);
    if (hiddenWithComma) {
      const [, mainR, cell] = hiddenWithComma;
      // 若 cell 就是目标格自身（直接唯余），用 targetAfter[0]（即答案）；
      // 否则 cell 是被赋值的中间格，其值等于从目标格排除的候选数（eliminated）。
      const cellVal = (cell === targetLabel)
        ? String(step.targetAfter[0] ?? answer)
        : step.eliminated.join(',');
      return { reason: mainR, trailingCell: `${cell}为${cellVal}` };
    }

    // 不完整宫排除："第N宫：仅[cell]可填V"
    const boxOnlyMatch = stripped.match(/^第(\d+)宫：仅([A-I]\d+)可填(\d+)$/);
    if (boxOnlyMatch) {
      return {
        reason: `第${boxOnlyMatch[1]}宫排除`,
        trailingCell: `${boxOnlyMatch[2]}为${boxOnlyMatch[3]}`,
      };
    }

    // 其余技巧（区块排除、数对、鱼类、链类等）：直接保留原因描述
    return { reason: stripped, trailingCell: null };
  };

  for (const step of allSteps) {
    if (step.affectsTarget) {
      const num = STEP_NUMS[affectIdx] ?? `(${affectIdx + 1})`;
      const isFinal = affectIdx === relevant.length - 1;
      const prereqPrefix = buildPrereqPrefix(step);
      pendingSteps.length = 0;

      const sd = step.shortDesc;
      const elimStr = step.eliminated.join(',');
      const remainStr = step.targetAfter.join(',');

      let desc: string;

      // 第一步：基础行列宫排除
      const initMatch = sd.match(/^基础行列宫排除 → 剩余候选数 \[(.+)\]$/);
      if (initMatch) {
        if (isFinal) {
          desc = `唯余${step.targetAfter[0]} ✓ → 行列宫排除`;
        } else {
          desc = `候选数 [${initMatch[1]}] → 行列宫排除`;
        }
      } else {
        const { reason, trailingCell } = extractDesc(step, isFinal);
        const fullReason = prereqPrefix + reason;

        if (isFinal) {
          const ans = step.targetAfter[0] ?? answer;
          if (!reason) {
            // 目标格是显性唯余，铺垫格描述（若有）直接收尾
            desc = prereqPrefix
              ? `唯余${ans} ✓ → ${prereqPrefix.replace(/。$/, '')}`
              : `唯余${ans} ✓`;
          } else {
            desc = `唯余${ans} ✓ → ${fullReason}`;
            if (trailingCell) desc += ` → ${trailingCell}`;
          }
        } else {
          // 有尾部结论格时，去掉 fullReason 末尾的。，避免"。 → XY为V"视觉噪音
          const reasonPart = trailingCell ? fullReason.replace(/。$/, '') : fullReason;
          desc = reasonPart
            ? `排除${elimStr} → [${remainStr}] → ${reasonPart}`
            : `排除${elimStr} → [${remainStr}]`;
          if (trailingCell) desc += ` → ${trailingCell}`;
        }
      }

      lines.push(`${num} ${desc}`);
      affectIdx++;
    } else {
      pendingSteps.push(step);
    }
  }

  return lines.join('\n');
}
