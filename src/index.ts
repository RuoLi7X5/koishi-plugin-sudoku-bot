import { Context, Schema } from "koishi";
import { SudokuGame } from "./game";
import { SudokuGenerator } from "./generator";
import { ImageRenderer } from "./renderer";
import { UserService } from "./user";

export const name = "sudoku-bot";

export interface Config {
  commandStart: string;
  commandStop: string;
  commandScore: string;
  commandExchange: string;
  commandRank: string;
  timeout: number;
  rounds: number;
  baseScore: number;
  penalty: number;
  streakBonus: number;
  difficulty: "easy" | "medium" | "hard";
  titleDuration: number;
}

export const Config: Schema<Config> = Schema.object({
  commandStart: Schema.string().default("数独开始").description("开始游戏命令"),
  commandStop: Schema.string()
    .default("数独结束")
    .description("强制结束游戏命令（管理员）"),
  commandScore: Schema.string().default("积分").description("查看积分命令"),
  commandExchange: Schema.string().default("兑换").description("兑换头衔命令"),
  commandRank: Schema.string()
    .default("数独排行")
    .description("查看排行榜命令"),
  timeout: Schema.number().default(30).description("每题超时（秒）"),
  rounds: Schema.number().default(8).description("每轮题目数量"),
  baseScore: Schema.number().default(10).description("答对基础分"),
  penalty: Schema.number().default(5).description("答错扣分"),
  streakBonus: Schema.number().default(1).description("连续答对额外加分"),
  difficulty: Schema.union(["easy", "medium", "hard"])
    .default("medium")
    .description("难度"),
  titleDuration: Schema.number().default(7).description("荣誉头衔有效期（天）"),
});

export function apply(ctx: Context, config: Config) {
  // 扩展数据库模型，使用 as const 解决类型问题
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
    },
    {
      primary: "id",
      autoInc: false,
    },
  );

  // 初始化组件
  const generator = new SudokuGenerator(config.difficulty);
  const renderer = new ImageRenderer();
  const game = new SudokuGame(ctx, config, generator, renderer);

  // 注册命令，处理 session 可能为 undefined 的情况
  ctx.command(config.commandStart).action(({ session }) => {
    if (!session) return "无法获取会话信息";
    return game.start(session);
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
    .command(config.commandExchange, "<title:string>")
    .action(({ session }, title) => {
      if (!session) return "无法获取会话信息";
      return game.exchangeTitle(session, title);
    });

  ctx
    .command(config.commandRank, "[type:string]")
    .action(({ session }, type) => {
      if (!session) return "无法获取会话信息";
      return game.showRank(session, type);
    });

  // 监听消息（抢答）
  ctx.middleware(async (session, next) => {
    if (session.content && /^[1-9]$/.test(session.content)) {
      await game.handleAnswer(session, parseInt(session.content));
    }
    return next();
  });
}
