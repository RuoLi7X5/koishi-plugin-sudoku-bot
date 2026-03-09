import { Context, Session, h } from "koishi";
import { Config } from "./index";
import { SudokuGenerator } from "./generator";
import { ImageRenderer } from "./renderer";
import { UserService } from "./user";

export class SudokuGame {
  private ctx: Context;
  private config: Config;
  private generator: SudokuGenerator;
  private renderer: ImageRenderer;
  private userService: UserService;

  private currentGame: {
    channelId: string;
    guildId?: string;
    puzzle: number[][];
    solution: number[][];
    questions: { row: number; col: number }[];
    currentIndex: number;
    participants: Map<
      string,
      { score: number; correct: number; wrong: number; streak: number }
    >;
    timer: any;
    answered: boolean;
  } | null = null;

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
  }

  // ==================== 公开方法 ====================

  async start(session: Session) {
    if (this.currentGame) {
      await session.send("当前已有游戏在进行中，请稍后。");
      return;
    }

    const { puzzle, solution } = this.generator.generate();
    const questions = this.selectQuestions(puzzle, this.config.rounds);

    const image = await this.renderer.render(puzzle);
    // 使用 h.image 将 Buffer 转换为可发送的图片元素
    await session.send(h.image(image, "image/png"));

    // 确保 channelId 存在（群聊中一定有）
    if (!session.channelId) {
      await session.send("无法在私聊中开始游戏。");
      return;
    }

    this.currentGame = {
      channelId: session.channelId,
      guildId: session.guildId,
      puzzle,
      solution,
      questions,
      currentIndex: 0,
      participants: new Map(),
      timer: null,
      answered: false,
    };

    await this.askNextQuestion(session);
  }

  async stop(session: Session) {
    // 检查权限：使用 authority（需要用户对象存在）
    const userAuth = (session.user as any)?.authority ?? 0;
    if (userAuth < 4) {
      await session.send("只有管理员可以使用结束命令。");
      return;
    }

    if (!this.currentGame) {
      await session.send("当前没有进行中的游戏。");
      return;
    }

    if (this.currentGame.timer) clearTimeout(this.currentGame.timer);
    this.currentGame = null;
    await session.send("游戏已强制结束。");
  }

  async showScore(session: Session) {
    // 确保 userId 存在
    if (!session.userId) {
      await session.send("无法获取用户信息。");
      return;
    }
    const user = await this.userService.getUser(session.userId);
    const correctRate =
      user.totalCorrect + user.totalWrong === 0
        ? "暂无"
        : (
            (user.totalCorrect / (user.totalCorrect + user.totalWrong)) *
            100
          ).toFixed(1) + "%";

    const message = [
      `【${session.username || session.userId} 的数独档案】`,
      `积分：${user.score}`,
      `参与轮数：${user.totalRounds}`,
      `答对/答错：${user.totalCorrect}/${user.totalWrong}`,
      `正确率：${correctRate}`,
      `当前连续答对：${user.streak}`,
      `历史最高连续：${user.maxStreak}`,
      `已解锁成就：${user.achievements.length} 个`,
      `当前头衔：${user.titles.map((t) => t.name).join("、") || "无"}`,
    ].join("\n");

    await session.send(message);
  }

  async showRank(session: Session, type: string = "score") {
    let users = await this.ctx.database.get("sudoku_user", {});
    if (users.length === 0) {
      await session.send("暂无数据。");
      return;
    }

    let sorted: any[] = [];
    const typeMap: Record<
      string,
      { field: string; desc: boolean; name: string }
    > = {
      score: { field: "score", desc: true, name: "积分榜" },
      correct: { field: "totalCorrect", desc: true, name: "答对榜" },
      rounds: { field: "totalRounds", desc: true, name: "参与榜" },
      rate: { field: "rate", desc: true, name: "正确率榜" },
    };

    const selected = typeMap[type] || typeMap.score;
    const title = selected.name;

    if (type === "rate") {
      users = users.filter((u) => u.totalCorrect + u.totalWrong >= 5);
      const usersWithRate = users.map((u) => ({
        ...u,
        rate: u.totalCorrect / (u.totalCorrect + u.totalWrong) || 0,
      })) as any[];
      sorted = usersWithRate.sort((a, b) => b.rate - a.rate).slice(0, 10);
    } else {
      // 使用类型断言绕过索引签名问题
      sorted = (users as any[])
        .sort((a, b) => b[selected.field] - a[selected.field])
        .slice(0, 10);
    }

    const lines = [`【${title} TOP 10】`];
    for (let i = 0; i < sorted.length; i++) {
      const u = sorted[i];
      let nickname = u.userId;
      try {
        if (session.guildId) {
          const member = await session.bot.getGuildMember?.(
            session.guildId,
            u.userId,
          );
          // 兼容不同适配器的字段名
          nickname =
            (member as any)?.nickname ?? (member as any)?.name ?? u.userId;
        }
      } catch {
        // 忽略错误
      }
      if (type === "rate") {
        lines.push(
          `${i + 1}. ${nickname}：${(u.rate * 100).toFixed(1)}% (答对${u.totalCorrect}，答错${u.totalWrong})`,
        );
      } else {
        lines.push(`${i + 1}. ${nickname}：${u[selected.field]}`);
      }
    }

    await session.send(lines.join("\n"));
  }

  async exchangeTitle(session: Session, titleName: string) {
    if (!session.userId) {
      await session.send("无法获取用户信息。");
      return;
    }
    const success = await this.userService.exchangeTitle(
      session.userId,
      titleName,
    );
    if (success) {
      await session.send(`兑换成功！你现在拥有头衔“${titleName}”。`);
    } else {
      await session.send("兑换失败，可能积分不足或头衔不存在。");
    }
  }

  // ==================== 内部游戏流程 ====================

  private async askNextQuestion(session: Session) {
    if (!this.currentGame) return;
    const game = this.currentGame;

    if (game.timer) clearTimeout(game.timer);

    if (game.currentIndex >= game.questions.length) {
      await this.endGame(session);
      return;
    }

    const q = game.questions[game.currentIndex];
    const coord = this.formatCoord(q.row, q.col);
    await session.send(`第${game.currentIndex + 1}题：${coord}格应该填什么？`);

    game.answered = false;
    game.timer = setTimeout(async () => {
      if (!this.currentGame || this.currentGame !== game) return;
      if (!game.answered) {
        const answer = game.solution[q.row][q.col];
        await session.send(`时间到！答案是 ${answer}。没人答对，下一题。`);
        game.currentIndex++;
        await this.askNextQuestion(session);
      }
    }, this.config.timeout * 1000);
  }

  async handleAnswer(session: Session, number: number) {
    if (!this.currentGame) return;
    const game = this.currentGame;
    if (session.channelId !== game.channelId) return;
    if (game.answered) return;
    if (!session.userId) return; // 忽略无用户ID的消息

    const q = game.questions[game.currentIndex];
    const correct = game.solution[q.row][q.col];

    if (number !== correct) {
      await this.updateParticipant(session.userId, false);
      await session.send(
        `@${session.username || session.userId} 答错了，扣 ${this.config.penalty} 分。`,
      );
      return;
    }

    clearTimeout(game.timer);
    game.answered = true;
    const participant = await this.updateParticipant(session.userId, true);
    if (!participant) return; // 理论上不会为 null
    const earned =
      this.config.baseScore +
      (participant.streak - 1) * this.config.streakBonus;

    await session.send(
      `恭喜 @${session.username || session.userId} 答对！+${earned} 分（连续${participant.streak}次）。`,
    );

    game.currentIndex++;
    await this.askNextQuestion(session);
  }

  private async updateParticipant(userId: string, isCorrect: boolean) {
    if (!this.currentGame) return null;
    const game = this.currentGame;
    let p = game.participants.get(userId);
    if (!p) {
      p = { score: 0, correct: 0, wrong: 0, streak: 0 };
      game.participants.set(userId, p);
    }
    if (isCorrect) {
      p.correct++;
      p.streak++;
      p.score +=
        this.config.baseScore + (p.streak - 1) * this.config.streakBonus;
    } else {
      p.wrong++;
      p.streak = 0;
      p.score -= this.config.penalty;
    }
    return p;
  }

  private async endGame(session: Session) {
    if (!this.currentGame) return;
    const game = this.currentGame;
    if (game.timer) clearTimeout(game.timer);

    const participants = Array.from(game.participants.entries());
    if (participants.length > 0) {
      const sorted = participants.sort((a, b) => b[1].score - a[1].score);
      let message = "本轮游戏结束，得分排行榜：\n";
      sorted.forEach(([uid, data], index) => {
        message += `${index + 1}. ${uid}：${data.score}分（答对${data.correct}，答错${data.wrong}）\n`;
      });
      await session.send(message);

      // 更新用户统计数据
      for (const [uid, data] of participants) {
        await this.userService.updateUser(uid, {
          scoreDelta: data.score,
          correctDelta: data.correct,
          wrongDelta: data.wrong,
          roundsDelta: 1,
        });
      }

      // 检查成就
      for (const [uid, data] of participants) {
        let username = uid;
        try {
          if (session.guildId) {
            const member = await session.bot.getGuildMember?.(
              session.guildId,
              uid,
            );
            username =
              (member as any)?.nickname ?? (member as any)?.name ?? uid;
          }
        } catch {
          // 忽略
        }
        const tempSession = {
          ...session,
          userId: uid,
          username: username,
          // 使用非空断言，因为游戏只在群聊中进行，channelId 一定存在
          send: (msg: string) =>
            session.bot.sendMessage(session.channelId!, msg),
        } as any;
        await this.userService.checkAchievements(uid, tempSession);
      }

      await this.userService.updateHonorTitles(this.config.titleDuration);
    } else {
      await session.send("本轮游戏无人参与，结束。");
    }

    this.currentGame = null;
  }

  // ==================== 辅助方法 ====================

  private formatCoord(row: number, col: number): string {
    const colLetter = String.fromCharCode(65 + col); // A-I
    return `${colLetter}${row + 1}`;
  }

  private selectQuestions(
    puzzle: number[][],
    count: number,
  ): { row: number; col: number }[] {
    const emptyCells: { row: number; col: number }[] = [];
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (puzzle[r][c] === 0) emptyCells.push({ row: r, col: c });
      }
    }
    const shuffled = emptyCells.sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }
}
