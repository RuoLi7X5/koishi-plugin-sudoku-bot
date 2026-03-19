import { Context, Schema } from "koishi";
import { SudokuGame } from "./game";
import { ImageRenderer } from "./renderer";

export const name = "sudoku-bot";

// 声明插件需要的服务
export const inject = ["database", "canvas"] as const;

export interface Config {
  commandStart: string;
  commandStop: string;
  commandScore: string;
  commandExchange: string;
  commandRank: string;
  commandProgress: string;
  commandDifficulty: string;
  commandTimeout: string;
  commandHelp: string;
  commandAchievement: string;
  commandInactivity: string;
  commandTitle: string;
  commandWear: string;
  commandUnwear: string;
  commandHint: string;
  commandTrainingStart: string;
  commandTrainingStop: string;
  trainingAllowPrivate: boolean;
  timeout: number;
  inactivityTimeout: number;
  rounds: number;
  baseScore: number;
  penalty: number;
  streakBonus: number;
  difficulty: 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    commandStart: Schema.string().default("开始答题").description("开始游戏命令"),
    commandStop: Schema.string()
      .default("结束答题")
      .description("结束游戏命令"),
    commandScore: Schema.string().default("个人档案").description("查看个人档案命令"),
    commandExchange: Schema.string().default("兑换").description("兑换头衔命令"),
    commandRank: Schema.string()
      .default("排行榜")
      .description("查看排行榜命令"),
    commandProgress: Schema.string()
      .default("游戏进度")
      .description("查看当前游戏进度命令"),
    commandDifficulty: Schema.string()
      .default("难度")
      .description("设置难度命令"),
    commandTimeout: Schema.string()
      .default("时间限制")
      .description("设置每题答题时间命令（0 = 无时间限制）"),
    commandHelp: Schema.string()
      .default("游戏帮助")
      .description("查看帮助命令"),
    commandAchievement: Schema.string()
      .default("个人成就")
      .description("查看成就命令"),
    commandInactivity: Schema.string()
      .default("无人超时")
      .description("设置无人参与自动结束时长命令（单位：分钟，0=禁用）"),
    commandTitle: Schema.string().default("头衔").description("查看/管理头衔命令"),
    commandWear: Schema.string().default("佩戴").description("佩戴头衔命令"),
    commandUnwear: Schema.string().default("卸下").description("卸下头衔命令"),
    commandHint: Schema.string().default("获取答案").description("查询题目求解路径的指令名"),
    commandTrainingStart: Schema.string().default("唯余训练").description("开始唯余训练指令"),
    commandTrainingStop: Schema.string().default("结束训练").description("结束唯余训练指令"),
  }).description("命令配置"),

  Schema.object({
    trainingAllowPrivate: Schema.boolean().default(true).description("唯余训练是否允许在私聊中使用（默认开启）"),
  }).description("唯余训练配置"),
  
  Schema.object({
    timeout: Schema.number().default(0).min(0).max(120).description("每题超时时间（秒），0 = 无时间限制"),
    inactivityTimeout: Schema.number().default(20).min(0).max(60).description("无人参与自动结束时长（分钟），0 = 禁用，默认 20 分钟"),
    rounds: Schema.number().default(8).min(1).max(20).description("每轮题目数量"),
    difficulty: Schema.union([
      Schema.union([1, 2, 3, 4, 5, 6, 7] as const),
      // 兼容旧版字符串配置，自动映射为数字
      Schema.transform(Schema.string(), (val) => {
        const legacyMap: Record<string, 1 | 2 | 3 | 4 | 5 | 6 | 7> = {
          easy: 1, medium: 2, hard: 4, expert: 6,
        };
        return (legacyMap[val] ?? 2) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
      }),
    ] as const).default(2).description("默认难度级别（1-7，2为默认）"),
  }).description("游戏配置"),
  
  Schema.object({
    baseScore: Schema.number().default(10).min(1).description("答对基础分"),
    penalty: Schema.number().default(5).min(0).description("答错扣分"),
    streakBonus: Schema.number().default(1).min(0).description("连续答对额外加分"),
  }).description("积分配置"),
  
]) as Schema<Config>;

export function apply(ctx: Context, config: Config) {
  // 兼容旧版本配置（如 difficulty 为字符串时，重置为默认值 2）
  if (!config) {
    ctx.logger("sudoku").error("插件配置为空，请在控制台重新配置 sudoku-bot 插件并保存");
    return;
  }
  if (typeof config.difficulty !== "number") {
    ctx.logger("sudoku").warn(`检测到旧版配置 difficulty="${config.difficulty}"，已自动重置为默认值 2，请在控制台重新保存配置`);
    (config as any).difficulty = 2;
  }

  // 扩展数据库模型（字段对象用 as any 绕过 Koishi 的 MapField 泛型约束，
  // 新增字段 activeTitle 未在 Tables 接口中声明，运行时会被 minato 正确处理）
  ctx.model.extend(
    "sudoku_user" as const,
    {
      id: "string",
      platform: "string",
      userId: "string",
      score: "integer",
      totalRounds: "integer",
      totalCorrect: "integer",
      totalWrong: "integer",
      streak: "integer",
      maxStreak: "integer",
      titles: "json",
      achievements: "json",
      gamesStarted: "integer",
      perfectRounds: "integer",
      mvpCount: "integer",
      lastPlaceCount: "integer",
      consecutiveLastPlace: "integer",
      consecutiveMvp: "integer",
      guilds: "json",
      activeTitle: "string",
      username: "string",
    } as any,
    {
      primary: "id",
      autoInc: false,
    },
  );

  // 初始化组件
  const renderer = new ImageRenderer(ctx);
  const game = new SudokuGame(ctx, config, renderer);

  // 注册命令，处理 session 可能为 undefined 的情况
  // 开始游戏命令，支持可选的难度参数
  ctx
    .command(`${config.commandStart} [difficulty:number]`)
    .action(({ session }, difficulty) => {
      if (!session) return "无法获取会话信息";
      return game.start(session, difficulty);
    });

  ctx.command(config.commandStop).action(({ session }) => {
    if (!session) return "无法获取会话信息";
    return game.stop(session);
  });

  ctx.command(config.commandScore).action(({ session }) => {
    if (!session) return "无法获取会话信息";
    return game.showScore(session);
  });

  ctx
    .command(`${config.commandExchange} [title:string]`)
    .action(({ session }, title) => {
      if (!session) return "无法获取会话信息";
      return game.exchangeTitle(session, title);
    });

  ctx
    .command(`${config.commandRank} [type:string] [scope:string]`)
    .action(({ session }, type, scope) => {
      if (!session) return "无法获取会话信息";
      return game.showRank(session, type, scope);
    });

  ctx.command(config.commandProgress).action(({ session }) => {
    if (!session) return "无法获取会话信息";
    return game.showProgress(session);
  });

  ctx
    .command(`${config.commandDifficulty} <level:number>`)
    .action(({ session }, level) => {
      if (!session) return "无法获取会话信息";
      if (level === undefined) return "请指定难度级别（1-7）。例如：难度 3";
      return game.setDifficulty(session, level);
    });

  ctx
    .command(`${config.commandTimeout} <seconds:number>`)
    .action(({ session }, seconds) => {
      if (!session) return "无法获取会话信息";
      if (seconds === undefined) return "请指定时间（秒），0 表示无时间限制。例如：时间限制 60";
      return game.setTimeoutLimit(session, seconds);
    });

  ctx.command(config.commandHelp).action(({ session }) => {
    if (!session) return "无法获取会话信息";
    return game.showHelp(session);
  });

  ctx
    .command(`${config.commandAchievement} [name:string]`)
    .action(({ session }, name) => {
      if (!session) return "无法获取会话信息";
      return game.showAchievements(session, name);
    });

  ctx
    .command(`${config.commandInactivity} <minutes:number>`)
    .action(({ session }, minutes) => {
      if (!session) return "无法获取会话信息";
      if (minutes === undefined) return "请指定分钟数，0 表示禁用。例如：无人超时 20";
      return game.setInactivityTimeout(session, minutes);
    });

  ctx
    .command(`${config.commandTitle} [name:string]`)
    .action(({ session }, name) => {
      if (!session) return "无法获取会话信息";
      return game.showTitles(session, name);
    });

  ctx
    .command(`${config.commandWear} <name:string>`)
    .action(({ session }, name) => {
      if (!session) return "无法获取会话信息";
      if (!name) return `请指定要佩戴的头衔名称。例如：${config.commandWear} 数独学徒`;
      return game.wearTitle(session, name);
    });

  ctx
    .command(`${config.commandUnwear} [name:string]`)
    .action(({ session }, name) => {
      if (!session) return "无法获取会话信息";
      return game.unwearTitle(session, name);
    });

  ctx
    .command(`${config.commandHint} <questionId:string>`)
    .action(({ session }, questionId) => {
      if (!session) return "无法获取会话信息";
      if (!questionId)
        return `请输入题目编号，例如：${config.commandHint} a1`;
      return game.showHint(session, questionId);
    });

  ctx.command(`${config.commandTrainingStart} [level]`).action(({ session, args }) => {
    if (!session) return "无法获取会话信息";
    const mode = args?.[0] === '2' ? 'advanced' : 'basic';
    return game.startTraining(session, mode);
  });

  ctx.command(config.commandTrainingStop).action(({ session }) => {
    if (!session) return "无法获取会话信息";
    return game.stopTraining(session);
  });

  // 监听消息（抢答 / 训练答题）—— 先快速检查当前频道是否有游戏，避免处理无关消息
  ctx.middleware(async (session, next) => {
    // 去除首尾空白，并剥离移动端输入法常见的尾部自动标点（句号、叹号、问号等），
    // 确保用户输入 "5。" 或 "5." 也能被正确识别为答案 "5"。
    const raw = session.content?.trim() ?? "";
    const content = raw.replace(/[。.！!？?，,、～~]+$/, "");
    if (/^[1-9]$/.test(content)) {
      if (game.hasGameInChannel(session.channelId)) {
        await game.handleAnswer(session, parseInt(content));
      } else if (game.hasTrainingInChannel(session.channelId, session.userId)) {
        await game.handleTrainingAnswer(session, parseInt(content));
      }
    }
    return next();
  });
}
