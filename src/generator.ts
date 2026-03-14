import * as dachev from "sudoku";

type SudokuGenDifficulty = "easy" | "medium" | "hard" | "expert";

export class SudokuGenerator {
  private difficulty: number;

  constructor(difficulty: number) {
    this.difficulty = difficulty;
  }

  generate(): { puzzle: number[][]; solution: number[][] } {
    // 难度档位与生成器的映射（按实际难度排序，D2↔D3、D4↔D5 已对调）：
    //   1: sudoku-gen easy         （简单）   avg ~3.7 步
    //   2: @forfuns/sudoku level 1 （较易）   avg ~4.0 步
    //   3: sudoku-gen medium       （中等）   avg ~9.6 步
    //   4: @forfuns/sudoku level 2 （中等+）  avg ~9.6 步
    //   5: sudoku-gen hard         （困难）   avg ~23 步
    //   6: sudoku-gen expert       （困难+）  avg ~34 步
    //   7: @forfuns/sudoku level 4 （极难）
    const useForfuns = [2, 4, 7].includes(this.difficulty);

    // 生成并验证：要求至少 20 个空格（正常谜题 30-65 个，20 作为安全下限）。
    // 极个别情况下第三方库会返回全填满盘面或极少空格盘面，直接拒绝并重试。
    const MIN_EMPTY = 20;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const result = useForfuns ? this.generateWithForfuns() : this.generateWithSudokuGen();
        const emptyCount = result.puzzle.flat().filter(v => v === 0).length;
        if (emptyCount >= MIN_EMPTY) return result;
        console.warn(`[Sudoku] 盘面空格数不足（${emptyCount} 格），第 ${attempt + 1} 次重试`);
      } catch (err) {
        console.warn(`[Sudoku] 生成器异常，第 ${attempt + 1} 次重试:`, err);
      }
    }

    // 5 次重试均不满足要求，降级到 dachev/sudoku 兜底（不支持难度，但保证有效）
    console.error("[Sudoku] 主生成器多次失败，降级到 dachev/sudoku");
    return this.generateWithDachev();
  }

  // ── sudoku-gen 路径（档位 1 / 3 / 5 / 6） ──────────────────────────────
  private generateWithSudokuGen(): { puzzle: number[][]; solution: number[][] } {
    const difficultyMap: Record<number, SudokuGenDifficulty> = {
      1: "easy",
      3: "medium",
      5: "hard",
      6: "expert",
    };
    const level = difficultyMap[this.difficulty] ?? "medium";

    try {
      // sudoku-gen 实际导出名为 getSudoku（非 generateSudoku）
      const mod = require("sudoku-gen") as any;
      const getSudoku = (mod.getSudoku ?? mod.default?.getSudoku) as
        | ((d: SudokuGenDifficulty) => { puzzle: string; solution: string })
        | undefined;
      if (typeof getSudoku !== "function") {
        throw new TypeError(`getSudoku is not a function (got ${typeof getSudoku})`);
      }
      const result = getSudoku(level);
      // sudoku-gen 返回 81 字符字符串，'-' 表示空格
      return {
        puzzle: this.stringTo2D(result.puzzle),
        solution: this.stringTo2D(result.solution),
      };
    } catch (error) {
      console.error("[Sudoku] sudoku-gen 生成失败，回退到 dachev/sudoku:", error);
      return this.generateWithDachev();
    }
  }

  // ── @forfuns/sudoku 路径（档位 2 / 4 / 7） ─────────────────────────────
  private generateWithForfuns(): { puzzle: number[][]; solution: number[][] } {
    const levelMap: Record<number, number> = { 2: 1, 4: 2, 7: 4 };
    const level = levelMap[this.difficulty] ?? 1;

    try {
      // @forfuns/sudoku 同样可能包含 ESM 默认导出
      const mod = require("@forfuns/sudoku") as any;
      const generator = (mod.generator ?? mod.default?.generator ?? mod.default) as
        | ((level: number) => number[])
        | undefined;
      if (typeof generator !== "function") {
        throw new TypeError(`generator is not a function (got ${typeof generator})`);
      }
      const puzzleArray = generator(level);
      // @forfuns/sudoku 用 -1 表示空格，转换为 0
      const normalized = puzzleArray.map((v) => (v === -1 ? 0 : v));
      const puzzle = this.to2D(normalized);
      const solution = this.to2D(this.solvePuzzle(normalized));
      return { puzzle, solution };
    } catch (error) {
      console.error("[Sudoku] @forfuns/sudoku 生成失败，回退到 sudoku-gen:", error);
      return this.generateWithSudokuGen();
    }
  }

  // ── dachev/sudoku 兜底（不支持难度，仅作 fallback） ────────────────────
  private generateWithDachev(): { puzzle: number[][]; solution: number[][] } {
    const puzzleArray = dachev.makepuzzle();
    const puzzle = this.to2D(
      puzzleArray.map((v: number | null) => (v === null ? 0 : v + 1)),
    );
    const solutionArray = dachev.solvepuzzle(puzzleArray);
    const solution = this.to2D(solutionArray.map((v: number) => v + 1));
    return { puzzle, solution };
  }

  // ── 内部工具方法 ────────────────────────────────────────────────────────

  /** 用 dachev/sudoku 求解（供 @forfuns 路径使用）。求解失败时抛出异常由上层重新生成。 */
  private solvePuzzle(puzzleArray: number[]): number[] {
    const input = puzzleArray.map((v) => (v === 0 ? null : v - 1));
    const result = dachev.solvepuzzle(input);
    if (!result) {
      throw new Error("dachev/sudoku 求解失败，本题盘面无解");
    }
    return result.map((v: number) => v + 1);
  }

  /** 将 sudoku-gen 的字符串（'-' / '.' 表示空格）转为 9×9 数字数组 */
  private stringTo2D(str: string): number[][] {
    const arr = str.split("").map((c) => (c === "-" || c === ".") ? 0 : parseInt(c, 10));
    return this.to2D(arr);
  }

  /** 将长度为 81 的一维数组转为 9×9 二维数组 */
  private to2D(arr: number[]): number[][] {
    const result: number[][] = [];
    for (let i = 0; i < 9; i++) {
      result.push(arr.slice(i * 9, i * 9 + 9));
    }
    return result;
  }
}
