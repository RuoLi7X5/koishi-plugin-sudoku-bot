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
  puzzle: number[][];
  solution: number[][];
  questions: { row: number; col: number }[];
  currentIndex: number;
  difficulty: number;
  participants: Map<
    string,
    {
      score: number;
      correct: number;
      wrong: number;
      streak: number;       // 当前连击数（答错重置）
      maxStreak: number;    // 本局最高连击数
      answerTimes: number[];
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
  private currentDifficulty: number;

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
  }

  // ==================== 公开方法 ====================

  async showHelp(session: Session) {
    const c = this.config;
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
      `  ${c.commandRank} [类型] - 查看排行榜`,
      "    类型：积分 / 答对 / 参与 / 正确率 / MVP / 完美 / 成就",
      "",
      "⚙️ 设置指令",
      `  ${c.commandDifficulty} <1-7> - 设置默认难度`,
      "    1简单  2较易  3中等  4中等+  5困难  6困难+  7极难",
      "",
      "🎖️ 头衔指令",
      `  ${c.commandExchange} - 查看可兑换头衔列表`,
      `  ${c.commandExchange} <头衔名> - 用积分兑换头衔`,
      "",
      "📝 玩法说明",
      `  每轮 ${c.rounds} 题，每题限时 ${c.timeout} 秒内抢答`,
      "  答对得分答错扣分，连续答对有积分加成",
      "  完美局（全对）可解锁专属成就，探索隐藏成就获得专属头衔！",
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

    // 确定使用的难度：优先使用参数，否则使用当前设置
    let useDifficulty = this.currentDifficulty;
    if (difficulty !== undefined) {
      if (difficulty < 1 || difficulty > 7) {
        await session.send("难度级别必须在 1-7 之间。\n1-简单 2-较易 3-中等 4-中等+ 5-困难 6-困难+ 7-极难");
        return;
      }
      useDifficulty = difficulty;
    }

    // 使用指定难度生成题目
    this.generator = new SudokuGenerator(useDifficulty);
    const { puzzle, solution } = this.generator.generate();
    const questions = this.selectQuestions(puzzle, this.config.rounds);

    const difficultyLabel = `level ${useDifficulty}`;
    const logger = this.ctx.logger("sudoku");

    try {
      const image = await this.renderer.render(puzzle, difficultyLabel);
      if (!image || image.length === 0) {
        logger.error("Canvas 返回空 Buffer，图片生成失败");
        await session.send("⚠️ 图片生成失败，但游戏继续。");
      } else {
        const base64Image = `data:image/png;base64,${image.toString("base64")}`;
        await session.send(h.image(base64Image));
        logger.info(`题目图片发送完成（${image.length} bytes）`);
      }
    } catch (error: any) {
      logger.error("图片渲染失败：", error);
      await session.send(`⚠️ 图片渲染失败：${error.message}\n游戏继续，请根据坐标答题。`);
    }

    const newGame: GameState = {
      channelId: session.channelId,
      guildId: session.guildId,
      puzzle,
      solution,
      questions,
      currentIndex: 0,
      difficulty: useDifficulty,
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
    if (game.timer) clearTimeout(game.timer);

    const completedQuestions = game.currentIndex;

    if (game.participants.size > 0) {
      await session.send(`游戏被提前结束！已完成 ${completedQuestions}/${game.questions.length} 题。\n正在结算...`);
      await this.endGame(session, game);
    } else {
      await session.send("游戏已结束。");
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
    this.currentDifficulty = level;
    await session.send(`已设置难度为：${SudokuGame.DIFFICULTY_NAMES[level]}（级别 ${level}）`);
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
      `当前连续答对：${user.streak}`,
      `历史最高连续：${user.maxStreak}`,
      `完美局数：${user.perfectRounds} 💯`,
      `MVP次数：${user.mvpCount} 🏆`,
      `已解锁成就：${(user.achievements ?? []).length} 个`,
      `当前头衔：${user.titles.filter(t => t.expire > Date.now()).map(t => t.name).join("、") || "无"}`,
    ].join("\n");

    await session.send(message);
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

    const currentQuestion = game.currentIndex + 1;
    const totalQuestions = game.questions.length;
    const elapsed = Math.floor((Date.now() - game.questionStartTime) / 1000);
    const remaining = Math.max(0, this.config.timeout - elapsed);
    const participantCount = game.participants.size;
    const topScorers = Array.from(game.participants.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 3);

    let message = `【游戏进度】\n`;
    message += `当前题目：第 ${currentQuestion}/${totalQuestions} 题\n`;
    message += `剩余时间：${remaining} 秒\n`;
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

    if (game.currentIndex >= game.questions.length) {
      await this.endGame(session, game);
      return;
    }

    const q = game.questions[game.currentIndex];
    const coord = this.formatCoord(q.row, q.col);
    await session.send(`第${game.currentIndex + 1}题：${coord}格应该填什么？`);

    game.answered = false;
    game.questionStartTime = Date.now();
    game.timer = setTimeout(async () => {
      // 校验游戏是否仍是同一局（防止已停止/重开后的定时器触发）
      const currentGame = this.games.get(game.channelId);
      if (!currentGame || currentGame !== game) return;
      if (!game.answered) {
        const answer = game.solution[q.row][q.col];
        // 群嘲逻辑：参与人数 >=2 时触发
        if (game.participants.size >= 2) {
          const mockMsg = this.getRandomMock("groupMock", { answer });
          await session.send(mockMsg);
        } else {
          await session.send(`时间到！答案是 ${answer}。`);
        }
        game.currentIndex++;
        await this.askNextQuestion(session, game);
      }
    }, this.config.timeout * 1000);
  }

  async handleAnswer(session: Session, number: number) {
    if (!session.channelId) return;
    const game = this.games.get(session.channelId);
    if (!game) return;
    if (game.answered) return;
    if (!session.userId) return;

    // 计算答题用时，至少为1秒（避免网络延迟导致负数）
    const answerTime = Math.max(1, Math.floor((Date.now() - game.questionStartTime) / 1000));

    const q = game.questions[game.currentIndex];
    const correct = game.solution[q.row][q.col];

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

    game.currentIndex++;
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
        answerTimes: [],
        correctAnswerTimes: [],
        answerPattern: [],
        lastSecondCount: 0,
      };
      game.participants.set(userId, p);
    }

    if (answerTime !== undefined) {
      p.answerTimes.push(answerTime);
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
        // 检测是否为最后5秒答对
        if (answerTime >= this.config.timeout - 5) {
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

  private async endGame(session: Session, game: GameState) {
    if (game.timer) clearTimeout(game.timer);
    // 从游戏表中移除，防止后续定时器重复触发
    this.games.delete(game.channelId);

    const participants = Array.from(game.participants.entries());
    if (participants.length > 0) {
      const sorted = participants.sort((a, b) => b[1].score - a[1].score);

      // 计算MVP：多人局中得分最高且答对至少1题（单人局无MVP概念，避免刷成就）
      let mvpUserId: string | null = null;
      if (participants.length > 1) {
        for (const [uid, data] of sorted) {
          if (data.correct > 0) {
            mvpUserId = uid;
            break;
          }
        }
      }

      let message = "本轮游戏结束！\n\n【得分排行榜】\n";
      let mvpDisplayName = mvpUserId ?? "";
      for (let index = 0; index < sorted.length; index++) {
        const [uid, data] = sorted[index];
        const isMVP = uid === mvpUserId;
        const prefix = isMVP ? "👑 " : "";
        const correctRate =
          data.correct + data.wrong === 0
            ? "0%"
            : ((data.correct / (data.correct + data.wrong)) * 100).toFixed(1) + "%";
        let nickname = uid;
        try {
          if (session.guildId) {
            const member = await session.bot.getGuildMember?.(session.guildId, uid);
            nickname = (member as any)?.nickname ?? (member as any)?.name ?? uid;
          }
        } catch { /* 忽略 */ }
        const u = await this.userService.getUser(uid);
        const titlePrefix = this.userService.getDisplayTitle(u);
        const nameDisplay = titlePrefix ? `${titlePrefix}${nickname}` : nickname;
        if (isMVP) mvpDisplayName = nameDisplay;
        message += `${prefix}${index + 1}. ${nameDisplay}：${data.score}分（✅${data.correct} ❌${data.wrong} 正确率${correctRate}）\n`;
      }

      if (participants.length === 1) {
        // 单人局不评 MVP，无需播报
      } else if (mvpUserId) {
        message += `\n🎉 本局MVP：${mvpDisplayName}`;
      } else {
        message += `\n本局无人答对，无MVP。`;
      }

      await session.send(message);

      // 垫底判定：
      //   多人局且唯一最低分 → true（计入垫底）
      //   多人局且并列最低分 → undefined（不计、不重置，避免并列误惩）
      //   多人局且非最低分  → false（重置连续垫底）
      //   单人局            → undefined（无对手语境，不影响垫底统计）
      const isMultiPlayer = participants.length > 1;
      const lowestScore = sorted[sorted.length - 1][1].score;
      const lowestCount = isMultiPlayer
        ? sorted.filter(([, d]) => d.score === lowestScore).length
        : 0;

      // 提前记录各玩家的连续垫底数（用于 rise_from_ashes 成就检测）
      const prevConsecutiveLastPlaces = new Map<string, number>();
      for (const [uid] of participants) {
        const u = await this.userService.getUser(uid);
        prevConsecutiveLastPlaces.set(uid, u.consecutiveLastPlace);
      }

      for (const [uid, data] of participants) {
        // 完美局：无错答且答对至少一半题目（允许中途加入的玩家也有机会）
        const isPerfect = data.wrong === 0 && data.correct >= Math.ceil(game.questions.length / 2);
        const isMVP = uid === mvpUserId;
        let isLastPlace: boolean | undefined;
        if (isMultiPlayer) {
          if (data.score === lowestScore && lowestCount === 1) {
            isLastPlace = true;          // 唯一垫底
          } else if (data.score > lowestScore) {
            isLastPlace = false;         // 非垫底，重置连续计数
          }
          // 并列最低：isLastPlace = undefined，不变
        }
        // 单人局：isLastPlace = undefined，不变
        await this.userService.updateUser(uid, {
          scoreDelta: data.score,
          correctDelta: data.correct,
          wrongDelta: data.wrong,
          roundsDelta: 1,
          perfectDelta: isPerfect ? 1 : 0,
          mvpDelta: isMVP ? 1 : 0,
          isLastPlace,
          isMvp: isMultiPlayer ? isMVP : undefined, // 单人局不影响连续MVP统计
          finalStreak: data.streak,         // 本局结束时的当前连击
          maxInGameStreak: data.maxStreak,  // 本局最高连击
          guildId: game.guildId,            // 记录群成员关系
        });
      }

      // 检查成就（包含隐藏成就）
      for (const [uid, data] of participants) {
        let username = uid;
        try {
          if (session.guildId) {
            const member = await session.bot.getGuildMember?.(session.guildId, uid);
            username = (member as any)?.nickname ?? (member as any)?.name ?? uid;
          }
        } catch { /* 忽略 */ }

        const isMVP = uid === mvpUserId;
        const isAlone = participants.length === 1;
        const leadMargin = sorted.length > 1 && isMVP
          ? sorted[0][1].score - sorted[1][1].score
          : 0;

        const answerPattern = data.answerPattern; // 直接传数组，user.ts 侧消除 split/join 往返
        // 使用仅答对的用时，排除答错时间对 speed_demon / zen_master 的干扰
        const fastestAnswer = data.correctAnswerTimes.length > 0 ? Math.min(...data.correctAnswerTimes) : undefined;
        const averageTime = data.correctAnswerTimes.length > 0
          ? data.correctAnswerTimes.reduce((a, b) => a + b, 0) / data.correctAnswerTimes.length
          : undefined;

        // 加 length >= N 防护，避免 JS 空数组 .every() 返回 true 的 vacuous truth 问题
        const firstThreeCorrect = data.answerPattern.length >= 3 &&
          data.answerPattern.slice(0, 3).every(p => p === "对");
        const first5Wrong = data.answerPattern.slice(0, 5).filter(p => p === "错").length;
        const last3Correct = data.answerPattern.length >= 3 &&
          data.answerPattern.slice(-3).every(p => p === "对");
        const comebackPattern = { first5Wrong, last3Correct: last3Correct ? 3 : 0 };
        const wrongButMvp = isMVP && data.wrong >= 3;
        // zen_master：每次答对时剩余时间在 15-20 秒（即用时在 timeout-20 ~ timeout-15 秒内）
        const zenPattern = data.correctAnswerTimes.length > 0 &&
          data.correctAnswerTimes.every(t => {
            const remaining = this.config.timeout - t;
            return remaining >= 15 && remaining <= 20;
          });

        const tempSession = {
          ...session,
          userId: uid,
          username: username,
          send: (msg: string) => session.bot.sendMessage(game.channelId, msg),
        } as any;

        await this.userService.checkAchievements(uid, {
          correct: data.correct,
          wrong: data.wrong,
          score: data.score,
          streak: data.maxStreak,  // 传本局最高连击，用于成就条件检测
          answerPattern,
          fastestAnswer,
          averageTime,
          lastSecondAnswers: data.lastSecondCount,
          firstThreeCorrect,
          comebackPattern,
          isAlone,
          leadMargin,
          wrongButMvp,
          zenPattern,
          prevConsecutiveLastPlace: prevConsecutiveLastPlaces.get(uid) ?? 0,
          isCurrentMvp: uid === mvpUserId,
        }, tempSession);
      }

      await this.userService.updateHonorTitles(game.guildId || "", session);

      // 发送完整答案图片
      const difficultyLabel = `level ${game.difficulty}`;
      try {
        await session.send("📋 完整答案：");
        const solutionImage = await this.renderer.render(game.solution, difficultyLabel);
        if (solutionImage && solutionImage.length > 0) {
          const base64Solution = `data:image/png;base64,${solutionImage.toString("base64")}`;
          await session.send(h.image(base64Solution));
        } else {
          await session.send("⚠️ 答案图片生成失败");
        }
      } catch (error: any) {
        this.ctx.logger("sudoku").error("答案图片渲染失败：", error);
        await session.send("⚠️ 答案图片生成失败");
      }
    } else {
      await session.send("本轮游戏无人参与，结束。");
    }
  }

  // ==================== 辅助方法 ====================

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

  private selectQuestions(puzzle: number[][], count: number): { row: number; col: number }[] {
    const emptyCells: { row: number; col: number }[] = [];
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (puzzle[r][c] === 0) emptyCells.push({ row: r, col: c });
      }
    }
    // Fisher-Yates 洗牌算法，保证均匀随机
    for (let i = emptyCells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [emptyCells[i], emptyCells[j]] = [emptyCells[j], emptyCells[i]];
    }
    // 空格数不足时返回所有可用空格，避免崩溃
    if (emptyCells.length < count) {
      this.ctx.logger("sudoku").warn(`空格数不足，期望${count}个，实际${emptyCells.length}个`);
      return emptyCells;
    }
    return emptyCells.slice(0, count);
  }
}
