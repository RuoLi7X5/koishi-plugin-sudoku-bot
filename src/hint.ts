/**
 * hint.ts — 求解指引功能核心模块
 *
 * 职责：
 *  1. 前缀分配器：每轮游戏分配唯一轮次前缀（a/b/.../z/aa/ab/...），24小时后回收复用
 *  2. QuestionRecord 缓存：记录每道题的盘面、答案、目标格，24小时后自动过期
 *  3. solveHint：求解占位（第一期返回 not_implemented，第二期替换为真实算法）
 */

const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 小时

/** 题目缓存记录 */
export type QuestionRecord = {
  puzzle: number[][];
  solution: number[][];
  targetRow: number;
  targetCol: number;
  targetAnswer: number;
  createdAt: number; // 毫秒时间戳
};

/** 单步推理记录（第二期求解算法填充） */
export type HintStep = {
  technique: string;  // 技巧名，如"宫排除"
  level: number;      // 1~5
  description: string;
  eliminated: number[];
  remaining: number[]; // 目标格当前剩余候选数
};

/** 求解结果 */
export type HintResult =
  | { success: true; steps: HintStep[]; maxLevel: number }
  | { success: false; reason: "unsolvable" | "not_implemented" };

/** 前缀注册条目 */
type PrefixEntry = {
  prefix: string;
  createdAt: number;
};

export class HintManager {
  /** key = channelId，value = 该频道历史上所有使用过的前缀列表 */
  private channelPrefixes: Map<string, PrefixEntry[]> = new Map();

  /** key = "<channelId>:<questionId>"，如 "701118454:a3" */
  private questionCache: Map<string, QuestionRecord> = new Map();

  // ==================== 前缀分配 ====================

  /**
   * 分配本轮前缀，每次新游戏开始时调用。
   *
   * 规则：
   *  1. 优先复用已过期（createdAt 超过 24h）的前缀中字典序最小的一个
   *  2. 若无可回收前缀，则在当前所有活跃前缀的最大值基础上递增，追加新前缀
   */
  allocatePrefix(channelId: string): string {
    const now = Date.now();
    if (!this.channelPrefixes.has(channelId)) {
      this.channelPrefixes.set(channelId, []);
    }
    const entries = this.channelPrefixes.get(channelId)!;

    // 找出所有已过期（可回收）条目，按字典序排序取最小
    const recyclable = entries
      .filter((e) => now - e.createdAt > EXPIRY_MS)
      .sort((a, b) => comparePrefix(a.prefix, b.prefix));

    if (recyclable.length > 0) {
      // 复用最小已过期前缀，更新其时间戳
      const entry = recyclable[0];
      entry.createdAt = now;
      return entry.prefix;
    }

    // 无可回收前缀：在活跃前缀最大值基础上递增
    const activePrefixes = entries
      .filter((e) => now - e.createdAt <= EXPIRY_MS)
      .map((e) => e.prefix)
      .sort((a, b) => comparePrefix(a, b));

    const nextPrefix =
      activePrefixes.length === 0
        ? "a"
        : incrementPrefix(activePrefixes[activePrefixes.length - 1]);

    entries.push({ prefix: nextPrefix, createdAt: now });
    return nextPrefix;
  }

  /**
   * 判断某前缀是否为指定频道当前活跃（未过期）的前缀。
   * 用于检查"是否属于当前进行中的轮次"。
   */
  isPrefixActive(channelId: string, prefix: string): boolean {
    const entries = this.channelPrefixes.get(channelId) ?? [];
    const entry = entries.find((e) => e.prefix === prefix);
    if (!entry) return false;
    return Date.now() - entry.createdAt <= EXPIRY_MS;
  }

  /**
   * 判断某前缀是否在频道的已知记录中（不论是否已过期）。
   * 用于区分"无效编号"和"已过期编号"。
   */
  isPrefixKnown(channelId: string, prefix: string): boolean {
    const entries = this.channelPrefixes.get(channelId) ?? [];
    return entries.some((e) => e.prefix === prefix);
  }

  // ==================== 题目缓存 ====================

  /** 注册题目到缓存，每道题生成后调用 */
  registerQuestion(
    channelId: string,
    questionId: string,
    record: QuestionRecord,
  ): void {
    this.questionCache.set(`${channelId}:${questionId}`, record);
  }

  /**
   * 查询题目缓存。
   *  - 找不到 → null（题目从未注册，或已被清理）
   *  - 已超过 24h → 删除条目并返回 null（懒惰清理）
   *  - 正常 → 返回 QuestionRecord
   */
  getQuestion(channelId: string, questionId: string): QuestionRecord | null {
    const key = `${channelId}:${questionId}`;
    const record = this.questionCache.get(key);
    if (!record) return null;
    if (Date.now() - record.createdAt > EXPIRY_MS) {
      this.questionCache.delete(key);
      return null;
    }
    return record;
  }

  // ==================== 编号解析 ====================

  /**
   * 解析题目编号字符串。
   *  - "a1"  → { prefix: "a",  index: 1 }
   *  - "ab3" → { prefix: "ab", index: 3 }
   *  - 格式非法 → null
   */
  parseQuestionId(
    questionId: string,
  ): { prefix: string; index: number } | null {
    const match = questionId
      .trim()
      .toLowerCase()
      .match(/^([a-z]+)(\d+)$/);
    if (!match) return null;
    const index = parseInt(match[2], 10);
    if (index < 1) return null;
    return { prefix: match[1], index };
  }

  // ==================== 求解（第一期占位） ====================

  /**
   * 求解入口。
   * 第一期：直接返回 not_implemented，不执行任何计算。
   * 第二期：替换为真实的 L1~L5 逻辑推理算法。
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  solveHint(_record: QuestionRecord): HintResult {
    return { success: false, reason: "not_implemented" };
  }
}

// ==================== 前缀工具函数 ====================

/**
 * 比较两个前缀的"字典序"。
 * 短的优先（等价于 26 进制数值更小），等长时按字母序。
 * 示例：a < b < z < aa < ab < ba < zz < aaa
 */
function comparePrefix(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 前缀递增（26 进制加 1）。
 * a→b, z→aa, az→ba, zz→aaa
 */
function incrementPrefix(prefix: string): string {
  const chars = prefix.split("").map((c) => c.charCodeAt(0) - 97); // 0-25
  let carry = 1;
  for (let i = chars.length - 1; i >= 0 && carry > 0; i--) {
    chars[i] += carry;
    carry = Math.floor(chars[i] / 26);
    chars[i] = chars[i] % 26;
  }
  if (carry > 0) {
    chars.unshift(0); // 最高位进位，相当于 z→aa
  }
  return chars.map((c) => String.fromCharCode(c + 97)).join("");
}
