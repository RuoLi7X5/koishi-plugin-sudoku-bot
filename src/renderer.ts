import { Context } from "koishi";

// 尝试导入多个可能的 canvas 库
let NativeCanvas: any;
try {
  NativeCanvas = require("@napi-rs/canvas");
} catch {
  try {
    NativeCanvas = require("canvas");
  } catch {
    NativeCanvas = null;
  }
}

declare module "koishi" {
  interface Context {
    canvas?: any;
  }
}

export class ImageRenderer {
  constructor(private ctx: Context) {}


  async render(puzzle: number[][], difficulty?: string): Promise<Buffer> {
    const cellSize = 50;
    const gridSize = cellSize * 9;
    const padding = 20; // 边距
    const bottomSpace = 40; // 底部空间用于显示难度
    const size = gridSize + padding * 2;
    const totalHeight = size + bottomSpace;

    try {
      console.log("[Sudoku] 开始渲染，尺寸:", size, "x", totalHeight, "难度:", difficulty);
      
      let canvas: any;
      let ctx2d: any;

      // 方法 1：尝试使用 Koishi Canvas 服务
      if (this.ctx.canvas) {
        console.log("[Sudoku] 检测到 Canvas 服务");
        console.log("[Sudoku] Canvas 服务类型:", typeof this.ctx.canvas);
        console.log("[Sudoku] Canvas 服务可用方法:", Object.keys(this.ctx.canvas).join(", "));
        
        // 尝试不同的 API
        if (typeof this.ctx.canvas.createCanvas === "function") {
          console.log("[Sudoku] 使用 canvas.createCanvas()");
          canvas = this.ctx.canvas.createCanvas(size, totalHeight);
          ctx2d = canvas.getContext("2d");
        } else if (typeof this.ctx.canvas.Canvas === "function") {
          console.log("[Sudoku] 使用 new canvas.Canvas()");
          canvas = new this.ctx.canvas.Canvas(size, totalHeight);
          ctx2d = canvas.getContext("2d");
        } else if (this.ctx.canvas.constructor && this.ctx.canvas.constructor.name === "Canvas") {
          console.log("[Sudoku] Canvas 服务本身就是 Canvas 构造函数");
          canvas = new this.ctx.canvas(size, totalHeight);
          ctx2d = canvas.getContext("2d");
        } else {
          console.log("[Sudoku] Canvas 服务不支持标准 API，尝试原生库");
          throw new Error("尝试原生库");
        }
      }
      
      // 方法 2：直接使用原生 canvas 库
      if (!canvas && NativeCanvas) {
        console.log("[Sudoku] 使用原生 Canvas 库");
        if (typeof NativeCanvas.createCanvas === "function") {
          canvas = NativeCanvas.createCanvas(size, totalHeight);
        } else {
          canvas = new NativeCanvas(size, totalHeight);
        }
        ctx2d = canvas.getContext("2d");
      }
      
      if (!canvas || !ctx2d) {
        throw new Error("无法创建 Canvas 对象。请确保已安装并启用 Canvas 插件。");
      }

      console.log("[Sudoku] Canvas 对象创建成功，Context2D 类型:", typeof ctx2d);
      
      // 绘制背景
      ctx2d.fillStyle = "#ffffff";
      ctx2d.fillRect(0, 0, size, totalHeight);

      // 应用偏移（留白）
      ctx2d.save();
      ctx2d.translate(padding, padding);

      // 绘制网格线
      ctx2d.strokeStyle = "#000000";
      ctx2d.lineWidth = 1;
      for (let i = 0; i <= 9; i++) {
        const pos = i * cellSize;
        ctx2d.beginPath();
        ctx2d.moveTo(pos, 0);
        ctx2d.lineTo(pos, gridSize);
        ctx2d.stroke();
        ctx2d.beginPath();
        ctx2d.moveTo(0, pos);
        ctx2d.lineTo(gridSize, pos);
        ctx2d.stroke();
      }

      // 绘制粗线分隔3x3宫
      ctx2d.lineWidth = 3;
      for (let i = 0; i <= 9; i += 3) {
        const pos = i * cellSize;
        ctx2d.beginPath();
        ctx2d.moveTo(pos, 0);
        ctx2d.lineTo(pos, gridSize);
        ctx2d.stroke();
        ctx2d.beginPath();
        ctx2d.moveTo(0, pos);
        ctx2d.lineTo(gridSize, pos);
        ctx2d.stroke();
      }

      // 绘制数字
      ctx2d.font = "30px Arial";
      ctx2d.fillStyle = "#000000";
      ctx2d.textAlign = "center";
      ctx2d.textBaseline = "middle";
      
      console.log("[Sudoku] 开始绘制数字，puzzle 维度:", puzzle.length, "x", (puzzle[0] ? puzzle[0].length : 0));
      
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          const val = puzzle[r][c];
          if (val !== 0) {
            const x = c * cellSize + cellSize / 2;
            const y = r * cellSize + cellSize / 2;
            ctx2d.fillText(val.toString(), x, y);
          }
        }
      }
      
      ctx2d.restore();
      
      // 绘制难度标注
      if (difficulty) {
        ctx2d.font = "bold 16px Arial";
        ctx2d.fillStyle = "#666666";
        ctx2d.textAlign = "center";
        ctx2d.textBaseline = "middle";
        ctx2d.fillText(difficulty, size / 2, size + bottomSpace / 2);
      }
      
      console.log("[Sudoku] Canvas 绘制完成");

      // 转换为 Buffer - 尝试多种方法
      let buffer: Buffer;
      
      if (typeof canvas.toBuffer === "function") {
        console.log("[Sudoku] 使用 toBuffer('image/png')");
        buffer = canvas.toBuffer("image/png");
      } else if (typeof canvas.encode === "function") {
        console.log("[Sudoku] 使用 encode('png')");
        buffer = await canvas.encode("png");
      } else if (typeof canvas.png === "function") {
        console.log("[Sudoku] 使用 png()");
        buffer = await canvas.png();
      } else if (typeof canvas.toDataURL === "function") {
        console.log("[Sudoku] 使用 toDataURL() 转换");
        const dataUrl = canvas.toDataURL("image/png");
        const base64 = dataUrl.split(",")[1];
        buffer = Buffer.from(base64, "base64");
      } else {
        throw new Error("Canvas 不支持转换为 Buffer (无 toBuffer/encode/png/toDataURL 方法)");
      }

      console.log("[Sudoku] Buffer 返回，长度:", buffer ? buffer.length : 0);
      
      // 验证 buffer 是否有效
      if (!buffer || buffer.length === 0) {
        console.error("[Sudoku] Canvas 返回空 Buffer！");
        throw new Error("Canvas 渲染返回空 Buffer");
      }

      console.log("[Sudoku] 渲染成功");
      return buffer;
    } catch (error: any) {
      console.error("[Sudoku] Canvas 渲染错误：", error);
      console.error("[Sudoku] 错误堆栈：", error.stack);
      throw new Error(`Canvas 渲染失败：${error?.message || error}\n请检查 Canvas 插件配置`);
    }
  }
}
