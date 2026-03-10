import { Context } from "koishi";

declare module "koishi" {
  interface Context {
    canvas: {
      render(width: number, height: number, callback: (ctx: any) => void): Promise<Buffer>;
    };
  }
}

export class ImageRenderer {
  constructor(private ctx: Context) {}

  async render(puzzle: number[][]): Promise<Buffer> {
    const cellSize = 50;
    const size = cellSize * 9;

    try {
      // 使用 Koishi 的 canvas 服务
      return await this.ctx.canvas.render(size, size, (ctx: any) => {
        // 绘制背景
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, size, size);

        // 绘制网格线
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 1;
        for (let i = 0; i <= 9; i++) {
          const pos = i * cellSize;
          ctx.beginPath();
          ctx.moveTo(pos, 0);
          ctx.lineTo(pos, size);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(0, pos);
          ctx.lineTo(size, pos);
          ctx.stroke();
        }

        // 绘制粗线分隔3x3宫
        ctx.lineWidth = 3;
        for (let i = 0; i <= 9; i += 3) {
          const pos = i * cellSize;
          ctx.beginPath();
          ctx.moveTo(pos, 0);
          ctx.lineTo(pos, size);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(0, pos);
          ctx.lineTo(size, pos);
          ctx.stroke();
        }

        // 绘制数字
        ctx.font = "30px Arial";
        ctx.fillStyle = "#000000";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (let r = 0; r < 9; r++) {
          for (let c = 0; c < 9; c++) {
            const val = puzzle[r][c];
            if (val !== 0) {
              const x = c * cellSize + cellSize / 2;
              const y = r * cellSize + cellSize / 2;
              ctx.fillText(val.toString(), x, y);
            }
          }
        }
      });
    } catch (error: any) {
      throw new Error(`Canvas 渲染失败：${error?.message || error}\n请确保已安装并启用 @koishijs/plugin-canvas 插件`);
    }
  }
}
