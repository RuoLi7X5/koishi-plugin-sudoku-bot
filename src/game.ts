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
      { 
        score: number; 
        correct: number; 
        wrong: number; 
        streak: number;
        answerTimes: number[]; // 每题答题用时（秒）
        answerPattern: string[]; // 答题模式记录（"对"/"错"）
        lastSecondCount: number; // 最后5秒答对次数
      }
    >;
    timer: any;
    answered: boolean;
    questionStartTime: number;
  } | null = null;

  // 嘲讽语句库
  private mockMessages = {
    groupMock: [
      "这么简单都不会？真是令人失望呢~",
      "时间到！看来大家都在划水啊🏊",
      "emmm...这题有这么难吗？",
      "全员开摆是吧？答案是 {answer}",
      "我怀疑你们根本就没在看题！答案：{answer}",
      "就这？连我家的猫都会做！正确答案是 {answer}",
      "建议各位回幼儿园重修数学，答案是 {answer}",
      "你们是来搞笑的吧？答案揭晓：{answer}",
      "集体摆烂了属于是，答案给你们：{answer}",
      "我觉得这题送分都没人要...答案是 {answer}",
      "时间到~答案是 {answer}，大家都在思考人生吗？",
      "居然无人答对？我不信！答案：{answer}",
      "这题难度：★☆☆☆☆，竟然没人会？答案是 {answer}",
      "集体沉默是金啊，答案公布：{answer}",
      "都在发呆？清醒一点！答案：{answer}",
      "这题我闭着眼都能做...答案是 {answer}",
      "是题目太难还是你们太菜？答案：{answer}",
      "我看大家都很有个性，集体不答题。正确答案：{answer}",
      "全员挂机了是吧？答案揭晓：{answer}",
      "这波团灭，答案是 {answer}",
      "一个能打的都没有！答案：{answer}",
      "我严重怀疑大家在玩别的游戏...答案是 {answer}",
      "你们这是在比赛谁更能忍住不答题吗？答案：{answer}",
      "集体装死？答案公布：{answer}",
      "都在等别人先答？答案是 {answer}",
      "这就是传说中的默契？集体不答。正确答案：{answer}",
      "我佛了，答案是 {answer}",
      "是不是该降低难度了？答案：{answer}",
      "群里就没有一个会做数独的？答案是 {answer}",
      "这局可以载入史册了，无人答对！答案：{answer}",
      "我看你们都挺忙的（做别的事），答案是 {answer}",
      "别装了，我知道你们都不会，答案：{answer}",
      "算了算了，答案告诉你们：{answer}",
      "本题作废！...才怪，答案是 {answer}",
      "下次记得把题目看完再发呆，答案：{answer}",
    ],
    singleMock: [
      "@{user} 答错了！扣 {penalty} 分，建议多练练~",
      "@{user} 这都能错？离谱！-{penalty}分",
      "@{user} 寄！扣你 {penalty} 分好好反省",
      "@{user} 答案都在盘面上，你居然还能错？-{penalty}",
      "@{user} 醒醒！这不是猜数字游戏！-{penalty}分",
      "@{user} 你是来搞笑的吧？-{penalty}分",
      "@{user} 建议回去补补课，-{penalty}分",
      "@{user} 我都替你尴尬...扣 {penalty} 分",
      "@{user} 这波啊，这波是纯纯的送分，-{penalty}",
      "@{user} 你可让我失望透了，-{penalty}分",
      "@{user} 哎呀呀，答错啦！-{penalty}分哦~",
      "@{user} 这题你确定看清楚了？-{penalty}分",
      "@{user} 勇气可嘉，但答案不对！-{penalty}",
      "@{user} 我相信你下次一定能...哦，又错了，-{penalty}",
      "@{user} 数独不是靠运气的...扣 {penalty} 分",
      "@{user} 建议先观摩，再答题，-{penalty}分",
      "@{user} 这个数字和答案八竿子打不着！-{penalty}",
      "@{user} 你这答案很有创意，但是错的，-{penalty}分",
      "@{user} 错得很果断啊！-{penalty}分",
      "@{user} 我觉得你需要眼镜...或者脑子？-{penalty}",
      "@{user} 这题答案不在1-9里吗？哦对，你答的就是1-9...但是错了，-{penalty}",
      "@{user} 送你一个字：错！-{penalty}分",
      "@{user} 重新组织一下语言...哦不，重新组织一下思路，-{penalty}",
      "@{user} 答案擦肩而过了呢，-{penalty}分",
      "@{user} 恭喜你答错！-{penalty}分",
      "@{user} 这就是所谓的自信吗？-{penalty}",
      "@{user} 我建议你慎重，但你没有...扣 {penalty} 分",
      "@{user} 你可能对数独有什么误解？-{penalty}分",
      "@{user} 错得离谱！-{penalty}",
      "@{user} 这答案...很有个性，但不对！-{penalty}分",
      "@{user} 你是故意的吧？-{penalty}",
      "@{user} 我相信你其实知道答案，只是手滑了...对吧？-{penalty}分",
      "@{user} 下次三思而后答，-{penalty}",
      "@{user} 本题已被你承包！错误答案承包，-{penalty}分",
      "@{user} 错得如此从容，-{penalty}",
      "@{user} 送分题都能错？-{penalty}分！",
      "@{user} 你这是在测试我的耐心吗？-{penalty}",
      "@{user} 请不要随机答题好吗？-{penalty}分",
      "@{user} 我怀疑你根本没看盘面！-{penalty}",
      "@{user} 建议使用排除法...哦，你已经把对的答案排除了，-{penalty}分",
    ],
  };

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

    console.log("[Sudoku] 游戏开始，准备渲染图片");
    
    try {
      const image = await this.renderer.render(puzzle);
      
      console.log("[Sudoku] 图片渲染完成，Buffer 长度:", image ? image.length : 0);
      
      // 验证图片数据
      if (!image || image.length === 0) {
        console.error("[Sudoku] 图片 Buffer 为空");
        await session.send("⚠️ 图片生成失败，但游戏继续。请查看日志。");
        this.ctx.logger("sudoku").error("Canvas 返回空 Buffer");
      } else {
        // 将 Buffer 转换为 base64 字符串
        const base64Image = `data:image/png;base64,${image.toString("base64")}`;
        console.log("[Sudoku] Base64 长度:", base64Image.length, "前50字符:", base64Image.substring(0, 50));
        await session.send(h.image(base64Image));
        console.log("[Sudoku] 图片发送完成");
      }
    } catch (error: any) {
      console.error("[Sudoku] 图片渲染异常：", error);
      this.ctx.logger("sudoku").error("图片渲染失败：", error);
      await session.send(`⚠️ 图片渲染失败：${error.message}\n游戏继续，请根据坐标答题。`);
    }

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
      questionStartTime: Date.now(),
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
      `完美局数：${user.perfectRounds} 💯`,
      `MVP次数：${user.mvpCount} 🏆`,
      `已解锁成就：${user.achievements.length} 个`,
      `当前头衔：${user.titles.map((t) => t.name).join("、") || "无"}`,
    ].join("\n");

    await session.send(message);
  }

  async showRank(session: Session, type: string = "积分") {
    let users = await this.ctx.database.get("sudoku_user", {});
    if (users.length === 0) {
      await session.send("暂无数据。");
      return;
    }

    // 中文参数映射
    const typeAlias: Record<string, string> = {
      积分: "score",
      答对: "correct",
      参与: "rounds",
      正确率: "rate",
      mvp: "mvp",
      MVP: "mvp",
      完美: "perfect",
      完美局: "perfect",
      成就: "achievement",
      // 保留英文兼容
      score: "score",
      correct: "correct",
      rounds: "rounds",
      rate: "rate",
      perfect: "perfect",
      achievement: "achievement",
    };

    const normalizedType = typeAlias[type] || "score";

    let sorted: any[] = [];
    const typeMap: Record<
      string,
      { field: string; desc: boolean; name: string; unit?: string }
    > = {
      score: { field: "score", desc: true, name: "积分榜", unit: "分" },
      correct: { field: "totalCorrect", desc: true, name: "答对榜", unit: "题" },
      rounds: { field: "totalRounds", desc: true, name: "参与榜", unit: "局" },
      rate: { field: "rate", desc: true, name: "正确率榜", unit: "%" },
      mvp: { field: "mvpCount", desc: true, name: "MVP榜", unit: "次" },
      perfect: {
        field: "perfectRounds",
        desc: true,
        name: "完美局榜",
        unit: "局",
      },
      achievement: {
        field: "achievementCount",
        desc: true,
        name: "成就榜",
        unit: "个",
      },
    };

    const selected = typeMap[normalizedType];
    const title = selected.name;

    // 特殊处理：正确率榜
    if (normalizedType === "rate") {
      users = users.filter((u) => u.totalCorrect + u.totalWrong >= 5);
      const usersWithRate = users.map((u) => ({
        ...u,
        rate: u.totalCorrect / (u.totalCorrect + u.totalWrong) || 0,
      })) as any[];
      sorted = usersWithRate.sort((a, b) => b.rate - a.rate).slice(0, 10);
    }
    // 特殊处理：成就榜
    else if (normalizedType === "achievement") {
      const usersWithCount = users.map((u) => ({
        ...u,
        achievementCount: u.achievements.length,
      })) as any[];
      sorted = usersWithCount
        .sort((a, b) => b.achievementCount - a.achievementCount)
        .slice(0, 10);
    }
    // 通用处理
    else {
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
      const titlePrefix = this.userService.getDisplayTitle(u);
      const nameDisplay = titlePrefix ? `${titlePrefix}${nickname}` : nickname;
      
      // 格式化输出
      if (normalizedType === "rate") {
        lines.push(
          `${i + 1}. ${nameDisplay}：${(u.rate * 100).toFixed(1)}% (✅${u.totalCorrect} ❌${u.totalWrong})`,
        );
      } else if (normalizedType === "mvp") {
        lines.push(`${i + 1}. ${nameDisplay}：${u.mvpCount}次 🏆`);
      } else if (normalizedType === "perfect") {
        lines.push(`${i + 1}. ${nameDisplay}：${u.perfectRounds}局 💯`);
      } else if (normalizedType === "achievement") {
        lines.push(`${i + 1}. ${nameDisplay}：${u.achievementCount}个 🎖️`);
      } else {
        const value = u[selected.field];
        lines.push(`${i + 1}. ${nameDisplay}：${value}${selected.unit || ""}`);
      }
    }

    await session.send(lines.join("\n"));
  }

  async showProgress(session: Session) {
    if (!this.currentGame) {
      await session.send("当前没有进行中的游戏。");
      return;
    }
    if (session.channelId !== this.currentGame.channelId) {
      return; // 不是同一个频道
    }

    const game = this.currentGame;
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
      topScorers.forEach(([uid, data], idx) => {
        message += `  ${idx + 1}. ${uid}：${data.score}分\n`;
      });
    }

    await session.send(message);
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
    game.questionStartTime = Date.now(); // 记录题目开始时间
    game.timer = setTimeout(async () => {
      if (!this.currentGame || this.currentGame !== game) return;
      if (!game.answered) {
        const answer = game.solution[q.row][q.col];
        
        // 群嘲逻辑：参与人数>=2时触发（修改条件）
        if (game.participants.size >= 2) {
          const mockMsg = this.getRandomMock("groupMock", { answer });
          await session.send(mockMsg);
        } else {
          await session.send(`时间到！答案是 ${answer}。`);
        }
        
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
    if (!session.userId) return;

    // 计算答题用时
    const answerTime = Math.floor((Date.now() - game.questionStartTime) / 1000);
    
    const q = game.questions[game.currentIndex];
    const correct = game.solution[q.row][q.col];

    if (number !== correct) {
      await this.updateParticipant(session.userId, false, answerTime);
      // 单人嘲讽：50%概率触发
      const shouldMock = Math.random() < 0.5;
      if (shouldMock) {
        const mockMsg = this.getRandomMock("singleMock", {
          user: session.username || session.userId,
          penalty: this.config.penalty,
        });
        await session.send(mockMsg);
      } else {
        await session.send(
          `@${session.username || session.userId} 答错了，扣 ${this.config.penalty} 分。`,
        );
      }
      return;
    }

    clearTimeout(game.timer);
    game.answered = true;
    const participant = await this.updateParticipant(session.userId, true, answerTime);
    if (!participant) return;
    const earned =
      this.config.baseScore +
      (participant.streak - 1) * this.config.streakBonus;

    const answerUser = await this.userService.getUser(session.userId);
    const titlePrefix = this.userService.getDisplayTitle(answerUser);
    const displayName = `${titlePrefix}@${session.username || session.userId}`;
    await session.send(
      `恭喜 ${displayName} 答对！+${earned} 分（连续${participant.streak}次）。`,
    );

    game.currentIndex++;
    await this.askNextQuestion(session);
  }

  private async updateParticipant(userId: string, isCorrect: boolean, answerTime?: number) {
    if (!this.currentGame) return null;
    const game = this.currentGame;
    let p = game.participants.get(userId);
    if (!p) {
      p = { 
        score: 0, 
        correct: 0, 
        wrong: 0, 
        streak: 0,
        answerTimes: [],
        answerPattern: [],
        lastSecondCount: 0,
      };
      game.participants.set(userId, p);
    }
    
    // 记录答题时间
    if (answerTime !== undefined) {
      p.answerTimes.push(answerTime);
    }
    
    // 记录答题模式
    p.answerPattern.push(isCorrect ? "对" : "错");
    
    // 检测是否为最后5秒答对
    if (isCorrect && answerTime !== undefined && answerTime >= this.config.timeout - 5) {
      p.lastSecondCount++;
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
      
      // 计算MVP：得分最高且答对至少1题
      let mvpUserId: string | null = null;
      for (const [uid, data] of sorted) {
        if (data.correct > 0) {
          mvpUserId = uid;
          break;
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
        // 解析昵称
        let nickname = uid;
        try {
          if (session.guildId) {
            const member = await session.bot.getGuildMember?.(session.guildId, uid);
            nickname = (member as any)?.nickname ?? (member as any)?.name ?? uid;
          }
        } catch { /* 忽略 */ }
        // 获取头衔前缀
        const u = await this.userService.getUser(uid);
        const titlePrefix = this.userService.getDisplayTitle(u);
        const nameDisplay = titlePrefix ? `${titlePrefix}${nickname}` : nickname;
        if (isMVP) mvpDisplayName = nameDisplay;
        message += `${prefix}${index + 1}. ${nameDisplay}：${data.score}分（✅${data.correct} ❌${data.wrong} 正确率${correctRate}）\n`;
      }

      if (mvpUserId) {
        message += `\n🎉 本局MVP：${mvpDisplayName}`;
      }

      await session.send(message);

      // 更新用户统计数据
      for (const [uid, data] of participants) {
        const isPerfect = data.wrong === 0 && data.correct === game.questions.length;
        const isMVP = uid === mvpUserId;
        await this.userService.updateUser(uid, {
          scoreDelta: data.score,
          correctDelta: data.correct,
          wrongDelta: data.wrong,
          roundsDelta: 1,
          perfectDelta: isPerfect ? 1 : 0,
          mvpDelta: isMVP ? 1 : 0,
        });
      }

      // 检查成就（包含隐藏成就）
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
        
        // 计算隐藏成就相关数据
        const isMVP = uid === mvpUserId;
        const isAlone = participants.length === 1;
        const leadMargin = sorted.length > 1 && isMVP 
          ? sorted[0][1].score - sorted[1][1].score 
          : 0;
        
        // 答题模式分析
        const answerPattern = data.answerPattern.join("");
        const fastestAnswer = data.answerTimes.length > 0 
          ? Math.min(...data.answerTimes) 
          : undefined;
        const averageTime = data.answerTimes.length > 0
          ? data.answerTimes.reduce((a, b) => a + b, 0) / data.answerTimes.length
          : undefined;
        
        // 前3题是否全对
        const firstThreeCorrect = data.answerPattern.slice(0, 3).every(p => p === "对");
        
        // 绝地反击：前5题至少错3题，后3题全对
        const first5Wrong = data.answerPattern.slice(0, 5).filter(p => p === "错").length;
        const last3Correct = data.answerPattern.slice(-3).every(p => p === "对");
        const comebackPattern = { first5Wrong, last3Correct: last3Correct ? 3 : 0 };
        
        // 答错3题但仍是MVP
        const wrongButMvp = isMVP && data.wrong >= 3;
        
        // 禅定模式：每题都在15-20秒答对
        const zenPattern = data.answerTimes.length > 0 &&
          data.answerTimes.every(t => t >= 15 && t <= 20);
        
        const tempSession = {
          ...session,
          userId: uid,
          username: username,
          send: (msg: string) =>
            session.bot.sendMessage(session.channelId!, msg),
        } as any;
        
        await this.userService.checkAchievements(uid, {
          correct: data.correct,
          wrong: data.wrong,
          score: data.score,
          streak: data.streak,
          // 隐藏成就数据
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
        }, tempSession);
      }

      await this.userService.updateHonorTitles(this.config.titleDuration, session);
      
      // 发送完整答案图片
      try {
        await session.send("📋 完整答案：");
        const solutionImage = await this.renderer.render(game.solution);
        
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

    this.currentGame = null;
  }

  // ==================== 辅助方法 ====================

  private getRandomMock(
    type: "groupMock" | "singleMock",
    params: Record<string, any>,
  ): string {
    const messages = this.mockMessages[type];
    const template = messages[Math.floor(Math.random() * messages.length)];
    return template.replace(/\{(\w+)\}/g, (_, key) => params[key] || "");
  }

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
