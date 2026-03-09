import { Context, Session } from "koishi";

interface UserData {
  id: string;
  platform: string;
  userId: string;
  score: number;
  totalRounds: number;
  totalCorrect: number;
  totalWrong: number;
  streak: number;
  maxStreak: number;
  titles: { name: string; expire: number }[]; // 明确类型
  achievements: string[];
  gamesStarted: number;
}

export class UserService {
  private ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  async getUser(userId: string): Promise<UserData> {
    const [user] = await this.ctx.database.get("sudoku_user", { userId });
    if (user) return user;
    const newUser: UserData = {
      id: `${userId}`,
      platform: "qq",
      userId,
      score: 0,
      totalRounds: 0,
      totalCorrect: 0,
      totalWrong: 0,
      streak: 0,
      maxStreak: 0,
      titles: [],
      achievements: [],
      gamesStarted: 0,
    };
    await this.ctx.database.create("sudoku_user", newUser);
    return newUser;
  }

  async updateUser(
    userId: string,
    delta: {
      scoreDelta?: number;
      correctDelta?: number;
      wrongDelta?: number;
      roundsDelta?: number;
    },
  ) {
    const user = await this.getUser(userId);
    if (delta.scoreDelta) user.score += delta.scoreDelta;
    if (delta.correctDelta) {
      user.totalCorrect += delta.correctDelta;
      user.streak += delta.correctDelta;
      if (user.streak > user.maxStreak) user.maxStreak = user.streak;
    }
    if (delta.wrongDelta) {
      user.totalWrong += delta.wrongDelta;
      user.streak = 0;
    }
    if (delta.roundsDelta) user.totalRounds += delta.roundsDelta;
    await this.ctx.database.set("sudoku_user", { userId }, user);
  }

  async checkAchievements(userId: string, session: Session) {
    const user = await this.getUser(userId);
    const unlocked: string[] = [];

    if (user.totalCorrect >= 1 && !user.achievements.includes("first_win")) {
      unlocked.push("首战告捷");
      user.score += 20;
    }
    // 可添加更多成就

    if (unlocked.length > 0) {
      user.achievements.push(...unlocked);
      await this.ctx.database.set("sudoku_user", { userId }, user);
      for (const ach of unlocked) {
        await session.send(
          `恭喜 @${session.username} 解锁成就：${ach}！获得20积分。`,
        );
      }
    }
  }

  async updateHonorTitles(durationDays: number) {
    const users = await this.ctx.database.get("sudoku_user", {});
    if (users.length === 0) return;

    const topScore = [...users].sort((a, b) => b.score - a.score)[0];
    const topCorrect = [...users].sort(
      (a, b) => b.totalCorrect - a.totalCorrect,
    )[0];
    const topRounds = [...users].sort(
      (a, b) => b.totalRounds - a.totalRounds,
    )[0];
    const topStarted = [...users].sort(
      (a, b) => b.gamesStarted - a.gamesStarted,
    )[0];

    const qualified = users.filter((u) => u.totalRounds >= 10);
    const topAccuracy = qualified.length
      ? [...qualified].sort((a, b) => {
          const rateA = a.totalCorrect / (a.totalCorrect + a.totalWrong) || 0;
          const rateB = b.totalCorrect / (b.totalCorrect + b.totalWrong) || 0;
          return rateB - rateA;
        })[0]
      : null;

    const now = Date.now();
    const expire = now + durationDays * 24 * 60 * 60 * 1000;
    const titles = [
      { userId: topScore?.userId, name: "积分之王", expire },
      { userId: topCorrect?.userId, name: "答题之王", expire },
      { userId: topRounds?.userId, name: "参与之王", expire },
      { userId: topStarted?.userId, name: "开局之王", expire },
      { userId: topAccuracy?.userId, name: "正确率之王", expire },
    ];

    for (const t of titles) {
      if (!t.userId) continue;
      const user = await this.getUser(t.userId);
      user.titles = user.titles.filter((title) => title.name !== t.name);
      user.titles.push({ name: t.name, expire: t.expire });
      await this.ctx.database.set("sudoku_user", { userId: t.userId }, user);
    }
  }

  async exchangeTitle(userId: string, titleName: string): Promise<boolean> {
    const user = await this.getUser(userId);

    const titleCatalog: Record<string, { price: number; duration: number }> = {
      数独学徒: { price: 100, duration: 7 },
      解题高手: { price: 500, duration: 30 },
      终盘大师: { price: 2000, duration: 365 },
    };

    const titleInfo = titleCatalog[titleName];
    if (!titleInfo) return false;
    if (user.score < titleInfo.price) return false;

    user.score -= titleInfo.price;
    const expire = Date.now() + titleInfo.duration * 24 * 60 * 60 * 1000;
    user.titles.push({ name: titleName, expire });

    await this.ctx.database.set("sudoku_user", { userId }, user);
    return true;
  }
}
