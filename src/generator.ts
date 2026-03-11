import * as sudoku from "sudoku";

export class SudokuGenerator {
  private difficulty: number;

  constructor(difficulty: number) {
    this.difficulty = difficulty;
  }

  generate(): { puzzle: number[][]; solution: number[][] } {
    // 根据难度档位选择生成器
    // 1: sudoku-gen easy
    // 2: sudoku-gen medium  
    // 3: @forfuns/sudoku medium (level 1)
    // 4: sudoku-gen hard
    // 5: @forfuns/sudoku hard (level 2)
    // 6: sudoku-gen expert
    // 7: @forfuns/sudoku hell (level 4)
    
    const useForfuns = [3, 5, 7].includes(this.difficulty);
    
    if (useForfuns) {
      return this.generateWithForfuns();
    } else {
      return this.generateWithSudokuGen();
    }
  }

  private generateWithSudokuGen(): { puzzle: number[][]; solution: number[][] } {
    // 原有的 sudoku 包逻辑（实际是 dachev/sudoku，不支持难度）
    const puzzleArray = sudoku.makepuzzle();
    const puzzle = this.to2D(
      puzzleArray.map((v: number | null) => (v === null ? 0 : v + 1)),
    );

    const solutionArray = sudoku.solvepuzzle(puzzleArray);
    const solution = this.to2D(solutionArray.map((v: number) => v + 1));

    return { puzzle, solution };
  }

  private generateWithForfuns(): { puzzle: number[][]; solution: number[][] } {
    try {
      const { generator } = require('@forfuns/sudoku');
      
      // 映射难度档位到 @forfuns/sudoku 的 level
      const levelMap: Record<number, number> = {
        3: 1, // 中等 -> medium
        5: 2, // 困难 -> hard
        7: 4, // 极难 -> hell
      };
      
      const level = levelMap[this.difficulty] || 1;
      const puzzleArray = generator(level);
      
      // 转换为我们的格式（将 -1 转为 0）
      const normalizedArray = puzzleArray.map((v: number) => v === -1 ? 0 : v);
      const puzzle = this.to2D(normalizedArray);
      
      // 求解答案
      const solutionArray = this.solvePuzzle(normalizedArray);
      const solution = this.to2D(solutionArray);
      
      return { puzzle, solution };
    } catch (error) {
      console.error("[Sudoku] @forfuns/sudoku 生成失败，回退到 sudoku 包:", error);
      return this.generateWithSudokuGen();
    }
  }

  private solvePuzzle(puzzleArray: number[]): number[] {
    // 使用 dachev/sudoku 包求解
    // 转换格式：0 -> null，数字 -> 数字-1
    const inputArray = puzzleArray.map(v => v === 0 ? null : v - 1);
    const solutionArray = sudoku.solvepuzzle(inputArray);
    
    if (!solutionArray) {
      // 如果求解失败，返回原puzzle（不应该发生）
      console.error("[Sudoku] 求解失败");
      return puzzleArray;
    }
    
    // 转换回我们的格式：数字+1
    return solutionArray.map((v: number) => v + 1);
  }

  private to2D(arr: number[]): number[][] {
    const result: number[][] = [];
    for (let i = 0; i < 9; i++) {
      result.push(arr.slice(i * 9, i * 9 + 9));
    }
    return result;
  }
}
