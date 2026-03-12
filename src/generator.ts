import * as dachev from "sudoku";

type SudokuGenDifficulty = "easy" | "medium" | "hard" | "expert";

export class SudokuGenerator {
  private difficulty: number;

  constructor(difficulty: number) {
    this.difficulty = difficulty;
  }

  generate(): { puzzle: number[][]; solution: number[][] } {
    // 难度档位与生成器的映射：
    //   1: sudoku-gen easy    （简单）
    //   2: sudoku-gen medium  （较易）
    //   3: @forfuns/sudoku level 1（中等）
    //   4: sudoku-gen hard    （中等+）
    //   5: @forfuns/sudoku level 2（困难）
    //   6: sudoku-gen expert  （困难+）
    //   7: @forfuns/sudoku level 4（极难）
    const useForfuns = [3, 5, 7].includes(this.difficulty);
    return useForfuns ? this.generateWithForfuns() : this.generateWithSudokuGen();
  }

  // ── sudoku-gen 路径（档位 1 / 2 / 4 / 6） ──────────────────────────────
  private generateWithSudokuGen(): { puzzle: number[][]; solution: number[][] } {
    const difficultyMap: Record<number, SudokuGenDifficulty> = {
      1: "easy",
      2: "medium",
      4: "hard",
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

  // ── @forfuns/sudoku 路径（档位 3 / 5 / 7） ─────────────────────────────
  private generateWithForfuns(): { puzzle: number[][]; solution: number[][] } {
    const levelMap: Record<number, number> = { 3: 1, 5: 2, 7: 4 };
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

  /** 用 dachev/sudoku 求解（供 @forfuns 路径使用） */
  private solvePuzzle(puzzleArray: number[]): number[] {
    const input = puzzleArray.map((v) => (v === 0 ? null : v - 1));
    const result = dachev.solvepuzzle(input);
    if (!result) {
      console.error("[Sudoku] 求解失败，返回原始 puzzle");
      return puzzleArray;
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
