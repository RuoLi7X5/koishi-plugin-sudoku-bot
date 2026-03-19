import { Context, Session, h } from "koishi";
import { Config } from "./index";
import { SudokuGenerator } from "./generator";
import { ImageRenderer, TrainingRenderData } from "./renderer";
import { UserService } from "./user";
import { MOCK_MESSAGES } from "./mockMessages";
import { HintManager } from "./hint";
import { solve, formatCompactSteps, checkPuzzleIntuitiveSolvable } from "./solver";

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
  questionStartTime: number;          // 出题时间戳
  wrongAttempts: Map<string, number>; // userId → 本题错误次数
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
  mode: 'basic' | 'advanced';        // 训练模式：basic=难度1纯唯余，advanced=难度2带干扰项唯余
  // 题目池：预生成并预渲染的训练题队列，可直接发送
  questionPool: PregeneratedTrainingQuestion[];
  poolNextQueuedIndex: number;        // 下一个待排入池的题号（始终领先于 currentQuestionIndex）
  poolFilling: boolean;               // 防止并发填充
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
      `  ${c.commandHint} a1 - 查询题目 a1 的推理解法（游戏结束后可用，24小时内有效）`,
    "",
    "🎯 唯余训练",
    `  ${c.commandTrainingStart} - 开始唯余训练（难度1：找出盘面中唯一的缺失数字）`,
    `  ${c.commandTrainingStart} 2 - 开始唯余训练难度2（加入视觉干扰项，不能靠"一眼少哪个"）`,
    `  ${c.commandTrainingStop} - 结束本轮训练并查看统计报告`,
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
  async startTraining(session: Session, mode: 'basic' | 'advanced' = 'basic'): Promise<void> {
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

    const ts: TrainingSession = {
      channelId: key,
      startTime: Date.now(),
      currentQuestion: null,
      currentQuestionIndex: 0,
      finishedQuestions: 0,
      participants: new Map(),
      mode,
      questionPool: [],
      poolNextQueuedIndex: 2, // 第1题由 nextTrainingQuestion 实时生成，池从第2题起预填
      poolFilling: false,
    };
    this.trainings.set(key, ts);

    // 开局即刻开始后台预生成题目池（利用发欢迎消息和渲染第1题的时间）
    this.fillTrainingPool(ts);

    if (mode === 'advanced') {
      await session.send(
        "🎯 唯余训练【难度2】开始！\n" +
        "盘面中恰好有一格可以用「唯余法」填入数字。\n" +
        "⚠️ 注意：盘面已加入视觉干扰数字，不能仅凭「哪个数少」来判断，需仔细对行/列/宫逐一排除！\n" +
        "输入 1-9 作答。\n" +
        "输入「" + this.config.commandTrainingStop + "」可结束本轮训练并查看报告。",
      );
    } else {
      await session.send(
        "🎯 唯余训练【难度1】开始！\n盘面中恰好有一格可以用「唯余法」填入数字，输入 1-9 作答。\n输入「" +
        this.config.commandTrainingStop +
        "」可结束本轮训练并查看报告。",
      );
    }
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

    // 答对
    const elapsed = Date.now() - cq.questionStartTime;
    participant.correct++;
    participant.correctAnswers.push({
      questionIndex: ts.currentQuestionIndex,
      elapsedMs: elapsed,
    });
    ts.finishedQuestions++;
    ts.currentQuestion = null;

    // 答对反馈：格式 "唯余:X 答对了！（XX秒）"
    const secs = elapsed < 1000
      ? (elapsed / 1000).toFixed(1)
      : String(Math.round(elapsed / 1000));
    await session.send(`唯余:${cq.answer} 答对了！（${secs}秒）`);

    // 检查训练是否已被停止（stopTraining 可能在 await 期间调用）
    if (!this.trainings.has(ts.channelId)) return;

    // 出下一题
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

  /** 训练题目池容量（预渲染图片数，每张约 100-200 KB，10 张 ≈ 1.5 MB） */
  private readonly TRAINING_POOL_SIZE = 10;

  /**
   * 后台持续填充训练题目池（fire-and-forget）。
   * 使用 setImmediate 确保填充从下一事件循环迭代开始，不阻塞当前消息收发。
   * 每次填充一道（生成盘面 + Canvas 渲染），完成后递归补充直到池满。
   * poolNextQueuedIndex 追踪下一个要加入池的题号，题号与渲染标签严格对应。
   */
  private fillTrainingPool(ts: TrainingSession): void {
    if (ts.poolFilling) return;
    if (ts.questionPool.length >= this.TRAINING_POOL_SIZE) return;
    if (!this.trainings.has(ts.channelId)) return;

    ts.poolFilling = true;

    setImmediate(async () => {
      try {
        // 每次调用最多连续填充直到池满或训练结束
        let consecutive_failures = 0;
        while (
          ts.questionPool.length < this.TRAINING_POOL_SIZE &&
          this.trainings.has(ts.channelId) &&
          consecutive_failures < 3
        ) {
          const idx = ts.poolNextQueuedIndex++;
          const labelPrefix = ts.mode === 'advanced' ? '唯余训练【难度2】' : '唯余训练【难度1】';
          const label = `${labelPrefix} · 第${idx}题`;
          try {
            const { puzzle, answer } = ts.mode === 'advanced'
              ? this.generateAdvancedTrainingPuzzle()
              : this.generateTrainingPuzzle();
            const imgBuf = await this.renderer.render(puzzle, label, undefined, undefined);
            if (!this.trainings.has(ts.channelId)) break;
            ts.questionPool.push({ puzzle, answer, renderedImage: imgBuf, label, questionIndex: idx });
            consecutive_failures = 0;
          } catch {
            consecutive_failures++;
            this.ctx.logger("sudoku").warn(`训练池填充第${idx}题失败（连续失败 ${consecutive_failures} 次）`);
          }
        }
      } finally {
        ts.poolFilling = false;
        // 若池仍未满（部分失败），延迟重试
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
    const labelPrefix = ts.mode === 'advanced' ? '唯余训练【难度2】' : '唯余训练【难度1】';
    const label = `${labelPrefix} · 第${expectedIndex}题`;

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

    // questionStartTime 将在图片发出后设置（finally 块），确保计时从玩家看到题目时开始
    const cq: TrainingQuestion = {
      answer: 0,
      questionStartTime: 0,
      wrongAttempts: new Map(),
    };
    ts.currentQuestion = cq;

    try {
      if (poolEntry) {
        // ── 路径A：命中题目池——直接发送预渲染图片（仅剩网络传输延迟）─────────────
        cq.answer = poolEntry.answer;
        if (!this.trainings.has(ts.channelId)) return;
        await this.sendImage(session, poolEntry.renderedImage);
      } else {
        // ── 路径B：池未就绪——实时生成 + 渲染（退化路径，通常仅第1题触发）──────────
        const { puzzle, answer } = ts.mode === 'advanced'
          ? this.generateAdvancedTrainingPuzzle()
          : this.generateTrainingPuzzle();
        cq.answer = answer;
        const imgBuf = await this.renderer.render(puzzle, label, undefined, undefined);
        if (!this.trainings.has(ts.channelId)) return;
        await this.sendImage(session, imgBuf);
      }
    } catch (err: any) {
      if (!this.trainings.has(ts.channelId)) return;
      logger.warn("唯余训练图片渲染/发送失败：", err);
      if (cq.answer === 0) {
        // 路径B生成失败，answer 还未设置，补一个
        const { answer } = ts.mode === 'advanced'
          ? this.generateAdvancedTrainingPuzzle()
          : this.generateTrainingPuzzle();
        cq.answer = answer;
      }
      await session.send(`📋 ${label}（图片渲染失败，请输入 1-9 作答）`);
    } finally {
      // 图片发出后启动计时
      cq.questionStartTime = Date.now();
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
    const modeLabel = ts.mode === 'advanced' ? '唯余训练【难度2】' : '唯余训练【难度1】';
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
