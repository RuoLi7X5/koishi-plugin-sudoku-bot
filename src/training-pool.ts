/**
 * training-pool.ts
 *
 * 唯余训练题目池管理（SQLite / Koishi Database）
 *
 * 功能：
 *   - 每个难度（D3~D8）维护 200 道题目的持久化题目池
 *   - 题目发出后标记 used=1，立即触发后台补充
 *   - 后台补充以 setImmediate 方式异步运行，不阻塞出题
 *   - 插件启动时自动填充空缺
 *
 * 表结构（training_puzzle_pool）：
 *   id         - 自增主键
 *   difficulty - 难度 3~8
 *   puzzle     - 9×9 盘面 JSON
 *   targetRow  - 目标格行（0-based）
 *   targetCol  - 目标格列（0-based）
 *   answer     - 答案（1-9）
 *   tracePath  - 推理路径文本（已渲染好的步骤字符串）
 *   traceJson  - 完整 TrainingTrace JSON（供高级查询用）
 *   isUsed     - 0=未使用，1=已发出
 *   createdAt  - 创建时间戳（ms）
 */

import { Context } from 'koishi';
import { generateTrainingPuzzle, BuildResult } from './training/builder';
import { renderTrainingPath } from './training/path-text';
import { TrainingTrace } from './training/solver';

// ═══════════════════════════════════════════════════════════════
// 常量配置
// ═══════════════════════════════════════════════════════════════

/** 每个难度维护的题目池容量 */
export const POOL_SIZE = 200;

/** 支持的训练难度列表（D3~D8） */
export const SUPPORTED_DIFFICULTIES = [3, 4, 5, 6, 7, 8] as const;

// ═══════════════════════════════════════════════════════════════
// 数据库模型扩展
// ═══════════════════════════════════════════════════════════════

/** 数据库行记录类型 */
export interface PoolRecord {
  id: number;
  difficulty: number;
  puzzle: string;     // JSON.stringify(number[][])
  targetRow: number;
  targetCol: number;
  answer: number;
  tracePath: string;  // 渲染好的推理路径文本
  traceJson: string;  // JSON.stringify(TrainingTrace)
  isUsed: number;     // 0 | 1
  createdAt: number;  // Date.now()
}

/** 在 Koishi 数据库中声明表结构 */
export function extendPoolModel(ctx: Context): void {
  ctx.model.extend(
    'training_puzzle_pool' as const,
    {
      id: 'unsigned',
      difficulty: 'integer',
      puzzle: 'text',
      targetRow: 'integer',
      targetCol: 'integer',
      answer: 'integer',
      tracePath: 'text',
      traceJson: 'text',
      isUsed: 'integer',
      createdAt: 'integer',
    } as any,
    { primary: 'id', autoInc: true },
  );
}

// ═══════════════════════════════════════════════════════════════
// 题目池管理器
// ═══════════════════════════════════════════════════════════════

export class TrainingPool {
  private ctx: Context;
  private filling: Set<number> = new Set(); // 正在填充中的难度，防并发

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** 启动时初始化：检查各难度题目池，空缺则触发后台补充 */
  async init(): Promise<void> {
    const logger = this.ctx.logger('sudoku');
    logger.info('[题目池] 开始检查各难度题目池...');
    for (const diff of SUPPORTED_DIFFICULTIES) {
      const count = await this.countAvailable(diff);
      logger.info(`[题目池] D${diff}: 当前可用 ${count} 道（目标 ${POOL_SIZE}）`);
      if (count < POOL_SIZE) {
        this.triggerFill(diff, POOL_SIZE - count);
      }
    }
  }

  /** 从题目池取出一道题目（标记为已使用，触发补充） */
  async drawOne(difficulty: number): Promise<PoolRecord | null> {
    const rows: PoolRecord[] = await this.ctx.database.get(
      'training_puzzle_pool' as any,
      { difficulty, isUsed: 0 } as any,
    ) as any[];

    if (!rows || rows.length === 0) return null;

    // 随机选一道
    const row = rows[Math.floor(Math.random() * rows.length)];

    // 标记为已使用
    await this.ctx.database.set(
      'training_puzzle_pool' as any,
      { id: row.id } as any,
      { isUsed: 1 } as any,
    );

    // 触发后台补充（维持池满）
    const remaining = rows.length - 1;
    if (remaining < POOL_SIZE) {
      this.triggerFill(difficulty, 1);
    }

    return row;
  }

  /** 查询指定难度可用题目数量 */
  async countAvailable(difficulty: number): Promise<number> {
    const rows: PoolRecord[] = await this.ctx.database.get(
      'training_puzzle_pool' as any,
      { difficulty, isUsed: 0 } as any,
    ) as any[];
    return rows?.length ?? 0;
  }

  /** 异步后台填充题目池（fire-and-forget，不阻塞调用方） */
  triggerFill(difficulty: number, targetCount: number = POOL_SIZE): void {
    if (this.filling.has(difficulty)) return;
    this.filling.add(difficulty);

    setImmediate(async () => {
      const logger = this.ctx.logger('sudoku');
      let filled = 0;
      let failures = 0;
      const maxFailures = 10;

      try {
        while (filled < targetCount && failures < maxFailures) {
          // 重新检查是否还需要补充
          const current = await this.countAvailable(difficulty);
          if (current >= POOL_SIZE) break;

          try {
            const result = generateTrainingPuzzle(difficulty);
            await this.insertPuzzle(difficulty, result);
            filled++;
            failures = 0;

            // 让出事件循环，每填充 3 道让出一次
            if (filled % 3 === 0) {
              await new Promise(resolve => setImmediate(resolve));
            }
          } catch (err: any) {
            failures++;
            logger.warn(`[题目池] D${difficulty} 生成失败（${failures}/${maxFailures}）: ${err?.message ?? err}`);
            await new Promise(resolve => setTimeout(resolve, 50 * failures));
          }
        }
        if (filled > 0) {
          logger.info(`[题目池] D${difficulty} 已补充 ${filled} 道题目`);
        }
      } finally {
        this.filling.delete(difficulty);
      }
    });
  }

  /** 插入一道题目到数据库 */
  private async insertPuzzle(difficulty: number, result: BuildResult): Promise<void> {
    const tracePath = renderTrainingPath(result.trace);
    await this.ctx.database.create(
      'training_puzzle_pool' as any,
      {
        difficulty,
        puzzle: JSON.stringify(result.puzzle),
        targetRow: result.targetRow,
        targetCol: result.targetCol,
        answer: result.answer,
        tracePath,
        traceJson: JSON.stringify(result.trace),
        isUsed: 0,
        createdAt: Date.now(),
      } as any,
    );
  }

  /**
   * 解析题目记录，返回可用于发题的结构体
   */
  static parseRecord(row: PoolRecord): {
    puzzle: number[][];
    targetRow: number;
    targetCol: number;
    answer: number;
    tracePath: string;
    trace: TrainingTrace;
  } {
    return {
      puzzle: JSON.parse(row.puzzle) as number[][],
      targetRow: row.targetRow,
      targetCol: row.targetCol,
      answer: row.answer,
      tracePath: row.tracePath,
      trace: JSON.parse(row.traceJson) as TrainingTrace,
    };
  }
}
