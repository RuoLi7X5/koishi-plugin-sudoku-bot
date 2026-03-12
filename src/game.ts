import { Context, Session, h } from "koishi";
import { Config } from "./index";
import { SudokuGenerator } from "./generator";
import { ImageRenderer } from "./renderer";
import { UserService } from "./user";
import { MOCK_MESSAGES } from "./mockMessages";

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
  userTitleCache: Map<string, string>; // 本局内头衔缓存，避免每次答对都查 DB
};

export class SudokuGame {
  private ctx: Context;
  private config: Config;
  private generator: SudokuGenerator;
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

  // 难度名称映射
  private static readonly DIFFICULTY_NAMES = [
    "", "简单", "较易", "中等", "中等+", "困难", "困难+", "极难"
  ];

  private mockMessages = MOCK_MESSAGES;

  constructor(
    ctx: Context,
    config: Config,
    generator: SudokuGenerator,
    renderer: ImageRenderer,
  ) {
    this.ctx = ctx;
    this.config = config;
    this.generator = generator;
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
      `  ${c.commandScore} - 查看个人积分与档案`,
      `  ${c.commandAchievement} - 查看成就列表`,
      `  ${c.commandAchievement} <成就名> - 查看指定成就详情`,
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
      `  ${c.commandExchange} - 查看可兑换头衔列表`,
      `  ${c.commandExchange} <头衔名> - 用积分兑换头衔`,
      "",
      "📝 玩法说明",
      `  每轮 ${c.rounds} 题，每题限时 ${curTimeout > 0 ? `${curTimeout} 秒` : "无限制（答对才进入下一题）"}`,
      "  答对得分答错扣分，连续答对有积分加成",
      `  完美局（全 ${c.rounds} 题全对，无一答错）可解锁专属成就，探索隐藏成就获得专属头衔！`,
    ].join("\n");
    await session.send(message);
  }

  hasGameInChannel(channelId?: string): boolean {
    if (!channelId) return false;
    return this.games.has(channelId);
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
    };

    this.games.set(session.channelId, newGame);

    // 记录发起游戏次数，同时绑定群成员关系（用于群榜单隔离和"开局之魂"成就）
    if (session.userId) {
      await this.userService.updateUser(session.userId, {
        gamesStartedDelta: 1,
        guildId: session.guildId,
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

    const message = [
      `【${session.username || session.userId} 的数独档案】`,
      `积分：${user.score}`,
      `参与轮数：${user.totalRounds}`,
      `答对/答错：${user.totalCorrect}/${user.totalWrong}`,
      `正确率：${correctRate}`,
      `上局结束连击：${user.streak}`,
      `历史最高连击：${user.maxStreak}`,
      `完美局数：${user.perfectRounds} 💯`,
      `MVP次数：${user.mvpCount} 🏆`,
      `已解锁成就：${(user.achievements ?? []).length} 个（输入「${this.config.commandAchievement}」查看详情）`,
      `当前头衔：${user.titles.filter(t => t.expire > Date.now()).map(t => t.name).join("、") || "无"}`,
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
      const text = await this.userService.getAchievementListText(
        session.userId,
        session.username || session.userId,
        this.config.commandAchievement,
      );
      await session.send(text);
    }
  }

  async showRank(session: Session, type: string = "积分") {
    // 解析 "全服" 前缀：全服模式不过滤群成员
    let isGlobal = false;
    let effectiveType = type;
    if (type.startsWith("全服")) {
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
      users = users.filter((u) => u.totalCorrect + u.totalWrong >= 5);
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
      let nickname = u.userId;
      try {
        if (session.guildId) {
          const member = await session.bot.getGuildMember?.(session.guildId, u.userId);
          nickname = (member as any)?.nickname ?? (member as any)?.name ?? u.userId;
        }
      } catch { /* 忽略 */ }
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
        let nickname = uid;
        try {
          if (session.guildId) {
            const member = await session.bot.getGuildMember?.(session.guildId, uid);
            nickname = (member as any)?.nickname ?? (member as any)?.name ?? uid;
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
        `输入「${this.config.commandExchange} <头衔名>」即可兑换`,
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

  private async askNextQuestion(session: Session, game: GameState) {
    // 确认游戏仍存在（可能被 stop 提前终止）
    if (!this.games.has(game.channelId)) return;

    if (game.timer) clearTimeout(game.timer);

    if (game.currentRound >= game.totalRounds) {
      await this.endGame(session, game);
      return;
    }

    // 每道题生成一道全新盘面
    const gen = new SudokuGenerator(game.difficulty);
    const { puzzle, solution } = gen.generate();

    // 随机挑选一个空格（puzzle 中值为 0 的格子）作为本题答案位置
    // 正常情况下 solution 所有格子均为 1-9；solution[r][c] !== 0 作为生成器异常的最后兜底
    const emptyCells: { row: number; col: number }[] = [];
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (puzzle[r][c] === 0 && solution[r][c] !== 0) {
          emptyCells.push({ row: r, col: c });
        }
      }
    }
    if (emptyCells.length === 0) {
      this.ctx.logger("sudoku").warn("生成题目异常：无有效空格，重新生成本轮盘面");
      await this.askNextQuestion(session, game);
      return;
    }
    const q = emptyCells[Math.floor(Math.random() * emptyCells.length)];

    // 更新当前题的状态
    game.currentPuzzle = puzzle;
    game.currentSolution = solution;
    game.currentQuestion = q;

    // 发送本题盘面图片
    const difficultyLabel = `level ${game.difficulty}`;
    const logger = this.ctx.logger("sudoku");
    try {
      const image = await this.renderer.render(puzzle, difficultyLabel, q);
      if (!image || image.length === 0) {
        logger.error("Canvas 返回空 Buffer，图片生成失败");
        await session.send("⚠️ 图片生成失败，但游戏继续。");
      } else {
        await session.send(h.image(`data:image/png;base64,${image.toString("base64")}`));
        logger.info(`第 ${game.currentRound + 1} 题盘面发送（${image.length} bytes）`);
      }
    } catch (error: any) {
      logger.error("图片渲染失败：", error);
      await session.send(`⚠️ 图片渲染失败：${error.message}\n游戏继续，请根据坐标答题。`);
    }

    const coord = this.formatCoord(q.row, q.col);
    await session.send(`第${game.currentRound + 1}题：${coord}格应该填什么？`);

    game.answered = false;
    game.questionStartTime = Date.now();

    // 每次出题重置无人参与超时计时器
    this.resetInactivityTimer(session, game);

    if (game.currentTimeout > 0) {
      // 有时间限制：倒计时结束后公布答案并进入下一题
      game.timer = setTimeout(async () => {
        const currentGame = this.games.get(game.channelId);
        if (!currentGame || currentGame !== game) return;
        if (!game.answered) {
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
      // 无时间限制：不设定时器，等待有人答对才进入下一题
      game.timer = null;
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

    // 有玩家应答，更新活动时间并重置无人超时计时器
    game.lastActivityTime = Date.now();
    this.resetInactivityTimer(session, game);

    const q = game.currentQuestion;
    const correct = game.currentSolution[q.row][q.col];

    if (number !== correct) {
      this.updateParticipant(game, session.userId, false, answerTime);
      // 单人嘲讽：50%概率触发
      if (Math.random() < 0.5) {
        const mockMsg = this.getRandomMock("singleMock", {
          user: session.username || session.userId,
          penalty: this.config.penalty,
        });
        await session.send(mockMsg);
      } else {
        await session.send(`${h.at(session.userId)} 答错了，扣 ${this.config.penalty} 分。`);
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
    await session.send(`恭喜 ${displayName} 答对！+${earned} 分（连续${participant.streak}次）。`);

    game.currentRound++;
    await this.askNextQuestion(session, game);
  }

  private updateParticipant(
    game: GameState,
    userId: string,
    isCorrect: boolean,
    answerTime?: number,
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
      p.score -= this.config.penalty;
    }
    return p;
  }

  /**
   * @param isComplete 是否完整完成所有轮次。
   *   - true（正常结束）：完整结算积分、MVP、垫底、成就、荣誉头衔。
   *   - false（提前结束）：仅记录参与次数和答对次数，不结算积分/成就/荣誉头衔。
   */
  private async endGame(session: Session, game: GameState, isComplete = true) {
    if (game.timer) clearTimeout(game.timer);
    if (game.inactivityTimer) clearTimeout(game.inactivityTimer);
    game.inactivityTimer = null;
    this.games.delete(game.channelId);

    const participants = Array.from(game.participants.entries());
    if (participants.length > 0) {
      const sorted = participants.sort((a, b) => b[1].score - a[1].score);

      // ── 1. 构建昵称缓存（单次 API 调用，排行榜与成就检测共用）──
      const nicknameMap = new Map<string, string>();
      for (const [uid] of participants) {
        let nickname = uid;
        try {
          if (session.guildId) {
            const member = await session.bot.getGuildMember?.(session.guildId, uid);
            nickname = (member as any)?.nickname ?? (member as any)?.name ?? uid;
          }
        } catch { /* 忽略 */ }
        nicknameMap.set(uid, nickname);
      }

      // ── 2. 预加载用户数据（单次 DB 读取，供排行榜头衔展示 + prevConsecutiveLastPlaces 复用）──
      const preUpdateUsers = new Map<string, any>();
      for (const [uid] of participants) {
        preUpdateUsers.set(uid, await this.userService.getUser(uid));
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

      // ─── 提前结束：仅记录参与次数和答对次数，不计积分/成就/荣誉头衔 ───
      if (!isComplete) {
        for (const [uid, data] of participants) {
          await this.userService.updateUser(uid, {
            correctDelta: data.correct,
            roundsDelta: 1,
            guildId: game.guildId,
          });
        }
        return;
      }

      // 以下仅完整完成时执行 ↓↓↓

      // 垫底判定
      const isMultiPlayer = participants.length > 1;
      const lowestScore = sorted[sorted.length - 1][1].score;
      const lowestCount = isMultiPlayer
        ? sorted.filter(([, d]) => d.score === lowestScore).length
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
          if (data.score === lowestScore && lowestCount === 1) {
            isLastPlace = true;
          } else if (data.score > lowestScore) {
            isLastPlace = false;
          }
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
          send: (msg: string) => session.bot.sendMessage(game.channelId, msg),
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

  private getRandomMock(type: "groupMock" | "singleMock", params: Record<string, any>): string {
    const messages = this.mockMessages[type];
    const template = messages[Math.floor(Math.random() * messages.length)];
    return template.replace(/\{(\w+)\}/g, (_, key) => params[key] || "");
  }

  private formatCoord(row: number, col: number): string {
    // 行用字母（A=第1行，从上往下），列用数字（1=第1列，从左往右）
    // 与玩家直觉一致：A6 = 第A行第6列
    const rowLetter = String.fromCharCode(65 + row); // A-I（行，从上到下）
    return `${rowLetter}${col + 1}`; // 列 1-9（从左到右）
  }

}
