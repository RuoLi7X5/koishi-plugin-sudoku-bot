import { Context, Session, h } from "koishi";
import { Config } from "./index";
import { SudokuGenerator } from "./generator";
import { ImageRenderer, TrainingRenderData } from "./renderer";
import { UserService } from "./user";
import { MOCK_MESSAGES } from "./mockMessages";
import { HintManager } from "./hint";
import { solve, formatCompactSteps, checkPuzzleIntuitiveSolvable } from "./solver";

// ══════════════════════════════════════════════════════
// 唯余训练：候选数工具函数（模块级，不依赖 this）
// ══════════════════════════════════════════════════════

/** 计算全盘每个空格的候选数集合（已填格返回空 Set） */
function computeCandidates(puzzle: number[][]): Set<number>[][] {
  const cands: Set<number>[][] = [];
  for (let r = 0; r < 9; r++) {
    cands[r] = [];
    for (let c = 0; c < 9; c++) {
      if (puzzle[r][c] !== 0) { cands[r][c] = new Set(); continue; }
      const seen = new Set<number>();
      for (let j = 0; j < 9; j++) {
        if (puzzle[r][j]) seen.add(puzzle[r][j]);
        if (puzzle[j][c]) seen.add(puzzle[j][c]);
      }
      const br = Math.floor(r / 3) * 3, bc = Math.floor(c / 3) * 3;
      for (let dr = 0; dr < 3; dr++)
        for (let dc = 0; dc < 3; dc++)
          if (puzzle[br + dr][bc + dc]) seen.add(puzzle[br + dr][bc + dc]);
      const cand = new Set<number>();
      for (let d = 1; d <= 9; d++) if (!seen.has(d)) cand.add(d);
      cands[r][c] = cand;
    }
  }
  return cands;
}

/** 获取某空格当前合法可填的数字集合 */
function getValidDigitsAt(puzzle: number[][], r: number, c: number): Set<number> {
  const seen = new Set<number>();
  for (let j = 0; j < 9; j++) {
    if (puzzle[r][j]) seen.add(puzzle[r][j]);
    if (puzzle[j][c]) seen.add(puzzle[j][c]);
  }
  const br = Math.floor(r / 3) * 3, bc = Math.floor(c / 3) * 3;
  for (let dr = 0; dr < 3; dr++)
    for (let dc = 0; dc < 3; dc++)
      if (puzzle[br + dr][bc + dc]) seen.add(puzzle[br + dr][bc + dc]);
  const valid = new Set<number>();
  for (let d = 1; d <= 9; d++) if (!seen.has(d)) valid.add(d);
  return valid;
}

/**
 * 在直接候选数基础上迭代应用区块排除推理（指向数对 + 区块行列法），直到稳定。
 * 用于验证 D3+ 难度题目中依赖区块逻辑才能出数的目标格。
 */
function computeAdvancedCandidates(puzzle: number[][]): Set<number>[][] {
  const cands = computeCandidates(puzzle);

  let changed = true;
  while (changed) {
    changed = false;

    // ── 指向数对（宫→行/列）────────────────────────────────────────────────────
    // 宫内某数字候选仅分布在同一行/列 → 该行/列在宫外的同数字候选消除
    for (let br = 0; br < 9; br += 3) {
      for (let bc = 0; bc < 9; bc += 3) {
        for (let d = 1; d <= 9; d++) {
          const pos: [number, number][] = [];
          for (let dr = 0; dr < 3; dr++)
            for (let dc = 0; dc < 3; dc++) {
              const r = br + dr, c = bc + dc;
              if (puzzle[r][c] === 0 && cands[r][c].has(d)) pos.push([r, c]);
            }
          if (pos.length === 0) continue;
          const rows = new Set(pos.map(p => p[0]));
          const cols = new Set(pos.map(p => p[1]));
          if (rows.size === 1) {
            const row = pos[0][0];
            for (let c = 0; c < 9; c++) {
              if (c >= bc && c < bc + 3) continue;
              if (puzzle[row][c] === 0 && cands[row][c].has(d)) {
                cands[row][c].delete(d); changed = true;
              }
            }
          }
          if (cols.size === 1) {
            const col = pos[0][1];
            for (let r = 0; r < 9; r++) {
              if (r >= br && r < br + 3) continue;
              if (puzzle[r][col] === 0 && cands[r][col].has(d)) {
                cands[r][col].delete(d); changed = true;
              }
            }
          }
        }
      }
    }

    // ── 区块行列法（行/列→宫）────────────────────────────────────────────────
    // 行/列内某数字候选仅分布在同一宫 → 该宫内同行/列以外的同数字候选消除
    for (let r = 0; r < 9; r++) {
      for (let d = 1; d <= 9; d++) {
        const cs: number[] = [];
        for (let c = 0; c < 9; c++)
          if (puzzle[r][c] === 0 && cands[r][c].has(d)) cs.push(c);
        if (cs.length === 0) continue;
        const boxCols = new Set(cs.map(c => Math.floor(c / 3)));
        if (boxCols.size === 1) {
          const bc = [...boxCols][0] * 3;
          const br = Math.floor(r / 3) * 3;
          for (let dr = 0; dr < 3; dr++)
            for (let dc = 0; dc < 3; dc++) {
              const r2 = br + dr, c2 = bc + dc;
              if (r2 === r) continue;
              if (puzzle[r2][c2] === 0 && cands[r2][c2].has(d)) {
                cands[r2][c2].delete(d); changed = true;
              }
            }
        }
      }
    }
    for (let c = 0; c < 9; c++) {
      for (let d = 1; d <= 9; d++) {
        const rs: number[] = [];
        for (let r = 0; r < 9; r++)
          if (puzzle[r][c] === 0 && cands[r][c].has(d)) rs.push(r);
        if (rs.length === 0) continue;
        const boxRows = new Set(rs.map(r => Math.floor(r / 3)));
        if (boxRows.size === 1) {
          const br = [...boxRows][0] * 3;
          const bc = Math.floor(c / 3) * 3;
          for (let dr = 0; dr < 3; dr++)
            for (let dc = 0; dc < 3; dc++) {
              const r2 = br + dr, c2 = bc + dc;
              if (c2 === c) continue;
              if (puzzle[r2][c2] === 0 && cands[r2][c2].has(d)) {
                cands[r2][c2].delete(d); changed = true;
              }
            }
        }
      }
    }
  }

  return cands;
}

/**
 * 获取盘面中所有可推理出的格子集合（显性唯余 + 隐性唯余行/列/宫）。
 * 使用含区块排除推理的候选数，支持 D3+ 难度题目的验证。
 * 用于验证"唯一出数"约束。
 */
function getDeducibleCells(puzzle: number[][]): Set<string> {
  const cands = computeAdvancedCandidates(puzzle);
  const result = new Set<string>();

  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++)
      if (puzzle[r][c] === 0 && cands[r][c].size === 1)
        result.add(`${r},${c}`);

  for (let r = 0; r < 9; r++)
    for (let d = 1; d <= 9; d++) {
      const pos: [number, number][] = [];
      for (let c = 0; c < 9; c++)
        if (puzzle[r][c] === 0 && cands[r][c].has(d)) pos.push([r, c]);
      if (pos.length === 1) result.add(`${pos[0][0]},${pos[0][1]}`);
    }

  for (let c = 0; c < 9; c++)
    for (let d = 1; d <= 9; d++) {
      const pos: [number, number][] = [];
      for (let r = 0; r < 9; r++)
        if (puzzle[r][c] === 0 && cands[r][c].has(d)) pos.push([r, c]);
      if (pos.length === 1) result.add(`${pos[0][0]},${pos[0][1]}`);
    }

  for (let br = 0; br < 9; br += 3)
    for (let bc = 0; bc < 9; bc += 3)
      for (let d = 1; d <= 9; d++) {
        const pos: [number, number][] = [];
        for (let dr = 0; dr < 3; dr++)
          for (let dc = 0; dc < 3; dc++) {
            const r = br + dr, c = bc + dc;
            if (puzzle[r][c] === 0 && cands[r][c].has(d)) pos.push([r, c]);
          }
        if (pos.length === 1) result.add(`${pos[0][0]},${pos[0][1]}`);
      }

  return result;
}

/** 验证全盘只有目标格可被推理出（唯一出数严格约束） */
function isExactlyOneDeducibleCell(puzzle: number[][], TR: number, TC: number): boolean {
  const cells = getDeducibleCells(puzzle);
  return cells.size === 1 && cells.has(`${TR},${TC}`);
}

// ─── 目标格验证：非直观技巧集合（难度5-6出题格禁止出现）───────────────────
//
// 直观技巧（允许）：行/列/宫排除、隐性唯余（宫/行/列）、显性唯余、
//                  区块排除（指向数对）、显性/隐性数对、显性/隐性数组
//
// 非直观技巧（禁止）：鱼类（X翼/剑鱼）、翼类（XY翼/XYZ翼）、
//                    链/着色类（单链着色/XY链/X链）
const CHAIN_TECHNIQUE_NAMES = new Set([
  "X翼",       // X-Wing（N-Fish n=2）
  "剑鱼",      // Swordfish（N-Fish n=3）
  "XY翼",      // XY-Wing
  "XYZ翼",     // XYZ-Wing
  "单链着色",  // Simple Coloring
  "XY链",      // XY-Chain
  "X链",       // X-Chain
]);

/**
 * 验证目标格是否可以不依赖链类技巧解出。
 * @returns `{ valid: true, solveText }` 或 `{ valid: false }`
 * 内部包含 try/catch，任何意外异常均视为"不可用格"，避免游戏卡死。
 */
function validateTargetNoChain(
  puzzle: number[][],
  row: number,
  col: number,
): { valid: boolean; solveText?: string } {
  try {
    const result = solve(puzzle, row, col);
    if (!result.success) return { valid: false };
    const usedChain = result.steps.some((s) => CHAIN_TECHNIQUE_NAMES.has(s.technique));
    if (usedChain) return { valid: false };
    const label = `${String.fromCharCode(65 + row)}${col + 1}`;
    return { valid: true, solveText: formatCompactSteps(result, label) };
  } catch {
    return { valid: false };
  }
}

/** Fisher-Yates 随机打乱数组（原地），返回原数组 */
function shuffleArray<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── 目标格难度筛选标准 ──────────────────────────────────────────────────────
//
// 仅靠盘面整体难度（生成器等级）无法保证目标格的体感难度符合标注，
// 因为同一张盘面中不同格的推导复杂度差异悬殊。
// 此处根据求解器的最短路径长度（pathLength）和是否包含 L3 技巧，
// 在目标格选取阶段增加一层精细筛选，确保玩家感受到的难度符合预期。
//
// minSteps / maxSteps：确定该格所需的最少步骤数范围（含最终填数步）
// requireL3         ：路径中是否必须至少含一个 L3 技巧步骤（数对/数组/显性唯余）
const DIFFICULTY_TARGET_CRITERIA: Record<
  number,
  { minSteps: number; maxSteps: number; requireL3: boolean }
> = {
  1: { minSteps: 1, maxSteps: 2,        requireL3: false }, // 简单：1-2步，直观可见
  2: { minSteps: 2, maxSteps: 4,        requireL3: false }, // 较易：2-4步
  3: { minSteps: 3, maxSteps: 6,        requireL3: false }, // 中等：3-6步
  4: { minSteps: 5, maxSteps: 9,        requireL3: false }, // 中等+：5-9步
  5: { minSteps: 7, maxSteps: 13,       requireL3: true  }, // 困难：7-13步，至少1个L3
  6: { minSteps: 10, maxSteps: 20,       requireL3: true  }, // 困难+：10-20步，至少1个L3
};

/**
 * 严格检查目标格的求解路径是否符合指定难度标准。
 * D7 不受限制，始终返回 true。
 */
function checkTargetDifficultyMatch(
  steps: Array<{ level: number; technique: string }>,
  difficulty: number,
): boolean {
  const criteria = DIFFICULTY_TARGET_CRITERIA[difficulty];
  if (!criteria) return true;
  const len = steps.length;
  if (len < criteria.minSteps || len > criteria.maxSteps) return false;
  if (criteria.requireL3 && !steps.some((s) => s.level >= 3)) return false;
  return true;
}

// ─── 唯余训练相关类型 ──────────────────────────────────────────────────────────

/** 单道训练题的运行状态 */
type TrainingQuestion = {
  answer: number;
  questionStartTime: number;          // 出题时间戳（图片发出后才设置）
  wrongAttempts: Map<string, number>; // userId → 本题错误次数
  /**
   * 第一个正确答案已收到，正在准备下一题。
   * 此状态下 ts.currentQuestion 仍指向本题，允许慢一步的玩家继续答对并计时，
   * 直到下一题图片真正发出时 ts.currentQuestion 才切换到新题。
   */
  transitioning: boolean;
  /** 本题已答对的玩家集合（防止同一玩家重复答对计分） */
  correctAnswerers: Set<string>;
};

/** 每个参与训练玩家的累计数据 */
type TrainingParticipant = {
  userId: string;
  username: string;
  correct: number;  // 答对题数
  wrong: number;    // 答错总次数
  /** 每道答对题的 { 题号, 用时(ms) } */
  correctAnswers: Array<{ questionIndex: number; elapsedMs: number }>;
};

/** 唯余训练会话 */
type TrainingSession = {
  channelId: string;
  startTime: number;
  currentQuestion: TrainingQuestion | null;
  currentQuestionIndex: number;       // 已出题序号（1-based）
  finishedQuestions: number;          // 已正确作答的题目总数
  participants: Map<string, TrainingParticipant>;
  /** 训练难度：1=纯唯余，2=干扰项唯余，3=区块唯余，4=双区块，5=数对→区块，6=多数对→双区块 */
  difficulty: number;
  /** 本轮轮次编号（每频道每次 startTraining 自增），用于生成题目编号如 "2-7" */
  round: number;
  // 题目池：预生成并预渲染的训练题队列，可直接发送
  questionPool: PregeneratedTrainingQuestion[];
  poolNextQueuedIndex: number;        // 下一个待排入池的题号（始终领先于 currentQuestionIndex）
  poolFilling: boolean;               // 防止并发填充
};

/** 唯余训练题目答案缓存条目 */
type TrainingHintEntry = {
  trainingId: string;      // 格式 "轮次-题号"，如 "2-7"
  targetRow: number;
  targetCol: number;
  answer: number;
  puzzle: number[][];
  difficulty: number;
  expireAt: number;        // Unix 时间戳（ms），24小时后过期
};

// ─── 预生成缓存类型 ──────────────────────────────────────────────────────────

/** 预生成的普通对局题目数据（puzzle + 目标格 + 解题文本，不含 questionId/图片） */
type PregeneratedGameQuestion = {
  puzzle: number[][];
  solution: number[][];
  targetCell: { row: number; col: number };
  preSolveText: string | undefined;
};

/** 预生成的唯余训练题目数据（含预渲染图片，可直接发送） */
type PregeneratedTrainingQuestion = {
  puzzle: number[][];
  answer: number;
  renderedImage: Buffer;
  label: string;
  questionIndex: number; // 对应 ts.currentQuestionIndex，用于校验
};

// 每个频道独立的游戏状态
type GameState = {
  channelId: string;
  guildId?: string;
  totalRounds: number;       // 本局总题数
  currentRound: number;      // 已出题轮次（0-indexed：第 N+1 题时值为 N）
  difficulty: number;
  currentPuzzle: number[][];          // 本轮盘面
  currentSolution: number[][];        // 本轮答案
  currentQuestion: { row: number; col: number } | null; // 本轮问题坐标
  currentTimeout: number;             // 本局每题限时（秒），0 = 无限制
  currentInactivityTimeout: number;   // 本局无人参与自动结束时长（分钟），0 = 禁用
  lastActivityTime: number;           // 最近一次任意玩家操作的时间戳
  inactivityTimer: any;               // 无人参与超时计时器（与 timer 独立）
  participants: Map<
    string,
    {
      score: number;
      correct: number;
      wrong: number;
      streak: number;       // 当前连击数（答错重置）
      maxStreak: number;    // 本局最高连击数
      correctAnswerTimes: number[]; // 仅答对时的用时（用于 speed_demon / zen_master）
      answerPattern: string[];
      lastSecondCount: number;
    }
  >;
  timer: any;
  answered: boolean;
  questionStartTime: number;
  userTitleCache: Map<string, string>;    // 本局内头衔缓存，避免每次答对都查 DB
  usernameCache: Map<string, string>;     // 本局内昵称缓存（answer 时捕获），用于结算和存储
  currentPrefix: string;                  // 本轮分配的题目前缀，如 "a"、"ab"
  currentQuestionIdx: number;             // 本轮已出题序号（1-based），当前题编号 = currentPrefix + currentQuestionIdx
  /** 当前题每个玩家的连续答错次数（每道新题出题时清空） */
  questionWrongAttempts: Map<string, number>;
  // 预生成下一题的异步任务（在当前题发出后立即触发，完成后可直接使用，消除出题延迟）
  pregenerationTask?: Promise<PregeneratedGameQuestion | null>;
};

export class SudokuGame {
  private ctx: Context;
  private config: Config;
  private renderer: ImageRenderer;
  private userService: UserService;
  private currentDifficulty: number;   // 全局默认难度（来自插件配置，作为兜底）
  private currentTimeout: number;      // 全局默认限时（来自插件配置，作为兜底）

  // 各群独立的难度 / 限时 / 无人超时设置（key = guildId || channelId）
  private channelDifficulty: Map<string, number> = new Map();
  private channelTimeout: Map<string, number> = new Map();
  private channelInactivityTimeout: Map<string, number> = new Map();

  // 多频道游戏状态表（key = channelId）
  private games: Map<string, GameState> = new Map();

  // 多频道唯余训练状态表（key = channelId）
  private trainings: Map<string, TrainingSession> = new Map();

  // 唯余训练轮次计数器（key = channelId，每次 startTraining 自增；内存级，重启清零）
  private trainingRoundCounter: Map<string, number> = new Map();

  // 唯余训练题目答案缓存（key = channelId → trainingId → TrainingHintEntry）
  private trainingHintCache: Map<string, Map<string, TrainingHintEntry>> = new Map();

  // 难度名称映射
  private static readonly DIFFICULTY_NAMES = [
    "", "简单", "较易", "中等", "中等+", "困难", "困难+", "极难"
  ];

  private mockMessages = MOCK_MESSAGES;
  private hintManager: HintManager = new HintManager();

  constructor(
    ctx: Context,
    config: Config,
    renderer: ImageRenderer,
  ) {
    this.ctx = ctx;
    this.config = config;
    this.renderer = renderer;
    this.userService = new UserService(ctx);
    this.currentDifficulty = config.difficulty;
    this.currentTimeout = config.timeout;
  }

  // ==================== 公开方法 ====================

  /** 取群/频道唯一 key，用于按群隔离难度设置 */
  private getChannelKey(session: Session): string {
    return session.guildId || session.channelId || "global";
  }

  /** 取当前频道生效的难度（群设置 > 全局默认） */
  private getEffectiveDifficulty(session: Session): number {
    return this.channelDifficulty.get(this.getChannelKey(session)) ?? this.currentDifficulty;
  }

  /** 取当前频道生效的限时（群设置 > 全局默认） */
  private getEffectiveTimeout(session: Session): number {
    return this.channelTimeout.get(this.getChannelKey(session)) ?? this.currentTimeout;
  }

  /** 取当前频道生效的无人超时（群设置 > 全局默认，单位：分钟） */
  private getEffectiveInactivityTimeout(session: Session): number {
    return this.channelInactivityTimeout.get(this.getChannelKey(session)) ?? this.config.inactivityTimeout;
  }

  async showHelp(session: Session) {
    const c = this.config;
    const curDiff = this.getEffectiveDifficulty(session);
    const curTimeout = this.getEffectiveTimeout(session);
    const curInactivity = this.getEffectiveInactivityTimeout(session);
    const message = [
      "【数独游戏帮助】",
      "",
      "📌 游戏指令",
      `  ${c.commandStart} [难度1-7] - 开始游戏（可指定临时难度）`,
      `  ${c.commandStop} - 提前结束当前游戏`,
      `  ${c.commandProgress} - 查看当前游戏进度与倒计时`,
      "",
      "📊 数据指令",
      `  ${c.commandScore} - 查看个人档案`,
      `  ${c.commandAchievement} - 查看成就列表`,
      `  ${c.commandAchievement} 首战告捷 - 查看指定成就详情`,
      `  ${c.commandRank} [类型] - 查看排行榜`,
      "    类型：积分 / 答对 / 参与 / 正确率 / MVP / 完美 / 成就",
      "",
      "⚙️ 设置指令",
      `  ${c.commandDifficulty} <1-7> - 设置本群默认难度（当前：${SudokuGame.DIFFICULTY_NAMES[curDiff]}·级别${curDiff}）`,
      "    1简单  2较易  3中等  4中等+  5困难  6困难+  7极难",
      `  ${c.commandTimeout} <秒> - 设置每题答题时间（0=无时间限制，当前：${curTimeout > 0 ? `${curTimeout}秒` : "无限制"}）`,
      `  ${c.commandInactivity} <分钟> - 设置无人参与自动结束时长（0=禁用，当前：${curInactivity > 0 ? `${curInactivity}分钟` : "禁用"}）`,
      "",
      "🎖️ 头衔指令",
      `  ${c.commandTitle} - 查看已拥有的头衔`,
      `  ${c.commandTitle} 数独学徒 - 查看指定头衔的详情`,
      `  ${c.commandWear} 数独学徒 - 佩戴已拥有的头衔`,
      `  ${c.commandUnwear} - 卸下当前佩戴的头衔（恢复自动展示）`,
      `  ${c.commandExchange} - 查看可兑换头衔列表`,
      `  ${c.commandExchange} 数独学徒 - 用积分兑换头衔`,
      "",
      "📝 玩法说明",
      `  每轮 ${c.rounds} 题，每题限时 ${curTimeout > 0 ? `${curTimeout} 秒` : "无限制（答对才进入下一题）"}`,
      "  答对得分，连续答对有积分加成",
      "  答错扣分（同一题连续答错递进惩罚）：首次-10分，再错-100分，三错及以上-666分",
      `  完美局（全 ${c.rounds} 题全对，无一答错）可解锁专属成就，探索隐藏成就获得专属头衔！`,
      "",
      "🔍 求解指引",
      `  ${c.commandHint} a1 - 查询游戏题目 a1 的推理解法（游戏结束后可用，24小时内有效）`,
      `  ${c.commandHint} 2-7 - 查询训练题目「第2轮第7题」的解题路径（24小时内有效）`,
      "",
      "🎯 唯余训练",
      `  ${c.commandTrainingStart} [难度1-6] - 开始唯余训练，不填难度默认1`,
      `  ${c.commandTrainingStop} - 结束本轮训练并查看统计报告`,
      "  训练说明：每题盘面只能推出一个数字，难度越高技巧越复杂",
      "  题目右下角显示编号（如 2-7），可用答案指令查询推理路径",
      "",
      "📖 难度说明",
      `  ${c.commandDiffInfo} - 查看答题游戏与唯余训练各难度的技巧详解`,
    ].join("\n");
    await session.send(message);
  }

  /** 难度说明：输出答题游戏难度 + 唯余训练难度的技巧说明 */
  async showDifficultyInfo(session: Session): Promise<void> {
    const message = [
      "【难度说明】",
      "",
      "🎮 答题游戏（1-7级）",
      "  1·简单    直接排除，盘面较空",
      "  2·较易    显性唯余：某格排除后仅剩1个候选数",
      "  3·中等    隐性唯余：某数字在行/列/宫中只有1格能填",
      "  4·中等+   区块排除：宫内候选格集中在同行/列，可向外消除",
      "  5·困难    显性数对：两格锁定相同2候选数，互相排除",
      "  6·困难+   数组等多技巧组合",
      "  7·极难    X翼/XY翼等多步高级推理",
      "",
      "━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
      "🎯 唯余训练（1-6级）  每题盘面恰好只有1格可推出",
      "  1·基础唯余    行/列/宫直接排除，目标格9缺1",
      "  2·干扰唯余    同训练1，加入干扰数字遮蔽视野",
      "  3·区块唯余    1个区块排除推出目标格（混合显/隐性）",
      "  4·双区块      2个区块排除推出目标格（混合显/隐性）",
      "  5·数对→区块   数对占位→形成区块→推出目标格",
      "  6·多数对      2个数对→双区块→推出目标格",
    ].join("\n");
    await session.send(message);
  }

  hasGameInChannel(channelId?: string): boolean {
    if (!channelId) return false;
    return this.games.has(channelId);
  }

  hasTrainingInChannel(channelId?: string, userId?: string): boolean {
    if (channelId && this.trainings.has(channelId)) return true;
    if (userId && this.trainings.has(`private:${userId}`)) return true;
    return false;
  }

  /**
   * 返回本次会话对应的训练频道 key。
   * 群聊：使用 channelId；私聊（channelId 为空）：若配置允许则使用 "private:{userId}"，否则返回 null。
   */
  private getTrainingChannelKey(session: Session): string | null {
    if (session.channelId) return session.channelId;
    if (this.config.trainingAllowPrivate && session.userId) {
      return `private:${session.userId}`;
    }
    return null;
  }

  async start(session: Session, difficulty?: number) {
    // 提前检查：仅允许群聊
    if (!session.channelId) {
      await session.send("无法在私聊中开始游戏。");
      return;
    }

    if (this.games.has(session.channelId)) {
      await session.send("当前已有游戏在进行中，请稍后。");
      return;
    }

    if (this.trainings.has(session.channelId)) {
      await session.send(`当前频道正在进行唯余训练，请先输入「${this.config.commandTrainingStop}」结束训练后再开始游戏。`);
      return;
    }

    // 确定使用的难度：优先使用本次参数，否则使用本群设置，最后兜底全局默认
    let useDifficulty = this.getEffectiveDifficulty(session);
    if (difficulty !== undefined) {
      if (difficulty < 1 || difficulty > 7) {
        await session.send("难度级别必须在 1-7 之间。\n1-简单 2-较易 3-中等 4-中等+ 5-困难 6-困难+ 7-极难");
        return;
      }
      useDifficulty = difficulty;
    }

    // 每道题单独生成盘面，此处只建立游戏状态
    const newGame: GameState = {
      channelId: session.channelId,
      guildId: session.guildId,
      totalRounds: this.config.rounds,
      currentRound: 0,
      difficulty: useDifficulty,
      currentPuzzle: [],
      currentSolution: [],
      currentQuestion: null,
      currentTimeout: this.getEffectiveTimeout(session),
      currentInactivityTimeout: this.getEffectiveInactivityTimeout(session),
      lastActivityTime: Date.now(),
      inactivityTimer: null,
      participants: new Map(),
      timer: null,
      answered: false,
      questionStartTime: Date.now(),
      userTitleCache: new Map(),
      usernameCache: new Map(),
      currentPrefix: "",
      currentQuestionIdx: 0,
      questionWrongAttempts: new Map(),
    };

    this.games.set(session.channelId, newGame);

    // 分配本轮唯一前缀（24h 回收机制由 HintManager 内部管理）
    newGame.currentPrefix = this.hintManager.allocatePrefix(session.channelId);

    // 记录发起游戏次数，同时绑定群成员关系（用于群榜单隔离和"开局之魂"成就）
    if (session.userId) {
      const startUsername = this.captureUsername(session);
      if (startUsername) newGame.usernameCache.set(session.userId, startUsername);
      await this.userService.updateUser(session.userId, {
        gamesStartedDelta: 1,
        guildId: session.guildId,
        username: startUsername,
      });
    }

    await this.askNextQuestion(session, newGame);
  }

  async stop(session: Session) {
    if (!session.channelId) return;
    const game = this.games.get(session.channelId);
    if (!game) {
      await session.send("当前没有进行中的游戏。");
      return;
    }

    // 立即从 Map 中移除，防止并发 stop 请求在 await 间隙重复找到同一局游戏，导致双重结算
    this.games.delete(session.channelId);
    if (game.timer) { clearTimeout(game.timer); game.timer = null; }
    if (game.inactivityTimer) { clearTimeout(game.inactivityTimer); game.inactivityTimer = null; }

    const completedQuestions = game.currentRound;

    if (game.participants.size > 0) {
      await session.send(`游戏被提前结束！已完成 ${completedQuestions}/${game.totalRounds} 题。`);
      await this.endGame(session, game, false);
    } else {
      await session.send("游戏已结束（无人参与，不计任何数据）。");
    }
  }

  async setDifficulty(session: Session, level: number) {
    if (level < 1 || level > 7) {
      await session.send("难度级别必须在 1-7 之间。\n1-简单 2-较易 3-中等 4-中等+ 5-困难 6-困难+ 7-极难");
      return;
    }
    if (session.channelId && this.games.has(session.channelId)) {
      await session.send("游戏进行中无法更改难度，请先结束当前游戏。");
      return;
    }
    this.channelDifficulty.set(this.getChannelKey(session), level);
    await session.send(`已设置本群难度为：${SudokuGame.DIFFICULTY_NAMES[level]}（级别 ${level}）`);
  }

  async setTimeoutLimit(session: Session, seconds: number) {
    if (!Number.isInteger(seconds) || seconds < 0) {
      await session.send("时间限制必须为非负整数（秒），0 表示无时间限制。");
      return;
    }
    if (session.channelId && this.games.has(session.channelId)) {
      await session.send("游戏进行中无法更改时间限制，请先结束当前游戏。");
      return;
    }
    this.channelTimeout.set(this.getChannelKey(session), seconds);
    if (seconds === 0) {
      await session.send("已设置本群为无时间限制，答对才会进入下一题。");
    } else {
      await session.send(`已设置本群每题答题时间为 ${seconds} 秒。`);
    }
  }

  async showScore(session: Session) {
    if (!session.userId) {
      await session.send("无法获取用户信息。");
      return;
    }
    const user = await this.userService.getUser(session.userId);
    const correctRate =
      user.totalCorrect + user.totalWrong === 0
        ? "暂无"
        : ((user.totalCorrect / (user.totalCorrect + user.totalWrong)) * 100).toFixed(1) + "%";

    const validTitleCount = user.titles.filter(t => t.expire > Date.now()).length;
    const displayTitle = this.userService.getDisplayTitle(user);
    // 优先用本次 session 捕获的昵称，其次用 DB 存储昵称，最后退回 ID
    const profileName = this.captureUsername(session) || user.username || session.userId;
    const message = [
      `【${profileName} 的数独档案】`,
      `积分：${user.score}`,
      `参与轮数：${user.totalRounds}`,
      `答对/答错：${user.totalCorrect}/${user.totalWrong}`,
      `正确率：${correctRate}`,
      `上局结束连击：${user.streak}`,
      `历史最高连击：${user.maxStreak}`,
      `完美局数：${user.perfectRounds} 💯`,
      `MVP次数：${user.mvpCount} 🏆`,
      `已解锁成就：${(user.achievements ?? []).length} 个（输入「${this.config.commandAchievement}」查看详情）`,
      `当前展示头衔：${displayTitle || "无"}${validTitleCount > 0 ? `（共拥有 ${validTitleCount} 个，输入「${this.config.commandTitle}」查看全部）` : ""}`,
    ].join("\n");

    await session.send(message);
  }

  async showAchievements(session: Session, name?: string) {
    if (!session.userId) {
      await session.send("无法获取用户信息。");
      return;
    }
    if (name) {
      const text = await this.userService.getAchievementDetailText(session.userId, name);
      await session.send(text);
    } else {
      // 名字优先级：session 捕获 > session.username > userId（getAchievementListText 内部会再用 DB 存储名兜底）
      const displayName = this.captureUsername(session) || session.userId;
      const text = await this.userService.getAchievementListText(
        session.userId,
        displayName,
        this.config.commandAchievement,
      );
      await session.send(text);
    }
  }

  async showTitles(session: Session, name?: string) {
    if (!session.userId) {
      await session.send("无法获取用户信息。");
      return;
    }
    if (name) {
      const text = await this.userService.getTitleDetailText(session.userId, name);
      await session.send(text);
    } else {
      const text = await this.userService.getOwnedTitlesText(
        session.userId,
        this.config.commandTitle,
        this.config.commandWear,
        this.config.commandUnwear,
      );
      await session.send(text);
    }
  }

  async wearTitle(session: Session, titleName: string) {
    if (!session.userId) {
      await session.send("无法获取用户信息。");
      return;
    }
    const msg = await this.userService.wearTitle(session.userId, titleName);
    await session.send(msg);
  }

  async unwearTitle(session: Session, titleName?: string) {
    if (!session.userId) {
      await session.send("无法获取用户信息。");
      return;
    }
    const msg = await this.userService.unwearTitle(session.userId, titleName);
    await session.send(msg);
  }

  async showHint(session: Session, rawId: string) {
    // 训练题编号格式（如 "1-7"、"2-23"）优先路由
    if (/^\d+-\d+$/.test(rawId.trim())) {
      return this.showTrainingHint(session, rawId.trim());
    }

    if (!session.channelId) return;

    const parsed = this.hintManager.parseQuestionId(rawId);
    if (!parsed) {
      await session.send(
        `题目编号格式不正确，请输入如 a1、ab3 格式的编号。\n示例：${this.config.commandHint} a1`,
      );
      return;
    }

    const { prefix } = parsed;

    // 统一小写（提前计算，供后续封锁判断和缓存查找共用）
    const normalizedId = rawId.trim().toLowerCase();

    // 游戏进行中时，仅禁止查询「当前正在作答、尚未揭晓答案」的题目。
    // 本局已经出过并公布答案的历史题（如第 1~4 题），允许正常查询推理路径。
    const game = this.games.get(session.channelId);
    if (game && game.currentPrefix === prefix) {
      const currentQuestionId = `${game.currentPrefix}${game.currentQuestionIdx}`.toLowerCase();
      if (normalizedId === currentQuestionId) {
        await session.send("当前题目尚未揭晓，无法提前查询答案。");
        return;
      }
    }
    const record = this.hintManager.getQuestion(session.channelId, normalizedId);

    if (!record) {
      // 区分"编号从未出现过"与"已过期"
      if (this.hintManager.isPrefixKnown(session.channelId, prefix)) {
        await session.send("该题目已过期，无法查询（题目数据仅保留 24 小时）。");
      } else {
        await session.send("题目编号无效，请确认编号是否正确。");
      }
      return;
    }

    // 调用求解
    const result = this.hintManager.solveHint(record);
    if (!result.success) {
      if (result.reason === "unsolvable") {
        await session.send("题目数据异常，无法解析。");
      } else {
        // beyond_l3：仍有部分推导文本可展示
        await session.send(
          result.text ?? "此题超出当前支持的推理范围，无法生成完整推理路径。",
        );
      }
      return;
    }

    await session.send(result.text);
  }

  /** 查询唯余训练题目答案（编号格式 "轮次-题号"，如 "2-7"） */
  private async showTrainingHint(session: Session, trainingId: string): Promise<void> {
    const key = this.getTrainingChannelKey(session) ?? session.channelId;
    if (!key) {
      await session.send("无法获取频道信息，请在群组中使用此指令。");
      return;
    }

    const cache = this.trainingHintCache.get(key);
    if (!cache) {
      await session.send(`训练题编号「${trainingId}」无效，请确认编号是否正确。`);
      return;
    }

    const entry = cache.get(trainingId);
    if (!entry) {
      await session.send(`训练题编号「${trainingId}」无效，请确认编号是否正确。`);
      return;
    }

    if (Date.now() > entry.expireAt) {
      cache.delete(trainingId);
      await session.send("该训练题已过期，无法查询（题目数据仅保留 24 小时）。");
      return;
    }

    const targetCell = `${String.fromCharCode(65 + entry.targetRow)}${entry.targetCol + 1}`;
    const explanation = generateTrainingHintExplanation(
      entry.puzzle, entry.targetRow, entry.targetCol, entry.answer,
    );
    await session.send(`目标格：${targetCell}\n解答：${explanation}`);
  }

  async showRank(session: Session, type: string = "积分", scope?: string) {
    // 解析全服模式：
    //   "排行榜 答对 全服"    → type="答对", scope="全服"
    //   "排行榜 全服"         → type="全服", scope=undefined（type 本身就是"全服"）
    //   "排行榜 全服积分"     → 兼容旧格式前缀
    let isGlobal = scope === "全服";
    let effectiveType = type;
    if (type === "全服") {
      isGlobal = true;
      effectiveType = "积分";
    } else if (type.startsWith("全服")) {
      isGlobal = true;
      effectiveType = type.slice(2).trim() || "积分";
    }

    const allUsers = await this.ctx.database.get("sudoku_user", {});
    if (allUsers.length === 0) {
      await session.send("暂无数据。");
      return;
    }

    // 本群筛选（有 guildId 且非全服模式时，只显示本群成员）
    const scopeLabel = !isGlobal && session.guildId ? "本群" : "全服";
    let users = allUsers;
    if (!isGlobal && session.guildId) {
      users = allUsers.filter(u => {
        const g = (u as any).guilds;
        return Array.isArray(g) && g.includes(session.guildId!);
      });
      if (users.length === 0) {
        await session.send(`本群暂无玩家数据。\n使用「${this.config.commandRank} 全服」可查看全服排行榜。`);
        return;
      }
    }

    const typeAlias: Record<string, string> = {
      积分: "score", 答对: "correct", 参与: "rounds", 正确率: "rate",
      mvp: "mvp", MVP: "mvp", 完美: "perfect", 完美局: "perfect",
      成就: "achievement",
      score: "score", correct: "correct", rounds: "rounds",
      rate: "rate", perfect: "perfect", achievement: "achievement",
    };

    const normalizedType = typeAlias[effectiveType] || "score";

    let sorted: any[] = [];
    const typeMap: Record<string, { field: string; desc: boolean; name: string; unit?: string }> = {
      score:       { field: "score",          desc: true, name: "积分榜",    unit: "分" },
      correct:     { field: "totalCorrect",   desc: true, name: "答对榜",    unit: "题" },
      rounds:      { field: "totalRounds",    desc: true, name: "参与榜",    unit: "局" },
      rate:        { field: "rate",           desc: true, name: "正确率榜",  unit: "%" },
      mvp:         { field: "mvpCount",       desc: true, name: "MVP榜",     unit: "次" },
      perfect:     { field: "perfectRounds",  desc: true, name: "完美局榜",  unit: "局" },
      achievement: { field: "achievementCount", desc: true, name: "成就榜", unit: "个" },
    };

    const selected = typeMap[normalizedType];
    const title = selected.name;

    if (normalizedType === "rate") {
      users = users.filter((u) => u.totalCorrect + u.totalWrong >= 20);
      const usersWithRate = users.map((u) => ({
        ...u,
        rate: u.totalCorrect / (u.totalCorrect + u.totalWrong) || 0,
      })) as any[];
      sorted = usersWithRate.sort((a, b) => b.rate - a.rate).slice(0, 10);
    } else if (normalizedType === "achievement") {
      const usersWithCount = users.map((u) => ({
        ...u,
        achievementCount: (u.achievements as any[] | null ?? []).length,
      })) as any[];
      sorted = usersWithCount
        .sort((a, b) => b.achievementCount - a.achievementCount || b.totalCorrect - a.totalCorrect)
        .slice(0, 10);
    } else {
      // 通用排序：同分时以答对数为次要排序
      sorted = (users as any[])
        .sort((a, b) => {
          const diff = b[selected.field] - a[selected.field];
          return diff !== 0 ? diff : b.totalCorrect - a.totalCorrect;
        })
        .slice(0, 10);
    }

    const lines = [`【${scopeLabel}${title} TOP 10】`];
    for (let i = 0; i < sorted.length; i++) {
      const u = sorted[i];
      // 优先使用 DB 存储昵称作为基础（全服榜无法跨群调 API）
      let nickname = (u as any).username || u.userId;
      // 本群榜额外尝试从 API 取群昵称（可能与存储昵称不同）
      if (!isGlobal) {
        try {
          if (session.guildId) {
            const member = await session.bot.getGuildMember?.(session.guildId, u.userId);
            const apiName = (member as any)?.nickname ?? (member as any)?.name;
            if (apiName) nickname = apiName;
          }
        } catch { /* 忽略 */ }
      }
      const titlePrefix = this.userService.getDisplayTitle(u);
      const nameDisplay = titlePrefix ? `${titlePrefix}${nickname}` : nickname;

      if (normalizedType === "rate") {
        lines.push(`${i + 1}. ${nameDisplay}：${(u.rate * 100).toFixed(1)}% (✅${u.totalCorrect} ❌${u.totalWrong})`);
      } else if (normalizedType === "mvp") {
        lines.push(`${i + 1}. ${nameDisplay}：${u.mvpCount}次 🏆`);
      } else if (normalizedType === "perfect") {
        lines.push(`${i + 1}. ${nameDisplay}：${u.perfectRounds}局 💯`);
      } else if (normalizedType === "achievement") {
        lines.push(`${i + 1}. ${nameDisplay}：${u.achievementCount}个 🎖️`);
      } else {
        lines.push(`${i + 1}. ${nameDisplay}：${u[selected.field]}${selected.unit || ""}`);
      }
    }

    await session.send(lines.join("\n"));
  }

  async showProgress(session: Session) {
    if (!session.channelId) return;
    const game = this.games.get(session.channelId);
    if (!game) {
      await session.send("当前没有进行中的游戏。");
      return;
    }

    const currentQuestion = game.currentRound + 1;
    const totalQuestions = game.totalRounds;
    const elapsed = Math.floor((Date.now() - game.questionStartTime) / 1000);
    const remaining = game.currentTimeout > 0 ? Math.max(0, game.currentTimeout - elapsed) : -1;
    const participantCount = game.participants.size;
    const topScorers = Array.from(game.participants.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 3);

    let message = `【游戏进度】\n`;
    message += `当前题目：第 ${currentQuestion}/${totalQuestions} 题\n`;
    message += `剩余时间：${remaining >= 0 ? `${remaining} 秒` : "无限制"}\n`;
    message += `参与人数：${participantCount} 人\n`;
    if (topScorers.length > 0) {
      message += `暂时领先：\n`;
      for (let idx = 0; idx < topScorers.length; idx++) {
        const [uid, data] = topScorers[idx];
        let nickname = game.usernameCache.get(uid) || uid;
        try {
          if (session.guildId) {
            const member = await session.bot.getGuildMember?.(session.guildId, uid);
            nickname = (member as any)?.nickname ?? (member as any)?.name ?? nickname;
          }
        } catch { /* 忽略 */ }
        message += `  ${idx + 1}. ${nickname}：${data.score}分\n`;
      }
    }

    await session.send(message);
  }

  async exchangeTitle(session: Session, titleName?: string) {
    if (!session.userId) {
      await session.send("无法获取用户信息。");
      return;
    }

    // 无参数时显示头衔商店目录
    if (!titleName) {
      const user = await this.userService.getUser(session.userId);
      const shopLines = [
        "【头衔兑换商店】",
        "  数独学徒 - 100积分 / 有效期7天",
        "  解题高手 - 500积分 / 有效期30天",
        "  终盘大师 - 2000积分 / 有效期365天",
        "",
        `当前积分：${user.score}`,
        `输入「${this.config.commandExchange} 数独学徒」即可兑换`,
      ];
      await session.send(shopLines.join("\n"));
      return;
    }

    const success = await this.userService.exchangeTitle(session.userId, titleName);
    if (success) {
      await session.send(`兑换成功！你现在拥有头衔「${titleName}」。`);
    } else {
      await session.send(`兑换失败，积分不足、头衔不存在或已持有该头衔。\n输入「${this.config.commandExchange}」可查看头衔列表。`);
    }
  }

  // ==================== 内部游戏流程 ====================

  /**
   * 从当前难度生成一道题目的纯数据（puzzle + 目标格 + 解题文本）。
   * 包含全部重试逻辑，使用循环代替递归，不依赖 game / session 状态。
   * 可在后台调用，用于预生成下一题，消除出题延迟。
   *
   * 重试策略（与原 askNextQuestion 完全一致）：
   *  D1-D3：最多重试20次，直到找到严格匹配目标格
   *  D4   ：同上，但有方案C兜底（步骤最接近的格）
   *  D5-D6：最多重试30次，先验证整题无链，再精选目标格；有方案C兜底
   *  D7   ：直接随机选格，无限制
   */
  private buildQuestionData(difficulty: number): PregeneratedGameQuestion | null {
    const logger = this.ctx.logger("sudoku");

    // D7：无限制，直接生成
    if (difficulty === 7) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const gen = new SudokuGenerator(difficulty);
        const { puzzle, solution } = gen.generate();
        const emptyCells: { row: number; col: number }[] = [];
        for (let r = 0; r < 9; r++)
          for (let c = 0; c < 9; c++)
            if (puzzle[r][c] === 0 && solution[r][c] !== 0) emptyCells.push({ row: r, col: c });
        if (emptyCells.length === 0) continue;
        const q = emptyCells[Math.floor(Math.random() * emptyCells.length)];
        return { puzzle, solution, targetCell: q, preSolveText: undefined };
      }
      return null;
    }

    // D1-D6：含步骤难度筛选
    const maxAttempts = (difficulty >= 5) ? 31 : 21;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const gen = new SudokuGenerator(difficulty);
      const { puzzle, solution } = gen.generate();

      const emptyCells: { row: number; col: number }[] = [];
      for (let r = 0; r < 9; r++)
        for (let c = 0; c < 9; c++)
          if (puzzle[r][c] === 0 && solution[r][c] !== 0) emptyCells.push({ row: r, col: c });
      if (emptyCells.length === 0) {
        logger.warn(`buildQuestionData 难度${difficulty}：无空格，重试（第${attempt + 1}次）`);
        continue;
      }

      const isLastAttempt = attempt >= maxAttempts - 1;

      if (difficulty === 5 || difficulty === 6) {
        // D5/D6：先确保整题无链
        if (!checkPuzzleIntuitiveSolvable(puzzle)) {
          if (!isLastAttempt) {
            logger.warn(`buildQuestionData 难度${difficulty}：盘面含链类技巧，重生成（第${attempt + 1}次）`);
            continue;
          }
          logger.warn(`buildQuestionData 难度${difficulty}：超过${maxAttempts}次重试，降级使用含链类盘面`);
        }
        const r56 = this.pickTargetCell(puzzle, emptyCells, difficulty);
        if (r56.q) {
          if (!r56.matched)
            logger.warn(`buildQuestionData 难度${difficulty}：无严格匹配格，使用方案C兜底`);
          return { puzzle, solution, targetCell: r56.q, preSolveText: r56.preSolveText };
        }
        // 极罕见：pickTargetCell 无任何格
        const q = emptyCells[Math.floor(Math.random() * emptyCells.length)];
        return { puzzle, solution, targetCell: q, preSolveText: validateTargetNoChain(puzzle, q.row, q.col).solveText };

      } else { // D1-D4
        const rDiff = this.pickTargetCell(puzzle, emptyCells, difficulty);
        if (rDiff.matched) {
          return { puzzle, solution, targetCell: rDiff.q!, preSolveText: rDiff.preSolveText };
        }
        if (difficulty >= 4 && rDiff.q) {
          logger.warn(`buildQuestionData 难度4：无严格匹配格，使用方案C兜底`);
          return { puzzle, solution, targetCell: rDiff.q, preSolveText: rDiff.preSolveText };
        }
        if (!isLastAttempt) {
          logger.warn(`buildQuestionData 难度${difficulty}：${rDiff.q ? "无符合步骤要求的目标格" : "无有效目标格（全链）"}，重生成（第${attempt + 1}次）`);
          continue;
        }
        // 超限降级
        logger.warn(`buildQuestionData 难度${difficulty}：超过${maxAttempts}次重试，降级随机选格`);
        const q = rDiff.q ?? emptyCells[Math.floor(Math.random() * emptyCells.length)];
        return {
          puzzle, solution, targetCell: q,
          preSolveText: rDiff.preSolveText ?? validateTargetNoChain(puzzle, q.row, q.col).solveText,
        };
      }
    }
    return null;
  }

  /**
   * 后台触发下一题预生成（fire-and-forget）。
   * 利用玩家答题时间异步完成高耗时计算，使下次 askNextQuestion 可以直接使用缓存数据。
   * 使用 setImmediate 延迟到下一次事件循环迭代，避免在当前帧阻塞消息收发。
   */
  private triggerGamePregeneration(game: GameState): void {
    // 已有进行中的预生成任务时不重复启动
    if (game.pregenerationTask) return;
    const difficulty = game.difficulty;
    game.pregenerationTask = new Promise<PregeneratedGameQuestion | null>((resolve) => {
      setImmediate(() => {
        // 游戏已结束则丢弃
        if (!this.games.has(game.channelId)) { resolve(null); return; }
        try {
          resolve(this.buildQuestionData(difficulty));
        } catch {
          resolve(null);
        }
      });
    });
  }

  private async askNextQuestion(session: Session, game: GameState) {
    // 确认游戏仍存在（可能被 stop 提前终止）
    if (!this.games.has(game.channelId)) return;

    if (game.timer) clearTimeout(game.timer);

    if (game.currentRound >= game.totalRounds) {
      await this.endGame(session, game);
      return;
    }

    const logger = this.ctx.logger("sudoku");

    // ── 使用预生成缓存或实时生成题目 ────────────────────────────────────────────
    // 若后台预生成任务已完成，直接使用结果；否则实时调用 buildQuestionData。
    // 两种路径的生成逻辑完全相同，差别仅在时序：
    //   缓存命中 → 数秒延迟已在玩家答题期间消化，本次几乎零等待
    //   缓存未就绪 → 等待后台任务完成（通常已接近结束），或退化为实时生成
    let questionData: PregeneratedGameQuestion | null = null;
    if (game.pregenerationTask) {
      questionData = await game.pregenerationTask;
      game.pregenerationTask = undefined;
      if (questionData) logger.info(`命中预生成缓存（难度${game.difficulty}）`);
    }
    if (!questionData) {
      questionData = this.buildQuestionData(game.difficulty);
    }

    if (!questionData) {
      logger.error("题目生成失败（已穷尽所有重试），跳过本题");
      await session.send("⚠️ 本题盘面生成异常，已自动跳过，进入下一题。");
      game.currentRound++;
      await this.askNextQuestion(session, game);
      return;
    }

    // 游戏在等待期间被停止
    if (!this.games.has(game.channelId)) return;

    const { puzzle, solution, targetCell: q, preSolveText } = questionData;

    // 更新当前题的状态
    game.currentPuzzle = puzzle;
    game.currentSolution = solution;
    game.currentQuestion = q;

    // 生成本题编号并注册到 HintManager 缓存
    game.currentQuestionIdx++;
    const questionId = `${game.currentPrefix}${game.currentQuestionIdx}`;
    this.hintManager.registerQuestion(game.channelId, questionId, {
      puzzle: puzzle.map((row) => [...row]),
      solution: solution.map((row) => [...row]),
      targetRow: q.row,
      targetCol: q.col,
      targetAnswer: solution[q.row][q.col],
      createdAt: Date.now(),
      solveText: preSolveText, // 各难度均在目标格选取时预计算，直接缓存；D7 为 undefined（实时计算）
    });

    // ── 标记题目为"待作答"（防止发图失败时游戏卡死），须在 send 之前完成 ────────
    game.answered = false;
    // 每道新题清空连续答错计数，重新开始计梯度扣分
    game.questionWrongAttempts = new Map();

    // 每次出题重置无人参与超时计时器（无需等待图片发出）
    this.resetInactivityTimer(session, game);

    // ── 发送本题盘面图片 ───────────────────────────────────────────────────
    // questionStartTime 和倒计时定时器在 finally 中（图片发出后）设置，
    // 确保计时从玩家实际看到题目的时刻开始，答题时长和剩余倒计时更准确。
    const difficultyLabel = `level ${game.difficulty}`;
    try {
      const image = await this.renderer.render(puzzle, difficultyLabel, q, questionId);
      if (!image || image.length === 0) {
        logger.error("Canvas 返回空 Buffer，图片生成失败");
        await session.send("⚠️ 图片生成失败，但游戏继续。");
      } else {
        await this.sendImage(session, image);
        logger.info(`第 ${game.currentRound + 1} 题盘面发送（${image.length} bytes）编号：${questionId}`);
      }
    } catch (error: any) {
      logger.error("图片渲染/发送失败：", error);
      try {
        await session.send(`⚠️ 图片发送失败，游戏继续，请根据编号 ${questionId} 继续作答。`);
      } catch {
        // 降级通知也失败时静默处理
      }
    } finally {
      // 图片发送完成（成功或确认失败）后，开始计时并启动倒计时
      game.questionStartTime = Date.now();
      if (game.currentTimeout > 0) {
        // 有时间限制：倒计时到期后公布答案并进入下一题
        game.timer = setTimeout(async () => {
          const currentGame = this.games.get(game.channelId);
          if (!currentGame || currentGame !== game) return;
          if (!game.answered) {
            // 立即锁定，防止在 await 挂起期间玩家抢答导致 currentRound 双重递增
            game.answered = true;
            const answer = game.currentSolution[game.currentQuestion!.row][game.currentQuestion!.col];
            if (game.participants.size >= 2) {
              const mockMsg = this.getRandomMock("groupMock", { answer });
              await session.send(mockMsg);
            } else {
              await session.send(`时间到！答案是 ${answer}。`);
            }
            game.currentRound++;
            await this.askNextQuestion(session, game);
          }
        }, game.currentTimeout * 1000);
      } else {
        // 无时间限制：不设定时器，等待玩家答对才进入下一题
        game.timer = null;
      }

      // ── 后台预生成下一题（利用玩家答题时间消化计算耗时） ───────────────────
      // 若还有下一题，立即在后台生成题目数据（puzzle + 目标格 + 解题文本）。
      // 当玩家答对本题时，askNextQuestion 可直接使用缓存，跳过数秒计算等待。
      if (game.currentRound + 1 < game.totalRounds) {
        this.triggerGamePregeneration(game);
      }
    }
  }

  async handleAnswer(session: Session, number: number) {
    if (!session.channelId) return;
    const game = this.games.get(session.channelId);
    if (!game) return;
    if (game.answered) return;
    if (!session.userId) return;

    // 计算答题用时，至少为1秒（避免网络延迟导致负数）
    const answerTime = Math.max(1, Math.floor((Date.now() - game.questionStartTime) / 1000));

    // 若题目尚未就绪（极短窗口期），忽略输入
    if (!game.currentQuestion) return;

    // 有玩家应答：更新活动时间、重置无人超时计时器、缓存昵称（多来源捕捉）
    game.lastActivityTime = Date.now();
    this.resetInactivityTimer(session, game);
    const capturedName = this.captureUsername(session);
    if (capturedName) game.usernameCache.set(session.userId, capturedName);

    const q = game.currentQuestion;
    const correct = game.currentSolution[q.row][q.col];

    if (number !== correct) {
      // 递进扣分：同一题连续答错依次 -10 / -100 / -666，防止瞎猜
      const prevWrong = game.questionWrongAttempts.get(session.userId) ?? 0;
      const newWrong = prevWrong + 1;
      game.questionWrongAttempts.set(session.userId, newWrong);
      const PENALTY_TIERS = [10, 100, 666] as const;
      const penalty = PENALTY_TIERS[Math.min(newWrong - 1, PENALTY_TIERS.length - 1)];

      this.updateParticipant(game, session.userId, false, answerTime, penalty);

      const displayUser = capturedName || game.usernameCache.get(session.userId) || session.userId;
      // 单人嘲讽：50%概率触发（首次答错）；多次答错固定显示警告
      try {
        if (newWrong === 1 && Math.random() < 0.5) {
          const mockMsg = this.getRandomMock("singleMock", {
            user: displayUser,
            penalty,
          });
          await session.send(mockMsg);
        } else if (newWrong === 2) {
          await session.send(`${h.at(session.userId)} 连续答错！扣 ${penalty} 分。`);
        } else if (newWrong >= 3) {
          await session.send(`${h.at(session.userId)} 疯狂乱猜？扣 ${penalty} 分！！`);
        } else {
          await session.send(`${h.at(session.userId)} 答错了，扣 ${penalty} 分。`);
        }
      } catch (err: any) {
        this.ctx.logger("sudoku").warn("答错反馈消息发送失败：", err?.message ?? err);
      }
      return;
    }

    clearTimeout(game.timer);
    game.answered = true;
    const participant = this.updateParticipant(game, session.userId, true, answerTime);
    const earned = this.config.baseScore + (participant.streak - 1) * this.config.streakBonus;

    let titlePrefix = game.userTitleCache.get(session.userId);
    if (titlePrefix === undefined) {
      const answerUser = await this.userService.getUser(session.userId);
      titlePrefix = this.userService.getDisplayTitle(answerUser);
      game.userTitleCache.set(session.userId, titlePrefix);
    }
    const atMention = h.at(session.userId);
    const displayName = titlePrefix ? `${titlePrefix}${atMention}` : `${atMention}`;
    // 格式化用时：< 60 秒显示秒数，>= 60 秒显示分秒
    const timeStr = answerTime < 60
      ? `${answerTime}秒`
      : `${Math.floor(answerTime / 60)}分${answerTime % 60}秒`;
    // 答对反馈：发送失败时仅记录警告，不阻止游戏推进（如 QQ 临时风控 retcode:1200）
    try {
      await session.send(`恭喜 ${displayName} 答对！+${earned} 分（连击${participant.streak}次），用时 ${timeStr}。`);
    } catch (err: any) {
      this.ctx.logger("sudoku").warn("答对反馈消息发送失败：", err?.message ?? err);
    }

    game.currentRound++;
    await this.askNextQuestion(session, game);
  }

  /**
   * 发送图片：优先 base64 内联（单次 API 调用，延迟最低）；
   * 若 base64 发送失败（如 OneBot 实现限制），自动降级为 file:// 本地路径。
   */
  private async sendImage(session: Session, buf: Buffer): Promise<void> {
    try {
      await session.send(h.image(`data:image/png;base64,${buf.toString("base64")}`));
    } catch {
      // base64 失败（请求体过大或 OneBot 限制）→ 降级为 file:// 本地文件路径
      const filePath = await this.renderer.saveTmpImage(buf);
      await session.send(h.image(`file://${filePath}`));
    }
  }

  private updateParticipant(
    game: GameState,
    userId: string,
    isCorrect: boolean,
    answerTime?: number,
    penalty?: number,
  ) {
    let p = game.participants.get(userId);
    if (!p) {
      p = {
        score: 0,
        correct: 0,
        wrong: 0,
        streak: 0,
        maxStreak: 0,
        correctAnswerTimes: [],
        answerPattern: [],
        lastSecondCount: 0,
      };
      game.participants.set(userId, p);
    }

    p.answerPattern.push(isCorrect ? "对" : "错");

    if (isCorrect) {
      p.correct++;
      p.streak++;
      if (p.streak > p.maxStreak) p.maxStreak = p.streak;
      p.score += this.config.baseScore + (p.streak - 1) * this.config.streakBonus;
      // 仅记录答对的用时（用于 speed_demon / zen_master 成就判断）
      if (answerTime !== undefined) {
        p.correctAnswerTimes.push(answerTime);
        // 仅有时间限制时才统计"最后5秒答对"（timeout=0表示无限制，没有"最后5秒"概念）
        if (game.currentTimeout > 0 && answerTime >= game.currentTimeout - 5) {
          p.lastSecondCount++;
        }
      }
    } else {
      p.wrong++;
      p.streak = 0;
      p.score -= (penalty ?? this.config.penalty);
    }
    return p;
  }

  /**
   * @param isComplete 是否完整完成所有轮次。
   *   - true（正常结束）：完整结算积分、MVP、垫底、成就、荣誉头衔。
   *   - false（提前结束）：仅记录参与次数和答对次数，不结算积分/成就/荣誉头衔。
   */
  private async endGame(session: Session, game: GameState, isComplete = true) {
    if (game.timer) { clearTimeout(game.timer); game.timer = null; }
    if (game.inactivityTimer) clearTimeout(game.inactivityTimer);
    game.inactivityTimer = null;
    this.games.delete(game.channelId);

    const participants = Array.from(game.participants.entries());
    if (participants.length > 0) {
      // 三级排序：① 积分高者靠前 ② 同分时答对数多者靠前 ③ 再同时答错数少者靠前
      // 三级标准大幅消除并列情况，使垫底判定更精确
      const sorted = participants.sort((a, b) => {
        const scoreDiff = b[1].score - a[1].score;
        if (scoreDiff !== 0) return scoreDiff;
        const correctDiff = b[1].correct - a[1].correct;
        if (correctDiff !== 0) return correctDiff;
        return a[1].wrong - b[1].wrong;
      });

      // ── 1. 预加载用户数据（单次 DB 读取，供排行榜头衔展示 + 昵称兜底 + prevConsecutiveLastPlaces）──
      const preUpdateUsers = new Map<string, any>();
      for (const [uid] of participants) {
        preUpdateUsers.set(uid, await this.userService.getUser(uid));
      }

      // ── 2. 构建昵称缓存（优先级：API群昵称 > 本局session捕获 > DB存储 > userId）──
      const nicknameMap = new Map<string, string>();
      for (const [uid] of participants) {
        // 先取本局 session 捕获或 DB 存储的昵称作为兜底（比裸 userId 更友好）
        const storedName = game.usernameCache.get(uid) || (preUpdateUsers.get(uid) as any)?.username || "";
        let nickname = storedName || uid;
        try {
          if (session.guildId) {
            const member = await session.bot.getGuildMember?.(session.guildId, uid);
            const apiName = (member as any)?.nickname ?? (member as any)?.name;
            if (apiName) nickname = apiName;
          }
        } catch { /* 忽略 */ }
        nicknameMap.set(uid, nickname);
      }

      // 计算MVP：多人局中得分最高且答对至少1题（单人局无MVP概念）
      let mvpUserId: string | null = null;
      if (participants.length > 1) {
        for (const [uid, data] of sorted) {
          if (data.correct > 0) {
            mvpUserId = uid;
            break;
          }
        }
      }

      const headerLine = isComplete
        ? "本轮游戏结束！\n\n【得分排行榜】"
        : "⚠️ 游戏提前结束（仅统计，不计积分/成就）\n\n【本局答题情况】";
      let message = headerLine + "\n";
      let mvpDisplayName = mvpUserId ?? "";
      for (let index = 0; index < sorted.length; index++) {
        const [uid, data] = sorted[index];
        const isMVP = uid === mvpUserId;
        const prefix = isMVP ? "👑 " : "";
        const correctRate =
          data.correct + data.wrong === 0
            ? "0%"
            : ((data.correct / (data.correct + data.wrong)) * 100).toFixed(1) + "%";
        const nickname = nicknameMap.get(uid) ?? uid;
        const preUser = preUpdateUsers.get(uid);
        const titlePrefix = preUser ? this.userService.getDisplayTitle(preUser) : "";
        const nameDisplay = titlePrefix ? `${titlePrefix}${nickname}` : nickname;
        if (isMVP) mvpDisplayName = nameDisplay;
        message += `${prefix}${index + 1}. ${nameDisplay}：${data.score}分（✅${data.correct} ❌${data.wrong} 正确率${correctRate}）\n`;
      }

      if (participants.length === 1) {
        // 单人局不评 MVP
      } else if (mvpUserId) {
        message += `\n🎉 本局MVP：${mvpDisplayName}`;
      } else {
        message += `\n本局无人答对，无MVP。`;
      }

      await session.send(message);

      // ─── 提前结束：记录参与次数、答对次数、答错次数，不计积分/成就/荣誉头衔 ───
      if (!isComplete) {
        for (const [uid, data] of participants) {
          await this.userService.updateUser(uid, {
            correctDelta: data.correct,
            wrongDelta: data.wrong,
            roundsDelta: 1,
            guildId: game.guildId,
            username: nicknameMap.get(uid) || game.usernameCache.get(uid) || "",
          });
        }
        return;
      }

      // 以下仅完整完成时执行 ↓↓↓

      // 垫底判定：以三级排序末名的综合表现为基准，精确区分"唯一垫底"与"并列垫底"
      const isMultiPlayer = participants.length > 1;
      const lastData = isMultiPlayer ? sorted[sorted.length - 1][1] : null;
      // 三级标准完全相同才视为"与末名并列"
      const isCompositeLastPlace = (d: typeof sorted[0][1]): boolean =>
        lastData !== null &&
        d.score === lastData.score &&
        d.correct === lastData.correct &&
        d.wrong === lastData.wrong;
      const lowestCount = isMultiPlayer
        ? sorted.filter(([, d]) => isCompositeLastPlace(d)).length
        : 0;

      // 从预加载数据取 prevConsecutiveLastPlaces（无额外 DB 查询）
      const prevConsecutiveLastPlaces = new Map<string, number>();
      for (const [uid] of participants) {
        prevConsecutiveLastPlaces.set(uid, preUpdateUsers.get(uid)?.consecutiveLastPlace ?? 0);
      }

      // ── 3. updateUser 并收集更新后的用户对象（避免 checkAchievements 重复读 DB）──
      const updatedUsers = new Map<string, any>();
      for (const [uid, data] of participants) {
        // 完美局：必须全程参与且所有题目全部答对（无任何答错）
        const isPerfect = data.wrong === 0 && data.correct === game.totalRounds;
        const isMVP = uid === mvpUserId;
        let isLastPlace: boolean | undefined;
        if (isMultiPlayer) {
          if (isCompositeLastPlace(data) && lowestCount === 1) {
            isLastPlace = true;   // 三级标准均最差且唯一
          } else if (!isCompositeLastPlace(data)) {
            isLastPlace = false;  // 三级标准至少有一项优于末名
          }
          // isCompositeLastPlace(data) && lowestCount > 1：三级标准完全相同（极罕见），不计入连续垫底
        }
        const updated = await this.userService.updateUser(uid, {
          scoreDelta: data.score,
          correctDelta: data.correct,
          wrongDelta: data.wrong,
          roundsDelta: 1,
          perfectDelta: isPerfect ? 1 : 0,
          mvpDelta: isMVP ? 1 : 0,
          isLastPlace,
          isMvp: isMultiPlayer ? isMVP : undefined,
          finalStreak: data.streak,
          maxInGameStreak: data.maxStreak,
          guildId: game.guildId,
          username: nicknameMap.get(uid) || game.usernameCache.get(uid) || "",
        });
        updatedUsers.set(uid, updated);
      }

      // ── 4. 成就检测（昵称缓存 + 已更新用户对象，减少重复 DB 查询）──
      for (const [uid, data] of participants) {
        const username = nicknameMap.get(uid) ?? uid;
        const isMVP = uid === mvpUserId;
        const isAlone = participants.length === 1;
        const leadMargin = sorted.length > 1 && isMVP
          ? sorted[0][1].score - sorted[1][1].score
          : 0;

        const answerPattern = data.answerPattern;
        const fastestAnswer = data.correctAnswerTimes.length > 0 ? Math.min(...data.correctAnswerTimes) : undefined;
        const averageTime = data.correctAnswerTimes.length > 0
          ? data.correctAnswerTimes.reduce((a, b) => a + b, 0) / data.correctAnswerTimes.length
          : undefined;

        const firstThreeCorrect = data.answerPattern.length >= 3 &&
          data.answerPattern.slice(0, 3).every(p => p === "对");
        const first5Wrong = data.answerPattern.slice(0, 5).filter(p => p === "错").length;
        const last3Correct = data.answerPattern.length >= 3 &&
          data.answerPattern.slice(-3).every(p => p === "对");
        const comebackPattern = { first5Wrong, last3Correct: last3Correct ? 3 : 0 };
        const wrongButMvp = isMVP && data.wrong >= 3;
        const zenPattern = game.currentTimeout > 0 &&
          data.correctAnswerTimes.length > 0 &&
          data.correctAnswerTimes.every(t => {
            const remaining = game.currentTimeout - t;
            return remaining >= 15 && remaining <= 20;
          });

        const tempSession = {
          ...session,
          userId: uid,
          username,
          send: async (msg: string) => {
            try {
              await session.bot.sendMessage(game.channelId, msg);
            } catch (err) {
              this.ctx.logger("sudoku").warn(`成就通知发送失败（uid=${uid}）：${err}`);
            }
          },
        } as any;

        await this.userService.checkAchievements(uid, {
          correct: data.correct,
          wrong: data.wrong,
          score: data.score,
          streak: data.maxStreak,
          answerPattern,
          fastestAnswer,
          averageTime,
          lastSecondAnswers: game.currentTimeout > 0 ? data.lastSecondCount : 0,
          firstThreeCorrect,
          comebackPattern,
          isAlone,
          leadMargin,
          wrongButMvp,
          zenPattern,
          prevConsecutiveLastPlace: prevConsecutiveLastPlaces.get(uid) ?? 0,
          isCurrentMvp: uid === mvpUserId,
        }, tempSession, updatedUsers.get(uid));
      }

      await this.userService.updateHonorTitles(game.guildId || "", session);
    } else {
      await session.send("本轮游戏无人参与，结束。");
    }
  }

  async setInactivityTimeout(session: Session, minutes: number) {
    if (!Number.isInteger(minutes) || minutes < 0) {
      await session.send("超时时长必须为非负整数（分钟），0 表示禁用。");
      return;
    }
    if (session.channelId && this.games.has(session.channelId)) {
      await session.send("游戏进行中无法更改超时设置，请先结束当前游戏。");
      return;
    }
    this.channelInactivityTimeout.set(this.getChannelKey(session), minutes);
    if (minutes === 0) {
      await session.send("已关闭无人参与自动结束功能。");
    } else {
      await session.send(`已设置本群无人参与自动结束时长为 ${minutes} 分钟。`);
    }
  }

  // ==================== 辅助方法 ====================

  // 林黛玉风格的无人参与超时播报语句
  private readonly LDY_TIMEOUT_MESSAGES = [
    "出了题目，等了许久，却无人应声……小仙这厢伤心，你们可知？（游戏已结束，呜呜）",
    "花谢花飞花满天，无人答题泪涟涟……既然没有人陪小仙玩，那便散了吧。（游戏已结束）",
    "良辰美景奈何天，题已出来无人怜……等了半天无人理，小仙只好独自散场。（游戏已结束）",
    "小仙精心出了一道题，竟等来满室寂寥，心里苦哟……（超时无人参与，游戏已结束）",
    "呜……侬今葬题知是谁？等了这许久无人应，小仙含泪收场。（游戏已结束）",
    "一灯如豆，孤题悬挂，却连一个来答的人都没有……小仙心如刀绞，就此别过。（游戏已结束）",
    "问君能有几多愁？出了题竟无人搭理，泪眼问花花不语，小仙伤心离去。（游戏已结束）",
  ];

  /**
   * 重置"无人参与"超时计时器。
   * 在每次出题和每次有玩家应答时调用，保证只要有人在线就不会触发超时结束。
   */
  private resetInactivityTimer(session: Session, game: GameState) {
    if (game.inactivityTimer) clearTimeout(game.inactivityTimer);
    game.inactivityTimer = null;
    if (game.currentInactivityTimeout <= 0) return;

    game.inactivityTimer = setTimeout(async () => {
      const currentGame = this.games.get(game.channelId);
      if (!currentGame || currentGame !== game) return;

      // ── 先删除游戏记录（与 stop() 的防并发写法一致），防止 stop() 在 await 期间
      //    仍能取到这局游戏，导致 endGame 被并发调用两次造成双重结算 ──
      this.games.delete(game.channelId);
      if (game.timer) { clearTimeout(game.timer); game.timer = null; }
      game.inactivityTimer = null;

      const msg = this.LDY_TIMEOUT_MESSAGES[
        Math.floor(Math.random() * this.LDY_TIMEOUT_MESSAGES.length)
      ];
      await session.send(msg);

      // 有参与者时才调 endGame 结算；无人参与时 LDY 播报即已完整说明，无需额外消息
      if (game.participants.size > 0) {
        await this.endGame(session, game, false);
      }
    }, game.currentInactivityTimeout * 60 * 1000);
  }

  /**
   * 多来源捕获用户昵称。
   *
   * 各来源说明：
   * 1. session.event.member.nick   —— Satori 标准的群成员昵称（QQ 群名片），随消息事件一起下发，不需要额外 API 调用
   * 2. session.event.user.name     —— Satori 标准的用户全局名称
   * 3. session.username            —— Koishi 封装的快捷属性，通常等于上面两者之一
   * 4. session.author.nickname     —— 部分适配器在 author 对象上暴露的昵称（OneBot 兼容层等）
   * 5. session.author.name         —— author 的 name 字段
   *
   * 返回第一个非空字符串；全部失败则返回空字符串，调用方应回退到 userId。
   */
  private captureUsername(session: Session): string {
    const candidates: unknown[] = [
      (session.event?.member as any)?.nick,
      (session.event?.user as any)?.name,
      session.username,
      (session.author as any)?.nickname,
      session.author?.name,
    ];
    return candidates.find(
      (n): n is string => typeof n === "string" && n.trim().length > 0,
    ) ?? "";
  }

  private getRandomMock(type: "groupMock" | "singleMock" | "trainingMock" | "trainingMockHard" | "trainingMockMax", params: Record<string, any>): string {
    const messages = this.mockMessages[type];
    const template = messages[Math.floor(Math.random() * messages.length)];
    return template.replace(/\{(\w+)\}/g, (_: string, key: string) => String(params[key] ?? ""));
  }

  /**
   * 从空格列表中按难度标准筛选最合适的目标格。
   *
   * 返回值说明：
   *   matched=true,  q=格  → 严格符合当前难度的目标格
   *   matched=false, q=格  → 无严格匹配，返回步骤数最接近目标区间的格（方案C兜底）
   *   matched=false, q=undefined → 无任何有效格（全部需要链类技巧，D1-D4 极罕见）
   *
   * 扫描策略：
   *   D1-D3：找到首个严格匹配即停止（减少计算量，盘面通常有大量符合格）
   *   D4-D6：累积至多3个严格匹配后停止（保留随机性），无严格匹配则方案C兜底
   */
  private pickTargetCell(
    puzzle: number[][],
    emptyCells: Array<{ row: number; col: number }>,
    difficulty: number,
  ): { q?: { row: number; col: number }; preSolveText?: string; matched: boolean } {
    const shuffled = shuffleArray([...emptyCells]);

    const strictMatches: Array<{ cell: { row: number; col: number }; solveText: string }> = [];
    const fallbackCells: Array<{
      cell: { row: number; col: number };
      solveText: string;
      pathLen: number;
    }> = [];

    for (const cell of shuffled) {
      let result: ReturnType<typeof solve>;
      try {
        result = solve(puzzle, cell.row, cell.col);
      } catch {
        continue;
      }
      if (!result.success) continue;

      // D1-D4：逐格排查链类技巧（D5-D6 由整题 checkPuzzleIntuitiveSolvable 保证无链）
      if (difficulty <= 4) {
        if ((result.steps as any[]).some((s) => CHAIN_TECHNIQUE_NAMES.has(s.technique))) {
          continue;
        }
      }

      const label = `${String.fromCharCode(65 + cell.row)}${cell.col + 1}`;
      const solveText = formatCompactSteps(result, label);
      const pathLen = result.steps.length;

      if (checkTargetDifficultyMatch(result.steps as any, difficulty)) {
        strictMatches.push({ cell, solveText });
        // D1-D3：首个匹配即停；D4-D6：积累3个后停（兼顾随机性与性能）
        const threshold = difficulty <= 3 ? 1 : 3;
        if (strictMatches.length >= threshold) break;
      } else {
        fallbackCells.push({ cell, solveText, pathLen });
      }
    }

    // ── 有严格匹配：随机取一个 ────────────────────────────────────────────────
    if (strictMatches.length > 0) {
      const chosen = strictMatches[Math.floor(Math.random() * strictMatches.length)];
      return { q: chosen.cell, preSolveText: chosen.solveText, matched: true };
    }

    // ── 无严格匹配：方案C——步骤数最接近目标区间的格 ─────────────────────────
    if (fallbackCells.length === 0) {
      return { matched: false }; // 无任何有效格（D1-D4 中极罕见）
    }

    const criteria = DIFFICULTY_TARGET_CRITERIA[difficulty];
    if (criteria) {
      // 向区间中点靠近（D6 也需遵守 maxSteps:20，不再偏向最长路径）
      const mid = (criteria.minSteps + Math.min(criteria.maxSteps, criteria.minSteps + 10)) / 2;
      fallbackCells.sort((a, b) => Math.abs(a.pathLen - mid) - Math.abs(b.pathLen - mid));
    }

    const best = fallbackCells[0];
    return { q: best.cell, preSolveText: best.solveText, matched: false };
  }

  // ══════════════════════════════════════════════════════
  // 唯余训练模式
  // ══════════════════════════════════════════════════════

  /** 开始唯余训练（指令入口） */
  async startTraining(session: Session, difficulty: number = 1): Promise<void> {
    const key = this.getTrainingChannelKey(session);
    if (!key) {
      await session.send("唯余训练暂不支持私聊，请在群组中使用。");
      return;
    }
    if (this.games.has(key)) {
      await session.send(`当前频道有正在进行的游戏，请先输入「${this.config.commandStop}」结束游戏后再开始唯余训练。`);
      return;
    }
    if (this.trainings.has(key)) {
      await session.send(`唯余训练已在进行中，输入「${this.config.commandTrainingStop}」可结束本轮训练。`);
      return;
    }

    const d = Math.min(Math.max(Math.floor(difficulty), 1), 6);

    // 自增本频道轮次计数器
    const round = (this.trainingRoundCounter.get(key) ?? 0) + 1;
    this.trainingRoundCounter.set(key, round);

    const ts: TrainingSession = {
      channelId: key,
      startTime: Date.now(),
      currentQuestion: null,
      currentQuestionIndex: 0,
      finishedQuestions: 0,
      participants: new Map(),
      difficulty: d,
      round,
      questionPool: [],
      poolNextQueuedIndex: 2,
      poolFilling: false,
    };
    this.trainings.set(key, ts);

    this.fillTrainingPool(ts);

    await session.send(
      `🎯 唯余训练【难度${d}】开始！\n首题生成时间较长，请默数 10 个数耐心等待！\n` +
      `盘面只能推出一个数字，找到它并填入！\n` +
      `输入「${this.config.commandTrainingStop}」可结束本轮训练并查看报告。`,
    );
    await this.nextTrainingQuestion(session, ts);
  }

  /** 结束唯余训练（指令入口） */
  async stopTraining(session: Session): Promise<void> {
    const key = this.getTrainingChannelKey(session);
    if (!key) return;
    const ts = this.trainings.get(key);
    if (!ts) {
      await session.send("当前没有正在进行的唯余训练。");
      return;
    }
    // 先从 map 中删除，阻止后续 handleTrainingAnswer 继续处理
    this.trainings.delete(key);
    await session.send("🏁 训练结束，正在生成报告……");
    await this.finishTraining(session, ts);
  }

  /** 处理训练阶段的用户答案 */
  async handleTrainingAnswer(session: Session, num: number): Promise<void> {
    if (!session.userId) return;
    const key = this.getTrainingChannelKey(session);
    if (!key) return;
    const ts = this.trainings.get(key);
    if (!ts || !ts.currentQuestion) return;

    const cq = ts.currentQuestion;
    const username = this.captureUsername(session) || session.userId;

    // 确保参与者记录存在
    if (!ts.participants.has(session.userId)) {
      ts.participants.set(session.userId, {
        userId: session.userId,
        username,
        correct: 0,
        wrong: 0,
        correctAnswers: [],
      });
    }
    const participant = ts.participants.get(session.userId)!;
    // 更新昵称（可能改过）
    participant.username = username;

    if (num !== cq.answer) {
      // 答错：记录连续答错次数，分级嘲讽，继续等待
      const attempts = (cq.wrongAttempts.get(session.userId) ?? 0) + 1;
      cq.wrongAttempts.set(session.userId, attempts);
      participant.wrong++;
      let mockType: "trainingMock" | "trainingMockHard" | "trainingMockMax";
      if (attempts >= 3) mockType = "trainingMockMax";
      else if (attempts === 2) mockType = "trainingMockHard";
      else mockType = "trainingMock";
      const mockMsg = this.getRandomMock(mockType, { user: username, attempts });
      await session.send(mockMsg);
      return;
    }

    // 答对 —— 防止同一玩家对同一题重复计分
    if (cq.correctAnswerers.has(session.userId)) return;
    cq.correctAnswerers.add(session.userId);

    const elapsed = Date.now() - cq.questionStartTime;
    participant.correct++;
    participant.correctAnswers.push({
      questionIndex: ts.currentQuestionIndex,
      elapsedMs: elapsed,
    });

    // 答对反馈：格式 "唯余:X 答对了！（XX.XX秒）"，精确到两位小数
    const secs = (elapsed / 1000).toFixed(2);
    await session.send(`唯余:${cq.answer} 答对了！（${secs}秒）`);

    // 检查训练是否已被停止（stopTraining 可能在 await 期间调用）
    if (!this.trainings.has(ts.channelId)) return;

    if (cq.transitioning) {
      // 已有玩家答对且正在过渡到下一题 —— 本次只记录时间/反馈，不重复推进
      return;
    }

    // 本题第一个正确答案：标记过渡状态，推进到下一题
    cq.transitioning = true;
    ts.finishedQuestions++;
    await this.nextTrainingQuestion(session, ts);
  }

  /**
   * 统计盘面中"唯余格"（仅剩1个候选数的空格）的数量。
   * 用于验证训练盘面中有且仅有1个格子可以被直接排除确定。
   */
  private countSoleCandidateCells(puzzle: number[][]): number {
    let count = 0;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (puzzle[r][c] !== 0) continue;
        const seen = new Set<number>();
        for (let cc = 0; cc < 9; cc++) if (puzzle[r][cc] !== 0) seen.add(puzzle[r][cc]);
        for (let rr = 0; rr < 9; rr++) if (puzzle[rr][c] !== 0) seen.add(puzzle[rr][c]);
        const br = Math.floor(r / 3) * 3;
        const bc = Math.floor(c / 3) * 3;
        for (let rr = br; rr < br + 3; rr++)
          for (let cc = bc; cc < bc + 3; cc++)
            if (puzzle[rr][cc] !== 0) seen.add(puzzle[rr][cc]);
        // 9 - seen.size === 候选数数量
        if (9 - seen.size === 1) count++;
      }
    }
    return count;
  }

  /**
   * 生成一道唯余训练盘面（单次）。
   * 随机选取目标格和答案，将其余8个数字放入同行/同列/同宫的8个随机peer格，
   * 保证目标格候选数恰好只剩答案。
   */
  private buildTrainingPuzzleOnce(): {
    puzzle: number[][];
    targetRow: number;
    targetCol: number;
    answer: number;
  } {
    const targetRow = Math.floor(Math.random() * 9);
    const targetCol = Math.floor(Math.random() * 9);
    const answer = Math.floor(Math.random() * 9) + 1;

    const peerSet = new Set<string>();
    const peers: Array<[number, number]> = [];
    const addPeer = (r: number, c: number) => {
      const key = `${r},${c}`;
      if ((r !== targetRow || c !== targetCol) && !peerSet.has(key)) {
        peerSet.add(key);
        peers.push([r, c]);
      }
    };
    for (let c = 0; c < 9; c++) addPeer(targetRow, c);   // 同行
    for (let r = 0; r < 9; r++) addPeer(r, targetCol);   // 同列
    const br = Math.floor(targetRow / 3) * 3;
    const bc = Math.floor(targetCol / 3) * 3;
    for (let r = br; r < br + 3; r++)                    // 同宫
      for (let c = bc; c < bc + 3; c++) addPeer(r, c);

    shuffleArray(peers);
    const selectedPeers = peers.slice(0, 8);
    const otherDigits = shuffleArray([1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => d !== answer));

    const puzzle: number[][] = Array.from({ length: 9 }, () => Array(9).fill(0));
    for (let i = 0; i < 8; i++) {
      puzzle[selectedPeers[i][0]][selectedPeers[i][1]] = otherDigits[i];
    }
    return { puzzle, targetRow, targetCol, answer };
  }

  /**
   * 生成一道唯余训练盘面，保证整张盘面有且仅有 1 个唯余格（即目标格）。
   * 避免玩家找到其他格的正确答案却被误判为答错。
   * 最多重试 30 次；极端情况（30次均失败）直接使用最后生成的盘面。
   */
  private generateTrainingPuzzle(): ReturnType<typeof this.buildTrainingPuzzleOnce> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = this.buildTrainingPuzzleOnce();
      if (this.countSoleCandidateCells(result.puzzle) === 1) {
        return result;
      }
    }
    // 极端兜底：直接使用（目标格本身一定是唯余的，极少出现其他唯余格）
    return this.buildTrainingPuzzleOnce();
  }

  // ─── 唯余训练难度2：带干扰项盘面生成 ─────────────────────────────────────────

  /**
   * 生成一道带干扰项的进阶唯余训练盘面（单次）。
   *
   * 干扰设计：
   *   1. 在目标格"看不到"的非peer格中放置答案数字（干扰视觉扫描）
   *   2. 额外随机散布 4-5 个合法数字（让盘面看起来更"满"）
   *   全程保证整张盘面仅 1 个唯余格（目标格），每步都回退验证。
   *
   * @returns 成功时返回盘面数据，若无法放置至少1个干扰答案数则返回 null（外层重试）
   */
  private buildAdvancedTrainingPuzzleOnce(): {
    puzzle: number[][];
    targetRow: number;
    targetCol: number;
    answer: number;
  } | null {
    // 必须用 generateTrainingPuzzle（而非 buildTrainingPuzzleOnce），
    // 确保基础盘面已经过 countSoleCandidateCells === 1 验证，
    // 否则后续的逐步回退检查会在"已有多个唯余格"的错误起点上运行。
    const base = this.generateTrainingPuzzle();
    const { targetRow, targetCol, answer } = base;
    const puzzle = base.puzzle.map((row) => [...row]);

    // 目标格所在宫的起始坐标
    const bTR = Math.floor(targetRow / 3) * 3;
    const bTC = Math.floor(targetCol / 3) * 3;

    /** 判断 (r,c) 是否为目标格的 peer（同行/同列/同宫） */
    const isPeer = (r: number, c: number): boolean =>
      r === targetRow || c === targetCol ||
      (r >= bTR && r < bTR + 3 && c >= bTC && c < bTC + 3);

    /** 获取 (r,c) 处当前合法可填的数字集合（不违反数独规则） */
    const getValidDigits = (r: number, c: number): Set<number> => {
      const seen = new Set<number>();
      for (let j = 0; j < 9; j++) {
        if (puzzle[r][j] !== 0) seen.add(puzzle[r][j]);
        if (puzzle[j][c] !== 0) seen.add(puzzle[j][c]);
      }
      const br = Math.floor(r / 3) * 3;
      const bc = Math.floor(c / 3) * 3;
      for (let rr = br; rr < br + 3; rr++)
        for (let cc = bc; cc < bc + 3; cc++)
          if (puzzle[rr][cc] !== 0) seen.add(puzzle[rr][cc]);
      const valid = new Set<number>();
      for (let d = 1; d <= 9; d++) if (!seen.has(d)) valid.add(d);
      return valid;
    };

    /**
     * 每次放置数字后的综合校验：
     * 1. 目标格仍以 answer 为唯一候选数（防止答案被"看见"导致目标格无解）
     * 2. 全盘无"死格"（0候选数的空格，放置错误会导致无解）
     * 3. 全盘恰好只有1个唯余格（即目标格）
     */
    const isValidPlacement = (): boolean => {
      const tc = getValidDigits(targetRow, targetCol);
      if (!tc.has(answer) || tc.size !== 1) return false;
      if (this.countSoleCandidateCells(puzzle) !== 1) return false;
      for (let rr = 0; rr < 9; rr++)
        for (let cc = 0; cc < 9; cc++) {
          if (puzzle[rr][cc] !== 0 || (rr === targetRow && cc === targetCol)) continue;
          if (getValidDigits(rr, cc).size === 0) return false;
        }
      return true;
    };

    // ── 第一步：在非 peer 格放置答案数（干扰项，最多放2个，至少成功1个）────────
    const nonPeerEmpties: [number, number][] = [];
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (puzzle[r][c] === 0 && !isPeer(r, c))
          nonPeerEmpties.push([r, c]);
    shuffleArray(nonPeerEmpties);

    let decoyCount = 0;
    for (const [r, c] of nonPeerEmpties) {
      if (decoyCount >= 2) break;
      if (!getValidDigits(r, c).has(answer)) continue;
      puzzle[r][c] = answer;
      if (isValidPlacement()) {
        decoyCount++;
      } else {
        puzzle[r][c] = 0;
      }
    }
    if (decoyCount === 0) return null; // 找不到可放干扰的非peer格，外层重试

    // ── 第二步：随机散布 4-5 个额外数字（增加盘面复杂度）────────────────────────
    const extraTarget = 4 + Math.floor(Math.random() * 2); // 4 或 5
    let extraCount = 0;

    const allEmpty: [number, number][] = [];
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (puzzle[r][c] === 0 && !(r === targetRow && c === targetCol))
          allEmpty.push([r, c]);
    shuffleArray(allEmpty);

    for (const [r, c] of allEmpty) {
      if (extraCount >= extraTarget) break;
      const valid = getValidDigits(r, c);
      if (valid.size === 0) continue;
      // peer 格不允许填入 answer（防止目标格候选数被消除）
      if (isPeer(r, c)) valid.delete(answer);
      if (valid.size === 0) continue;
      const digits = [...valid];
      const digit = digits[Math.floor(Math.random() * digits.length)];
      puzzle[r][c] = digit;
      if (isValidPlacement()) {
        extraCount++;
      } else {
        puzzle[r][c] = 0;
      }
    }

    return { puzzle, targetRow, targetCol, answer };
  }

  /**
   * 生成一道进阶唯余训练盘面，确保整张盘面有且仅有1个唯余格。
   * 最多重试50次，全部失败时退化为基础模式。
   */
  private generateAdvancedTrainingPuzzle(): ReturnType<typeof this.buildTrainingPuzzleOnce> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = this.buildAdvancedTrainingPuzzleOnce();
      if (result && this.countSoleCandidateCells(result.puzzle) === 1) {
        return result;
      }
    }
    // 极端兜底：退化为基础模式
    return this.generateTrainingPuzzle();
  }

  // ─── 干扰数字添加（D2-D6 通用）──────────────────────────────────────────────

  /**
   * 向已验证的训练盘面追加干扰数字。
   * 每追加一个数字立即验证唯一出数约束，不满足则撤销。
   * @param maxDecoys  目标答案数字的副本数上限（放在非peer区域）
   * @param maxExtras  额外随机数字上限
   */
  private addTrainingInterference(
    puzzle: number[][],
    TR: number, TC: number, answer: number,
    maxDecoys = 2, maxExtras = 5,
  ): void {
    const peerKey = (r: number, c: number) =>
      r === TR || c === TC ||
      (Math.floor(r / 3) * 3 === Math.floor(TR / 3) * 3 &&
       Math.floor(c / 3) * 3 === Math.floor(TC / 3) * 3);

    const empties: [number, number][] = [];
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (puzzle[r][c] === 0 && !(r === TR && c === TC))
          empties.push([r, c]);
    shuffleArray(empties);

    // 放目标数副本（非peer位置）
    let decoys = 0;
    for (const [r, c] of empties) {
      if (decoys >= maxDecoys) break;
      if (peerKey(r, c)) continue;
      if (!getValidDigitsAt(puzzle, r, c).has(answer)) continue;
      puzzle[r][c] = answer;
      if (isExactlyOneDeducibleCell(puzzle, TR, TC)) { decoys++; } else { puzzle[r][c] = 0; }
    }

    // 放随机额外数字
    let extras = 0;
    const allEmpties: [number, number][] = [];
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (puzzle[r][c] === 0 && !(r === TR && c === TC))
          allEmpties.push([r, c]);
    shuffleArray(allEmpties);

    for (const [r, c] of allEmpties) {
      if (extras >= maxExtras) break;
      const valid = getValidDigitsAt(puzzle, r, c);
      if (valid.size === 0) continue;
      const digit = [...valid][Math.floor(Math.random() * valid.size)];
      puzzle[r][c] = digit;
      if (isExactlyOneDeducibleCell(puzzle, TR, TC)) { extras++; } else { puzzle[r][c] = 0; }
    }
  }

  // ══════════════════════════════════════════════════════
  // 难度3：1区块唯余（显性 + 隐性 混合）
  // ══════════════════════════════════════════════════════

  /**
   * 构造D3显性唯余：1个指向区块排除目标格1个候选数 + 7个直接peer覆盖其余候选。
   *
   * 区块方向（指向排除）：
   *   源宫B（与目标格同行带、不同列带）内，数字D仅在目标格所在行TR有候选
   *   → D从TR行宫B以外的格消除 → 目标格(TR,TC)的D被消除
   *   构造手段：在源宫B的非TR行中（行r1,r2）各放1个D，使D在行r1/r2可见
   *             → 源宫B内r1/r2行格子的D被消除 → D锁在源宫B的TR行 → 区块形成
   */
  /**
   * 构造D3显性唯余（行列式区块排除）：
   *
   * 使用「行列式」（box-line reduction）：目标宫行带中选一行 lockRow（≠ TR），
   * 该行的数字 D 候选仅分布在目标宫列带内（targetBC 列带）。
   * → 行列式排除：目标宫内非 lockRow 行的 D 候选被消去，包括 (TR, TC)。
   * 配合7个直接peer排除其余7个候选数，(TR, TC) 仅余 A（显性唯余）。
   *
   * 构造手段：在所有6个非目标宫列带（共6列）分别放置 D，
   * 行不得为 TR 或 lockRow → lockRow 行中 D 只剩目标宫列带 → 行列式形成。
   */
  private buildD3NakedSingleOnce(): {
    puzzle: number[][];
    targetRow: number; targetCol: number; answer: number;
  } | null {
    const TR = Math.floor(Math.random() * 9);
    const TC = Math.floor(Math.random() * 9);
    const A  = Math.floor(Math.random() * 9) + 1;

    const targetBR = Math.floor(TR / 3) * 3;
    const targetBC = Math.floor(TC / 3) * 3;

    const others = shuffleArray([1,2,3,4,5,6,7,8,9].filter(d => d !== A));
    const D   = others[0];   // 通过行列式消去的候选数
    const rem7 = others.slice(1);

    // lockRow：目标宫行带内 ≠ TR 的一行（随机选一个）
    const nonTR = [targetBR, targetBR + 1, targetBR + 2].filter(r => r !== TR);
    const lockRow = nonTR[Math.floor(Math.random() * nonTR.length)];

    // 非目标宫列带共6列，各放一个 D（行不得为 TR 或 lockRow）
    const nonTargetBCCols = shuffleArray(
      [0,1,2,3,4,5,6,7,8].filter(c => c < targetBC || c > targetBC + 2)
    );
    const forbidRows = new Set([TR, lockRow]);

    const puzzle: number[][] = Array.from({length: 9}, () => Array(9).fill(0));
    for (const col of nonTargetBCCols) {
      const availRows = shuffleArray([0,1,2,3,4,5,6,7,8].filter(r => !forbidRows.has(r)));
      let placed = false;
      for (const r of availRows) {
        if (!getValidDigitsAt(puzzle, r, col).has(D)) continue;
        puzzle[r][col] = D; placed = true; break;
      }
      if (!placed) return null;
    }

    // 验证行列式已形成：lockRow 行中 D 只在目标宫列带有候选
    const candsCheck = computeCandidates(puzzle);
    for (let c = 0; c < 9; c++) {
      if (c >= targetBC && c <= targetBC + 2) continue;
      if (puzzle[lockRow][c] === 0 && candsCheck[lockRow][c].has(D)) return null;
    }
    // 目标宫列带在 lockRow 行中需有至少一个 D 候选（行列式才有意义）
    let lockHasD = false;
    for (let dc = 0; dc < 3; dc++) {
      if (puzzle[lockRow][targetBC + dc] === 0 && candsCheck[lockRow][targetBC + dc].has(D)) {
        lockHasD = true; break;
      }
    }
    if (!lockHasD) return null;

    // 放7个直接peer数字；排除 lockRow 在目标宫内的格（保护行列式）
    const peerSeen = new Set<string>();
    const peerList: [number, number][] = [];
    for (let c = 0; c < 9; c++)  if (c !== TC) peerList.push([TR, c]);
    for (let r = 0; r < 9; r++)  if (r !== TR && r !== lockRow) peerList.push([r, TC]);
    for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
      const r = targetBR + dr, c = targetBC + dc;
      if (r !== TR && c !== TC && r !== lockRow) peerList.push([r, c]);
    }
    const uniquePeers: [number, number][] = [];
    for (const [r, c] of peerList) {
      const k = `${r},${c}`;
      if (!peerSeen.has(k)) { peerSeen.add(k); uniquePeers.push([r, c]); }
    }
    shuffleArray(uniquePeers);

    for (const digit of rem7) {
      let ok = false;
      for (const [r, c] of uniquePeers) {
        if (puzzle[r][c] !== 0) continue;
        if (!getValidDigitsAt(puzzle, r, c).has(digit)) continue;
        puzzle[r][c] = digit; ok = true; break;
      }
      if (!ok) return null;
    }

    const cands = computeAdvancedCandidates(puzzle);
    if (!cands[TR][TC].has(A) || cands[TR][TC].size !== 1) return null;
    if (!isExactlyOneDeducibleCell(puzzle, TR, TC)) return null;

    this.addTrainingInterference(puzzle, TR, TC, A);
    return { puzzle, targetRow: TR, targetCol: TC, answer: A };
  }

  /**
   * 构造D3显性唯余（列向行列式）：与行向变体对称。
   *
   * 目标宫列带内选一列 lockCol（≠ TC），使该列的数字 D 候选仅在目标宫行带（targetBR 行带）。
   * → 列向行列式排除：目标宫内非 lockCol 列的 D 候选被消去，包括 (TR, TC)。
   * 配合7个直接peer排除其余7个候选数，(TR, TC) 仅余 A（显性唯余）。
   *
   * 构造手段：在所有6个非目标宫行带（共6行）分别放置 D（列 ≠ TC、≠ lockCol），
   * 使 lockCol 列非目标宫行带各行 D 均被消去 → 列向行列式形成。
   */
  private buildD3NakedSingleColOnce(): {
    puzzle: number[][];
    targetRow: number; targetCol: number; answer: number;
  } | null {
    const TR = Math.floor(Math.random() * 9);
    const TC = Math.floor(Math.random() * 9);
    const A  = Math.floor(Math.random() * 9) + 1;

    const targetBR = Math.floor(TR / 3) * 3;
    const targetBC = Math.floor(TC / 3) * 3;

    const others = shuffleArray([1,2,3,4,5,6,7,8,9].filter(d => d !== A));
    const D    = others[0];
    const rem7 = others.slice(1);

    // lockCol：目标宫列带内 ≠ TC 的一列
    const lockColOpts = [targetBC, targetBC + 1, targetBC + 2].filter(c => c !== TC);
    const lockCol = lockColOpts[Math.floor(Math.random() * lockColOpts.length)];

    // 在所有6个非目标宫行带的行里，各放一个 D（列 ≠ TC, ≠ lockCol）
    const nonTargetBRRows = shuffleArray(
      [0,1,2,3,4,5,6,7,8].filter(r => r < targetBR || r > targetBR + 2)
    );
    const forbidCols = new Set([TC, lockCol]);

    const puzzle: number[][] = Array.from({length: 9}, () => Array(9).fill(0));
    for (const row of nonTargetBRRows) {
      const availCols = shuffleArray([0,1,2,3,4,5,6,7,8].filter(c => !forbidCols.has(c)));
      let placed = false;
      for (const c of availCols) {
        if (!getValidDigitsAt(puzzle, row, c).has(D)) continue;
        puzzle[row][c] = D; placed = true; break;
      }
      if (!placed) return null;
    }

    // 验证列向行列式已形成：lockCol 列中 D 只在目标宫行带有候选
    const candsCheck = computeCandidates(puzzle);
    for (let r = 0; r < 9; r++) {
      if (r >= targetBR && r <= targetBR + 2) continue;
      if (puzzle[r][lockCol] === 0 && candsCheck[r][lockCol].has(D)) return null;
    }
    let lockHasD = false;
    for (let dr = 0; dr < 3; dr++) {
      if (puzzle[targetBR + dr][lockCol] === 0 && candsCheck[targetBR + dr][lockCol].has(D)) {
        lockHasD = true; break;
      }
    }
    if (!lockHasD) return null;

    // 放7个直接peer数字；排除 lockCol 在目标宫内的格（保护列向行列式）
    const peerSeen = new Set<string>();
    const peerList: [number, number][] = [];
    for (let c = 0; c < 9; c++)  if (c !== TC) peerList.push([TR, c]);
    for (let r = 0; r < 9; r++)  if (r !== TR) peerList.push([r, TC]);
    for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
      const r = targetBR + dr, c = targetBC + dc;
      if (r !== TR && c !== TC && c !== lockCol) peerList.push([r, c]);
    }
    const uniquePeers: [number, number][] = [];
    for (const [r, c] of peerList) {
      const k = `${r},${c}`;
      if (!peerSeen.has(k)) { peerSeen.add(k); uniquePeers.push([r, c]); }
    }
    shuffleArray(uniquePeers);

    for (const digit of rem7) {
      let ok = false;
      for (const [r, c] of uniquePeers) {
        if (puzzle[r][c] !== 0) continue;
        if (!getValidDigitsAt(puzzle, r, c).has(digit)) continue;
        puzzle[r][c] = digit; ok = true; break;
      }
      if (!ok) return null;
    }

    const cands = computeAdvancedCandidates(puzzle);
    if (!cands[TR][TC].has(A) || cands[TR][TC].size !== 1) return null;
    if (!isExactlyOneDeducibleCell(puzzle, TR, TC)) return null;

    this.addTrainingInterference(puzzle, TR, TC, A);
    return { puzzle, targetRow: TR, targetCol: TC, answer: A };
  }

  /**
   * 构造D3隐性唯余（行排除）：
   * 1个区块（列向指向排除）消除行TR某格的候选A + 7个直接A放置消除其余行TR格的A
   * → 行TR中只有目标格(TR,TC)可以填A
   *
   * 区块方向（列向指向排除）：
   *   源宫S（不同行带，与cBlocked同列带）内A的候选仅在cBlocked列
   *   → A从cBlocked列宫S以外的格消除 → (TR, cBlocked) 的A被消除
   *   构造手段：在源宫S的非cBlocked列格子，通过在其行/列外部放置A来消除S内A候选
   */
  private buildD3HiddenSingleRowOnce(): {
    puzzle: number[][];
    targetRow: number; targetCol: number; answer: number;
  } | null {
    const TR = Math.floor(Math.random() * 9);
    const TC = Math.floor(Math.random() * 9);
    const A  = Math.floor(Math.random() * 9) + 1;

    const targetBR = Math.floor(TR / 3) * 3;
    const targetBC = Math.floor(TC / 3) * 3;

    // 随机选一列 cBlocked（行TR中需要被区块封锁的格子的列）
    const rowCols = [0,1,2,3,4,5,6,7,8].filter(c => c !== TC);
    shuffleArray(rowCols);
    let cBlocked = -1;
    for (const c of rowCols) {
      const bc = Math.floor(c / 3) * 3;
      if (bc !== targetBC) { cBlocked = c; break; }
    }
    if (cBlocked === -1) return null;

    const srcBC = Math.floor(cBlocked / 3) * 3;

    // 源宫S：不同行带（行带 ≠ targetBR），与 cBlocked 同列带
    const srcBROptions = [0, 3, 6].filter(br => br !== targetBR);
    const srcBR = srcBROptions[Math.floor(Math.random() * srcBROptions.length)];

    const puzzle: number[][] = Array.from({length: 9}, () => Array(9).fill(0));

    // 源宫S内需要封锁A的格子（非cBlocked列的6格）
    // 封锁方法：在该格的行（源宫外）或列（源宫外）放置A
    const srcNonCCols = [srcBC, srcBC + 1, srcBC + 2].filter(c => c !== cBlocked);
    for (const col of srcNonCCols) {
      // 对该列的3个源宫行，逐一在源宫外的行放A来消除该列源宫格
      const rowsInSrc = [srcBR, srcBR + 1, srcBR + 2];
      // 找一个行外位置放A（只需让该列在源宫以外已有A即可）
      const outsideRows = [0,1,2,3,4,5,6,7,8].filter(r => r < srcBR || r > srcBR + 2);
      shuffleArray(outsideRows);
      let placed = false;
      for (const r of outsideRows) {
        if (r === TR) continue; // 不能放在目标行（会直接可见影响目标）
        if (getValidDigitsAt(puzzle, r, col).has(A)) {
          puzzle[r][col] = A; placed = true; break;
        }
      }
      if (!placed) return null;
    }

    // 验证：源宫S内A的候选仅在cBlocked列
    const candsCheck = computeCandidates(puzzle);
    let srcHasAOutsideCBlocked = false;
    for (let dr = 0; dr < 3; dr++)
      for (let dc = 0; dc < 3; dc++) {
        const r = srcBR + dr, c = srcBC + dc;
        if (c !== cBlocked && puzzle[r][c] === 0 && candsCheck[r][c].has(A)) {
          srcHasAOutsideCBlocked = true;
        }
      }
    if (srcHasAOutsideCBlocked) return null; // 区块未成功形成

    // 对行TR其余7格（≠TC, ≠cBlocked）逐一在其列或宫放A来封锁
    const otherRowCols = [0,1,2,3,4,5,6,7,8].filter(c => c !== TC && c !== cBlocked);
    for (const col of otherRowCols) {
      const cands2 = computeCandidates(puzzle);
      if (!cands2[TR][col].has(A)) continue; // 已经被封锁，无需处理
      // 在该列（行TR以外）找一个位置放A
      const colRows = [0,1,2,3,4,5,6,7,8].filter(r => r !== TR);
      shuffleArray(colRows);
      let placed = false;
      for (const r of colRows) {
        if (puzzle[r][col] !== 0) continue;
        if (!getValidDigitsAt(puzzle, r, col).has(A)) continue;
        puzzle[r][col] = A; placed = true; break;
      }
      if (!placed) {
        // 尝试在该格的宫内放A
        const brc = Math.floor(TR / 3) * 3, bcc = Math.floor(col / 3) * 3;
        let placedBox = false;
        const boxCells: [number,number][] = [];
        for (let dr = 0; dr < 3; dr++)
          for (let dc = 0; dc < 3; dc++)
            boxCells.push([brc + dr, bcc + dc]);
        shuffleArray(boxCells);
        for (const [r2, c2] of boxCells) {
          if (r2 === TR || puzzle[r2][c2] !== 0) continue;
          if (!getValidDigitsAt(puzzle, r2, c2).has(A)) continue;
          puzzle[r2][c2] = A; placedBox = true; break;
        }
        if (!placedBox) return null;
      }
    }

    // 验证行TR中只有(TR,TC)可以填A（隐性唯余·行）
    const candsF = computeAdvancedCandidates(puzzle);
    if (!candsF[TR][TC].has(A)) return null;
    for (let c = 0; c < 9; c++)
      if (c !== TC && puzzle[TR][c] === 0 && candsF[TR][c].has(A)) return null;

    if (!isExactlyOneDeducibleCell(puzzle, TR, TC)) return null;

    this.addTrainingInterference(puzzle, TR, TC, A);
    return { puzzle, targetRow: TR, targetCol: TC, answer: A };
  }

  /**
   * 构造D3隐性唯余（列排除）：与行排除对称，但在目标格所在列中寻找隐性唯余。
   */
  private buildD3HiddenSingleColOnce(): {
    puzzle: number[][];
    targetRow: number; targetCol: number; answer: number;
  } | null {
    const TR = Math.floor(Math.random() * 9);
    const TC = Math.floor(Math.random() * 9);
    const A  = Math.floor(Math.random() * 9) + 1;

    const targetBR = Math.floor(TR / 3) * 3;
    const targetBC = Math.floor(TC / 3) * 3;

    // 随机选一行 rBlocked（列TC中需要被区块封锁的格子的行）
    const colRows = [0,1,2,3,4,5,6,7,8].filter(r => r !== TR);
    shuffleArray(colRows);
    let rBlocked = -1;
    for (const r of colRows) {
      const br = Math.floor(r / 3) * 3;
      if (br !== targetBR) { rBlocked = r; break; }
    }
    if (rBlocked === -1) return null;

    const srcBR = Math.floor(rBlocked / 3) * 3;

    // 源宫S：不同列带，与 rBlocked 同行带
    const srcBCOptions = [0, 3, 6].filter(bc => bc !== targetBC);
    const srcBC = srcBCOptions[Math.floor(Math.random() * srcBCOptions.length)];

    const puzzle: number[][] = Array.from({length: 9}, () => Array(9).fill(0));

    // 源宫S内非rBlocked行的格子：在其列（宫外）放A
    const srcNonRRows = [srcBR, srcBR + 1, srcBR + 2].filter(r => r !== rBlocked);
    for (const row of srcNonRRows) {
      const colsInSrc = [srcBC, srcBC + 1, srcBC + 2];
      const outsideCols = [0,1,2,3,4,5,6,7,8].filter(c => c < srcBC || c > srcBC + 2);
      shuffleArray(outsideCols);
      let placed = false;
      for (const col of outsideCols) {
        if (col === TC) continue;
        if (getValidDigitsAt(puzzle, row, col).has(A)) {
          puzzle[row][col] = A; placed = true; break;
        }
      }
      if (!placed) return null;
    }

    const candsCheck = computeCandidates(puzzle);
    let srcHasAOutsideRBlocked = false;
    for (let dr = 0; dr < 3; dr++)
      for (let dc = 0; dc < 3; dc++) {
        const r = srcBR + dr, c = srcBC + dc;
        if (r !== rBlocked && puzzle[r][c] === 0 && candsCheck[r][c].has(A))
          srcHasAOutsideRBlocked = true;
      }
    if (srcHasAOutsideRBlocked) return null;

    // 封锁列TC其余行（≠TR, ≠rBlocked）
    const otherColRows = [0,1,2,3,4,5,6,7,8].filter(r => r !== TR && r !== rBlocked);
    for (const row of otherColRows) {
      const cands2 = computeCandidates(puzzle);
      if (!cands2[row][TC].has(A)) continue;
      const rowCols = [0,1,2,3,4,5,6,7,8].filter(c => c !== TC);
      shuffleArray(rowCols);
      let placed = false;
      for (const col of rowCols) {
        if (puzzle[row][col] !== 0) continue;
        if (!getValidDigitsAt(puzzle, row, col).has(A)) continue;
        puzzle[row][col] = A; placed = true; break;
      }
      if (!placed) {
        const brc = Math.floor(row / 3) * 3, bcc = Math.floor(TC / 3) * 3;
        let placedBox = false;
        const boxCells: [number,number][] = [];
        for (let dr = 0; dr < 3; dr++)
          for (let dc = 0; dc < 3; dc++) boxCells.push([brc + dr, bcc + dc]);
        shuffleArray(boxCells);
        for (const [r2, c2] of boxCells) {
          if (c2 === TC || puzzle[r2][c2] !== 0) continue;
          if (!getValidDigitsAt(puzzle, r2, c2).has(A)) continue;
          puzzle[r2][c2] = A; placedBox = true; break;
        }
        if (!placedBox) return null;
      }
    }

    const candsF = computeAdvancedCandidates(puzzle);
    if (!candsF[TR][TC].has(A)) return null;
    for (let r = 0; r < 9; r++)
      if (r !== TR && puzzle[r][TC] === 0 && candsF[r][TC].has(A)) return null;

    if (!isExactlyOneDeducibleCell(puzzle, TR, TC)) return null;

    this.addTrainingInterference(puzzle, TR, TC, A);
    return { puzzle, targetRow: TR, targetCol: TC, answer: A };
  }

  /** D3 单次构造：随机在显性唯余 / 隐性唯余行 / 隐性唯余列 三种形式中选一 */
  private buildD3PuzzleOnce(): {
    puzzle: number[][];
    targetRow: number; targetCol: number; answer: number;
  } | null {
    const type = Math.floor(Math.random() * 4);
    if (type === 0) return this.buildD3NakedSingleOnce();       // 行向行列式
    if (type === 1) return this.buildD3NakedSingleColOnce();    // 列向行列式（新变体）
    if (type === 2) return this.buildD3HiddenSingleRowOnce();
    return this.buildD3HiddenSingleColOnce();
  }

  private generateD3Puzzle(): { puzzle: number[][]; targetRow: number; targetCol: number; answer: number } {
    for (let i = 0; i < 200; i++) {
      const r = this.buildD3PuzzleOnce();
      if (r) return r;
    }
    throw new Error('D3 puzzle generation failed after 200 attempts');
  }

  // ══════════════════════════════════════════════════════
  // 难度4：双区块唯余
  // ══════════════════════════════════════════════════════

  /**
   * 构造D4显性唯余（双行列式区块排除）：
   *
   * 目标宫行带中两行 lockRow1、lockRow2（均≠TR），分别对 D1、D2 形成行列式：
   * 各自通过在所有6个非目标宫列带放置该数字（行不含 lockRowX 和 TR），
   * 使 lockRowX 行的 DX 候选仅剩目标宫列带。
   * 两次行列式排除各消去 (TR,TC) 一个候选数；配合6个直接peer，使 (TR,TC) 仅余 A。
   */
  private buildD4NakedSingleOnce(): {
    puzzle: number[][];
    targetRow: number; targetCol: number; answer: number;
  } | null {
    const TR = Math.floor(Math.random() * 9);
    const TC = Math.floor(Math.random() * 9);
    const A  = Math.floor(Math.random() * 9) + 1;

    const targetBR = Math.floor(TR / 3) * 3;
    const targetBC = Math.floor(TC / 3) * 3;

    const others = shuffleArray([1,2,3,4,5,6,7,8,9].filter(d => d !== A));
    const D1 = others[0], D2 = others[1];
    const rem6 = others.slice(2);

    // 目标宫行带中两个非TR行分别作为两个行列式的锁行
    const nonTR = [targetBR, targetBR + 1, targetBR + 2].filter(r => r !== TR);
    const lockRow1 = nonTR[0], lockRow2 = nonTR[1];

    const nonTargetBCCols = [0,1,2,3,4,5,6,7,8].filter(c => c < targetBC || c > targetBC + 2);

    const puzzle: number[][] = Array.from({length: 9}, () => Array(9).fill(0));

    // 构造 D1 的行列式（禁止行：TR 和 lockRow1）
    for (const col of shuffleArray([...nonTargetBCCols])) {
      const forbid = new Set([TR, lockRow1]);
      const availRows = shuffleArray([0,1,2,3,4,5,6,7,8].filter(r => !forbid.has(r)));
      let placed = false;
      for (const r of availRows) {
        if (!getValidDigitsAt(puzzle, r, col).has(D1)) continue;
        puzzle[r][col] = D1; placed = true; break;
      }
      if (!placed) return null;
    }

    // 构造 D2 的行列式（禁止行：TR 和 lockRow2）
    for (const col of shuffleArray([...nonTargetBCCols])) {
      const forbid = new Set([TR, lockRow2]);
      const availRows = shuffleArray([0,1,2,3,4,5,6,7,8].filter(r => !forbid.has(r)));
      let placed = false;
      for (const r of availRows) {
        if (!getValidDigitsAt(puzzle, r, col).has(D2)) continue;
        puzzle[r][col] = D2; placed = true; break;
      }
      if (!placed) return null;
    }

    // 验证两个行列式均已形成
    const candsCheck = computeCandidates(puzzle);
    for (const [Di, lockRow] of [[D1, lockRow1], [D2, lockRow2]] as [number, number][]) {
      for (let c = 0; c < 9; c++) {
        if (c >= targetBC && c <= targetBC + 2) continue;
        if (puzzle[lockRow][c] === 0 && candsCheck[lockRow][c].has(Di)) return null;
      }
      let hasD = false;
      for (let dc = 0; dc < 3; dc++) {
        if (puzzle[lockRow][targetBC + dc] === 0 && candsCheck[lockRow][targetBC + dc].has(Di)) {
          hasD = true; break;
        }
      }
      if (!hasD) return null;
    }

    // 放6个直接peer数字；排除 lockRow1/lockRow2 在目标宫内的格（保护行列式）
    const peerSeen = new Set<string>();
    const peerList: [number, number][] = [];
    for (let c = 0; c < 9; c++) if (c !== TC) peerList.push([TR, c]);
    for (let r = 0; r < 9; r++) {
      if (r !== TR && r !== lockRow1 && r !== lockRow2) peerList.push([r, TC]);
    }
    for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
      const r = targetBR + dr, c = targetBC + dc;
      if (r !== TR && c !== TC && r !== lockRow1 && r !== lockRow2) peerList.push([r, c]);
    }
    const uniquePeers: [number, number][] = [];
    for (const [r, c] of peerList) {
      const k = `${r},${c}`;
      if (!peerSeen.has(k)) { peerSeen.add(k); uniquePeers.push([r, c]); }
    }
    shuffleArray(uniquePeers);

    for (const digit of rem6) {
      let ok = false;
      for (const [r, c] of uniquePeers) {
        if (puzzle[r][c] !== 0) continue;
        if (!getValidDigitsAt(puzzle, r, c).has(digit)) continue;
        puzzle[r][c] = digit; ok = true; break;
      }
      if (!ok) return null;
    }

    const cands = computeAdvancedCandidates(puzzle);
    if (!cands[TR][TC].has(A) || cands[TR][TC].size !== 1) return null;
    if (!isExactlyOneDeducibleCell(puzzle, TR, TC)) return null;

    this.addTrainingInterference(puzzle, TR, TC, A);
    return { puzzle, targetRow: TR, targetCol: TC, answer: A };
  }

  /**
   * 构造D4显性唯余（双列向行列式）：与行向变体对称。
   *
   * 目标宫列带内选两列 lockCol1、lockCol2（均 ≠ TC，互不相同，恰好是 targetBC 带内除 TC 外的两列），
   * 分别使 D1、D2 通过列向行列式消去目标格候选，配合6个peer，(TR,TC) 仅余 A。
   *
   * 构造：对 D1/D2 各自在6个非目标宫行带行放置（列 ≠ TC、≠ 对应 lockCol），
   * 使 lockCol1 列和 lockCol2 列的 D1/D2 候选均被锁定在目标宫行带内。
   */
  private buildD4NakedSingleColOnce(): {
    puzzle: number[][];
    targetRow: number; targetCol: number; answer: number;
  } | null {
    const TR = Math.floor(Math.random() * 9);
    const TC = Math.floor(Math.random() * 9);
    const A  = Math.floor(Math.random() * 9) + 1;

    const targetBR = Math.floor(TR / 3) * 3;
    const targetBC = Math.floor(TC / 3) * 3;

    const others = shuffleArray([1,2,3,4,5,6,7,8,9].filter(d => d !== A));
    const D1   = others[0];
    const D2   = others[1];
    const rem6 = others.slice(2);

    // lockCol1 和 lockCol2 是 targetBC 列带内 ≠ TC 的两列（恰好2个）
    const lockCols = [targetBC, targetBC + 1, targetBC + 2].filter(c => c !== TC);
    if (lockCols.length < 2) return null;
    const lockCol1 = lockCols[0], lockCol2 = lockCols[1];

    // 6个非目标宫行带的行
    const nonTargetBRRows = [0,1,2,3,4,5,6,7,8].filter(r => r < targetBR || r > targetBR + 2);

    const puzzle: number[][] = Array.from({length: 9}, () => Array(9).fill(0));

    // D1 列向行列式：在每个非目标宫行带行放 D1（列 ≠ TC, ≠ lockCol1）
    for (const row of shuffleArray([...nonTargetBRRows])) {
      const availCols = shuffleArray([0,1,2,3,4,5,6,7,8].filter(c => c !== TC && c !== lockCol1));
      let placed = false;
      for (const c of availCols) {
        if (!getValidDigitsAt(puzzle, row, c).has(D1)) continue;
        puzzle[row][c] = D1; placed = true; break;
      }
      if (!placed) return null;
    }

    // D2 列向行列式：在每个非目标宫行带行放 D2（列 ≠ TC, ≠ lockCol2）
    for (const row of shuffleArray([...nonTargetBRRows])) {
      const availCols = shuffleArray([0,1,2,3,4,5,6,7,8].filter(c => c !== TC && c !== lockCol2));
      let placed = false;
      for (const c of availCols) {
        if (!getValidDigitsAt(puzzle, row, c).has(D2)) continue;
        puzzle[row][c] = D2; placed = true; break;
      }
      if (!placed) return null;
    }

    // 验证两个列向行列式均形成
    const candsCheck = computeCandidates(puzzle);
    for (const [Di, lockCol] of [[D1, lockCol1], [D2, lockCol2]] as [number, number][]) {
      for (let r = 0; r < 9; r++) {
        if (r >= targetBR && r <= targetBR + 2) continue;
        if (puzzle[r][lockCol] === 0 && candsCheck[r][lockCol].has(Di)) return null;
      }
      let hasD = false;
      for (let dr = 0; dr < 3; dr++) {
        if (puzzle[targetBR + dr][lockCol] === 0 && candsCheck[targetBR + dr][lockCol].has(Di)) {
          hasD = true; break;
        }
      }
      if (!hasD) return null;
    }

    // 放6个直接peer数字；排除目标宫内 lockCol1 和 lockCol2 列的格（保护行列式）
    const lockColSet = new Set([lockCol1, lockCol2]);
    const peerSeen  = new Set<string>();
    const peerList: [number, number][] = [];
    for (let c = 0; c < 9; c++) if (c !== TC) peerList.push([TR, c]);
    for (let r = 0; r < 9; r++) if (r !== TR) peerList.push([r, TC]);
    for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
      const r = targetBR + dr, c = targetBC + dc;
      if (r !== TR && c !== TC && !lockColSet.has(c)) peerList.push([r, c]);
    }
    const uniquePeers: [number, number][] = [];
    for (const [r, c] of peerList) {
      const k = `${r},${c}`;
      if (!peerSeen.has(k)) { peerSeen.add(k); uniquePeers.push([r, c]); }
    }
    shuffleArray(uniquePeers);

    for (const digit of rem6) {
      let ok = false;
      for (const [r, c] of uniquePeers) {
        if (puzzle[r][c] !== 0) continue;
        if (!getValidDigitsAt(puzzle, r, c).has(digit)) continue;
        puzzle[r][c] = digit; ok = true; break;
      }
      if (!ok) return null;
    }

    const cands = computeAdvancedCandidates(puzzle);
    if (!cands[TR][TC].has(A) || cands[TR][TC].size !== 1) return null;
    if (!isExactlyOneDeducibleCell(puzzle, TR, TC)) return null;

    this.addTrainingInterference(puzzle, TR, TC, A);
    return { puzzle, targetRow: TR, targetCol: TC, answer: A };
  }

  /**
   * D4隐性唯余（行排除）：2个独立的列向区块各封锁行TR中1格的候选A + 6个直接A放置封锁其余6格。
   */
  private buildD4HiddenSingleRowOnce(): {
    puzzle: number[][];
    targetRow: number; targetCol: number; answer: number;
  } | null {
    const TR = Math.floor(Math.random() * 9);
    const TC = Math.floor(Math.random() * 9);
    const A  = Math.floor(Math.random() * 9) + 1;

    const targetBR = Math.floor(TR / 3) * 3;
    const targetBC = Math.floor(TC / 3) * 3;

    // 选2个不同列（不同列带，均不是TC所在列带）作为2个区块封锁目标
    const nonTargetBCs = [0, 3, 6].filter(bc => bc !== targetBC);
    if (nonTargetBCs.length < 2) return null;
    const [bc1, bc2] = nonTargetBCs;

    // 各选一列作为 cBlocked1/cBlocked2
    const bc1Cols = shuffleArray([bc1, bc1 + 1, bc1 + 2]);
    const bc2Cols = shuffleArray([bc2, bc2 + 1, bc2 + 2]);
    const cBlocked1 = bc1Cols[0];
    const cBlocked2 = bc2Cols[0];

    // 2个源宫（不同行带）
    const srcBROptions = [0, 3, 6].filter(br => br !== targetBR);
    if (srcBROptions.length < 1) return null;
    const srcBR1 = srcBROptions[Math.floor(Math.random() * srcBROptions.length)];
    const srcBR2Options = srcBROptions.filter(br => br !== srcBR1);
    const srcBR2 = srcBR2Options.length > 0
      ? srcBR2Options[Math.floor(Math.random() * srcBR2Options.length)]
      : srcBR1;

    const puzzle: number[][] = Array.from({length: 9}, () => Array(9).fill(0));

    // 封锁区块1：源宫1（srcBR1, bc1）内A的非cBlocked1列格子在列外放A
    const buildBlock = (srcBR: number, srcBC_: number, cBlk: number): boolean => {
      const nonBlkCols = [srcBC_, srcBC_ + 1, srcBC_ + 2].filter(c => c !== cBlk);
      for (const col of nonBlkCols) {
        const outsideRows = [0,1,2,3,4,5,6,7,8].filter(r => r < srcBR || r > srcBR + 2);
        shuffleArray(outsideRows);
        let ok = false;
        for (const r of outsideRows) {
          if (r === TR) continue;
          if (getValidDigitsAt(puzzle, r, col).has(A)) { puzzle[r][col] = A; ok = true; break; }
        }
        if (!ok) return false;
      }
      return true;
    };

    if (!buildBlock(srcBR1, bc1, cBlocked1)) return null;
    if (!buildBlock(srcBR2, bc2, cBlocked2)) return null;

    // 封锁行TR其余格（≠TC, ≠cBlocked1, ≠cBlocked2）
    const otherCols = [0,1,2,3,4,5,6,7,8].filter(c => c !== TC && c !== cBlocked1 && c !== cBlocked2);
    for (const col of otherCols) {
      const cands2 = computeCandidates(puzzle);
      if (!cands2[TR][col].has(A)) continue;
      const opts = shuffleArray([0,1,2,3,4,5,6,7,8].filter(r => r !== TR));
      let placed = false;
      for (const r of opts) {
        if (puzzle[r][col] !== 0 || !getValidDigitsAt(puzzle, r, col).has(A)) continue;
        puzzle[r][col] = A; placed = true; break;
      }
      if (!placed) return null;
    }

    const candsF = computeAdvancedCandidates(puzzle);
    if (!candsF[TR][TC].has(A)) return null;
    for (let c = 0; c < 9; c++)
      if (c !== TC && puzzle[TR][c] === 0 && candsF[TR][c].has(A)) return null;

    if (!isExactlyOneDeducibleCell(puzzle, TR, TC)) return null;

    this.addTrainingInterference(puzzle, TR, TC, A);
    return { puzzle, targetRow: TR, targetCol: TC, answer: A };
  }

  private buildD4PuzzleOnce(): {
    puzzle: number[][];
    targetRow: number; targetCol: number; answer: number;
  } | null {
    const type = Math.floor(Math.random() * 4);
    if (type === 0) return this.buildD4NakedSingleOnce();       // 行向双行列式
    if (type === 1) return this.buildD4NakedSingleColOnce();    // 列向双行列式（新变体）
    if (type === 2) return this.buildD4HiddenSingleRowOnce();
    return this.buildD4HiddenSingleRowOnce();
  }

  private generateD4Puzzle(): { puzzle: number[][]; targetRow: number; targetCol: number; answer: number } {
    for (let i = 0; i < 200; i++) {
      const r = this.buildD4PuzzleOnce();
      if (r) return r;
    }
    throw new Error('D4 puzzle generation failed after 200 attempts');
  }

  // ══════════════════════════════════════════════════════
  // 难度5：显性数对 → 1个区块 → 唯余
  // ══════════════════════════════════════════════════════

  /**
   * D5构造（隐性唯余·行）：
   * 1. 选一源宫S（不同行带，列带含cBlocked）
   * 2. 源宫S内，A仅在cBlocked列有候选
   *    其中：对某一非cBlocked列中的某行格 (rPair, cPairInBox)，A被排除原因是【数对占位】
   *          另一非cBlocked列的格子：通过外部已知A直接封锁
   * 3. 数对 {P,Q} 在列cPairInBox的两格（rPair在源宫内，rPartner在源宫外）
   *    → 使 (rPair, cPairInBox) 只剩候选 {P,Q}（不含A）
   * 4. 源宫S因A仅在cBlocked列 → 列向区块 → A从cBlocked列宫S以外的格消除
   * 5. 行TR其余格通过6个直接A封锁 → (TR,TC) 隐性唯余
   */
  private buildD5PuzzleOnce(): {
    puzzle: number[][];
    targetRow: number; targetCol: number; answer: number;
  } | null {
    const TR = Math.floor(Math.random() * 9);
    const TC = Math.floor(Math.random() * 9);
    const A  = Math.floor(Math.random() * 9) + 1;

    const targetBR = Math.floor(TR / 3) * 3;
    const targetBC = Math.floor(TC / 3) * 3;

    // 选cBlocked（源自非targetBC列带）
    const nonTargetBCs = [0, 3, 6].filter(bc => bc !== targetBC);
    if (nonTargetBCs.length === 0) return null;
    const srcBCIdx = Math.floor(Math.random() * nonTargetBCs.length);
    const srcBC = nonTargetBCs[srcBCIdx];
    const srcBCCols = [srcBC, srcBC + 1, srcBC + 2];
    shuffleArray(srcBCCols);
    const cBlocked = srcBCCols[0];
    const nonCBlkCols = srcBCCols.slice(1); // 2个非cBlocked列

    // 源宫行带（不同于targetBR）
    const srcBROptions = [0, 3, 6].filter(br => br !== targetBR);
    const srcBR = srcBROptions[Math.floor(Math.random() * srcBROptions.length)];

    // 数对配置
    const digitsNonA = shuffleArray([1,2,3,4,5,6,7,8,9].filter(d => d !== A));
    const P = digitsNonA[0], Q = digitsNonA[1];

    // 数对列：选 nonCBlkCols[0] 作为放数对的列（cPairInBox）
    const cPairInBox = nonCBlkCols[0];
    const cOtherInBox = nonCBlkCols[1]; // 另一非cBlocked列，直接外部A封锁

    // 数对行：在源宫行带中选一行作为 rPair（数对在源宫内的那个格）
    const srcRows = shuffleArray([srcBR, srcBR + 1, srcBR + 2]);
    const rPair = srcRows[0];

    const puzzle: number[][] = Array.from({length: 9}, () => Array(9).fill(0));

    // 封锁cOtherInBox列源宫格：在列cOtherInBox的宫外行放A
    const cOtherOutsideRows = shuffleArray([0,1,2,3,4,5,6,7,8].filter(r => r < srcBR || r > srcBR + 2));
    let placedCOther = false;
    for (const r of cOtherOutsideRows) {
      if (r === TR) continue;
      if (getValidDigitsAt(puzzle, r, cOtherInBox).has(A)) {
        puzzle[r][cOtherInBox] = A; placedCOther = true; break;
      }
    }
    if (!placedCOther) return null;

    // 构造数对：使 (rPair, cPairInBox) 候选数仅剩 {P,Q}
    // 需要在其peer（行rPair、列cPairInBox、源宫S）内放置A和其他5个数（除P,Q外）
    const toElim = [1,2,3,4,5,6,7,8,9].filter(d => d !== P && d !== Q);
    // 先放A（通过在rPair行宫外或列cPairInBox宫外放A）
    // 确保A不在rPair行（否则会影响源宫内cBlocked列的A）
    // 用列cPairInBox宫外放A来消除 (rPair, cPairInBox) 的A
    const pairColOutsideRows = shuffleArray([0,1,2,3,4,5,6,7,8].filter(r => r < srcBR || r > srcBR + 2));
    let placedAPairCol = false;
    for (const r of pairColOutsideRows) {
      if (r === TR) continue;
      if (getValidDigitsAt(puzzle, r, cPairInBox).has(A)) {
        puzzle[r][cPairInBox] = A; placedAPairCol = true; break;
      }
    }
    if (!placedAPairCol) return null;

    // 放另外5个非P非Q的数到 (rPair, cPairInBox) 的peer
    const remainElim = toElim.filter(d => d !== A);
    const pairPeers: [number, number][] = [];
    for (let c = 0; c < 9; c++) if (c !== cPairInBox) pairPeers.push([rPair, c]);
    for (let r = 0; r < 9; r++) if (r !== rPair) pairPeers.push([r, cPairInBox]);
    const pairBR = Math.floor(rPair / 3) * 3, pairBC = Math.floor(cPairInBox / 3) * 3;
    for (let dr = 0; dr < 3; dr++)
      for (let dc = 0; dc < 3; dc++) {
        const r = pairBR + dr, c = pairBC + dc;
        if (r !== rPair && c !== cPairInBox) pairPeers.push([r, c]);
      }
    shuffleArray(pairPeers);

    const usedPairPeers = new Set<string>();
    for (const d of remainElim) {
      let ok = false;
      for (const [r, c] of pairPeers) {
        if (usedPairPeers.has(`${r},${c}`) || puzzle[r][c] !== 0) continue;
        if (!getValidDigitsAt(puzzle, r, c).has(d)) continue;
        puzzle[r][c] = d; usedPairPeers.add(`${r},${c}`); ok = true; break;
      }
      if (!ok) return null;
    }

    // 验证 (rPair, cPairInBox) 候选数 = {P,Q}
    const pairCands = computeCandidates(puzzle);
    const pc = pairCands[rPair][cPairInBox];
    if (pc.size !== 2 || !pc.has(P) || !pc.has(Q)) return null;

    // 添加数对伙伴格（同行或同列同宫中另一格也有候选{P,Q}，构成合法数对）
    // 数对在列cPairInBox中：找另一行（宫外）的格，候选也仅{P,Q}
    const partnerRows = shuffleArray([0,1,2,3,4,5,6,7,8].filter(r => r !== rPair));
    let partnerPlaced = false;
    for (const rPartner of partnerRows) {
      if (puzzle[rPartner][cPairInBox] !== 0) continue;
      const partCands = computeCandidates(puzzle);
      const partC = partCands[rPartner][cPairInBox];
      if (partC.size === 2 && partC.has(P) && partC.has(Q)) {
        partnerPlaced = true; break; // 已自然形成数对
      }
      // 尝试在 rPartner 行放入A和其他数，使 (rPartner,cPairInBox) 候选仅{P,Q}
      const toElimPartner = [1,2,3,4,5,6,7,8,9].filter(d => d !== P && d !== Q);
      const partnerPeers: [number,number][] = [];
      for (let c = 0; c < 9; c++) if (c !== cPairInBox) partnerPeers.push([rPartner, c]);
      for (let r = 0; r < 9; r++) if (r !== rPartner) partnerPeers.push([r, cPairInBox]);
      const pBR = Math.floor(rPartner / 3) * 3, pBC = Math.floor(cPairInBox / 3) * 3;
      for (let dr = 0; dr < 3; dr++)
        for (let dc = 0; dc < 3; dc++) {
          const r = pBR + dr, c = pBC + dc;
          if (r !== rPartner && c !== cPairInBox) partnerPeers.push([r, c]);
        }
      shuffleArray(partnerPeers);
      const savedPuzzle = puzzle.map(row => [...row]);
      const usedPP = new Set<string>();
      let elimFailed = false;
      for (const d of toElimPartner) {
        if (computeCandidates(puzzle)[rPartner][cPairInBox].has(d)) {
          let ok2 = false;
          for (const [r2, c2] of partnerPeers) {
            if (usedPP.has(`${r2},${c2}`) || puzzle[r2][c2] !== 0) continue;
            if (!getValidDigitsAt(puzzle, r2, c2).has(d)) continue;
            puzzle[r2][c2] = d; usedPP.add(`${r2},${c2}`); ok2 = true; break;
          }
          if (!ok2) { elimFailed = true; break; }
        }
      }
      if (elimFailed) {
        // 回滚
        for (let r = 0; r < 9; r++) puzzle[r] = savedPuzzle[r];
        continue;
      }
      const newCands = computeCandidates(puzzle);
      if (newCands[rPartner][cPairInBox].size === 2 &&
          newCands[rPartner][cPairInBox].has(P) &&
          newCands[rPartner][cPairInBox].has(Q)) {
        partnerPlaced = true; break;
      }
      // 回滚
      for (let r = 0; r < 9; r++) puzzle[r] = savedPuzzle[r];
    }
    if (!partnerPlaced) return null;

    // 验证区块：源宫S内A仅在cBlocked列
    const candsBlockCheck = computeCandidates(puzzle);
    for (let dr = 0; dr < 3; dr++)
      for (let dc = 0; dc < 3; dc++) {
        const r = srcBR + dr, c = srcBC + dc;
        if (c !== cBlocked && puzzle[r][c] === 0 && candsBlockCheck[r][c].has(A)) return null;
      }

    // 封锁行TR其余格（≠TC, ≠cBlocked）
    const otherRowCols = [0,1,2,3,4,5,6,7,8].filter(c => c !== TC && c !== cBlocked);
    for (const col of otherRowCols) {
      const cands2 = computeCandidates(puzzle);
      if (!cands2[TR][col].has(A)) continue;
      const opts = shuffleArray([0,1,2,3,4,5,6,7,8].filter(r => r !== TR));
      let placed = false;
      for (const r of opts) {
        if (puzzle[r][col] !== 0 || !getValidDigitsAt(puzzle, r, col).has(A)) continue;
        puzzle[r][col] = A; placed = true; break;
      }
      if (!placed) return null;
    }

    const candsF = computeAdvancedCandidates(puzzle);
    if (!candsF[TR][TC].has(A)) return null;
    for (let c = 0; c < 9; c++)
      if (c !== TC && puzzle[TR][c] === 0 && candsF[TR][c].has(A)) return null;

    if (!isExactlyOneDeducibleCell(puzzle, TR, TC)) return null;

    this.addTrainingInterference(puzzle, TR, TC, A, 1, 3);
    return { puzzle, targetRow: TR, targetCol: TC, answer: A };
  }

  /**
   * D5构造变体：横向数对（Row Pair）
   *
   * 与纵向数对变体对称。数对 {P,Q} 横向分布在源宫同一行 rPair 的两个非cBlocked列
   * (cPair1, cPair2) 中，两格均在源宫内。
   *
   * 布局差异：纵向数对两格上下排列，横向数对两格左右并排，产生不同视觉形态。
   * 区块形成机制相同：列向行列式使 A 仅在 cBlocked 列有候选 → 行 TR 隐性唯余。
   */
  private buildD5RowPairOnce(): {
    puzzle: number[][];
    targetRow: number; targetCol: number; answer: number;
  } | null {
    const TR = Math.floor(Math.random() * 9);
    const TC = Math.floor(Math.random() * 9);
    const A  = Math.floor(Math.random() * 9) + 1;

    const targetBR = Math.floor(TR / 3) * 3;
    const targetBC = Math.floor(TC / 3) * 3;

    // 选源宫（不同行带、不同列带）
    const nonTargetBCs = [0, 3, 6].filter(bc => bc !== targetBC);
    if (nonTargetBCs.length === 0) return null;
    const srcBC = nonTargetBCs[Math.floor(Math.random() * nonTargetBCs.length)];
    const srcBCCols = shuffleArray([srcBC, srcBC + 1, srcBC + 2]);
    const cBlocked = srcBCCols[0];
    const cPair1   = srcBCCols[1]; // 横向数对的两列
    const cPair2   = srcBCCols[2];

    const srcBROptions = [0, 3, 6].filter(br => br !== targetBR);
    const srcBR = srcBROptions[Math.floor(Math.random() * srcBROptions.length)];

    // 数对配置
    const digitsNonA = shuffleArray([1,2,3,4,5,6,7,8,9].filter(d => d !== A));
    const P = digitsNonA[0], Q = digitsNonA[1];

    // rPair：横向数对所在行（在源宫行带内）
    const srcRows = shuffleArray([srcBR, srcBR + 1, srcBR + 2]);
    const rPair = srcRows[0];

    const puzzle: number[][] = Array.from({length: 9}, () => Array(9).fill(0));

    // 分别在 cPair1 和 cPair2 列宫外放 A，消除源宫这两列中 A 的候选
    for (const col of [cPair1, cPair2]) {
      const outsideRows = shuffleArray([0,1,2,3,4,5,6,7,8].filter(r => r < srcBR || r > srcBR + 2));
      let placed = false;
      for (const r of outsideRows) {
        if (r === TR) continue;
        if (getValidDigitsAt(puzzle, r, col).has(A)) {
          puzzle[r][col] = A; placed = true; break;
        }
      }
      if (!placed) return null;
    }

    // 构造横向数对：使 (rPair, cPair1) 和 (rPair, cPair2) 候选均仅剩 {P, Q}
    // 两格同行同宫，共享行 peer 和宫 peer；优先用行 peer 同时消去两格中的候选数字
    const toElim = [1,2,3,4,5,6,7,8,9].filter(d => d !== P && d !== Q);

    // 合并两个数对格的 peer 集合（去重）
    const peerSeen = new Set<string>();
    const combinedPeers: [number, number][] = [];
    // 行 peer（同时对两格有效）
    for (let c = 0; c < 9; c++) {
      if (c !== cPair1 && c !== cPair2) {
        const k = `${rPair},${c}`;
        if (!peerSeen.has(k)) { peerSeen.add(k); combinedPeers.push([rPair, c]); }
      }
    }
    // cPair1 列 peer
    for (let r = 0; r < 9; r++) {
      if (r !== rPair) {
        const k = `${r},${cPair1}`;
        if (!peerSeen.has(k)) { peerSeen.add(k); combinedPeers.push([r, cPair1]); }
      }
    }
    // cPair2 列 peer
    for (let r = 0; r < 9; r++) {
      if (r !== rPair) {
        const k = `${r},${cPair2}`;
        if (!peerSeen.has(k)) { peerSeen.add(k); combinedPeers.push([r, cPair2]); }
      }
    }
    // 源宫宫 peer（非 rPair 行、非 cPair1/cPair2 列）
    for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
      const r = srcBR + dr, c = srcBC + dc;
      if (r !== rPair && c !== cPair1 && c !== cPair2) {
        const k = `${r},${c}`;
        if (!peerSeen.has(k)) { peerSeen.add(k); combinedPeers.push([r, c]); }
      }
    }
    shuffleArray(combinedPeers);

    const usedPeers = new Set<string>();
    // 两轮消除：第一轮用行 peer 尽可能同时消去两格；第二轮处理残余
    for (let pass = 0; pass < 2; pass++) {
      for (const d of toElim) {
        const curCands = computeCandidates(puzzle);
        const need1 = puzzle[rPair][cPair1] === 0 && curCands[rPair][cPair1].has(d);
        const need2 = puzzle[rPair][cPair2] === 0 && curCands[rPair][cPair2].has(d);
        if (!need1 && !need2) continue;
        let ok = false;
        for (const [r, c] of combinedPeers) {
          if (usedPeers.has(`${r},${c}`) || puzzle[r][c] !== 0) continue;
          if (!getValidDigitsAt(puzzle, r, c).has(d)) continue;
          puzzle[r][c] = d; usedPeers.add(`${r},${c}`); ok = true; break;
        }
        if (!ok && pass === 1) return null;
      }
    }

    // 验证两个数对格候选数均为 {P, Q}
    const pairCands = computeCandidates(puzzle);
    const pc1 = pairCands[rPair][cPair1], pc2 = pairCands[rPair][cPair2];
    if (pc1.size !== 2 || !pc1.has(P) || !pc1.has(Q)) return null;
    if (pc2.size !== 2 || !pc2.has(P) || !pc2.has(Q)) return null;

    // 验证区块：源宫 A 仅在 cBlocked 列
    const candsBlk = computeCandidates(puzzle);
    for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
      const r = srcBR + dr, c = srcBC + dc;
      if (c !== cBlocked && puzzle[r][c] === 0 && candsBlk[r][c].has(A)) return null;
    }

    // 封锁行 TR 其余格（≠ TC, ≠ cBlocked）的 A
    const otherRowCols = [0,1,2,3,4,5,6,7,8].filter(c => c !== TC && c !== cBlocked);
    for (const col of otherRowCols) {
      const cands2 = computeCandidates(puzzle);
      if (!cands2[TR][col].has(A)) continue;
      const opts = shuffleArray([0,1,2,3,4,5,6,7,8].filter(r => r !== TR));
      let placed = false;
      for (const r of opts) {
        if (puzzle[r][col] !== 0 || !getValidDigitsAt(puzzle, r, col).has(A)) continue;
        puzzle[r][col] = A; placed = true; break;
      }
      if (!placed) return null;
    }

    const candsF = computeAdvancedCandidates(puzzle);
    if (!candsF[TR][TC].has(A)) return null;
    for (let c = 0; c < 9; c++)
      if (c !== TC && puzzle[TR][c] === 0 && candsF[TR][c].has(A)) return null;

    if (!isExactlyOneDeducibleCell(puzzle, TR, TC)) return null;

    this.addTrainingInterference(puzzle, TR, TC, A, 1, 3);
    return { puzzle, targetRow: TR, targetCol: TC, answer: A };
  }

  private generateD5Puzzle(): { puzzle: number[][]; targetRow: number; targetCol: number; answer: number } {
    for (let i = 0; i < 200; i++) {
      const r = Math.random() < 0.5 ? this.buildD5PuzzleOnce() : this.buildD5RowPairOnce();
      if (r) return r;
    }
    throw new Error('D5 puzzle generation failed after 200 attempts');
  }

  // ══════════════════════════════════════════════════════
  // 难度6：多数对/数组 → 双区块 → 唯余
  // ══════════════════════════════════════════════════════

  /**
   * D6构造：2个数对各自推导出1个区块（方向相同：均为列向区块封锁行TR不同格的A）
   * → 双区块 + 6个直接A封锁 → (TR,TC) 隐性唯余·行
   */
  private buildD6PuzzleOnce(): {
    puzzle: number[][];
    targetRow: number; targetCol: number; answer: number;
  } | null {
    const TR = Math.floor(Math.random() * 9);
    const TC = Math.floor(Math.random() * 9);
    const A  = Math.floor(Math.random() * 9) + 1;

    const targetBR = Math.floor(TR / 3) * 3;
    const targetBC = Math.floor(TC / 3) * 3;

    // 2个不同列带（非targetBC）各设1个源宫+1个数对
    const nonTargetBCs = [0, 3, 6].filter(bc => bc !== targetBC);
    if (nonTargetBCs.length < 2) return null;
    const [srcBC1, srcBC2] = shuffleArray([...nonTargetBCs]);

    // 2个不同行带（非targetBR）作为2个源宫行带
    const srcBROptions = [0, 3, 6].filter(br => br !== targetBR);
    const srcBR1 = srcBROptions[Math.floor(Math.random() * srcBROptions.length)];
    const srcBR2Options = srcBROptions.filter(br => br !== srcBR1);
    const srcBR2 = srcBR2Options.length > 0
      ? srcBR2Options[Math.floor(Math.random() * srcBR2Options.length)]
      : srcBR1;

    // 各选一列作为被封锁列
    const bc1Cols = shuffleArray([srcBC1, srcBC1 + 1, srcBC1 + 2]);
    const bc2Cols = shuffleArray([srcBC2, srcBC2 + 1, srcBC2 + 2]);
    const cBlocked1 = bc1Cols[0];
    const cBlocked2 = bc2Cols[0];
    const nonCBlk1 = bc1Cols.slice(1);
    const nonCBlk2 = bc2Cols.slice(1);

    const digitsNonA = shuffleArray([1,2,3,4,5,6,7,8,9].filter(d => d !== A));
    // 2个数对：{P1,Q1} 和 {P2,Q2}（允许数字重叠，但对间独立）
    const P1 = digitsNonA[0], Q1 = digitsNonA[1];
    const P2 = digitsNonA[2], Q2 = digitsNonA[3];

    const puzzle: number[][] = Array.from({length: 9}, () => Array(9).fill(0));

    // 构造源宫1的区块（通过数对+直接封锁使A仅在cBlocked1列）
    const buildBlockWithPair = (
      srcBR: number, srcBC_: number, cBlk: number, nonCBlkCols_: number[],
      Pp: number, Qp: number,
    ): boolean => {
      // nonCBlkCols_[0]: 数对列, nonCBlkCols_[1]: 直接A封锁列
      const cPairInBox = nonCBlkCols_[0];
      const cDirectBlk = nonCBlkCols_[1];

      // 直接封锁 cDirectBlk（在其列宫外放A）
      const outsideRowsDirect = shuffleArray([0,1,2,3,4,5,6,7,8].filter(r => r < srcBR || r > srcBR + 2));
      let placedDirect = false;
      for (const r of outsideRowsDirect) {
        if (r === TR) continue;
        if (getValidDigitsAt(puzzle, r, cDirectBlk).has(A)) {
          puzzle[r][cDirectBlk] = A; placedDirect = true; break;
        }
      }
      if (!placedDirect) return false;

      // 在 cPairInBox 列宫外放A，消除源宫内该列的A
      const outsideRowsPair = shuffleArray([0,1,2,3,4,5,6,7,8].filter(r => r < srcBR || r > srcBR + 2));
      let placedAPairCol = false;
      for (const r of outsideRowsPair) {
        if (r === TR) continue;
        if (getValidDigitsAt(puzzle, r, cPairInBox).has(A)) {
          puzzle[r][cPairInBox] = A; placedAPairCol = true; break;
        }
      }
      if (!placedAPairCol) return false;

      // 构造数对：选 srcBR 区的一行 rPair，使 (rPair, cPairInBox) 仅有 {Pp,Qq}
      const pairRows = shuffleArray([srcBR, srcBR + 1, srcBR + 2]);
      let pairMade = false;
      for (const rPair of pairRows) {
        const toElimPair = [1,2,3,4,5,6,7,8,9].filter(d => d !== Pp && d !== Qp);
        const peerCells: [number,number][] = [];
        for (let c = 0; c < 9; c++) if (c !== cPairInBox) peerCells.push([rPair, c]);
        for (let r = 0; r < 9; r++) if (r !== rPair) peerCells.push([r, cPairInBox]);
        const pBR = Math.floor(rPair / 3) * 3, pBC = Math.floor(cPairInBox / 3) * 3;
        for (let dr2 = 0; dr2 < 3; dr2++)
          for (let dc2 = 0; dc2 < 3; dc2++) {
            const r2 = pBR + dr2, c2 = pBC + dc2;
            if (r2 !== rPair && c2 !== cPairInBox) peerCells.push([r2, c2]);
          }
        shuffleArray(peerCells);
        const saved = puzzle.map(row => [...row]);
        const used = new Set<string>();
        let failed = false;
        for (const d of toElimPair) {
          if (!computeCandidates(puzzle)[rPair][cPairInBox].has(d)) continue;
          let ok2 = false;
          for (const [r2, c2] of peerCells) {
            if (used.has(`${r2},${c2}`) || puzzle[r2][c2] !== 0) continue;
            if (!getValidDigitsAt(puzzle, r2, c2).has(d)) continue;
            puzzle[r2][c2] = d; used.add(`${r2},${c2}`); ok2 = true; break;
          }
          if (!ok2) { failed = true; break; }
        }
        if (!failed) {
          const c = computeCandidates(puzzle);
          if (c[rPair][cPairInBox].size === 2 && c[rPair][cPairInBox].has(Pp) && c[rPair][cPairInBox].has(Qp)) {
            pairMade = true; break;
          }
        }
        for (let r = 0; r < 9; r++) puzzle[r] = saved[r];
      }
      return pairMade;
    };

    if (!buildBlockWithPair(srcBR1, srcBC1, cBlocked1, nonCBlk1, P1, Q1)) return null;
    if (!buildBlockWithPair(srcBR2, srcBC2, cBlocked2, nonCBlk2, P2, Q2)) return null;

    // 验证2个区块均形成
    const candsBlk = computeCandidates(puzzle);
    for (let dr = 0; dr < 3; dr++)
      for (let dc = 0; dc < 3; dc++) {
        const r1 = srcBR1 + dr, c1 = srcBC1 + dc;
        if (c1 !== cBlocked1 && puzzle[r1][c1] === 0 && candsBlk[r1][c1].has(A)) return null;
        const r2 = srcBR2 + dr, c2 = srcBC2 + dc;
        if (c2 !== cBlocked2 && puzzle[r2][c2] === 0 && candsBlk[r2][c2].has(A)) return null;
      }

    // 封锁行TR其余格
    const otherRowCols = [0,1,2,3,4,5,6,7,8].filter(c => c !== TC && c !== cBlocked1 && c !== cBlocked2);
    for (const col of otherRowCols) {
      const cands2 = computeCandidates(puzzle);
      if (!cands2[TR][col].has(A)) continue;
      const opts = shuffleArray([0,1,2,3,4,5,6,7,8].filter(r => r !== TR));
      let placed = false;
      for (const r of opts) {
        if (puzzle[r][col] !== 0 || !getValidDigitsAt(puzzle, r, col).has(A)) continue;
        puzzle[r][col] = A; placed = true; break;
      }
      if (!placed) return null;
    }

    const candsF = computeAdvancedCandidates(puzzle);
    if (!candsF[TR][TC].has(A)) return null;
    for (let c = 0; c < 9; c++)
      if (c !== TC && puzzle[TR][c] === 0 && candsF[TR][c].has(A)) return null;

    if (!isExactlyOneDeducibleCell(puzzle, TR, TC)) return null;

    this.addTrainingInterference(puzzle, TR, TC, A, 1, 2);
    return { puzzle, targetRow: TR, targetCol: TC, answer: A };
  }

  /**
   * D6构造变体：双横向数对
   *
   * 与 buildD6PuzzleOnce 结构相同，但两个数对均采用横向布局：
   * 数对 {P,Q} 分布在源宫同一行的两个非 cBlocked 列，两格左右并排（横向），
   * 而非上下排列（纵向）。两种布局产生截然不同的视觉图案。
   */
  private buildD6RowPairOnce(): {
    puzzle: number[][];
    targetRow: number; targetCol: number; answer: number;
  } | null {
    const TR = Math.floor(Math.random() * 9);
    const TC = Math.floor(Math.random() * 9);
    const A  = Math.floor(Math.random() * 9) + 1;

    const targetBR = Math.floor(TR / 3) * 3;
    const targetBC = Math.floor(TC / 3) * 3;

    // 两个不同列带（非 targetBC），每个设1个横向数对源宫
    const nonTargetBCs = [0, 3, 6].filter(bc => bc !== targetBC);
    if (nonTargetBCs.length < 2) return null;
    const [srcBC1, srcBC2] = shuffleArray([...nonTargetBCs]);

    // 两个源宫行带（可相同）
    const srcBROptions = [0, 3, 6].filter(br => br !== targetBR);
    const srcBR1 = srcBROptions[Math.floor(Math.random() * srcBROptions.length)];
    const srcBR2Options = srcBROptions.filter(br => br !== srcBR1);
    const srcBR2 = srcBR2Options.length > 0
      ? srcBR2Options[Math.floor(Math.random() * srcBR2Options.length)]
      : srcBR1;

    // 各选 cBlocked 列
    const bc1Cols = shuffleArray([srcBC1, srcBC1 + 1, srcBC1 + 2]);
    const bc2Cols = shuffleArray([srcBC2, srcBC2 + 1, srcBC2 + 2]);
    const cBlocked1 = bc1Cols[0];
    const cBlocked2 = bc2Cols[0];

    const digitsNonA = shuffleArray([1,2,3,4,5,6,7,8,9].filter(d => d !== A));
    const P1 = digitsNonA[0], Q1 = digitsNonA[1];
    const P2 = digitsNonA[2], Q2 = digitsNonA[3];

    const puzzle: number[][] = Array.from({length: 9}, () => Array(9).fill(0));

    // 横向数对区块构造辅助：在 srcBR 宫中，选 rPair 行放横向数对 {Pp,Qp}，
    // 两对格列 = nonCBlk 的两列，通过列向 A 封锁 + peer 消除 构造横向数对
    const buildBlockWithRowPair = (
      srcBR: number, srcBC_: number, cBlk: number,
      Pp: number, Qp: number,
    ): boolean => {
      const nonCBlkCols = shuffleArray([srcBC_, srcBC_ + 1, srcBC_ + 2].filter(c => c !== cBlk));
      const cP1 = nonCBlkCols[0], cP2 = nonCBlkCols[1];

      // 在 cP1 和 cP2 列宫外放 A，消除源宫中这两列的 A 候选
      for (const col of [cP1, cP2]) {
        const outsideRows = shuffleArray([0,1,2,3,4,5,6,7,8].filter(r => r < srcBR || r > srcBR + 2));
        let placedA = false;
        for (const r of outsideRows) {
          if (r === TR) continue;
          if (getValidDigitsAt(puzzle, r, col).has(A)) {
            puzzle[r][col] = A; placedA = true; break;
          }
        }
        if (!placedA) return false;
      }

      // 在 srcBR 行带中选 rPair
      const pairRows = shuffleArray([srcBR, srcBR + 1, srcBR + 2]);
      let pairMade = false;
      for (const rPair of pairRows) {
        const toElimPair = [1,2,3,4,5,6,7,8,9].filter(d => d !== Pp && d !== Qp);

        // 合并两格 peer（优先行 peer 以同时消去两格候选）
        const pSeen = new Set<string>();
        const peers: [number, number][] = [];
        for (let c = 0; c < 9; c++) {
          if (c !== cP1 && c !== cP2) {
            const k = `${rPair},${c}`;
            if (!pSeen.has(k)) { pSeen.add(k); peers.push([rPair, c]); }
          }
        }
        for (const col of [cP1, cP2]) {
          for (let r = 0; r < 9; r++) {
            if (r !== rPair) {
              const k = `${r},${col}`;
              if (!pSeen.has(k)) { pSeen.add(k); peers.push([r, col]); }
            }
          }
        }
        for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
          const r2 = srcBR + dr, c2 = srcBC_ + dc;
          if (r2 !== rPair && c2 !== cP1 && c2 !== cP2) {
            const k = `${r2},${c2}`;
            if (!pSeen.has(k)) { pSeen.add(k); peers.push([r2, c2]); }
          }
        }
        shuffleArray(peers);

        const saved = puzzle.map(row => [...row]);
        const used  = new Set<string>();
        for (let pass = 0; pass < 2; pass++) {
          for (const d of toElimPair) {
            const cc = computeCandidates(puzzle);
            const n1 = puzzle[rPair][cP1] === 0 && cc[rPair][cP1].has(d);
            const n2 = puzzle[rPair][cP2] === 0 && cc[rPair][cP2].has(d);
            if (!n1 && !n2) continue;
            let ok2 = false;
            for (const [r2, c2] of peers) {
              if (used.has(`${r2},${c2}`) || puzzle[r2][c2] !== 0) continue;
              if (!getValidDigitsAt(puzzle, r2, c2).has(d)) continue;
              puzzle[r2][c2] = d; used.add(`${r2},${c2}`); ok2 = true; break;
            }
            if (!ok2 && pass === 1) { /* will rollback */ }
          }
        }
        const cc2 = computeCandidates(puzzle);
        const ok1 = cc2[rPair][cP1].size === 2 && cc2[rPair][cP1].has(Pp) && cc2[rPair][cP1].has(Qp);
        const ok2 = cc2[rPair][cP2].size === 2 && cc2[rPair][cP2].has(Pp) && cc2[rPair][cP2].has(Qp);
        if (ok1 && ok2) { pairMade = true; break; }
        for (let r = 0; r < 9; r++) puzzle[r] = saved[r];
      }
      return pairMade;
    };

    if (!buildBlockWithRowPair(srcBR1, srcBC1, cBlocked1, P1, Q1)) return null;
    if (!buildBlockWithRowPair(srcBR2, srcBC2, cBlocked2, P2, Q2)) return null;

    // 验证两个区块均形成
    const candsBlk = computeCandidates(puzzle);
    for (const [srcBR, srcBC_, cBlk] of [
      [srcBR1, srcBC1, cBlocked1], [srcBR2, srcBC2, cBlocked2]
    ] as [number, number, number][]) {
      for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
        const r = srcBR + dr, c = srcBC_ + dc;
        if (c !== cBlk && puzzle[r][c] === 0 && candsBlk[r][c].has(A)) return null;
      }
    }

    // 封锁行 TR 其余格（≠ TC, ≠ cBlocked1, ≠ cBlocked2）的 A
    const blockedCols = new Set([TC, cBlocked1, cBlocked2]);
    const otherRowCols = [0,1,2,3,4,5,6,7,8].filter(c => !blockedCols.has(c));
    for (const col of otherRowCols) {
      const cands2 = computeCandidates(puzzle);
      if (!cands2[TR][col].has(A)) continue;
      const opts = shuffleArray([0,1,2,3,4,5,6,7,8].filter(r => r !== TR));
      let placed = false;
      for (const r of opts) {
        if (puzzle[r][col] !== 0 || !getValidDigitsAt(puzzle, r, col).has(A)) continue;
        puzzle[r][col] = A; placed = true; break;
      }
      if (!placed) return null;
    }

    const candsF = computeAdvancedCandidates(puzzle);
    if (!candsF[TR][TC].has(A)) return null;
    for (let c = 0; c < 9; c++)
      if (c !== TC && puzzle[TR][c] === 0 && candsF[TR][c].has(A)) return null;

    if (!isExactlyOneDeducibleCell(puzzle, TR, TC)) return null;

    this.addTrainingInterference(puzzle, TR, TC, A, 1, 2);
    return { puzzle, targetRow: TR, targetCol: TC, answer: A };
  }

  private generateD6Puzzle(): { puzzle: number[][]; targetRow: number; targetCol: number; answer: number } {
    for (let i = 0; i < 200; i++) {
      const r = Math.random() < 0.5 ? this.buildD6PuzzleOnce() : this.buildD6RowPairOnce();
      if (r) return r;
    }
    throw new Error('D6 puzzle generation failed after 200 attempts');
  }

  /** 根据难度编号路由到对应生成函数 */
  private generateTrainingPuzzleByDifficulty(difficulty: number): {
    puzzle: number[][]; targetRow: number; targetCol: number; answer: number;
  } {
    switch (difficulty) {
      case 2: return this.generateAdvancedTrainingPuzzle();
      case 3: return this.generateD3Puzzle();
      case 4: return this.generateD4Puzzle();
      case 5: return this.generateD5Puzzle();
      case 6: return this.generateD6Puzzle();
      default: return this.generateTrainingPuzzle();
    }
  }

  /** 训练题目池容量（预渲染图片数，每张约 100-200 KB，10 张 ≈ 1.5 MB） */
  private readonly TRAINING_POOL_SIZE = 10;

  /**
   * 将训练题目的答案信息存入频道提示缓存，供查询时使用。
   * 旧的过期条目在此处顺带清理。
   */
  private storeTrainingHint(
    channelId: string,
    trainingId: string,
    entry: Omit<TrainingHintEntry, "trainingId" | "expireAt">,
  ): void {
    if (!this.trainingHintCache.has(channelId)) {
      this.trainingHintCache.set(channelId, new Map());
    }
    const cache = this.trainingHintCache.get(channelId)!;
    const now = Date.now();
    // 顺带清理已过期条目（避免内存无限增长）
    for (const [id, e] of cache) {
      if (e.expireAt <= now) cache.delete(id);
    }
    cache.set(trainingId, {
      trainingId,
      ...entry,
      puzzle: entry.puzzle.map((row) => [...row]),
      expireAt: now + 24 * 60 * 60 * 1000,
    });
  }

  /**
   * 后台持续填充训练题目池（fire-and-forget）。
   * 使用 setImmediate 确保填充从下一事件循环迭代开始，不阻塞当前消息收发。
   * 每次填充一道（生成盘面 + Canvas 渲染），完成后递归补充直到池满。
   */
  private fillTrainingPool(ts: TrainingSession): void {
    if (ts.poolFilling) return;
    if (ts.questionPool.length >= this.TRAINING_POOL_SIZE) return;
    if (!this.trainings.has(ts.channelId)) return;

    ts.poolFilling = true;

    setImmediate(async () => {
      try {
        let consecutive_failures = 0;
        while (
          ts.questionPool.length < this.TRAINING_POOL_SIZE &&
          this.trainings.has(ts.channelId) &&
          consecutive_failures < 3
        ) {
          const idx = ts.poolNextQueuedIndex++;
          const trainingId = `${ts.round}-${idx}`;
          const label = `${trainingId}  唯余训练·难度${ts.difficulty}`;
          try {
            const { puzzle, targetRow, targetCol, answer } =
              this.generateTrainingPuzzleByDifficulty(ts.difficulty);
            const imgBuf = await this.renderer.render(puzzle, label, undefined, undefined);
            if (!this.trainings.has(ts.channelId)) break;
            this.storeTrainingHint(ts.channelId, trainingId, {
              targetRow, targetCol, answer, puzzle, difficulty: ts.difficulty,
            });
            ts.questionPool.push({ puzzle, answer, renderedImage: imgBuf, label, questionIndex: idx });
            consecutive_failures = 0;
          } catch {
            consecutive_failures++;
            this.ctx.logger("sudoku").warn(`训练池填充第${idx}题失败（连续失败 ${consecutive_failures} 次）`);
          }
        }
      } finally {
        ts.poolFilling = false;
        if (ts.questionPool.length < this.TRAINING_POOL_SIZE && this.trainings.has(ts.channelId)) {
          setTimeout(() => this.fillTrainingPool(ts), 500);
        }
      }
    });
  }

  /** 发送下一道训练题 */
  private async nextTrainingQuestion(session: Session, ts: TrainingSession): Promise<void> {
    // 检查训练是否仍在运行（stopTraining 可能在 await 期间调用）
    if (!this.trainings.has(ts.channelId)) return;

    const logger = this.ctx.logger("sudoku");

    ts.currentQuestionIndex++;
    const expectedIndex = ts.currentQuestionIndex;
    const trainingId = `${ts.round}-${expectedIndex}`;
    const label = `${trainingId}  唯余训练·难度${ts.difficulty}`;

    // ── 从题目池取题（校验题号匹配）────────────────────────────────────────────
    // 题目池以 poolNextQueuedIndex 严格递增排队，正常情况下池头题号与期望题号吻合。
    // 若不吻合（极罕见：训练暂停重置、池生成失败跳号），丢弃不匹配项，实时补题。
    let poolEntry: PregeneratedTrainingQuestion | null = null;
    if (ts.questionPool.length > 0 && ts.questionPool[0].questionIndex === expectedIndex) {
      poolEntry = ts.questionPool.shift()!;
      logger.info(`命中训练题目池（第${expectedIndex}题，池剩余 ${ts.questionPool.length} 道）`);
    } else if (ts.questionPool.length > 0) {
      const poolHead = ts.questionPool[0].questionIndex;
      if (poolHead > expectedIndex) {
        // 池超前（最常见：第1题由实时生成，池从第2题起填充），属正常流程，实时生成当前题
        logger.info(`训练题目池超前（池头=${poolHead}，期望=${expectedIndex}），实时生成第${expectedIndex}题`);
      } else {
        // 池落后或题号跳跃，属真正异常，记录警告
        logger.warn(
          `训练题目池题号异常（池头=${poolHead}，期望=${expectedIndex}），丢弃并实时生成`,
        );
        ts.questionPool.shift(); // 丢弃错误条目
      }
    }

    // 题目从池中取走后立即触发补充，维持池的饱满度
    this.fillTrainingPool(ts);

    // 新题对象：answer 和 questionStartTime 均在图片发出后才最终确定/计时
    // ts.currentQuestion 保持指向旧题，直到新题图片真正发出才切换（见 finally）
    // 这样消除了"新题已赋值但图片未发"的竞态窗口，避免错误的 questionStartTime=0 问题
    const cq: TrainingQuestion = {
      answer: 0,
      questionStartTime: 0,
      wrongAttempts: new Map(),
      transitioning: false,
      correctAnswerers: new Set(),
    };

    try {
      if (poolEntry) {
        cq.answer = poolEntry.answer;
        if (!this.trainings.has(ts.channelId)) return;
        await this.sendImage(session, poolEntry.renderedImage);
      } else {
        const { puzzle, targetRow, targetCol, answer } =
          this.generateTrainingPuzzleByDifficulty(ts.difficulty);
        cq.answer = answer;
        // 生成成功后立即缓存答案（渲染失败也能保留正确答案供查询）
        this.storeTrainingHint(ts.channelId, trainingId, {
          targetRow, targetCol, answer, puzzle, difficulty: ts.difficulty,
        });
        const imgBuf = await this.renderer.render(puzzle, label, undefined, undefined);
        if (!this.trainings.has(ts.channelId)) return;
        await this.sendImage(session, imgBuf);
      }
    } catch (err: any) {
      if (!this.trainings.has(ts.channelId)) return;
      logger.warn("唯余训练图片渲染/发送失败：", err);
      if (cq.answer === 0) {
        try {
          const { answer } = this.generateTrainingPuzzleByDifficulty(ts.difficulty);
          cq.answer = answer;
        } catch {
          cq.answer = Math.floor(Math.random() * 9) + 1;
        }
      }
      await session.send(`📋 ${label}（图片渲染失败，请输入 1-9 作答）`);
    } finally {
      // 图片（或降级文本）发出后，原子性地切换当前题并启动计时
      // 若训练在此期间被停止，则不切换（避免悬挂引用）
      if (this.trainings.has(ts.channelId)) {
        cq.questionStartTime = Date.now();
        ts.currentQuestion = cq;
      }
    }
  }

  /** 生成训练报告并发送 */
  private async finishTraining(session: Session, ts: TrainingSession): Promise<void> {
    if (ts.participants.size === 0) {
      await session.send("本轮训练无人参与，不生成报告。");
      return;
    }
    if (ts.finishedQuestions === 0) {
      await session.send("本轮训练无人答对任何题目，不生成报告。");
      return;
    }

    const endTime = Date.now();
    const participants = Array.from(ts.participants.values());

    // 标题
    const modeLabel = `唯余训练【难度${ts.difficulty}】`;
    const title =
      participants.length === 1
        ? `「${participants[0].username}」${modeLabel}报告`
        : participants.map((p) => `「${p.username}」`).join("") + `${modeLabel}报告`;

    // 时间范围
    const fmt = (d: Date) =>
      `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
    const timeRange = `${fmt(new Date(ts.startTime))} - ${fmt(new Date(endTime))}`;

    const renderData: TrainingRenderData = {
      title,
      timeRange,
      totalQuestions: ts.finishedQuestions,
      participants: participants.map((p) => ({
        username: p.username,
        correct: p.correct,
        wrong: p.wrong,
        correctTimesMs: p.correctAnswers.map((a) => a.elapsedMs),
        questionIndices: p.correctAnswers.map((a) => a.questionIndex),
      })),
    };

    try {
      const imgBuf = await this.renderer.renderTrainingStats(renderData);
      await this.sendImage(session, imgBuf);
    } catch (err: any) {
      this.ctx.logger("sudoku").warn("训练报告渲染失败，降级为文字：", err);
      // 文字降级报告
      const lines = [
        `📊 ${modeLabel}报告`,
        `训练时间：${timeRange}`,
        `共完成 ${ts.finishedQuestions} 题`,
        "",
        ...participants.map((p) => {
          const total = p.correct + p.wrong;
          const acc = total === 0 ? "0%" : `${((p.correct / total) * 100).toFixed(1)}%`;
          const avgMs =
            p.correctAnswers.length > 0
              ? p.correctAnswers.reduce((s, a) => s + a.elapsedMs, 0) / p.correctAnswers.length
              : 0;
          return `${p.username}：✅${p.correct} ❌${p.wrong} 正确率${acc} 均${(avgMs / 1000).toFixed(1)}s`;
        }),
      ];
      await session.send(lines.join("\n"));
    }
  }

}

// ─── 训练题答案推理路径生成器 ────────────────────────────────────────────────────

/**
 * 根据训练题盘面、目标格和答案，生成人类可读的推理路径说明。
 * 逻辑：先找区块排除（指向/行列式），再判断是显性唯余还是隐性唯余，逐步解释。
 */
function generateTrainingHintExplanation(
  puzzle: number[][],
  TR: number,
  TC: number,
  answer: number,
): string {
  const cn = (r: number, c: number) => `${String.fromCharCode(65 + r)}${c + 1}`;
  const TARGET = cn(TR, TC);
  const boxNo = (r: number, c: number) => Math.floor(r / 3) * 3 + Math.floor(c / 3) + 1;

  // ── 直接候选数计算 ──────────────────────────────────────────────────────────
  const wc: Set<number>[][] = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (_, c) => {
      if (puzzle[r][c] !== 0) return new Set<number>();
      const seen = new Set<number>();
      for (let j = 0; j < 9; j++) {
        if (puzzle[r][j]) seen.add(puzzle[r][j]);
        if (puzzle[j][c]) seen.add(puzzle[j][c]);
      }
      const br = Math.floor(r / 3) * 3, bc = Math.floor(c / 3) * 3;
      for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++)
        if (puzzle[br + dr][bc + dc]) seen.add(puzzle[br + dr][bc + dc]);
      const s = new Set<number>();
      for (let d = 1; d <= 9; d++) if (!seen.has(d)) s.add(d);
      return s;
    }),
  );

  // ── 区块排除追踪 ────────────────────────────────────────────────────────────
  // 追踪哪些区块排除步骤影响了目标格所在行/列/宫，以及目标格自身
  type LockedStep = { text: string; type: "onTarget" | "onRow" | "onCol" | "onBox"; digit: number };
  const lockedSteps: LockedStep[] = [];

  let changed = true;
  while (changed) {
    changed = false;

    // 指向排除（宫 → 行/列）
    for (let br = 0; br < 9; br += 3) {
      for (let bc = 0; bc < 9; bc += 3) {
        for (let d = 1; d <= 9; d++) {
          const pos: [number, number][] = [];
          for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
            const r = br + dr, c = bc + dc;
            if (puzzle[r][c] === 0 && wc[r][c].has(d)) pos.push([r, c]);
          }
          if (pos.length === 0) continue;
          const rowSet = new Set(pos.map((p) => p[0]));
          const colSet = new Set(pos.map((p) => p[1]));

          if (rowSet.size === 1) {
            const row = pos[0][0];
            const aff: string[] = [];
            for (let c = 0; c < 9; c++) {
              if (c >= bc && c < bc + 3) continue;
              if (puzzle[row][c] === 0 && wc[row][c].has(d)) {
                wc[row][c].delete(d); changed = true;
                aff.push(cn(row, c));
              }
            }
            if (aff.length > 0) {
              const text = `第${boxNo(br, bc)}宫数字${d}候选仅在第${row + 1}行（指向排除）→ 排除${aff.join("、")}的候选${d}`;
              for (const cellStr of aff) {
                const cellR = cellStr.charCodeAt(0) - 65;
                const cellC = parseInt(cellStr[1]) - 1;
                let type: LockedStep["type"] | null = null;
                if (cellR === TR && cellC === TC) type = "onTarget";
                else if (cellR === TR && d === answer) type = "onRow";
                else if (cellC === TC && d === answer) type = "onCol";
                else if (Math.floor(cellR / 3) === Math.floor(TR / 3) &&
                  Math.floor(cellC / 3) === Math.floor(TC / 3) && d === answer) type = "onBox";
                if (type) {
                  // 去重：同一 text+type 只记录一次
                  if (!lockedSteps.some((s) => s.text === text && s.type === type)) {
                    lockedSteps.push({ text, type, digit: d });
                  }
                }
              }
            }
          }

          if (colSet.size === 1) {
            const col = pos[0][1];
            const aff: string[] = [];
            for (let r = 0; r < 9; r++) {
              if (r >= br && r < br + 3) continue;
              if (puzzle[r][col] === 0 && wc[r][col].has(d)) {
                wc[r][col].delete(d); changed = true;
                aff.push(cn(r, col));
              }
            }
            if (aff.length > 0) {
              const text = `第${boxNo(br, bc)}宫数字${d}候选仅在第${col + 1}列（指向排除）→ 排除${aff.join("、")}的候选${d}`;
              for (const cellStr of aff) {
                const cellR = cellStr.charCodeAt(0) - 65;
                const cellC = parseInt(cellStr[1]) - 1;
                let type: LockedStep["type"] | null = null;
                if (cellR === TR && cellC === TC) type = "onTarget";
                else if (cellR === TR && d === answer) type = "onRow";
                else if (cellC === TC && d === answer) type = "onCol";
                else if (Math.floor(cellR / 3) === Math.floor(TR / 3) &&
                  Math.floor(cellC / 3) === Math.floor(TC / 3) && d === answer) type = "onBox";
                if (type) {
                  if (!lockedSteps.some((s) => s.text === text && s.type === type)) {
                    lockedSteps.push({ text, type, digit: d });
                  }
                }
              }
            }
          }
        }
      }
    }

    // 行列式（行/列 → 宫）
    for (let r = 0; r < 9; r++) {
      for (let d = 1; d <= 9; d++) {
        const cs: number[] = [];
        for (let c = 0; c < 9; c++) if (puzzle[r][c] === 0 && wc[r][c].has(d)) cs.push(c);
        if (cs.length === 0) continue;
        const bcSet = new Set(cs.map((c) => Math.floor(c / 3)));
        if (bcSet.size === 1) {
          const bc = [...bcSet][0] * 3, br = Math.floor(r / 3) * 3;
          const aff: string[] = [];
          for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
            const r2 = br + dr, c2 = bc + dc;
            if (r2 === r) continue;
            if (puzzle[r2][c2] === 0 && wc[r2][c2].has(d)) {
              wc[r2][c2].delete(d); changed = true;
              aff.push(cn(r2, c2));
            }
          }
          if (aff.length > 0) {
            const text = `第${r + 1}行数字${d}候选仅在第${boxNo(br, bc)}宫（行列式）→ 排除${aff.join("、")}的候选${d}`;
            for (const cellStr of aff) {
              const cellR = cellStr.charCodeAt(0) - 65;
              const cellC = parseInt(cellStr[1]) - 1;
              let type: LockedStep["type"] | null = null;
              if (cellR === TR && cellC === TC) type = "onTarget";
              else if (cellR === TR && d === answer) type = "onRow";
              else if (cellC === TC && d === answer) type = "onCol";
              else if (Math.floor(cellR / 3) === Math.floor(TR / 3) &&
                Math.floor(cellC / 3) === Math.floor(TC / 3) && d === answer) type = "onBox";
              if (type) {
                if (!lockedSteps.some((s) => s.text === text && s.type === type)) {
                  lockedSteps.push({ text, type, digit: d });
                }
              }
            }
          }
        }
      }
    }
    for (let c = 0; c < 9; c++) {
      for (let d = 1; d <= 9; d++) {
        const rs: number[] = [];
        for (let r = 0; r < 9; r++) if (puzzle[r][c] === 0 && wc[r][c].has(d)) rs.push(r);
        if (rs.length === 0) continue;
        const brSet = new Set(rs.map((r) => Math.floor(r / 3)));
        if (brSet.size === 1) {
          const br = [...brSet][0] * 3, bc = Math.floor(c / 3) * 3;
          const aff: string[] = [];
          for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
            const r2 = br + dr, c2 = bc + dc;
            if (c2 === c) continue;
            if (puzzle[r2][c2] === 0 && wc[r2][c2].has(d)) {
              wc[r2][c2].delete(d); changed = true;
              aff.push(cn(r2, c2));
            }
          }
          if (aff.length > 0) {
            const text = `第${c + 1}列数字${d}候选仅在第${boxNo(br, bc)}宫（行列式）→ 排除${aff.join("、")}的候选${d}`;
            for (const cellStr of aff) {
              const cellR = cellStr.charCodeAt(0) - 65;
              const cellC = parseInt(cellStr[1]) - 1;
              let type: LockedStep["type"] | null = null;
              if (cellR === TR && cellC === TC) type = "onTarget";
              else if (cellR === TR && d === answer) type = "onRow";
              else if (cellC === TC && d === answer) type = "onCol";
              else if (Math.floor(cellR / 3) === Math.floor(TR / 3) &&
                Math.floor(cellC / 3) === Math.floor(TC / 3) && d === answer) type = "onBox";
              if (type) {
                if (!lockedSteps.some((s) => s.text === text && s.type === type)) {
                  lockedSteps.push({ text, type, digit: d });
                }
              }
            }
          }
        }
      }
    }
  }

  // ── 判断出数方式并生成解释 ──────────────────────────────────────────────────

  // 显性唯余（目标格仅剩1个候选数）
  if (wc[TR][TC].size === 1 && wc[TR][TC].has(answer)) {
    const rowNums: number[] = [], colNums: number[] = [], boxNums: number[] = [];
    const onTargetDigits = new Set(lockedSteps.filter((s) => s.type === "onTarget").map((s) => s.digit));
    for (let d = 1; d <= 9; d++) {
      if (d === answer || onTargetDigits.has(d)) continue;
      let found = false;
      for (let j = 0; j < 9; j++) { if (puzzle[TR][j] === d) { rowNums.push(d); found = true; break; } }
      if (!found) for (let i = 0; i < 9; i++) { if (puzzle[i][TC] === d) { colNums.push(d); found = true; break; } }
      if (!found) {
        const br2 = Math.floor(TR / 3) * 3, bc2 = Math.floor(TC / 3) * 3;
        outer: for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++)
          if (puzzle[br2 + dr][bc2 + dc] === d) { boxNums.push(d); found = true; break outer; }
      }
    }
    const parts: string[] = [];
    const onTargetSteps = lockedSteps.filter((s) => s.type === "onTarget");
    // 区块排除步骤优先展示
    const seenTexts = new Set<string>();
    for (const s of onTargetSteps) { if (!seenTexts.has(s.text)) { parts.push(s.text); seenTexts.add(s.text); } }
    if (rowNums.length) parts.push(`同行已有 ${rowNums.join("/")} 排除`);
    if (colNums.length) parts.push(`同列已有 ${colNums.join("/")} 排除`);
    if (boxNums.length) parts.push(`同宫已有 ${boxNums.join("/")} 排除`);
    return parts.join("；\n") + `；\n${TARGET} 候选仅剩 ${answer}，答案确定（显性唯余）。`;
  }

  // 隐性唯余（行）
  const rowCands = Array.from({ length: 9 }, (_, c) => c).filter(
    (c) => puzzle[TR][c] === 0 && wc[TR][c].has(answer),
  );
  if (rowCands.length === 1 && rowCands[0] === TC) {
    const parts: string[] = [];
    const seenTexts = new Set<string>();
    for (const s of lockedSteps.filter((s) => s.type === "onRow")) {
      if (!seenTexts.has(s.text)) { parts.push(s.text); seenTexts.add(s.text); }
    }
    for (let c = 0; c < 9; c++) {
      if (c === TC || puzzle[TR][c] !== 0 || wc[TR][c].has(answer)) continue;
      const cell = cn(TR, c);
      if (parts.some((p) => p.includes(cell))) continue;
      let done = false;
      for (let i = 0; i < 9 && !done; i++) if (puzzle[i][c] === answer) { parts.push(`${cell} 因第${c + 1}列已有${answer}排除`); done = true; }
      if (!done) {
        const br2 = Math.floor(TR / 3) * 3, bc2 = Math.floor(c / 3) * 3;
        outer: for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++)
          if (puzzle[br2 + dr][bc2 + dc] === answer) { parts.push(`${cell} 因宫内已有${answer}排除`); done = true; break outer; }
      }
      if (!done) parts.push(`${cell} 经区块排除数字${answer}`);
    }
    return parts.join("；\n") + `；\n第${TR + 1}行数字${answer}仅 ${TARGET} 可填，答案确定（隐性唯余·行）。`;
  }

  // 隐性唯余（列）
  const colCands = Array.from({ length: 9 }, (_, r) => r).filter(
    (r) => puzzle[r][TC] === 0 && wc[r][TC].has(answer),
  );
  if (colCands.length === 1 && colCands[0] === TR) {
    const parts: string[] = [];
    const seenTexts = new Set<string>();
    for (const s of lockedSteps.filter((s) => s.type === "onCol")) {
      if (!seenTexts.has(s.text)) { parts.push(s.text); seenTexts.add(s.text); }
    }
    for (let r = 0; r < 9; r++) {
      if (r === TR || puzzle[r][TC] !== 0 || wc[r][TC].has(answer)) continue;
      const cell = cn(r, TC);
      if (parts.some((p) => p.includes(cell))) continue;
      let done = false;
      for (let j = 0; j < 9 && !done; j++) if (puzzle[r][j] === answer) { parts.push(`${cell} 因第${r + 1}行已有${answer}排除`); done = true; }
      if (!done) {
        const br2 = Math.floor(r / 3) * 3, bc2 = Math.floor(TC / 3) * 3;
        outer: for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++)
          if (puzzle[br2 + dr][bc2 + dc] === answer) { parts.push(`${cell} 因宫内已有${answer}排除`); done = true; break outer; }
      }
      if (!done) parts.push(`${cell} 经区块排除数字${answer}`);
    }
    return parts.join("；\n") + `；\n第${TC + 1}列数字${answer}仅 ${TARGET} 可填，答案确定（隐性唯余·列）。`;
  }

  // 隐性唯余（宫）
  const brT = Math.floor(TR / 3) * 3, bcT = Math.floor(TC / 3) * 3;
  const boxCands: [number, number][] = [];
  for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
    const r = brT + dr, c = bcT + dc;
    if (puzzle[r][c] === 0 && wc[r][c].has(answer)) boxCands.push([r, c]);
  }
  if (boxCands.length === 1 && boxCands[0][0] === TR && boxCands[0][1] === TC) {
    const bN = boxNo(TR, TC);
    const parts: string[] = [];
    const seenTexts = new Set<string>();
    for (const s of lockedSteps.filter((s) => s.type === "onBox")) {
      if (!seenTexts.has(s.text)) { parts.push(s.text); seenTexts.add(s.text); }
    }
    for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
      const r = brT + dr, c = bcT + dc;
      if ((r === TR && c === TC) || puzzle[r][c] !== 0 || wc[r][c].has(answer)) continue;
      const cell = cn(r, c);
      if (parts.some((p) => p.includes(cell))) continue;
      let done = false;
      for (let j = 0; j < 9 && !done; j++) if (puzzle[r][j] === answer) { parts.push(`${cell} 因第${r + 1}行已有${answer}排除`); done = true; }
      if (!done) for (let i = 0; i < 9 && !done; i++) if (puzzle[i][c] === answer) { parts.push(`${cell} 因第${c + 1}列已有${answer}排除`); done = true; }
      if (!done) parts.push(`${cell} 经区块排除数字${answer}`);
    }
    return parts.join("；\n") + `；\n第${bN}宫数字${answer}仅 ${TARGET} 可填，答案确定（隐性唯余·宫）。`;
  }

  return `${TARGET} 的答案为 ${answer}（推理路径自动分析失败，请结合难度说明手动推理）。`;
}
