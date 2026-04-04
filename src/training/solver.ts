/**
 * training/solver.ts
 *
 * 唯余训练推理引擎 — 带完整轨迹记录的分层技巧求解器
 *
 * 技巧层级：
 *   L2: 指向排除（宫→行/列）、区块行列法（行/列→宫）
 *   L3: 显性数对/三数组、隐性数对/三数组
 *   L4: 四数组（保留扩展）
 *
 * 核心输出：TrainingTrace — 包含所有技巧步骤 + 最终出数说明 + 难度分级
 */

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

type CandGrid = Set<number>[][];

/** 一次候选数消除事件 */
export interface Elim {
  r: number;
  c: number;
  d: number;
}

/** 技巧类型代码 */
export type TechCode =
  | 'pointing_row'    // 指向排除：宫内某数仅在同一行 → 消除行宫外候选
  | 'pointing_col'    // 指向排除：宫内某数仅在同一列 → 消除列宫外候选
  | 'box_line_row'    // 行列式：行内某数仅在同一宫 → 消除宫行外候选
  | 'box_line_col'    // 行列式：列内某数仅在同一宫 → 消除宫列外候选
  | 'naked_pair'      // 显性数对
  | 'naked_triple'    // 显性三数组
  | 'naked_quad'      // 显性四数组
  | 'hidden_pair'     // 隐性数对
  | 'hidden_triple'   // 隐性三数组
  | 'naked_single'    // 最终出数：显性唯余
  | 'hidden_row'      // 最终出数：行隐性唯余
  | 'hidden_col'      // 最终出数：列隐性唯余
  | 'hidden_box';     // 最终出数：宫隐性唯余

/** 技巧应用步骤（路径中的一条记录） */
export interface TrainingStep {
  techCode: TechCode;
  level: number;                 // 1~4，对应技巧层级
  /** 触发该技巧的源单元名称，e.g. "5宫"、"3列"、"A行" */
  srcUnitName: string;
  /** 触发该技巧的数字集合，e.g. [5,6] 表示56数对 */
  triggerDigits: number[];
  /** 触发该技巧的格坐标 */
  triggerCells: [number, number][];
  /** 消除发生的目标单元名称 */
  elimUnitName: string;
  /** 本步骤实际消除的候选数 */
  elims: Elim[];
  /** 人类可读的步骤描述（完整版，用于路径展示） */
  desc: string;
}

/** 完整训练轨迹 */
export interface TrainingTrace {
  targetRow: number;
  targetCol: number;
  answer: number;
  /** 推理路径中的所有有效步骤（按执行顺序排列） */
  steps: TrainingStep[];
  /** 最终出数描述 */
  finalDesc: string;
  /** 分类后的难度（3~8） */
  difficulty: number;
}

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

/** 行名：A-I */
export function rowLabel(r: number): string { return String.fromCharCode(65 + r); }

/** 格名：A1~I9 */
export function cellName(r: number, c: number): string { return `${rowLabel(r)}${c + 1}`; }

/** 宫序号（1-based，行优先） */
export function boxNo(r: number, c: number): number {
  return Math.floor(r / 3) * 3 + Math.floor(c / 3) + 1;
}

/** 宫左上角坐标 */
export function boxOrigin(r: number, c: number): [number, number] {
  return [Math.floor(r / 3) * 3, Math.floor(c / 3) * 3];
}

/** 格子所属宫序号（1-based） */
export function cellBoxNo(r: number, c: number): number { return boxNo(r, c); }

/** 宫单元内所有格 */
function boxCells(br: number, bc: number): [number, number][] {
  const out: [number, number][] = [];
  for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) out.push([br + dr, bc + dc]);
  return out;
}

/** 复制候选数网格（深拷贝） */
export function cloneCands(cands: CandGrid): CandGrid {
  return cands.map(row => row.map(s => new Set(s)));
}

/** 数字集合转字符串，e.g. [3,4,8] → "348" */
function digStr(digits: number[]): string { return [...digits].sort((a, b) => a - b).join(''); }

/** 格坐标数组转名称字符串，e.g. [[0,3],[1,3]] → "A4B4" */
function cellsStr(cells: [number, number][]): string { return cells.map(([r, c]) => cellName(r, c)).join(''); }

// ═══════════════════════════════════════════════════════════════
// 初始候选数计算（L1：直接排除）
// ═══════════════════════════════════════════════════════════════

/** 计算全盘 L1 候选数（仅行列宫直接排除） */
export function initCands(puzzle: number[][]): CandGrid {
  const cands: CandGrid = [];
  for (let r = 0; r < 9; r++) {
    cands[r] = [];
    for (let c = 0; c < 9; c++) {
      if (puzzle[r][c] !== 0) { cands[r][c] = new Set(); continue; }
      const seen = new Set<number>();
      for (let j = 0; j < 9; j++) {
        if (puzzle[r][j]) seen.add(puzzle[r][j]);
        if (puzzle[j][c]) seen.add(puzzle[j][c]);
      }
      const [br, bc] = boxOrigin(r, c);
      for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
        const v = puzzle[br + dr][bc + dc];
        if (v) seen.add(v);
      }
      const cand = new Set<number>();
      for (let d = 1; d <= 9; d++) if (!seen.has(d)) cand.add(d);
      cands[r][c] = cand;
    }
  }
  return cands;
}

// ═══════════════════════════════════════════════════════════════
// L2 技巧：指向排除 + 区块行列法
// ═══════════════════════════════════════════════════════════════

/** 对 cands 应用一轮指向排除（宫→行/列），返回产生的步骤 */
export function applyPointing(cands: CandGrid): TrainingStep[] {
  const steps: TrainingStep[] = [];
  for (let br = 0; br < 9; br += 3) {
    for (let bc = 0; bc < 9; bc += 3) {
      for (let d = 1; d <= 9; d++) {
        // 收集该宫内 d 的候选格
        const pos: [number, number][] = [];
        for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
          const r = br + dr, c = bc + dc;
          if (cands[r][c].has(d)) pos.push([r, c]);
        }
        if (pos.length === 0) continue;

        const rows = new Set(pos.map(p => p[0]));
        const cols = new Set(pos.map(p => p[1]));

        if (rows.size === 1) {
          const row = pos[0][0];
          const elims: Elim[] = [];
          for (let c = 0; c < 9; c++) {
            if (c >= bc && c < bc + 3) continue;
            if (cands[row][c].has(d)) {
              cands[row][c].delete(d);
              elims.push({ r: row, c, d });
            }
          }
          if (elims.length > 0) {
            const elimCells = elims.map(e => cellName(e.r, e.c)).join('');
            steps.push({
              techCode: 'pointing_row',
              level: 2,
              srcUnitName: `${boxNo(br, bc)}宫`,
              triggerDigits: [d],
              triggerCells: pos,
              elimUnitName: `${rowLabel(row)}行`,
              elims,
              desc: `${boxNo(br, bc)}宫${d}对${rowLabel(row)}行排除，${elimCells}非${d}`,
            });
          }
        }

        if (cols.size === 1) {
          const col = pos[0][1];
          const elims: Elim[] = [];
          for (let r = 0; r < 9; r++) {
            if (r >= br && r < br + 3) continue;
            if (cands[r][col].has(d)) {
              cands[r][col].delete(d);
              elims.push({ r, c: col, d });
            }
          }
          if (elims.length > 0) {
            const elimCells = elims.map(e => cellName(e.r, e.c)).join('');
            steps.push({
              techCode: 'pointing_col',
              level: 2,
              srcUnitName: `${boxNo(br, bc)}宫`,
              triggerDigits: [d],
              triggerCells: pos,
              elimUnitName: `${col + 1}列`,
              elims,
              desc: `${boxNo(br, bc)}宫${d}对${col + 1}列排除，${elimCells}非${d}`,
            });
          }
        }
      }
    }
  }
  return steps;
}

/** 对 cands 应用一轮区块行列法（行/列→宫），返回产生的步骤 */
export function applyBoxLine(cands: CandGrid): TrainingStep[] {
  const steps: TrainingStep[] = [];

  // 行→宫
  for (let row = 0; row < 9; row++) {
    for (let d = 1; d <= 9; d++) {
      const cs: number[] = [];
      for (let c = 0; c < 9; c++) if (cands[row][c].has(d)) cs.push(c);
      if (cs.length === 0) continue;
      const boxCols = new Set(cs.map(c => Math.floor(c / 3)));
      if (boxCols.size !== 1) continue;
      const bc = [...boxCols][0] * 3;
      const br = Math.floor(row / 3) * 3;
      const triggerCells: [number, number][] = cs.map(c => [row, c] as [number, number]);
      const elims: Elim[] = [];
      for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
        const r = br + dr, c = bc + dc;
        if (r === row) continue;
        if (cands[r][c].has(d)) { cands[r][c].delete(d); elims.push({ r, c, d }); }
      }
      if (elims.length > 0) {
        const elimCells = elims.map(e => cellName(e.r, e.c)).join('');
        steps.push({
          techCode: 'box_line_row',
          level: 2,
          srcUnitName: `${rowLabel(row)}行`,
          triggerDigits: [d],
          triggerCells,
          elimUnitName: `${boxNo(br, bc)}宫`,
          elims,
          desc: `${rowLabel(row)}行${d}对${boxNo(br, bc)}宫排除，${elimCells}非${d}`,
        });
      }
    }
  }

  // 列→宫
  for (let col = 0; col < 9; col++) {
    for (let d = 1; d <= 9; d++) {
      const rs: number[] = [];
      for (let r = 0; r < 9; r++) if (cands[r][col].has(d)) rs.push(r);
      if (rs.length === 0) continue;
      const boxRows = new Set(rs.map(r => Math.floor(r / 3)));
      if (boxRows.size !== 1) continue;
      const br = [...boxRows][0] * 3;
      const bc = Math.floor(col / 3) * 3;
      const triggerCells: [number, number][] = rs.map(r => [r, col] as [number, number]);
      const elims: Elim[] = [];
      for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
        const r = br + dr, c = bc + dc;
        if (c === col) continue;
        if (cands[r][c].has(d)) { cands[r][c].delete(d); elims.push({ r, c, d }); }
      }
      if (elims.length > 0) {
        const elimCells = elims.map(e => cellName(e.r, e.c)).join('');
        steps.push({
          techCode: 'box_line_col',
          level: 2,
          srcUnitName: `${col + 1}列`,
          triggerDigits: [d],
          triggerCells,
          elimUnitName: `${boxNo(br, bc)}宫`,
          elims,
          desc: `${col + 1}列${d}对${boxNo(br, bc)}宫排除，${elimCells}非${d}`,
        });
      }
    }
  }

  return steps;
}

// ═══════════════════════════════════════════════════════════════
// L3 技巧：显性数对/三数组/四数组
// ═══════════════════════════════════════════════════════════════

/** 获取 27 个单元（9行+9列+9宫）的格坐标列表及名称 */
function getAllUnits(): Array<{ name: string; cells: [number, number][] }> {
  const units: Array<{ name: string; cells: [number, number][] }> = [];
  for (let i = 0; i < 9; i++) {
    units.push({ name: `${rowLabel(i)}行`, cells: Array.from({ length: 9 }, (_, c) => [i, c] as [number, number]) });
    units.push({ name: `${i + 1}列`, cells: Array.from({ length: 9 }, (_, r) => [r, i] as [number, number]) });
  }
  for (let br = 0; br < 9; br += 3) for (let bc = 0; bc < 9; bc += 3) {
    units.push({ name: `${boxNo(br, bc)}宫`, cells: boxCells(br, bc) });
  }
  return units;
}

/** 对 cands 应用一轮显性裸集（Naked Sets），maxSize=2/3/4，返回产生的步骤 */
export function applyNakedSets(cands: CandGrid, maxSize: number = 3): TrainingStep[] {
  const steps: TrainingStep[] = [];
  const units = getAllUnits();

  for (const unit of units) {
    // 只考虑候选数 ≤ maxSize 的空格
    const emptyCells = unit.cells.filter(([r, c]) => cands[r][c].size > 0);
    if (emptyCells.length < 2) continue;

    // 枚举 size=2..maxSize 的子集
    for (let size = 2; size <= Math.min(maxSize, emptyCells.length - 1); size++) {
      // 枚举 size 大小的组合
      const combos = combinations(emptyCells, size);
      for (const combo of combos) {
        // 合并候选数
        const union = new Set<number>();
        for (const [r, c] of combo) for (const d of cands[r][c]) union.add(d);
        if (union.size !== size) continue; // 不是 naked set
        // 确认：每个格的候选数都是 union 的子集
        if (!combo.every(([r, c]) => [...cands[r][c]].every(d => union.has(d)))) continue;

        // 找可排除的格
        const elimSet = new Set(combo.map(([r, c]) => `${r},${c}`));
        const elims: Elim[] = [];
        for (const [r, c] of unit.cells) {
          if (elimSet.has(`${r},${c}`)) continue;
          if (cands[r][c].size === 0) continue;
          for (const d of union) {
            if (cands[r][c].has(d)) { cands[r][c].delete(d); elims.push({ r, c, d }); }
          }
        }
        if (elims.length === 0) continue;

        const digits = [...union].sort((a, b) => a - b);
        const setName = size === 2 ? '数对' : size === 3 ? '三数组' : '四数组';
        const techCode: TechCode = size === 2 ? 'naked_pair' : size === 3 ? 'naked_triple' : 'naked_quad';
        const comboCells = combo.map(([r, c]) => cellName(r, c)).join('');
        const elimCells = elims.map(e => cellName(e.r, e.c)).join('');
        steps.push({
          techCode,
          level: 3,
          srcUnitName: unit.name,
          triggerDigits: digits,
          triggerCells: combo as [number, number][],
          elimUnitName: unit.name,
          elims,
          desc: `${unit.name}${digits.join('')}${setName}（${comboCells}格）对${unit.name}排除，${elimCells}非${digits.join('')}`,
        });
      }
    }
  }
  return steps;
}

// ═══════════════════════════════════════════════════════════════
// L3 技巧：隐性数对/三数组
// ═══════════════════════════════════════════════════════════════

/** 对 cands 应用一轮隐性裸集（Hidden Sets），maxSize=2/3，返回产生的步骤 */
export function applyHiddenSets(cands: CandGrid, maxSize: number = 3): TrainingStep[] {
  const steps: TrainingStep[] = [];
  const units = getAllUnits();

  for (const unit of units) {
    const emptyCells = unit.cells.filter(([r, c]) => cands[r][c].size > 0);
    if (emptyCells.length < 2) continue;

    // 对每个数字，找它在本单元出现的格
    const digitCells = new Map<number, [number, number][]>();
    for (let d = 1; d <= 9; d++) {
      const cells: [number, number][] = emptyCells.filter(([r, c]) => cands[r][c].has(d));
      if (cells.length >= 2 && cells.length <= maxSize) digitCells.set(d, cells);
    }

    const digits = [...digitCells.keys()];
    if (digits.length < 2) continue;

    for (let size = 2; size <= Math.min(maxSize, digits.length); size++) {
      const digCombos = combinations(digits, size);
      for (const dc of digCombos) {
        // 合并这 size 个数字出现的格
        const cellSet = new Set<string>();
        for (const d of dc) {
          const cells = digitCells.get(d) ?? [];
          for (const [r, c] of cells) cellSet.add(`${r},${c}`);
        }
        if (cellSet.size !== size) continue; // 不是 hidden set（出现格数 ≠ size）

        // 找可排除的候选（这些格中非 dc 数字的候选）
        const elims: Elim[] = [];
        for (const key of cellSet) {
          const [r, c] = key.split(',').map(Number);
          for (const d of cands[r][c]) {
            if (!dc.includes(d)) { cands[r][c].delete(d); elims.push({ r, c, d }); }
          }
        }
        if (elims.length === 0) continue;

        const sortedDc = [...dc].sort((a, b) => a - b);
        const setName = size === 2 ? '数对' : '三数组';
        const techCode: TechCode = size === 2 ? 'hidden_pair' : 'hidden_triple';
        const setCells = [...cellSet].map(k => { const [r, c] = k.split(',').map(Number); return cellName(r, c); }).join('');
        const elimCells = elims.map(e => cellName(e.r, e.c)).join('');
        steps.push({
          techCode,
          level: 3,
          srcUnitName: unit.name,
          triggerDigits: sortedDc,
          triggerCells: [...cellSet].map(k => k.split(',').map(Number) as [number, number]),
          elimUnitName: unit.name,
          elims,
          desc: `${unit.name}${sortedDc.join('')}隐性${setName}（仅${setCells}格有候选）→ ${elimCells}排除非${sortedDc.join('')}候选`,
        });
      }
    }
  }
  return steps;
}

// ═══════════════════════════════════════════════════════════════
// 判断目标格是否已确定（Naked / Hidden Single）
// ═══════════════════════════════════════════════════════════════

interface Determined {
  answer: number;
  type: 'naked_single' | 'hidden_row' | 'hidden_col' | 'hidden_box';
  unitName: string;
  desc: string;
}

/** 检查目标格是否当前已确定，返回 Determined 或 null */
export function checkDetermined(cands: CandGrid, tr: number, tc: number): Determined | null {
  // 显性唯余
  if (cands[tr][tc].size === 1) {
    const answer = [...cands[tr][tc]][0];
    return {
      answer,
      type: 'naked_single',
      unitName: cellName(tr, tc),
      desc: `${cellName(tr, tc)}候选仅剩${answer}，填入${answer} ✓`,
    };
  }

  // 行隐性唯余
  for (let d of cands[tr][tc]) {
    const rowCount = Array.from({ length: 9 }, (_, c) => c)
      .filter(c => c !== tc && cands[tr][c].has(d)).length;
    if (rowCount === 0) {
      return {
        answer: d,
        type: 'hidden_row',
        unitName: `${rowLabel(tr)}行`,
        desc: `${rowLabel(tr)}行数字${d}唯一可填位置为${cellName(tr, tc)}，填入${d} ✓`,
      };
    }
  }

  // 列隐性唯余
  for (let d of cands[tr][tc]) {
    const colCount = Array.from({ length: 9 }, (_, r) => r)
      .filter(r => r !== tr && cands[r][tc].has(d)).length;
    if (colCount === 0) {
      return {
        answer: d,
        type: 'hidden_col',
        unitName: `${tc + 1}列`,
        desc: `${tc + 1}列数字${d}唯一可填位置为${cellName(tr, tc)}，填入${d} ✓`,
      };
    }
  }

  // 宫隐性唯余
  const [br, bc] = boxOrigin(tr, tc);
  for (let d of cands[tr][tc]) {
    const boxCount = boxCells(br, bc)
      .filter(([r, c]) => !(r === tr && c === tc) && cands[r][c].has(d)).length;
    if (boxCount === 0) {
      return {
        answer: d,
        type: 'hidden_box',
        unitName: `${boxNo(tr, tc)}宫`,
        desc: `${boxNo(tr, tc)}宫数字${d}唯一可填位置为${cellName(tr, tc)}，填入${d} ✓`,
      };
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// 主求解函数：对目标格进行带轨迹的求解
// ═══════════════════════════════════════════════════════════════

/**
 * 对目标格 (tr, tc) 进行带轨迹推理求解。
 * maxLevel: 2=仅L2, 3=L2+L3（L3包含显性/隐性数对三数组）
 * 返回完整的 TrainingTrace，若目标格无法在给定层级内确定则返回 null。
 */
export function trainingSolve(
  puzzle: number[][],
  tr: number,
  tc: number,
  maxLevel: number = 3,
): TrainingTrace | null {
  const cands = initCands(puzzle);
  const steps: TrainingStep[] = [];

  // 先检查 L1 直接是否已确定（不记录任何步骤，仅检测）
  const directCheck = checkDetermined(cands, tr, tc);
  if (directCheck) {
    // L1 即可确定，不算 training 题（返回仍有效，由 builder 判断是否接受）
    return buildTrace([], directCheck, tr, tc);
  }

  let changed = true;
  while (changed) {
    changed = false;

    // ── L2: 指向排除 ───────────────────────────────────────────
    const pSteps = applyPointing(cands);
    if (pSteps.length > 0) {
      steps.push(...pSteps);
      const det = checkDetermined(cands, tr, tc);
      if (det) return buildTrace(steps, det, tr, tc);
      changed = true;
      continue;
    }

    // ── L2: 区块行列法 ─────────────────────────────────────────
    const blSteps = applyBoxLine(cands);
    if (blSteps.length > 0) {
      steps.push(...blSteps);
      const det = checkDetermined(cands, tr, tc);
      if (det) return buildTrace(steps, det, tr, tc);
      changed = true;
      continue;
    }

    if (maxLevel >= 3) {
      // ── L3: 显性数对/三数组 ──────────────────────────────────
      const nakedSteps = applyNakedSets(cands, 3);
      if (nakedSteps.length > 0) {
        steps.push(...nakedSteps);
        const det = checkDetermined(cands, tr, tc);
        if (det) return buildTrace(steps, det, tr, tc);
        changed = true;
        continue;
      }

      // ── L3: 隐性数对/三数组 ──────────────────────────────────
      const hiddenSteps = applyHiddenSets(cands, 3);
      if (hiddenSteps.length > 0) {
        steps.push(...hiddenSteps);
        const det = checkDetermined(cands, tr, tc);
        if (det) return buildTrace(steps, det, tr, tc);
        changed = true;
        continue;
      }

      if (maxLevel >= 4) {
        // ── L4: 显性四数组 ───────────────────────────────────
        const quadSteps = applyNakedSets(cands, 4);
        if (quadSteps.length > 0) {
          steps.push(...quadSteps);
          const det = checkDetermined(cands, tr, tc);
          if (det) return buildTrace(steps, det, tr, tc);
          changed = true;
          continue;
        }
      }
    }
  }

  return null; // 无法在给定层级内确定目标格
}

/** 构建最终 TrainingTrace，包含难度分类 */
function buildTrace(steps: TrainingStep[], det: Determined, tr: number, tc: number): TrainingTrace {
  // 过滤出影响目标格的相关步骤（向后追踪依赖）
  const relevantSteps = filterRelevantSteps(steps, tr, tc, det);
  const difficulty = classifyDifficulty(relevantSteps, det);
  return {
    targetRow: tr,
    targetCol: tc,
    answer: det.answer,
    steps: relevantSteps,
    finalDesc: det.desc,
    difficulty,
  };
}

/**
 * 过滤出"对目标格出数有贡献"的步骤。
 *
 * 策略：从最终出数类型出发，反向找所有依赖步骤：
 *   - naked_single：找消除了目标格候选数的步骤
 *   - hidden_xxx：找消除了目标格所在行/列/宫中其他格的答案候选的步骤
 * 对这些步骤的触发格（triggerCells），递归找使其候选数产生变化的步骤。
 */
function filterRelevantSteps(
  steps: TrainingStep[],
  tr: number,
  tc: number,
  det: Determined,
): TrainingStep[] {
  if (steps.length === 0) return [];

  // 找"直接相关"的消除集合
  const relevantElims = new Set<string>();

  if (det.type === 'naked_single') {
    // 所有消除目标格候选数的步骤
    for (const s of steps) {
      for (const e of s.elims) {
        if (e.r === tr && e.c === tc) relevantElims.add(`${e.r},${e.c},${e.d}`);
      }
    }
  } else {
    // hidden_row/col/box：找消除了目标格所在单元中其他格的答案数 det.answer 的步骤
    const A = det.answer;
    // 目标单元内其他格的坐标
    let unitCells: [number, number][] = [];
    if (det.type === 'hidden_row') {
      unitCells = Array.from({ length: 9 }, (_, c) => [tr, c] as [number, number]).filter(([, c]) => c !== tc);
    } else if (det.type === 'hidden_col') {
      unitCells = Array.from({ length: 9 }, (_, r) => [r, tc] as [number, number]).filter(([r]) => r !== tr);
    } else {
      const [br, bc] = boxOrigin(tr, tc);
      unitCells = boxCells(br, bc).filter(([r, c]) => !(r === tr && c === tc));
    }
    for (const [r, c] of unitCells) {
      for (const s of steps) {
        for (const e of s.elims) {
          if (e.r === r && e.c === c && e.d === A) relevantElims.add(`${e.r},${e.c},${e.d}`);
        }
      }
    }
  }

  // 标记直接相关的步骤
  const included = new Set<number>();
  for (let i = 0; i < steps.length; i++) {
    for (const e of steps[i].elims) {
      if (relevantElims.has(`${e.r},${e.c},${e.d}`)) { included.add(i); break; }
    }
  }

  // 向前传播：找这些步骤的触发格上发生过的消除，其来源步骤也加入
  let prevSize = 0;
  while (included.size !== prevSize) {
    prevSize = included.size;
    for (const idx of [...included]) {
      const s = steps[idx];
      // 触发格：如果某步骤消除了 s.triggerCells 中某格的某候选，使该格候选变成了 s.triggerDigits，则该步骤也相关
      for (const [tr2, tc2] of s.triggerCells) {
        for (let j = 0; j < idx; j++) {
          if (included.has(j)) continue;
          const prev = steps[j];
          for (const e of prev.elims) {
            if (e.r === tr2 && e.c === tc2) { included.add(j); break; }
          }
        }
      }
    }
  }

  // 按原顺序返回
  return steps.filter((_, i) => included.has(i));
}

// ═══════════════════════════════════════════════════════════════
// 难度分类
// ═══════════════════════════════════════════════════════════════

/**
 * 根据推理步骤序列分类难度（3~8）
 *
 * 分类规则：
 *   D3: 仅 L2，相关步骤数 1~2
 *   D4: 仅 L2，相关步骤数 3+
 *   D5: 含 L3（naked/hidden sets），无联合排除，步骤数 ≤ 3
 *   D6: 含 L3，无联合排除，步骤数 4~6
 *   D7: 含"联合排除"（多个 L2 来源共同形成 L3 数组），步骤数 ≤ 6
 *   D8: 含联合排除，步骤数 7+；或无联合排除但 L3 步骤数极多（> 6）
 *
 * 核心原则：
 *   - 联合排除是 D7 的判别特征，其优先级高于步骤数检查
 *   - D7/D8 由 联合排除 + 步骤复杂度区分，而非技巧层级（L3 足够）
 */
export function classifyDifficulty(steps: TrainingStep[], _det?: Determined): number {
  if (steps.length === 0) return 3;

  const maxLevel = Math.max(...steps.map(s => s.level));
  const stepCount = steps.length;
  const hasJointElim = detectJointElimination(steps);

  // ── 纯 L2 技巧（D3/D4）──────────────────────────────────────────
  if (maxLevel <= 2) {
    return stepCount <= 2 ? 3 : 4;
  }

  // ── 含 L3 技巧 ──────────────────────────────────────────────────
  // 优先判断联合排除：这是 D7/D8 的核心特征，不受步骤数干预
  if (hasJointElim) {
    return stepCount <= 6 ? 7 : 8;
  }

  // 无联合排除的 L3 链（最高 D6）
  return stepCount <= 3 ? 5 : 6;
}

/**
 * 检测是否存在"联合排除"模式：
 * 某个 L3 数组步骤（显性或隐性）的触发格，其候选数的形成依赖于来自不同单元的 ≥2 个 L2 步骤。
 * 这是 D7+ 的核心特征。
 *
 * 覆盖：naked_pair, naked_triple, hidden_pair, hidden_triple（所有 L3 数组技巧）
 */
function detectJointElimination(steps: TrainingStep[]): boolean {
  // 找所有 L3 数组步骤（显性和隐性均纳入）
  const setSteps = steps.filter(s => s.level === 3 &&
    ['naked_pair', 'naked_triple', 'naked_quad', 'hidden_pair', 'hidden_triple'].includes(s.techCode));

  for (const ss of setSteps) {
    // 找消除了该数组触发格候选数的 L2 步骤，统计来源单元的多样性
    const contributingL2Units = new Set<string>();
    for (const [tr2, tc2] of ss.triggerCells) {
      for (const prev of steps) {
        if (prev.level !== 2) continue;
        for (const e of prev.elims) {
          if (e.r === tr2 && e.c === tc2) { contributingL2Units.add(prev.srcUnitName); break; }
        }
      }
    }
    // ≥2 个不同来源 → 联合排除
    if (contributingL2Units.size >= 2) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// 全盘可推出格检测（用于"唯一出数"验证）
// ═══════════════════════════════════════════════════════════════

/** 获取全盘在给定层级下可推出的所有格（返回 "row,col" 集合） */
export function getDeducibleCells(puzzle: number[][], maxLevel: number = 3): Set<string> {
  const cands = initCands(puzzle);

  // 迭代应用技巧直到稳定（严格按层级限制，不超过 maxLevel）
  let changed = true;
  while (changed) {
    changed = false;
    if (maxLevel >= 2) {
      if (applyPointing(cands).length > 0) { changed = true; continue; }
      if (applyBoxLine(cands).length > 0) { changed = true; continue; }
    }
    if (maxLevel >= 3) {
      if (applyNakedSets(cands, 3).length > 0) { changed = true; continue; }
      if (applyHiddenSets(cands, 3).length > 0) { changed = true; continue; }
    }
    if (maxLevel >= 4) {
      if (applyNakedSets(cands, 4).length > 0) { changed = true; continue; }
    }
  }

  // 找所有已确定的格
  const result = new Set<string>();
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (puzzle[r][c] !== 0) continue;
      if (checkDetermined(cands, r, c)) result.add(`${r},${c}`);
    }
  }
  return result;
}

/** 验证：全盘恰好只有目标格可推出 */
export function isExactlyOneDeducible(puzzle: number[][], tr: number, tc: number, maxLevel: number = 3): boolean {
  const cells = getDeducibleCells(puzzle, maxLevel);
  return cells.size === 1 && cells.has(`${tr},${tc}`);
}

// ═══════════════════════════════════════════════════════════════
// 辅助：组合数生成
// ═══════════════════════════════════════════════════════════════

function combinations<T>(arr: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (arr.length < size) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, size - 1).map(c => [first, ...c]);
  const withoutFirst = combinations(rest, size);
  return [...withFirst, ...withoutFirst];
}
