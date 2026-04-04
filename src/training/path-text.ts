/**
 * training/path-text.ts
 *
 * 将 TrainingTrace 转换为人类可读的推理路径文本。
 *
 * 输出格式示例：
 *   ① 5宫56数对对6宫排除 → D8F8形成56数对
 *   ② 8宫7对7宫排除，G1I1形成7区块
 *   ③ 7区块对B行排除，B1非7
 *   ④ B行7隐性唯余，只能在B8格，填入7 ✓
 *
 * 联合排除格式：
 *   ① 6列348+G行34+4列8联合排除8宫 → H4H5I5形成348三数组
 */

import { TrainingTrace, TrainingStep } from './solver';

// ═══════════════════════════════════════════════════════════════
// 主函数
// ═══════════════════════════════════════════════════════════════

/**
 * 生成训练题推理路径的完整文本。
 * 包含步骤编号、每步描述、最终出数。
 */
export function renderTrainingPath(trace: TrainingTrace): string {
  const lines: string[] = [];

  if (trace.steps.length === 0) {
    // 直接唯余（L1），无中间步骤
    lines.push(`${trace.finalDesc}`);
    return lines.join('\n');
  }

  // 合并相关步骤（同一技巧链的多步可以合并描述）
  const mergedSteps = mergeSteps(trace.steps);

  const stepNums = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩',
    '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];

  for (let i = 0; i < mergedSteps.length; i++) {
    const num = stepNums[i] ?? `(${i + 1})`;
    lines.push(`${num} ${mergedSteps[i]}`);
  }

  // 最终出数
  const finalNum = stepNums[mergedSteps.length] ?? `(${mergedSteps.length + 1})`;
  lines.push(`${finalNum} ${trace.finalDesc}`);

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// 步骤合并逻辑
// ═══════════════════════════════════════════════════════════════

/**
 * 将步骤列表合并为人类可读的描述列表。
 *
 * 合并策略（两阶段）：
 *
 * 阶段一：预扫描，识别所有"联合排除"（JE）组。
 *   JE 定义：某 L3 naked/hidden set 步骤的触发格，被来自 ≥2 个不同源单元的 L2 步骤
 *   共同消除了候选数，从而形成该数组。两种常见形式：
 *     - pointing 型（宫→行，如 builder.ts 生成的 D7/D8）
 *     - box_line 型（行/列→宫）
 *
 * 阶段二：按顺序输出。
 *   - JE 的 L2 步骤（已在阶段一标记）：跳过（随 L3 步骤一起输出）
 *   - JE 的 L3 步骤：输出完整联合排除描述
 *   - naked/hidden set → 区块链：合并输出
 *   - 其余步骤：独立输出
 */
function mergeSteps(steps: TrainingStep[]): string[] {
  if (steps.length === 0) return [];

  // ── 阶段一：预扫描 JE 组 ─────────────────────────────────────────────────
  interface JEGroup { l2Indices: number[]; l3Index: number }
  const jeGroups: JEGroup[] = [];
  const jeL2Set = new Set<number>(); // JE 中的 L2 步骤索引
  const jeL3Set = new Set<number>(); // JE 中的 L3 步骤索引

  for (let k = 0; k < steps.length; k++) {
    const sk = steps[k];
    if (sk.level !== 3) continue;
    if (!['naked_pair', 'naked_triple', 'hidden_pair', 'hidden_triple'].includes(sk.techCode)) continue;

    // 找所有在 k 之前、消除了 sk.triggerCells 中某格候选数的 L2 步骤
    const contributing: number[] = [];
    const contribUnits = new Set<string>();
    for (let j = 0; j < k; j++) {
      const prev = steps[j];
      if (prev.level !== 2) continue;
      const affected = prev.elims.some(e =>
        sk.triggerCells.some(([tr2, tc2]) => e.r === tr2 && e.c === tc2),
      );
      if (affected) {
        contributing.push(j);
        contribUnits.add(prev.srcUnitName);
      }
    }

    // ≥2 个不同来源 → 这是一个 JE 组
    if (contribUnits.size >= 2) {
      jeGroups.push({ l2Indices: contributing, l3Index: k });
      contributing.forEach(j => jeL2Set.add(j));
      jeL3Set.add(k);
    }
  }

  // ── 阶段二：迭代输出 ──────────────────────────────────────────────────────
  const result: string[] = [];
  const used = new Set<number>();

  for (let i = 0; i < steps.length; i++) {
    if (used.has(i)) continue;
    const s = steps[i];

    // JE 的 L2 步骤：直接跳过（随对应 L3 步骤一起输出）
    if (jeL2Set.has(i)) {
      used.add(i);
      continue;
    }

    // JE 的 L3 步骤：输出完整联合排除描述
    if (jeL3Set.has(i)) {
      const group = jeGroups.find(g => g.l3Index === i)!;
      result.push(buildJointDesc(group.l2Indices.map(idx => steps[idx]), s));
      used.add(i);
      continue;
    }

    // ─── 检测数对/数组衍生模式 ─────────────────────────────────────────────
    // naked pair/triple 步骤后紧跟 pointing/box_line 步骤（由前一步骤使能）
    if (['naked_pair', 'naked_triple', 'hidden_pair', 'hidden_triple'].includes(s.techCode)) {
      // 排除 JE 专属的 L2 步骤（jeL2Set），避免被误作"数对→区块"链的区块步骤
      const nextIdx = steps.findIndex((t, j) => j > i && !used.has(j) && !jeL2Set.has(j) && t.level === 2);
      if (nextIdx !== -1 && isEnabledBy(steps[nextIdx], s)) {
        result.push(buildNakedToBlockDesc(s, steps[nextIdx]));
        used.add(i);
        used.add(nextIdx);
        continue;
      }
    }

    // ─── 默认：独立输出 ────────────────────────────────────────────────────
    result.push(formatStepDesc(s));
    used.add(i);
  }

  return result;
}

/** 判断步骤 next 是否由步骤 prev 使能（prev 的排除使 next 的触发条件得以满足） */
function isEnabledBy(next: TrainingStep, prev: TrainingStep): boolean {
  // prev 的排除格是否在 next 的触发格中（prev 消除了 next 触发格的某候选）
  for (const e of prev.elims) {
    for (const [tr2, tc2] of next.triggerCells) {
      if (e.r === tr2 && e.c === tc2) return true;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// 描述格式化
// ═══════════════════════════════════════════════════════════════

/** 格式化单个步骤的描述（简洁版，用于最终输出） */
function formatStepDesc(s: TrainingStep): string {
  const digStr = s.triggerDigits.join('');

  switch (s.techCode) {
    case 'pointing_row':
    case 'pointing_col': {
      // "5宫7对B行排除，B1非7"
      const affStr = s.elims.map(e => {
        const r = e.r, c = e.c;
        const cn = String.fromCharCode(65 + r) + (c + 1);
        return cn;
      }).join('');
      return `${s.srcUnitName}${digStr}对${s.elimUnitName}排除，${affStr}非${digStr}`;
    }

    case 'box_line_row':
    case 'box_line_col': {
      const affStr = s.elims.map(e => {
        const cn = String.fromCharCode(65 + e.r) + (e.c + 1);
        return cn;
      }).join('');
      return `${s.srcUnitName}${digStr}对${s.elimUnitName}排除，${affStr}非${digStr}`;
    }

    case 'naked_pair':
    case 'naked_triple':
    case 'naked_quad': {
      const setName = s.techCode === 'naked_pair' ? '数对' : s.techCode === 'naked_triple' ? '三数组' : '四数组';
      const trigStr = s.triggerCells.map(([r, c]) => String.fromCharCode(65 + r) + (c + 1)).join('');
      const affStr = s.elims.map(e => String.fromCharCode(65 + e.r) + (e.c + 1)).join('');
      return `${s.srcUnitName}${digStr}${setName}（${trigStr}格）对${s.elimUnitName}排除，${affStr}非${digStr}`;
    }

    case 'hidden_pair':
    case 'hidden_triple': {
      const setName = s.techCode === 'hidden_pair' ? '隐性数对' : '隐性三数组';
      const trigStr = s.triggerCells.map(([r, c]) => String.fromCharCode(65 + r) + (c + 1)).join('');
      const affStr = s.elims.map(e => String.fromCharCode(65 + e.r) + (e.c + 1)).join('');
      return `${s.srcUnitName}${digStr}${setName}（仅${trigStr}格），${affStr}排除非${digStr}候选`;
    }

    default:
      return s.desc;
  }
}

/**
 * 构建联合排除的描述。
 *
 * 若传入了紧随其后形成的 L3 数组步骤（followingSet），输出格式为：
 *   "6列348+G行34+4列8联合排除8宫 → H4H5I5形成348三数组"
 *
 * 否则仅描述消除：
 *   "6列348+G行34+4列8联合排除8宫，H4H5I5非348"
 */
function buildJointDesc(peerSteps: TrainingStep[], followingSet?: TrainingStep): string {
  const sources = peerSteps.map(s => `${s.srcUnitName}${s.triggerDigits.join('')}`).join('+');
  // 联合排除目标单元：
  //   followingSet 存在（L3 数组步骤）时，用数组所在单元（srcUnitName）
  //   —— pointing 型 JE 的 elimUnitName 是行/列，但数组形成在宫，必须取 srcUnitName
  //   followingSet 不存在时，用 L2 步骤的 elimUnitName（box_line 型 JE 该值即为宫名）
  const tgtUnit = followingSet ? followingSet.srcUnitName : peerSteps[0].elimUnitName;

  if (followingSet) {
    // 有紧随的 naked/hidden set：显示"→ 格形成XYZ数组"
    const setDigStr = followingSet.triggerDigits.join('');
    const setCellStr = followingSet.triggerCells
      .map(([r, c]) => String.fromCharCode(65 + r) + (c + 1)).join('');
    const setName = followingSet.techCode === 'naked_pair' ? '数对'
      : followingSet.techCode === 'naked_triple' ? '三数组'
      : followingSet.techCode === 'hidden_pair' ? '隐性数对'
      : '隐性三数组';
    return `${sources}联合排除${tgtUnit} → ${setCellStr}形成${setDigStr}${setName}`;
  }

  // 无后续数组步骤：仅描述排除结果
  const allElimCells = new Set<string>();
  for (const s of peerSteps) for (const e of s.elims) {
    allElimCells.add(String.fromCharCode(65 + e.r) + (e.c + 1));
  }
  const allDigits = new Set<number>();
  for (const s of peerSteps) for (const d of s.triggerDigits) allDigits.add(d);
  const digStr = [...allDigits].sort((a, b) => a - b).join('');
  return `${sources}联合排除${tgtUnit}，${[...allElimCells].join('')}非${digStr}`;
}

/**
 * 构建"数对→区块"链描述：
 * "5宫56数对对6宫排除 → D8F8形成56数对"
 *   或
 * "56数对占位（D8F8）→ 5宫56锁定在E列 → E列56对2宫排除"
 */
function buildNakedToBlockDesc(nakedStep: TrainingStep, blockStep: TrainingStep): string {
  const digStr = nakedStep.triggerDigits.join('');
  const setName = nakedStep.techCode === 'naked_pair' ? '数对' :
    nakedStep.techCode === 'naked_triple' ? '三数组' : '数对';
  const trigStr = nakedStep.triggerCells.map(([r, c]) => String.fromCharCode(65 + r) + (c + 1)).join('');
  const blockDigStr = blockStep.triggerDigits.join('');
  const blockAffStr = blockStep.elims.map(e => String.fromCharCode(65 + e.r) + (e.c + 1)).join('');

  // 简洁格式
  return `${nakedStep.srcUnitName}${digStr}${setName}（${trigStr}格）→ ${blockStep.srcUnitName}${blockDigStr}对${blockStep.elimUnitName}排除，${blockAffStr}非${blockDigStr}`;
}

// ═══════════════════════════════════════════════════════════════
// 简洁标题：用于训练报告展示
// ═══════════════════════════════════════════════════════════════

/**
 * 生成该题的核心技巧摘要（一行），用于报告展示。
 * e.g. "区块排除×2 → 隐性唯余"
 */
export function renderTrainingTechSummary(trace: TrainingTrace): string {
  if (trace.steps.length === 0) return '直接唯余';

  const techCounts: Record<string, number> = {};
  for (const s of trace.steps) {
    const name = techShortName(s.techCode);
    techCounts[name] = (techCounts[name] ?? 0) + 1;
  }

  const parts = Object.entries(techCounts).map(([name, count]) => count > 1 ? `${name}×${count}` : name);
  const finalType = trace.finalDesc.includes('唯一可填') || trace.finalDesc.includes('唯一') ? '隐性唯余' : '显性唯余';
  return `${parts.join(' + ')} → ${finalType}`;
}

function techShortName(code: string): string {
  const map: Record<string, string> = {
    pointing_row: '指向排除', pointing_col: '指向排除',
    box_line_row: '行列式', box_line_col: '行列式',
    naked_pair: '显性数对', naked_triple: '显性三数组', naked_quad: '显性四数组',
    hidden_pair: '隐性数对', hidden_triple: '隐性三数组',
  };
  return map[code] ?? code;
}
