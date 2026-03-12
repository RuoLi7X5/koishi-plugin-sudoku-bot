import { Context, Session, h } from "koishi";

// 头衔条目：type 用于显示优先级和包裹符号，guildId 用于荣誉头衔的群隔离
interface TitleEntry {
  name: string;
  expire: number;
  type?: "honor" | "achievement" | "regular";
  guildId?: string;
}

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
  titles: TitleEntry[];
  achievements: string[];
  gamesStarted: number;
  perfectRounds: number;
  mvpCount: number;
  lastPlaceCount: number;
  consecutiveLastPlace: number;
  consecutiveMvp: number;
  guilds: string[]; // 参与过的群 ID 列表
}

const ACHIEVEMENTS: Record<
  string,
  { name: string; desc: string; reward: number; hidden?: boolean; title?: string }
> = {
  // 基础成就
  first_win: { name: "首战告捷", desc: "首次答对", reward: 20 },
  first_wrong: { name: "初尝败绩", desc: "首次答错", reward: 5 },

  // 连胜成就
  streak_5: { name: "连击高手", desc: "连续答对5题", reward: 50 },
  streak_10: { name: "连击大师", desc: "连续答对10题", reward: 100 },
  streak_20: { name: "连击传说", desc: "连续答对20题", reward: 200 },

  // 参与成就
  rounds_10: { name: "新手村毕业", desc: "参与10局游戏", reward: 30 },
  rounds_50: { name: "资深玩家", desc: "参与50局游戏", reward: 100 },
  rounds_100: { name: "数独狂热者", desc: "参与100局游戏", reward: 300 },

  // 积分成就
  score_100: { name: "小有成就", desc: "累计积分达到100", reward: 10 },
  score_500: { name: "积分大户", desc: "累计积分达到500", reward: 50 },
  score_1000: { name: "积分富豪", desc: "累计积分达到1000", reward: 100 },
  score_5000: { name: "积分巨擘", desc: "累计积分达到5000", reward: 500 },

  // 正确率成就
  accuracy_80: { name: "稳健发挥", desc: "正确率达到80%（至少答20题）", reward: 50 },
  accuracy_90: { name: "数独精英", desc: "正确率达到90%（至少答20题）", reward: 100 },
  accuracy_95: { name: "数独宗师", desc: "正确率达到95%（至少答20题）", reward: 200 },

  // 完美局成就
  perfect_1: { name: "完美首秀", desc: "首次全对完成一局", reward: 100 },
  perfect_10: { name: "完美主义者", desc: "完成10局完美对局", reward: 300 },

  // MVP成就
  mvp_1: { name: "初露锋芒", desc: "获得首次MVP", reward: 50 },
  mvp_10: { name: "常胜将军", desc: "获得10次MVP", reward: 200 },
  mvp_50: { name: "传奇MVP", desc: "获得50次MVP", reward: 1000 },

  // 答题量成就
  correct_100: { name: "百题斩", desc: "累计答对100题", reward: 80 },
  correct_500: { name: "五百题斩", desc: "累计答对500题", reward: 300 },
  correct_1000: { name: "千题斩", desc: "累计答对1000题", reward: 800 },

  // === 隐藏成就（每个都配有专属头衔）===
  lightning_hand: {
    name: "闪电之手",
    desc: "在5秒内答对",
    reward: 150,
    hidden: true,
    title: "⚡闪电侠",
  },
  last_second_hero: {
    name: "压哨绝杀",
    desc: "在最后5秒答对",
    reward: 200,
    hidden: true,
    title: "🏀绝杀王",
  },
  own_rhythm: {
    name: "自有旋律",
    desc: "单局答题严格对错或错对交替（至少4题）",
    reward: 300,
    hidden: true,
    title: "🎵节奏大师",
  },
  perfect_start: {
    name: "完美开局",
    desc: "单局前3题全对",
    reward: 80,
    hidden: true,
    title: "🚀开局王者",
  },
  comeback_king: {
    name: "绝地反击",
    desc: "前5题至少错3题，但最后3题全对",
    reward: 250,
    hidden: true,
    title: "💪逆转之王",
  },
  lone_wolf: {
    name: "孤胆英雄",
    desc: "独自一人完成一局游戏",
    reward: 500,
    hidden: true,
    title: "🦸独行侠",
  },
  dominator: {
    name: "一骑绝尘",
    desc: "单局领先第二名30分以上",
    reward: 180,
    hidden: true,
    title: "🏇霸主",
  },
  never_defeated: {
    name: "不败传说",
    desc: "连续10局都获得MVP",
    reward: 1500,
    hidden: true,
    title: "👑不败神话",
  },
  wrong_is_right: {
    name: "歪打正着",
    desc: "单局答错3题但仍然获得MVP",
    reward: 350,
    hidden: true,
    title: "🎲幸运之子",
  },
  speed_demon: {
    name: "速度恶魔",
    desc: "单局所有答对题目平均用时不超过10秒",
    reward: 400,
    hidden: true,
    title: "👹极速狂飙",
  },
  lucky_seven: {
    name: "幸运七",
    desc: "恰好答对7题答错1题",
    reward: 120,
    hidden: true,
    title: "🍀七星高照",
  },
  zen_master: {
    name: "禅定大师",
    desc: "单局每题都在倒计时剩余15-20秒时答对",
    reward: 500,
    hidden: true,
    title: "🧘禅心如一",
  },

  // === 不屈勇士系列隐藏成就 ===
  brave_heart: {
    name: "不屈之心",
    desc: "连续5局垫底仍继续参与",
    reward: 600,
    hidden: true,
    title: "💖屡败屡战",
  },
  iron_will: {
    name: "钢铁意志",
    desc: "连续10局垫底仍继续参与",
    reward: 1200,
    hidden: true,
    title: "🛡️钢铁战士",
  },
  eternal_warrior: {
    name: "永恒战士",
    desc: "虽然累计垫底20次，但从未放弃",
    reward: 2000,
    hidden: true,
    title: "⚔️不灭斗魂",
  },
  rise_from_ashes: {
    name: "浴火重生",
    desc: "连续5局垫底后，终于获得MVP",
    reward: 1500,
    hidden: true,
    title: "🔥凤凰涅槃",
  },
  starter_spirit: {
    name: "开局之魂",
    desc: "累计主动发起游戏50次（无论成绩）",
    reward: 800,
    hidden: true,
    title: "🎮游戏先驱",
  },
  never_give_up: {
    name: "永不言弃",
    desc: "在正确率低于30%的情况下仍参与50局",
    reward: 1000,
    hidden: true,
    title: "🌟不屈之魂",
  },
};

// 荣誉头衔名集合（用于兼容旧数据的类型推断）
const HONOR_TITLE_NAMES = new Set([
  "积分之王", "答题之王", "参与之王", "开局之王", "正确率之王",
]);

// 隐藏成就专属头衔名集合（用于兼容旧数据的类型推断）
const ACHIEVEMENT_TITLE_NAMES = new Set(
  Object.values(ACHIEVEMENTS)
    .filter(a => a.hidden && a.title)
    .map(a => a.title!)
);

// 荣誉头衔永久有效（不依赖时间过期，通过每局结算易主控制）
const HONOR_EXPIRE = Number.MAX_SAFE_INTEGER;

export class UserService {
  private ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  // 剔除主键 id，并清理过期的非永久头衔，避免数组无限膨胀
  private toUpdateData(user: UserData): Omit<UserData, "id"> {
    const { id, ...data } = user;
    const now = Date.now();
    // 荣誉头衔 expire = HONOR_EXPIRE，永远不会被清理
    data.titles = data.titles.filter(t => t.expire > now);
    return data;
  }

  async getUser(userId: string): Promise<UserData> {
    const [user] = await this.ctx.database.get("sudoku_user", { userId });
    if (user) {
      const u = user as any;
      return {
        ...user,
        perfectRounds: u.perfectRounds ?? 0,
        mvpCount: u.mvpCount ?? 0,
        lastPlaceCount: u.lastPlaceCount ?? 0,
        consecutiveLastPlace: u.consecutiveLastPlace ?? 0,
        consecutiveMvp: u.consecutiveMvp ?? 0,
        titles: Array.isArray(u.titles) ? (u.titles as TitleEntry[]) : [],
        achievements: Array.isArray(u.achievements) ? (u.achievements as string[]) : [],
        guilds: Array.isArray(u.guilds) ? (u.guilds as string[]) : [],
      } as UserData;
    }
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
      lastPlaceCount: 0,
      consecutiveLastPlace: 0,
      consecutiveMvp: 0,
      guilds: [],
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
      isLastPlace?: boolean;
      isMvp?: boolean;
      gamesStartedDelta?: number;
      finalStreak?: number;
      maxInGameStreak?: number;
      guildId?: string; // 本局所在群（用于群成员记录）
    },
  ): Promise<UserData> {
    const user = await this.getUser(userId);
    if (delta.scoreDelta) user.score += delta.scoreDelta;
    // 积分下限为 0，不允许负分
    user.score = Math.max(0, user.score);

    if (delta.correctDelta) user.totalCorrect += delta.correctDelta;
    if (delta.wrongDelta) user.totalWrong += delta.wrongDelta;
    if (delta.finalStreak !== undefined) user.streak = delta.finalStreak;
    if (delta.maxInGameStreak !== undefined && delta.maxInGameStreak > user.maxStreak) {
      user.maxStreak = delta.maxInGameStreak;
    }
    if (delta.roundsDelta) user.totalRounds += delta.roundsDelta;
    if (delta.perfectDelta) user.perfectRounds += delta.perfectDelta;
    if (delta.mvpDelta) user.mvpCount += delta.mvpDelta;
    if (delta.gamesStartedDelta) user.gamesStarted += delta.gamesStartedDelta;

    // 记录群成员关系（用于群榜单隔离）
    if (delta.guildId && !user.guilds.includes(delta.guildId)) {
      user.guilds.push(delta.guildId);
    }

    // 垫底统计
    if (delta.isLastPlace === true) {
      user.lastPlaceCount++;
      user.consecutiveLastPlace++;
    } else if (delta.isLastPlace === false) {
      user.consecutiveLastPlace = 0;
    }

    // 连续MVP追踪
    if (delta.isMvp === true) {
      user.consecutiveMvp++;
    } else if (delta.isMvp === false) {
      user.consecutiveMvp = 0;
    }

    await this.ctx.database.set("sudoku_user", { userId }, this.toUpdateData(user));
    return user;
  }

  async checkAchievements(
    userId: string,
    roundData: {
      correct: number;
      wrong: number;
      score: number;
      streak: number;
      answerPattern?: string[];
      fastestAnswer?: number;
      slowestCorrect?: number;
      averageTime?: number;
      lastSecondAnswers?: number;
      firstThreeCorrect?: boolean;
      comebackPattern?: { first5Wrong: number; last3Correct: number };
      isAlone?: boolean;
      leadMargin?: number;
      wrongButMvp?: boolean;
      zenPattern?: boolean;
      prevConsecutiveLastPlace?: number;
      isCurrentMvp?: boolean;
    },
    session: Session,
    preloadedUser?: UserData,
  ) {
    const user = preloadedUser ?? await this.getUser(userId);
    const unlocked: Array<{ name: string; reward: number; isHidden: boolean }> = [];
    const totalAnswered = user.totalCorrect + user.totalWrong;
    const accuracy = totalAnswered === 0 ? 0 : user.totalCorrect / totalAnswered;

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

    // 隐藏成就检测
    if (roundData.fastestAnswer !== undefined && roundData.fastestAnswer <= 5) {
      checks.push({ key: "lightning_hand", condition: true });
    }
    if (roundData.lastSecondAnswers !== undefined && roundData.lastSecondAnswers > 0) {
      checks.push({ key: "last_second_hero", condition: true });
    }
    // 对错或错对严格交替（至少4题，answerPattern 本身已是 string[]）
    if (roundData.answerPattern && roundData.answerPattern.length >= 4) {
      const isAlternating = roundData.answerPattern.every(
        (p, i) => i === 0 || p !== roundData.answerPattern![i - 1],
      );
      checks.push({ key: "own_rhythm", condition: isAlternating });
    }
    if (roundData.firstThreeCorrect) {
      checks.push({ key: "perfect_start", condition: true });
    }
    if (roundData.comebackPattern) {
      const { first5Wrong, last3Correct } = roundData.comebackPattern;
      checks.push({ key: "comeback_king", condition: first5Wrong >= 3 && last3Correct === 3 });
    }
    if (roundData.isAlone) {
      checks.push({ key: "lone_wolf", condition: true });
    }
    if (roundData.leadMargin !== undefined && roundData.leadMargin >= 30) {
      checks.push({ key: "dominator", condition: true });
    }
    if (roundData.wrongButMvp) {
      checks.push({ key: "wrong_is_right", condition: true });
    }
    if (roundData.averageTime !== undefined && roundData.averageTime <= 10) {
      checks.push({ key: "speed_demon", condition: true });
    }
    if (roundData.correct === 7 && roundData.wrong === 1) {
      checks.push({ key: "lucky_seven", condition: true });
    }
    if (roundData.zenPattern) {
      checks.push({ key: "zen_master", condition: true });
    }
    if (
      roundData.prevConsecutiveLastPlace !== undefined &&
      roundData.prevConsecutiveLastPlace >= 5 &&
      roundData.isCurrentMvp
    ) {
      checks.push({ key: "rise_from_ashes", condition: true });
    }

    checks.push({ key: "never_defeated", condition: user.consecutiveMvp >= 10 });
    checks.push({ key: "brave_heart", condition: user.consecutiveLastPlace >= 5 });
    checks.push({ key: "iron_will", condition: user.consecutiveLastPlace >= 10 });
    checks.push({ key: "eternal_warrior", condition: user.lastPlaceCount >= 20 });
    checks.push({ key: "starter_spirit", condition: user.gamesStarted >= 50 });
    checks.push({ key: "never_give_up", condition: totalAnswered >= 50 && accuracy < 0.3 && user.totalRounds >= 50 });

    for (const check of checks) {
      if (check.condition && !user.achievements.includes(check.key)) {
        const achievement = ACHIEVEMENTS[check.key];
        unlocked.push({
          name: achievement.name,
          reward: achievement.reward,
          isHidden: achievement.hidden || false,
        });
        user.achievements.push(check.key);
        user.score += achievement.reward;

        // 隐藏成就专属头衔（标记 type: "achievement"）
        if (achievement.hidden && achievement.title) {
          const titleExpire = Date.now() + 365 * 24 * 60 * 60 * 1000;
          user.titles.push({ name: achievement.title, expire: titleExpire, type: "achievement" });
        }
      }
    }

    if (unlocked.length > 0) {
      await this.ctx.database.set("sudoku_user", { userId }, this.toUpdateData(user));
      for (const ach of unlocked) {
        const achievement = Object.values(ACHIEVEMENTS).find(a => a.name === ach.name);
        if (ach.isHidden) {
          const prefix = "✨✨✨ 隐藏成就解锁 ✨✨✨";
          if (achievement?.title) {
            await session.send(
              `${prefix}\n恭喜 ${h.at(session.userId)} 解锁成就【${ach.name}】！\n🎁 获得 ${ach.reward} 积分奖励！\n🎖️ 同时获得专属头衔【${achievement.title}】！（有效期1年）`,
            );
          } else {
            await session.send(
              `${prefix}\n恭喜 ${h.at(session.userId)} 解锁成就【${ach.name}】！\n🎁 获得 ${ach.reward} 积分奖励！`,
            );
          }
        } else {
          await session.send(
            `🎊\n恭喜 ${h.at(session.userId)} 解锁成就[${ach.name}]！\n🎁 获得 ${ach.reward} 积分奖励！`,
          );
        }
      }
    }
  }

  /**
   * 每局结算荣誉头衔。
   * - 荣誉头衔永久有效（不设时间过期），条件不符立即易主。
   * - 每个群独立结算，只考虑在该群参与过游戏的用户。
   */
  async updateHonorTitles(guildId: string, session?: Session) {
    // 没有 guildId 时跳过，避免对全服误结算
    if (!guildId) return;

    const allUsers = await this.ctx.database.get("sudoku_user", {});
    if (allUsers.length === 0) return;

    // 筛选本群成员（用 Array.isArray 防旧数据非数组崩溃）
    const users = allUsers.filter(u => {
      const g = (u as any).guilds;
      return Array.isArray(g) && g.includes(guildId);
    });

    if (users.length === 0) return;

    // 资格过滤：参与场次 >= 10 且积分 >= 100，才有资格竞争荣誉头衔
    const eligible = users.filter(u => u.totalRounds >= 10 && u.score >= 100);
    if (eligible.length === 0) return; // 无人达到门槛，本轮跳过

    // 计算各维度榜首（均在有资格玩家中产生）
    const topScore   = [...eligible].sort((a, b) => b.score - a.score)[0];
    const topCorrect = [...eligible].sort((a, b) => b.totalCorrect - a.totalCorrect)[0];
    const topRounds  = [...eligible].sort((a, b) => b.totalRounds - a.totalRounds)[0];
    const topStarted = [...eligible].sort((a, b) => b.gamesStarted - a.gamesStarted)[0];
    const topAccuracy = [...eligible].sort((a, b) => {
      const rA = a.totalCorrect / (a.totalCorrect + a.totalWrong) || 0;
      const rB = b.totalCorrect / (b.totalCorrect + b.totalWrong) || 0;
      return rB - rA;
    })[0];

    const titleConfig = [
      { userId: topScore?.userId,    name: "积分之王",   rankType: "积分" },
      { userId: topCorrect?.userId,  name: "答题之王",   rankType: "答对数" },
      { userId: topRounds?.userId,   name: "参与之王",   rankType: "参与局数" },
      { userId: topStarted?.userId,  name: "开局之王",   rankType: "开局数" },
      { userId: topAccuracy?.userId, name: "正确率之王", rankType: "正确率" },
    ];

    for (const cfg of titleConfig) {
      if (!cfg.userId) continue;

      // 找到当前持有该群荣誉头衔的用户（通过 guildId 隔离）
      const currentHolders = allUsers.filter(u =>
        (u.titles as TitleEntry[]).some(
          t => t.name === cfg.name && (t.guildId === guildId || (!t.guildId && !guildId))
        )
      );

      const currentHolder = currentHolders.length > 0 ? currentHolders[0] : null;
      const isFirstTime = currentHolder === null;
      const isChange = currentHolder !== null && currentHolder.userId !== cfg.userId;
      const newHolder = await this.getUser(cfg.userId);

      // 检测易主
      if (isChange && session) {
        let oldName = currentHolder.userId;
        let newName = cfg.userId;
        try {
          if (session.guildId) {
            const oldM = await session.bot.getGuildMember?.(session.guildId, currentHolder.userId);
            oldName = (oldM as any)?.nickname ?? (oldM as any)?.name ?? oldName;
            const newM = await session.bot.getGuildMember?.(session.guildId, cfg.userId);
            newName = (newM as any)?.nickname ?? (newM as any)?.name ?? newName;
          }
        } catch { /* 忽略 */ }
        await session.send(`🔄 ${cfg.rankType}榜首易主！\n${newName} 取代 ${oldName} 成为新的第一！`);
      }

      // 清除所有旧持有者在此群的该荣誉头衔
      for (const holder of currentHolders) {
        if (holder.userId !== cfg.userId) {
          const oldHolder = await this.getUser(holder.userId);
          oldHolder.titles = oldHolder.titles.filter(
            t => !(t.name === cfg.name && (t.guildId === guildId || (!t.guildId && !guildId)))
          );
          await this.ctx.database.set("sudoku_user", { userId: holder.userId }, this.toUpdateData(oldHolder));
        }
      }

      // 授予新持有者（刷新）
      newHolder.titles = newHolder.titles.filter(
        t => !(t.name === cfg.name && (t.guildId === guildId || (!t.guildId && !guildId)))
      );
      newHolder.titles.push({ name: cfg.name, expire: HONOR_EXPIRE, type: "honor", guildId });
      await this.ctx.database.set("sudoku_user", { userId: cfg.userId }, this.toUpdateData(newHolder));

      // 只在首次授予或易主时播报，持有者不变则静默刷新
      if ((isFirstTime || isChange) && session) {
        let holderName = cfg.userId;
        try {
          if (session.guildId) {
            const m = await session.bot.getGuildMember?.(session.guildId, cfg.userId);
            holderName = (m as any)?.nickname ?? (m as any)?.name ?? holderName;
          }
        } catch { /* 忽略 */ }
        await session.send(
          `👑 当前 ${holderName} ${cfg.rankType}本群排名第一！\n` +
          `🎖️ 小仙授予 ${holderName} 荣誉头衔「${cfg.name}」`
        );
      }
    }
  }

  async exchangeTitle(userId: string, titleName: string): Promise<boolean> {
    const user = await this.getUser(userId);

    const titleCatalog: Record<string, { name: string; price: number; duration: number }> = {
      sudoku_apprentice: { name: "数独学徒", price: 100, duration: 7 },
      problem_solver:    { name: "解题高手", price: 500, duration: 30 },
      endgame_master:    { name: "终盘大师", price: 2000, duration: 365 },
    };

    const titleKey = Object.keys(titleCatalog).find(k => titleCatalog[k].name === titleName);
    if (!titleKey) return false;

    const titleInfo = titleCatalog[titleKey];
    if (user.score < titleInfo.price) return false;

    // 防止重复购买未过期的头衔
    const now = Date.now();
    if (user.titles.some(t => t.name === titleInfo.name && t.expire > now)) return false;

    user.score -= titleInfo.price;
    user.score = Math.max(0, user.score); // 二次保底
    const expire = Date.now() + titleInfo.duration * 24 * 60 * 60 * 1000;
    user.titles.push({ name: titleName, expire, type: "regular" });

    await this.ctx.database.set("sudoku_user", { userId }, this.toUpdateData(user));
    return true;
  }

  /**
   * 返回用户成就列表的格式化文本（供 game.ts 发送）。
   * 普通成就全部展示 ✅/❌，隐藏成就只展示已解锁的。
   */
  async getAchievementListText(userId: string, username: string, detailCommand: string): Promise<string> {
    const user = await this.getUser(userId);
    const unlocked = new Set(user.achievements);

    // 按分类组织普通成就
    const categories: Array<{ label: string; keys: string[] }> = [
      { label: "基础",   keys: ["first_win", "first_wrong"] },
      { label: "连击",   keys: ["streak_5", "streak_10", "streak_20"] },
      { label: "参与",   keys: ["rounds_10", "rounds_50", "rounds_100"] },
      { label: "积分",   keys: ["score_100", "score_500", "score_1000", "score_5000"] },
      { label: "正确率", keys: ["accuracy_80", "accuracy_90", "accuracy_95"] },
      { label: "完美局", keys: ["perfect_1", "perfect_10"] },
      { label: "MVP",   keys: ["mvp_1", "mvp_10", "mvp_50"] },
      { label: "答题量", keys: ["correct_100", "correct_500", "correct_1000"] },
    ];

    const regularKeys = new Set(categories.flatMap(c => c.keys));
    const regularTotal = regularKeys.size;
    const regularUnlocked = [...regularKeys].filter(k => unlocked.has(k)).length;

    const hiddenEntries = Object.entries(ACHIEVEMENTS).filter(([, a]) => a.hidden);
    const unlockedHidden = hiddenEntries.filter(([key]) => unlocked.has(key));

    const lines: string[] = [
      `【${username} 的成就档案】`,
      `普通 ${regularUnlocked}/${regularTotal}  ✨隐藏已解锁 ${unlockedHidden.length} 个`,
      "",
      "📋 普通成就",
    ];

    for (const cat of categories) {
      const parts = cat.keys.map(key => {
        const ach = ACHIEVEMENTS[key];
        return `${unlocked.has(key) ? "✅" : "❌"}${ach?.name ?? key}`;
      });
      lines.push(`${cat.label}:  ${parts.join("  ")}`);
    }

    if (unlockedHidden.length > 0) {
      lines.push("", "✨ 已解锁隐藏成就");
      for (const [, ach] of unlockedHidden) {
        const titlePart = ach.title ? `  头衔：${ach.title}` : "";
        lines.push(`  【${ach.name}】${titlePart}`);
      }
    }

    lines.push("", `💡 输入「${detailCommand} <成就名>」查看成就详情`);
    return lines.join("\n");
  }

  /**
   * 返回指定成就的详情文本。
   * 隐藏成就未解锁时只返回神秘提示，已解锁或普通成就则展示全部信息。
   */
  async getAchievementDetailText(userId: string, achievementName: string): Promise<string> {
    const user = await this.getUser(userId);

    const entry = Object.entries(ACHIEVEMENTS).find(([, a]) => a.name === achievementName);
    if (!entry) {
      return `未找到名为「${achievementName}」的成就，请检查名称是否正确。`;
    }

    const [key, ach] = entry;
    const isUnlocked = user.achievements.includes(key);

    if (ach.hidden && !isUnlocked) {
      return `【成就：${achievementName}】\n该成就尚未解锁，继续探索吧～ 🔒`;
    }

    const lines: string[] = [
      `【成就：${ach.name}】${ach.hidden ? "（隐藏成就）" : ""}`,
      `条件：${ach.desc}`,
      `奖励：+${ach.reward} 积分`,
    ];
    if (ach.title) {
      lines.push(`专属头衔：${ach.title}`);
    }
    lines.push(`状态：${isUnlocked ? "✅ 已解锁" : "❌ 未解锁"}`);
    return lines.join("\n");
  }

  /**
   * 获取展示头衔（带包裹符号）。
   * 优先级：成就头衔 > 荣誉头衔 > 普通头衔。
   * 兼容旧数据（无 type 字段时通过名称推断）。
   */
  getDisplayTitle(user: UserData): string {
    if (!user.titles || user.titles.length === 0) return "";
    const now = Date.now();
    const validTitles = user.titles.filter(t => t.expire > now);
    if (validTitles.length === 0) return "";

    // 推断头衔类型（兼容旧数据）
    const inferType = (t: TitleEntry): "achievement" | "honor" | "regular" => {
      if (t.type) return t.type;
      if (ACHIEVEMENT_TITLE_NAMES.has(t.name)) return "achievement";
      if (HONOR_TITLE_NAMES.has(t.name)) return "honor";
      return "regular";
    };

    const typePriority: Record<string, number> = { achievement: 0, honor: 1, regular: 2 };
    const sorted = [...validTitles].sort(
      (a, b) => (typePriority[inferType(a)] ?? 2) - (typePriority[inferType(b)] ?? 2)
    );

    const best = sorted[0];
    const type = inferType(best);
    if (type === "achievement") return `【${best.name}】`;
    if (type === "honor") return `「${best.name}」`;
    return `[${best.name}]`;
  }
}
