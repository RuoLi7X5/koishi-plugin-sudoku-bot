import * as sudoku from "sudoku";

export class SudokuGenerator {
  private difficulty: string;

  constructor(difficulty: string) {
    this.difficulty = difficulty;
  }

  generate(): { puzzle: number[][]; solution: number[][] } {
    // 生成谜题（一维数组，null 表示空格）
    const puzzleArray = sudoku.makepuzzle();
    // 转换为二维数组，0 表示空格，数字转换为 1-9
    const puzzle = this.to2D(
      puzzleArray.map((v: number | null) => (v === null ? 0 : v + 1)),
    );

    // 求解
    const solutionArray = sudoku.solvepuzzle(puzzleArray);
    const solution = this.to2D(solutionArray.map((v: number) => v + 1));

    return { puzzle, solution };
  }

  private to2D(arr: number[]): number[][] {
    const result: number[][] = [];
    for (let i = 0; i < 9; i++) {
      result.push(arr.slice(i * 9, i * 9 + 9));
    }
    return result;
  }
}
