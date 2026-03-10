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
  titles: { name: string; expire: number }[];
  achievements: string[];
  gamesStarted: number;
  perfectRounds: number;
  mvpCount: number;
}

declare module "koishi" {
  interface Tables {
    sudoku_user: UserData;
  }
}

const ACHIEVEMENTS: Record<
  string,
  { name: string; desc: string; reward: number }
> = {
  first_win: { name: "????", desc: "????", reward: 20 },
  first_wrong: { name: "????", desc: "????", reward: 5 },
  
  streak_5: { name: "????", desc: "????5?", reward: 50 },
  streak_10: { name: "????", desc: "????10?", reward: 100 },
  streak_20: { name: "????", desc: "????20?", reward: 200 },
  
  rounds_10: { name: "?????", desc: "??10???", reward: 30 },
  rounds_50: { name: "????", desc: "??50???", reward: 100 },
  rounds_100: { name: "?????", desc: "??100???", reward: 300 },
  
  score_100: { name: "????", desc: "??????100", reward: 10 },
  score_500: { name: "????", desc: "??????500", reward: 50 },
  score_1000: { name: "????", desc: "??????1000", reward: 100 },
  score_5000: { name: "????", desc: "??????5000", reward: 500 },
  
  accuracy_80: { name: "????", desc: "?????80%????20??", reward: 50 },
  accuracy_90: { name: "????", desc: "?????90%????20??", reward: 100 },
  accuracy_95: { name: "????", desc: "?????95%????20??", reward: 200 },
  
  perfect_1: { name: "????", desc: "????????", reward: 100 },
  perfect_10: { name: "?????", desc: "??10?????", reward: 300 },
  
  mvp_1: { name: "????", desc: "????MVP", reward: 50 },
  mvp_10: { name: "????", desc: "??10?MVP", reward: 200 },
  mvp_50: { name: "??MVP", desc: "??50?MVP", reward: 1000 },
  
  correct_100: { name: "???", desc: "????100?", reward: 80 },
  correct_500: { name: "????", desc: "????500?", reward: 300 },
  correct_1000: { name: "???", desc: "????1000?", reward: 800 },
};

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
      perfectRounds: 0,
      mvpCount: 0,
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
      perfectDelta?: number;
      mvpDelta?: number;
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
    if (delta.perfectDelta) user.perfectRounds += delta.perfectDelta;
    if (delta.mvpDelta) user.mvpCount += delta.mvpDelta;
    await this.ctx.database.set("sudoku_user", { userId }, user);
  }

  async checkAchievements(
    userId: string,
    roundData: { correct: number; wrong: number; score: number; streak: number },
    session: Session,
  ) {
    const user = await this.getUser(userId);
    const unlocked: Array<{ name: string; reward: number }> = [];
    const totalAnswered = user.totalCorrect + user.totalWrong;
    const accuracy =
      totalAnswered === 0 ? 0 : user.totalCorrect / totalAnswered;

    const checks: Array<{ key: string; condition: boolean }> = [
      { key: "first_win", condition: user.totalCorrect >= 1 },
      { key: "first_wrong", condition: user.totalWrong >= 1 },
      { key: "streak_5", condition: user.maxStreak >= 5 },
      { key: "streak_10", condition: user.maxStreak >= 10 },
      { key: "streak_20", condition: user.maxStreak >= 20 },
      { key: "rounds_10", condition: user.totalRounds >= 10 },
      { key: "rounds_50", condition: user.totalRounds >= 50 },
      { key: "rounds_100", condition: user.totalRounds >= 100 },
      { key: "score_100", condition: user.score >= 100 },
      { key: "score_500", condition: user.score >= 500 },
      { key: "score_1000", condition: user.score >= 1000 },
      { key: "score_5000", condition: user.score >= 5000 },
      { key: "accuracy_80", condition: totalAnswered >= 20 && accuracy >= 0.8 },
      { key: "accuracy_90", condition: totalAnswered >= 20 && accuracy >= 0.9 },
      { key: "accuracy_95", condition: totalAnswered >= 20 && accuracy >= 0.95 },
      { key: "perfect_1", condition: user.perfectRounds >= 1 },
      { key: "perfect_10", condition: user.perfectRounds >= 10 },
      { key: "mvp_1", condition: user.mvpCount >= 1 },
      { key: "mvp_10", condition: user.mvpCount >= 10 },
      { key: "mvp_50", condition: user.mvpCount >= 50 },
      { key: "correct_100", condition: user.totalCorrect >= 100 },
      { key: "correct_500", condition: user.totalCorrect >= 500 },
      { key: "correct_1000", condition: user.totalCorrect >= 1000 },
    ];

    for (const check of checks) {
      if (check.condition && !user.achievements.includes(check.key)) {
        const achievement = ACHIEVEMENTS[check.key];
        unlocked.push({ name: achievement.name, reward: achievement.reward });
        user.achievements.push(check.key);
        user.score += achievement.reward;
      }
    }

    if (unlocked.length > 0) {
      await this.ctx.database.set("sudoku_user", { userId }, user);
      for (const ach of unlocked) {
        await session.send(
          `?? ?? @${session.username} ?????${ach.name}???? ${ach.reward} ?????`,
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
      { userId: topScore?.userId, name: "????", expire },
      { userId: topCorrect?.userId, name: "????", expire },
      { userId: topRounds?.userId, name: "????", expire },
      { userId: topStarted?.userId, name: "????", expire },
      { userId: topAccuracy?.userId, name: "?????", expire },
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
    
    const titleCatalog = {
      sudoku_apprentice: { name: "????", price: 100, duration: 7 },
      problem_solver: { name: "????", price: 500, duration: 30 },
      endgame_master: { name: "????", price: 2000, duration: 365 },
    } as const;

    type TitleCatalogKey = keyof typeof titleCatalog;
    const titleKey = (Object.keys(titleCatalog) as TitleCatalogKey[]).find(
      (key: TitleCatalogKey) => titleCatalog[key].name === titleName,
    );
    if (!titleKey) return false;

    const titleInfo = titleCatalog[titleKey];
    if (user.score < titleInfo.price) return false;

    user.score -= titleInfo.price;
    const expire = Date.now() + titleInfo.duration * 24 * 60 * 60 * 1000;
    user.titles.push({ name: titleName, expire });

    await this.ctx.database.set("sudoku_user", { userId }, user);
    return true;
  }
}
