import "koishi";

declare module "koishi" {
  interface Tables {
    sudoku_user: {
      id: string;
      platform: string;
      userId: string;
      score: number;
      totalRounds: number;
      totalCorrect: number;
      totalWrong: number;
      streak: number;
      maxStreak: number;
      titles: any;
      achievements: any;
      gamesStarted: number;
      perfectRounds: number;
      mvpCount: number;
      lastPlaceCount: number;
      consecutiveLastPlace: number;
      consecutiveMvp: number;
    };
  }
}
