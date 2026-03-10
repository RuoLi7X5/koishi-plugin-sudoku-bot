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
  lastPlaceCount: number; // 垫底次数
  consecutiveLastPlace: number; // 连续垫底次数
}

// 普通成就
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
    title: "⚡闪电侠"
  },
  last_second_hero: { 
    name: "压哨绝杀", 
    desc: "在最后5秒答对（该题无人答对过）", 
    reward: 200, 
    hidden: true,
    title: "🏀绝杀王"
  },
  own_rhythm: { 
    name: "自有旋律", 
    desc: "单局对错交替完成全部8题", 
    reward: 300, 
    hidden: true,
    title: "🎵节奏大师"
  },
  perfect_start: { 
    name: "完美开局", 
    desc: "单局前3题全对", 
    reward: 80, 
    hidden: true,
    title: "🚀开局王者"
  },
  comeback_king: { 
    name: "绝地反击", 
    desc: "前5题至少错3题，但最后3题全对", 
    reward: 250, 
    hidden: true,
    title: "💪逆转之王"
  },
  lone_wolf: { 
    name: "孤胆英雄", 
    desc: "独自一人完成一局游戏", 
    reward: 500, 
    hidden: true,
    title: "🦸独行侠"
  },
  dominator: { 
    name: "一骑绝尘", 
    desc: "单局领先第二名30分以上", 
    reward: 180, 
    hidden: true,
    title: "🏇霸主"
  },
  never_defeated: { 
    name: "不败传说", 
    desc: "连续10局都获得MVP", 
    reward: 1500, 
    hidden: true,
    title: "👑不败神话"
  },
  wrong_is_right: { 
    name: "歪打正着", 
    desc: "单局答错3题但仍然获得MVP", 
    reward: 350, 
    hidden: true,
    title: "🎲幸运之子"
  },
  speed_demon: { 
    name: "速度恶魔", 
    desc: "单局所有答对题目平均用时不超过10秒", 
    reward: 400, 
    hidden: true,
    title: "👹极速狂飙"
  },
  lucky_seven: { 
    name: "幸运七", 
    desc: "恰好答对7题答错1题", 
    reward: 120, 
    hidden: true,
    title: "🍀七星高照"
  },
  zen_master: { 
    name: "禅定大师", 
    desc: "单局每题都在倒计时剩余15-20秒时答对", 
    reward: 500, 
    hidden: true,
    title: "🧘禅心如一"
  },
  
  // === 不屈勇士系列隐藏成就 ===
  brave_heart: {
    name: "不屈之心",
    desc: "连续5局垫底仍继续参与",
    reward: 600,
    hidden: true,
    title: "💖屡败屡战"
  },
  iron_will: {
    name: "钢铁意志",
    desc: "连续10局垫底仍继续参与",
    reward: 1200,
    hidden: true,
    title: "🛡️钢铁战士"
  },
  eternal_warrior: {
    name: "永恒战士",
    desc: "虽然累计垫底20次，但从未放弃",
    reward: 2000,
    hidden: true,
    title: "⚔️不灭斗魂"
  },
  rise_from_ashes: {
    name: "浴火重生",
    desc: "连续5局垫底后，终于获得MVP",
    reward: 1500,
    hidden: true,
    title: "🔥凤凰涅槃"
  },
  starter_spirit: {
    name: "开局之魂",
    desc: "累计主动发起游戏50次（无论成绩）",
    reward: 800,
    hidden: true,
    title: "🎮游戏先驱"
  },
  never_give_up: {
    name: "永不言弃",
    desc: "在正确率低于30%的情况下仍参与50局",
    reward: 1000,
    hidden: true,
    title: "🌟不屈之魂"
  },
};

export class UserService {
  private ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  async getUser(userId: string): Promise<UserData> {
    const [user] = await this.ctx.database.get("sudoku_user", { userId });
    if (user) {
      // 确保旧数据兼容新字段
      const userData = user as any;
      return {
        ...user,
        perfectRounds: userData.perfectRounds ?? 0,
        mvpCount: userData.mvpCount ?? 0,
        lastPlaceCount: userData.lastPlaceCount ?? 0,
        consecutiveLastPlace: userData.consecutiveLastPlace ?? 0,
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
    roundData: { 
      correct: number; 
      wrong: number; 
      score: number; 
      streak: number;
      // 隐藏成就相关数据
      answerPattern?: string; // 答题模式，如"对错对错对错对错"
      fastestAnswer?: number; // 最快答题时间（秒）
      slowestCorrect?: number; // 最慢的正确答案（秒）
      averageTime?: number; // 平均答题时间
      lastSecondAnswers?: number; // 最后5秒答对数
      firstThreeCorrect?: boolean; // 前3题是否全对
      comebackPattern?: { first5Wrong: number; last3Correct: number }; // 反击模式
      isAlone?: boolean; // 是否独自完成
      leadMargin?: number; // 领先第二名的分数
      wrongButMvp?: boolean; // 答错3题但仍是MVP
      zenPattern?: boolean; // 禅定模式（每题都在15-20秒）
    },
    session: Session,
  ) {
    const user = await this.getUser(userId);
    const unlocked: Array<{ name: string; reward: number; isHidden: boolean }> = [];
    const totalAnswered = user.totalCorrect + user.totalWrong;
    const accuracy = totalAnswered === 0 ? 0 : user.totalCorrect / totalAnswered;

    // 检查普通成就
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

    // 检查隐藏成就
    if (roundData.fastestAnswer !== undefined && roundData.fastestAnswer <= 5) {
      checks.push({ key: "lightning_hand", condition: true });
    }
    if (roundData.lastSecondAnswers !== undefined && roundData.lastSecondAnswers > 0) {
      checks.push({ key: "last_second_hero", condition: true });
    }
    if (roundData.answerPattern === "对错对错对错对错") {
      checks.push({ key: "own_rhythm", condition: true });
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

    // 检查连续10局MVP
    const recentMvps = await this.getRecentMvpStreak(userId);
    if (recentMvps >= 10) {
      checks.push({ key: "never_defeated", condition: true });
    }
    
    // 检查不屈勇士系列成就
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
          isHidden: achievement.hidden || false
        });
        user.achievements.push(check.key);
        user.score += achievement.reward;
        
        // 如果隐藏成就有专属头衔，自动授予
        if (achievement.hidden && achievement.title) {
          const titleExpire = Date.now() + 365 * 24 * 60 * 60 * 1000; // 隐藏成就头衔有效期1年
          user.titles.push({ name: achievement.title, expire: titleExpire });
        }
      }
    }

    if (unlocked.length > 0) {
      await this.ctx.database.set("sudoku_user", { userId }, user);
      for (const ach of unlocked) {
        let prefix: string;
        let titleWrapper: [string, string];
        
        const achievement = Object.values(ACHIEVEMENTS).find(a => a.name === ach.name);
        
        if (ach.isHidden) {
          // 隐藏成就：特殊播报 + 【】符号
          prefix = "✨✨✨ 隐藏成就解锁 ✨✨✨";
          titleWrapper = ["【", "】"];
          
          // 如果有专属头衔，一并播报
          if (achievement?.title) {
            await session.send(
              `${prefix}\n恭喜 @${session.username} 解锁成就${titleWrapper[0]}${ach.name}${titleWrapper[1]}！\n🎁 获得 ${ach.reward} 积分奖励！\n🎖️ 同时获得专属头衔【${achievement.title}】！（有效期1年）`,
            );
          } else {
            await session.send(
              `${prefix}\n恭喜 @${session.username} 解锁成就${titleWrapper[0]}${ach.name}${titleWrapper[1]}！\n🎁 获得 ${ach.reward} 积分奖励！`,
            );
          }
        } else {
          // 普通成就：普通播报 + []符号
          prefix = "🎊";
          titleWrapper = ["[", "]"];
          await session.send(
            `${prefix}\n恭喜 @${session.username} 解锁成就${titleWrapper[0]}${ach.name}${titleWrapper[1]}！\n🎁 获得 ${ach.reward} 积分奖励！`,
          );
        }
      }
    }
  }

  // 获取最近的MVP连胜数
  async getRecentMvpStreak(userId: string): Promise<number> {
    // 这里需要额外的数据结构来记录每局的MVP
    // 暂时返回0，后续可以实现
    return 0;
  }

  async updateHonorTitles(durationDays: number, session?: Session) {
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
    
    const titleConfig = [
      { 
        userId: topScore?.userId, 
        name: "积分之王", 
        rankType: "积分",
        value: topScore?.score,
        expire 
      },
      { 
        userId: topCorrect?.userId, 
        name: "答题之王", 
        rankType: "答对数",
        value: topCorrect?.totalCorrect,
        expire 
      },
      { 
        userId: topRounds?.userId, 
        name: "参与之王", 
        rankType: "参与局数",
        value: topRounds?.totalRounds,
        expire 
      },
      { 
        userId: topStarted?.userId, 
        name: "开局之王", 
        rankType: "开局数",
        value: topStarted?.gamesStarted,
        expire 
      },
      { 
        userId: topAccuracy?.userId, 
        name: "正确率之王", 
        rankType: "正确率",
        value: topAccuracy ? 
          ((topAccuracy.totalCorrect / (topAccuracy.totalCorrect + topAccuracy.totalWrong)) * 100).toFixed(1) + "%" : 
          null,
        expire 
      },
    ];

    // 检测易主并播报
    for (const config of titleConfig) {
      if (!config.userId) continue;
      
      // 查找当前拥有该头衔的用户
      const currentHolders = users.filter(u => 
        u.titles.some((t: { name: string; expire: number }) => t.name === config.name && t.expire > now)
      );
      
      const currentHolder = currentHolders.length > 0 ? currentHolders[0] : null;
      const newHolder = await this.getUser(config.userId);
      
      // 检测是否易主
      if (currentHolder && currentHolder.userId !== config.userId) {
        // 发生易主
        if (session) {
          let oldHolderName = currentHolder.userId;
          let newHolderName = config.userId;
          
          // 尝试获取昵称
          try {
            if (session.guildId) {
              const oldMember = await session.bot.getGuildMember?.(session.guildId, currentHolder.userId);
              oldHolderName = (oldMember as any)?.nickname ?? (oldMember as any)?.name ?? currentHolder.userId;
              
              const newMember = await session.bot.getGuildMember?.(session.guildId, config.userId);
              newHolderName = (newMember as any)?.nickname ?? (newMember as any)?.name ?? config.userId;
            }
          } catch {
            // 忽略错误
          }
          
          await session.send(
            `🔄 ${config.rankType}榜首易主了！\n` +
            `${newHolderName} 取代 ${oldHolderName} 成为新的第一！`
          );
        }
      }
      
      // 更新头衔
      newHolder.titles = newHolder.titles.filter((title) => title.name !== config.name);
      newHolder.titles.push({ name: config.name, expire: config.expire });
      await this.ctx.database.set("sudoku_user", { userId: config.userId }, newHolder);
      
      // 播报授予头衔
      if (session) {
        let holderName = config.userId;
        try {
          if (session.guildId) {
            const member = await session.bot.getGuildMember?.(session.guildId, config.userId);
            holderName = (member as any)?.nickname ?? (member as any)?.name ?? config.userId;
          }
        } catch {
          // 忽略错误
        }
        
        await session.send(
          `👑 当前 ${holderName} ${config.rankType}排名第一！\n` +
          `🎖️ 小仙授予 ${holderName} 荣誉头衔「${config.name}」\n` +
          `⏰ 有效期：${durationDays}天`
        );
      }
    }
  }

  async grantTitle(
    userId: string, 
    titleName: string, 
    durationDays: number,
    session?: Session
  ): Promise<boolean> {
    const user = await this.getUser(userId);
    const expire = Date.now() + durationDays * 24 * 60 * 60 * 1000;
    
    // 检查是否已有该头衔
    const hasTitle = user.titles.some(t => t.name === titleName);
    if (hasTitle) return false;
    
    user.titles.push({ name: titleName, expire });
    await this.ctx.database.set("sudoku_user", { userId }, user);
    
    // 播报获得头衔（区分荣誉头衔和普通头衔）
    if (session) {
      const honorTitles = ["积分之王", "答题之王", "参与之王", "开局之王", "正确率之王"];
      const wrapper = honorTitles.includes(titleName) 
        ? ["「", "」"]  // 荣誉头衔
        : ["[", "]"];    // 普通头衔
      
      await session.send(
        `🎉 恭喜 @${session.username} 获得头衔${wrapper[0]}${titleName}${wrapper[1]}！`
      );
    }
    
    return true;
  }

  async exchangeTitle(userId: string, titleName: string): Promise<boolean> {
    const user = await this.getUser(userId);
    
    const titleCatalog: Record<string, { name: string; price: number; duration: number }> = {
      sudoku_apprentice: { name: "数独学徒", price: 100, duration: 7 },
      problem_solver: { name: "解题高手", price: 500, duration: 30 },
      endgame_master: { name: "终盘大师", price: 2000, duration: 365 },
    };

    const titleKey = Object.keys(titleCatalog).find(
      (key) => titleCatalog[key].name === titleName,
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

  getDisplayTitle(user: UserData): string {
    if (user.titles.length === 0) return "";
    const now = Date.now();
    const validTitles = user.titles.filter(t => t.expire > now);
    if (validTitles.length === 0) return "";
    
    const firstTitle = validTitles[0].name;
    
    // 判断是否为荣誉头衔（自动授予的头衔）
    const honorTitles = ["积分之王", "答题之王", "参与之王", "开局之王", "正确率之王"];
    if (honorTitles.includes(firstTitle)) {
      return `「${firstTitle}」`; // 荣誉头衔用「」
    }
    
    return `[${firstTitle}]`; // 普通头衔用[]
  }
}
