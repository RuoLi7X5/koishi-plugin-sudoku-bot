import { Context, Logger } from "koishi";
import { join } from "path";

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

// ── 中文字体候选文件表 ────────────────────────────────────────────────────────
// 每条记录：[字体文件绝对路径, 注册到 Canvas 的字族名]
// 覆盖 Debian/Ubuntu、CentOS/RHEL、Arch、Alpine、macOS、Windows 常见路径。
const CJK_FONT_FILES: Array<[string, string]> = [
  // ── Debian / Ubuntu ──────────────────────────────────────────────────────
  ["/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",        "WenQuanYi Zen Hei"],
  ["/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",      "WenQuanYi Micro Hei"],
  ["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",  "Noto Sans CJK SC"],
  ["/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc", "Noto Serif CJK SC"],
  ["/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf","Droid Sans"],
  ["/usr/share/fonts/truetype/droid/DroidSansFallback.ttf",   "Droid Sans"],
  // ── CentOS / RHEL / Fedora ───────────────────────────────────────────────
  ["/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc",          "WenQuanYi Zen Hei"],
  ["/usr/share/fonts/wqy-microhei/wqy-microhei.ttc",      "WenQuanYi Micro Hei"],
  ["/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc","Noto Sans CJK SC"],
  ["/usr/share/fonts/google-droid/DroidSansFallback.ttf",  "Droid Sans"],
  // ── 通用 noto-cjk 目录（多发行版）───────────────────────────────────────
  ["/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",   "Noto Sans CJK SC"],
  ["/usr/share/fonts/noto/NotoSansCJKsc-Regular.otf",      "Noto Sans CJK SC"],
  // ── Alpine ───────────────────────────────────────────────────────────────
  ["/usr/share/fonts/noto/NotoSans-Regular.ttf",           "Noto Sans"],
  // ── macOS ────────────────────────────────────────────────────────────────
  ["/System/Library/Fonts/PingFang.ttc",                   "PingFang SC"],
  ["/Library/Fonts/Arial Unicode MS.ttf",                  "Arial Unicode MS"],
  // ── Windows ──────────────────────────────────────────────────────────────
  ["C:\\Windows\\Fonts\\msyh.ttc",                         "Microsoft YaHei"],
  ["C:\\Windows\\Fonts\\msyhbd.ttc",                       "Microsoft YaHei"],
  ["C:\\Windows\\Fonts\\simsun.ttc",                       "SimSun"],
];

// @napi-rs/canvas 需要扫描的目录（loadFontsFromDir 不递归，需列出子目录）
const CJK_FONT_DIRS = [
  "/usr/share/fonts",
  "/usr/share/fonts/truetype",
  "/usr/share/fonts/truetype/wqy",
  "/usr/share/fonts/opentype",
  "/usr/share/fonts/opentype/noto",
  "/usr/share/fonts/noto-cjk",
  "/usr/share/fonts/noto",
  "/usr/share/fonts/google-noto-cjk",
  "/usr/share/fonts/google-droid",
  "/usr/share/fonts/truetype/droid",
  "/usr/share/fonts/wqy-zenhei",
  "/usr/share/fonts/wqy-microhei",
  "/usr/local/share/fonts",
  "/Library/Fonts",
  "/System/Library/Fonts",
];

/** Canvas 字体族字符串——所有 ctx2d.font 均使用此常量，确保中文可渲染 */
export const CJK_FONT_STACK = [
  '"Microsoft YaHei"',
  '"WenQuanYi Zen Hei"',
  '"WenQuanYi Micro Hei"',
  '"Noto Sans CJK SC"',
  '"Source Han Sans SC"',
  '"PingFang SC"',
  '"Droid Sans"',
  '"Noto Sans"',
  "Arial",
  "sans-serif",
].join(", ");

/**
 * 向 Canvas 注册 CJK 字体，返回成功注册的文件数。
 *
 * 优先级：koishiCanvas.GlobalFonts（与画布创建使用同一模块实例）> NativeCanvas.GlobalFonts > NativeCanvas.registerFont
 *
 * @param extraDirs    额外扫描目录（Koishi 数据目录 fonts 子目录等）
 * @param logger       日志器
 * @param koishiCanvas ctx.canvas，用于访问与画布同一模块实例的 GlobalFonts
 */
function loadCJKFonts(
  extraDirs: string[] = [],
  logger?: Logger,
  koishiCanvas?: any,
): number {
  const { existsSync, readFileSync, readdirSync } = require("fs");

  // 获取 GlobalFonts：优先从 Koishi canvas 服务（与 createCanvas 同实例），
  // 兜底用直接 require 到的 NativeCanvas
  const gf: any =
    koishiCanvas?.GlobalFonts ??
    NativeCanvas?.GlobalFonts ??
    null;

  const legacyRegisterFont: ((path: string, options: { family: string }) => void) | null =
    NativeCanvas?.registerFont ?? koishiCanvas?.registerFont ?? null;

  if (!gf && !legacyRegisterFont) {
    logger?.warn(
      "Canvas 字体注册 API 不可用（GlobalFonts / registerFont 均未找到），中文将显示为方块。\n" +
      "  请确认 @napi-rs/canvas 或 canvas 已正确安装。"
    );
    return 0;
  }

  let loaded = 0;

  if (gf) {
    // ── @napi-rs/canvas GlobalFonts ────────────────────────────────────
    try { gf.loadSystemFonts?.(); } catch {}

    for (const dir of [...CJK_FONT_DIRS, ...extraDirs]) {
      try { gf.loadFontsFromDir?.(dir); } catch {}
    }

    // 逐文件显式注册
    for (const [filePath, family] of CJK_FONT_FILES) {
      try {
        if (existsSync(filePath)) {
          gf.register(readFileSync(filePath) as Buffer, family);
          loaded++;
        }
      } catch {}
    }

    // 扫描用户自定义目录
    for (const dir of extraDirs) {
      try {
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir) as string[]) {
          if (!/\.(ttf|otf|ttc|woff|woff2)$/i.test(file)) continue;
          try {
            gf.register(
              readFileSync(join(dir, file)) as Buffer,
              file.replace(/\.[^.]+$/, ""),
            );
            loaded++;
          } catch {}
        }
      } catch {}
    }
  } else if (legacyRegisterFont) {
    // ── node-canvas registerFont ───────────────────────────────────────
    for (const [filePath, family] of CJK_FONT_FILES) {
      try {
        if (existsSync(filePath)) {
          legacyRegisterFont(filePath, { family });
          loaded++;
        }
      } catch {}
    }

    for (const dir of extraDirs) {
      try {
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir) as string[]) {
          if (!/\.(ttf|otf|ttc)$/i.test(file)) continue;
          try {
            legacyRegisterFont(join(dir, file), { family: file.replace(/\.[^.]+$/, "") });
            loaded++;
          } catch {}
        }
      } catch {}
    }
  }

  return loaded;
}

/**
 * 当系统无任何 CJK 字体时，从 CDN 下载 Noto Sans SC 简体子集（约 1.2 MB）并缓存。
 * 下载成功后立即注册到 GlobalFonts；下次启动直接从缓存加载，无需再次下载。
 */
async function downloadAndCacheCJKFont(
  cacheDir: string,
  gf: any,
  logger?: Logger,
): Promise<void> {
  const fsp = require("fs").promises;
  const https = require("https");
  const http = require("http");
  const cachedPath = join(cacheDir, "NotoSansSC-Regular.woff2");

  // 已缓存则直接注册
  try {
    const buf = await fsp.readFile(cachedPath);
    gf.register(buf, "Noto Sans CJK SC");
    logger?.info(`CJK 字体从缓存加载：${cachedPath}`);
    return;
  } catch {}

  // 尝试多个 CDN（按优先级）
  const FONT_URLS = [
    // jsDelivr 上的 @fontsource/noto-sans-sc 简体子集 woff2，约 1.2 MB
    "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5/files/noto-sans-sc-chinese-simplified-400-normal.woff2",
    // 备用：unpkg
    "https://unpkg.com/@fontsource/noto-sans-sc@5/files/noto-sans-sc-chinese-simplified-400-normal.woff2",
  ];

  for (const url of FONT_URLS) {
    try {
      const buf = await new Promise<Buffer>((resolve, reject) => {
        const lib = url.startsWith("https") ? https : http;
        lib.get(url, { timeout: 30_000 }, (res: any) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        }).on("error", reject).on("timeout", () => reject(new Error("timeout")));
      });

      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(cachedPath, buf);
      gf.register(buf, "Noto Sans CJK SC");
      logger?.info(`CJK 字体下载并缓存成功（${(buf.length / 1024).toFixed(0)} KB）：${cachedPath}`);
      return;
    } catch (err: any) {
      logger?.warn(`CJK 字体从 ${url} 下载失败：${err?.message}`);
    }
  }

  logger?.warn(
    "CJK 字体自动下载失败，中文将显示为方块。\n" +
    "  请手动将 .ttf/.otf 字体文件放入 Koishi 数据目录下的 fonts/ 子目录，或安装系统字体：\n" +
    "    yum install google-droid-sans-fonts  （CentOS/RHEL）\n" +
    "    apt-get install fonts-wqy-zenhei      （Debian/Ubuntu）"
  );
}

declare module "koishi" {
  interface Context {
    canvas?: any;
  }
}

/** 唯余训练报告渲染数据 */
export type TrainingRenderData = {
  title: string;
  timeRange: string;
  totalQuestions: number;
  participants: Array<{
    username: string;
    correct: number;
    wrong: number;
    /** 每道答对题的用时（ms），与 questionIndices 一一对应 */
    correctTimesMs: number[];
    /** 每道答对题对应的题号（1-based） */
    questionIndices: number[];
  }>;
};

/** 10 个精选对比色，覆盖常规训练人数 */
const PLAYER_COLOR_PALETTE = [
  "#4C9BE8", // 蓝
  "#E8634C", // 红橙
  "#5ABF6F", // 绿
  "#F4A026", // 橙黄
  "#9B59B6", // 紫
  "#1ABC9C", // 青绿
  "#E91E8C", // 玫红
  "#D4AC0D", // 金黄
  "#2E86C1", // 深蓝
  "#784212", // 棕
];

/** HSL → #rrggbb，用于超过调色板容量时动态生成 */
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** 返回 n 个唯一且视觉可辨的玩家颜色 */
function getPlayerColors(n: number): string[] {
  if (n <= PLAYER_COLOR_PALETTE.length) {
    return PLAYER_COLOR_PALETTE.slice(0, n);
  }
  // 超过调色板上限：用黄金角均匀分布色相，保证最大视觉差异
  return Array.from({ length: n }, (_, i) =>
    hslToHex((i * 137.508) % 360, 65, 48),
  );
}

export class ImageRenderer {
  private static fontsInitialized = false;

  /** 临时图片目录，用于 file:// 方式发图，避免大 base64 请求体 */
  private tmpDir: string;

  constructor(private ctx: Context) {
    // ── 字体初始化 ──────────────────────────────────────────────────────────
    if (!ImageRenderer.fontsInitialized) {
      ImageRenderer.fontsInitialized = true;
      const logger = ctx.logger("sudoku");
      const extraDirs = ctx.baseDir
        ? [
            join(ctx.baseDir, "fonts"),
            join(ctx.baseDir, "data", "fonts"),
            join(ctx.baseDir, "data", "sudoku", "fonts"),
          ]
        : [];

      // 关键修复：同时传入 ctx.canvas，确保使用与 createCanvas 相同模块实例的 GlobalFonts
      const loaded = loadCJKFonts(extraDirs, logger, ctx.canvas);

      if (loaded > 0) {
        logger.info(`CJK 字体加载完成，共注册 ${loaded} 个字体文件`);
      } else {
        logger.warn("未找到系统 CJK 字体，尝试自动下载 Noto Sans SC 子集…");
        // 异步下载字体，不阻塞启动
        const gf: any =
          ctx.canvas?.GlobalFonts ??
          NativeCanvas?.GlobalFonts ??
          null;
        if (gf) {
          const cacheDir = ctx.baseDir
            ? join(ctx.baseDir, "data", "sudoku", "fonts")
            : join(require("os").tmpdir(), "sudoku-fonts");
          downloadAndCacheCJKFont(cacheDir, gf, logger).catch(() => {});
        } else {
          logger.warn(
            "GlobalFonts API 不可用，无法自动下载字体。\n" +
            "  请安装系统字体或将字体文件放入 Koishi 数据目录下的 fonts/ 子目录。"
          );
        }
      }
    }

    // ── 临时目录初始化 ──────────────────────────────────────────────────────
    this.tmpDir = ctx.baseDir
      ? join(ctx.baseDir, "tmp", "sudoku-images")
      : join(require("os").tmpdir(), "sudoku-images");
    try {
      require("fs").mkdirSync(this.tmpDir, { recursive: true });
    } catch {}
  }

  /**
   * 将图片 Buffer 写入临时文件，返回绝对路径（供 file:// 降级路径使用）。
   * 同时异步清理超过 10 分钟的旧文件，不阻塞事件循环。
   */
  async saveTmpImage(buf: Buffer): Promise<string> {
    const fsp = require("fs").promises;

    // 异步写入新文件（先写后清理，确保主路径最快完成）
    const fileName = `sudoku_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
    const filePath = join(this.tmpDir, fileName);
    await fsp.writeFile(filePath, buf);

    // 后台异步清理超龄文件（不 await，不阻塞调用方）
    fsp.readdir(this.tmpDir).then(async (files: string[]) => {
      const now = Date.now();
      for (const file of files) {
        if (!file.endsWith(".png")) continue;
        const fp = join(this.tmpDir, file);
        try {
          const stat = await fsp.stat(fp);
          if (now - stat.mtimeMs > 10 * 60 * 1000) await fsp.unlink(fp);
        } catch {}
      }
    }).catch(() => {});

    return filePath;
  }

  /** 创建 Canvas 和 2D 上下文（自动探测可用 API） */
  private createCanvasCtx(w: number, h: number): { canvas: any; ctx2d: any } {
    let canvas: any;

    if (this.ctx.canvas) {
      if (typeof this.ctx.canvas.createCanvas === "function") {
        canvas = this.ctx.canvas.createCanvas(w, h);
      } else if (typeof this.ctx.canvas.Canvas === "function") {
        canvas = new this.ctx.canvas.Canvas(w, h);
      } else if (
        this.ctx.canvas.constructor &&
        this.ctx.canvas.constructor.name === "Canvas"
      ) {
        canvas = new this.ctx.canvas(w, h);
      }
    }

    if (!canvas && NativeCanvas) {
      canvas =
        typeof NativeCanvas.createCanvas === "function"
          ? NativeCanvas.createCanvas(w, h)
          : new NativeCanvas(w, h);
    }

    if (!canvas) {
      throw new Error("无法创建 Canvas 对象。请确保已安装并启用 Canvas 插件。");
    }
    const ctx2d = canvas.getContext("2d");
    return { canvas, ctx2d };
  }

  /** 将 canvas 转换为 PNG Buffer（自动探测可用 API） */
  private async canvasToBuffer(canvas: any): Promise<Buffer> {
    let buffer: Buffer;

    if (typeof canvas.toBuffer === "function") {
      buffer = canvas.toBuffer("image/png");
    } else if (typeof canvas.encode === "function") {
      buffer = await canvas.encode("png");
    } else if (typeof canvas.png === "function") {
      buffer = await canvas.png();
    } else if (typeof canvas.toDataURL === "function") {
      const dataUrl = canvas.toDataURL("image/png");
      buffer = Buffer.from(dataUrl.split(",")[1], "base64");
    } else {
      throw new Error(
        "Canvas 不支持转换为 Buffer (无 toBuffer/encode/png/toDataURL 方法)"
      );
    }

    if (!buffer || buffer.length === 0) {
      throw new Error("Canvas 渲染返回空 Buffer");
    }
    return buffer;
  }

  async render(
    puzzle: number[][],
    difficulty?: string,
    questionCell?: { row: number; col: number },
    questionId?: string,
  ): Promise<Buffer> {
    const logger = this.ctx.logger("sudoku");
    const cellSize = 40;          // 原 50，缩减 20% 使 PNG 体积减少约 30%
    const gridSize = cellSize * 9;
    const padding = 16;
    const bottomSpace = 34;
    const size = gridSize + padding * 2;
    const totalHeight = size + bottomSpace;

    try {
      const { canvas, ctx2d } = this.createCanvasCtx(size, totalHeight);

      // 绘制背景
      ctx2d.fillStyle = "#ffffff";
      ctx2d.fillRect(0, 0, size, totalHeight);

      ctx2d.save();
      ctx2d.translate(padding, padding);

      // 细网格线
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

      // 粗线分隔 3×3 宫
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

      // 题目格高亮（浅绿色背景）
      if (questionCell) {
        ctx2d.fillStyle = "#90EE90";
        const qx = questionCell.col * cellSize + 1;
        const qy = questionCell.row * cellSize + 1;
        ctx2d.fillRect(qx, qy, cellSize - 2, cellSize - 2);
      }

      // 数字
      ctx2d.font = `24px ${CJK_FONT_STACK}`;
      ctx2d.fillStyle = "#000000";
      ctx2d.textAlign = "center";
      ctx2d.textBaseline = "middle";
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

      // 底部：难度居中，题目编号右对齐
      const bottomY = size + bottomSpace / 2;
      ctx2d.font = `bold 13px ${CJK_FONT_STACK}`;
      ctx2d.fillStyle = "#666666";
      ctx2d.textBaseline = "middle";

      if (difficulty && questionId) {
        ctx2d.textAlign = "center";
        ctx2d.fillText(difficulty, size / 2, bottomY);
        ctx2d.textAlign = "right";
        ctx2d.fillText(questionId, size - padding, bottomY);
      } else if (difficulty) {
        ctx2d.textAlign = "center";
        ctx2d.fillText(difficulty, size / 2, bottomY);
      } else if (questionId) {
        ctx2d.textAlign = "right";
        ctx2d.fillText(questionId, size - padding, bottomY);
      }

      return await this.canvasToBuffer(canvas);
    } catch (error: any) {
      logger.error("Canvas 渲染失败：", error);
      throw new Error(`Canvas 渲染失败：${error?.message || error}\n请检查 Canvas 插件配置`);
    }
  }

  // ─────────────────────────────────────────
  // 唯余训练报告渲染
  // ─────────────────────────────────────────

  async renderTrainingStats(data: TrainingRenderData): Promise<Buffer> {
    const W = 800;
    const PAD = 30;
    const AXIS_W = 38; // Y 轴标签宽度
    const X_LABEL_H = 26; // X 轴标签高度
    const CHART_W = W - PAD * 2 - AXIS_W; // 图表绘制宽度

    const TITLE_H = 78;
    const PLAYER_ROW_H = 54;
    const DIV_H = 18;
    const CHART_LABEL_H = 28;
    const HIST_H = 195; // 含 X 标签
    const LINE_H = 205; // 含 X 标签
    const FOOTER_H = 20;

    const nPlayers = data.participants.length;
    const playerColors = getPlayerColors(nPlayers);
    const totalH =
      TITLE_H +
      PLAYER_ROW_H * nPlayers +
      DIV_H +
      CHART_LABEL_H + HIST_H +
      DIV_H +
      CHART_LABEL_H + LINE_H +
      FOOTER_H;

    const { canvas, ctx2d } = this.createCanvasCtx(W, totalH);

    // 白底
    ctx2d.fillStyle = "#f8f9fa";
    ctx2d.fillRect(0, 0, W, totalH);

    let y = 0;

    // ── 标题区 ──────────────────────────────────
    ctx2d.fillStyle = "#2c3e50";
    ctx2d.font = `bold 22px ${CJK_FONT_STACK}`;
    ctx2d.textAlign = "center";
    ctx2d.textBaseline = "middle";
    ctx2d.fillText(data.title, W / 2, y + 28);

    ctx2d.fillStyle = "#7f8c8d";
    ctx2d.font = `13px ${CJK_FONT_STACK}`;
    ctx2d.fillText(
      `${data.timeRange}  ·  共 ${data.totalQuestions} 题`,
      W / 2,
      y + 55,
    );
    y += TITLE_H;

    // ── 玩家统计行 ───────────────────────────────
    for (let i = 0; i < nPlayers; i++) {
      const p = data.participants[i];
      const color = playerColors[i];
      const total = p.correct + p.wrong;
      const accuracy = total === 0 ? "—" : `${((p.correct / total) * 100).toFixed(1)}%`;
      const avgMs =
        p.correctTimesMs.length > 0
          ? p.correctTimesMs.reduce((s, t) => s + t, 0) / p.correctTimesMs.length
          : 0;
      const minMs = p.correctTimesMs.length > 0 ? Math.min(...p.correctTimesMs) : 0;
      const maxMs = p.correctTimesMs.length > 0 ? Math.max(...p.correctTimesMs) : 0;

      const rowY = y + i * PLAYER_ROW_H;

      // 颜色标识条
      ctx2d.fillStyle = color;
      ctx2d.fillRect(PAD, rowY + 10, 6, 33);

      // 玩家名
      ctx2d.fillStyle = "#2c3e50";
      ctx2d.font = `bold 15px ${CJK_FONT_STACK}`;
      ctx2d.textAlign = "left";
      ctx2d.textBaseline = "top";
      ctx2d.fillText(p.username, PAD + 14, rowY + 12);

      // 统计数据
      ctx2d.font = `13px ${CJK_FONT_STACK}`;
      const stats = [
        { color: "#27ae60", text: `✅ ${p.correct}` },
        { color: "#e74c3c", text: `❌ ${p.wrong}` },
        { color: "#7f8c8d", text: `正确率 ${accuracy}` },
        { color: "#7f8c8d", text: `均 ${(avgMs / 1000).toFixed(1)}s` },
        { color: "#7f8c8d", text: `最快 ${(minMs / 1000).toFixed(1)}s` },
        { color: "#7f8c8d", text: `最慢 ${(maxMs / 1000).toFixed(1)}s` },
      ];
      let sx = PAD + 14;
      const statY = rowY + 32;
      for (const s of stats) {
        ctx2d.fillStyle = s.color;
        ctx2d.fillText(s.text, sx, statY);
        sx += ctx2d.measureText(s.text).width + 16;
      }
    }
    y += PLAYER_ROW_H * nPlayers;

    // ── 分隔线 ────────────────────────────────────
    this.drawDivider(ctx2d, W, PAD, y + 8);
    y += DIV_H;

    // ── 图表1：时间分布直方图 ─────────────────────
    ctx2d.fillStyle = "#2c3e50";
    ctx2d.font = `bold 14px ${CJK_FONT_STACK}`;
    ctx2d.textAlign = "left";
    ctx2d.textBaseline = "middle";
    ctx2d.fillText("时间分布（答对用时）", PAD + AXIS_W, y + 14);
    y += CHART_LABEL_H;

    this.drawHistogram(
      ctx2d,
      data.participants,
      playerColors,
      PAD + AXIS_W,
      y,
      CHART_W,
      HIST_H,
      X_LABEL_H,
    );
    y += HIST_H;

    // ── 分隔线 ────────────────────────────────────
    this.drawDivider(ctx2d, W, PAD, y + 8);
    y += DIV_H;

    // ── 图表2：答题节奏折线图 ──────────────────────
    ctx2d.fillStyle = "#2c3e50";
    ctx2d.font = `bold 14px ${CJK_FONT_STACK}`;
    ctx2d.textAlign = "left";
    ctx2d.textBaseline = "middle";
    ctx2d.fillText("答题节奏（每题用时）", PAD + AXIS_W, y + 14);
    // 图例（多玩家时显示）
    if (nPlayers > 1) {
      let lx = W - PAD;
      for (let i = nPlayers - 1; i >= 0; i--) {
        const lbl = data.participants[i].username;
        ctx2d.font = `12px ${CJK_FONT_STACK}`;
        const tw = ctx2d.measureText(lbl).width;
        lx -= tw;
        ctx2d.fillStyle = "#2c3e50";
        ctx2d.textAlign = "left";
        ctx2d.fillText(lbl, lx, y + 14);
        lx -= 16;
        ctx2d.fillStyle = playerColors[i];
        ctx2d.fillRect(lx - 12, y + 6, 12, 12);
        lx -= 18;
      }
    }
    y += CHART_LABEL_H;

    this.drawLineChart(
      ctx2d,
      data.participants,
      playerColors,
      PAD + AXIS_W,
      y,
      CHART_W,
      LINE_H,
      X_LABEL_H,
      data.totalQuestions,
    );

    return await this.canvasToBuffer(canvas);
  }

  private drawDivider(ctx2d: any, W: number, PAD: number, lineY: number) {
    ctx2d.strokeStyle = "#dee2e6";
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(PAD, lineY);
    ctx2d.lineTo(W - PAD, lineY);
    ctx2d.stroke();
  }

  /**
   * 时间分布直方图
   * @param chartX  图表区域左边界（已含 AXIS_W 偏移）
   * @param chartY  图表区域顶边界
   * @param chartW  图表区域宽度
   * @param chartH  图表区域高度（含 X 轴标签）
   * @param xLabelH X 轴标签高度
   */
  private drawHistogram(
    ctx2d: any,
    participants: TrainingRenderData["participants"],
    playerColors: string[],
    chartX: number,
    chartY: number,
    chartW: number,
    chartH: number,
    xLabelH: number,
  ) {
    const BUCKET_EDGES = [0, 2, 4, 6, 8, 10, Infinity];
    const BUCKET_LABELS = ["<2s", "2-4s", "4-6s", "6-8s", "8-10s", ">10s"];
    const N_BUCKETS = 6;
    const barAreaH = chartH - xLabelH;
    const nPlayers = participants.length;

    // 统计各玩家各桶计数
    const counts: number[][] = participants.map((p) => {
      const bc = Array(N_BUCKETS).fill(0);
      for (const ms of p.correctTimesMs) {
        const s = ms / 1000;
        for (let b = 0; b < N_BUCKETS; b++) {
          if (s >= BUCKET_EDGES[b] && s < BUCKET_EDGES[b + 1]) {
            bc[b]++;
            break;
          }
        }
      }
      return bc;
    });

    const maxCount = Math.max(1, ...counts.flat());

    // Y 轴格线 & 标签
    const gridSteps = 4;
    for (let g = 0; g <= gridSteps; g++) {
      const cnt = Math.round((maxCount * g) / gridSteps);
      const gy = chartY + barAreaH - (cnt / maxCount) * barAreaH;
      ctx2d.strokeStyle = "#e8ecef";
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      ctx2d.moveTo(chartX, gy);
      ctx2d.lineTo(chartX + chartW, gy);
      ctx2d.stroke();

      ctx2d.fillStyle = "#999";
      ctx2d.font = `11px ${CJK_FONT_STACK}`;
      ctx2d.textAlign = "right";
      ctx2d.textBaseline = "middle";
      ctx2d.fillText(cnt.toString(), chartX - 4, gy);
    }

    // 柱子
    const bucketW = chartW / N_BUCKETS;
    const BAR_GAP = 5;
    const innerW = bucketW - BAR_GAP * 2;
    const barW = nPlayers > 1
      ? (innerW - BAR_GAP * (nPlayers - 1)) / nPlayers
      : innerW;

    for (let bi = 0; bi < N_BUCKETS; bi++) {
      const labelX = chartX + bi * bucketW + bucketW / 2;

      // X 轴标签
      ctx2d.fillStyle = "#555";
      ctx2d.font = `11px ${CJK_FONT_STACK}`;
      ctx2d.textAlign = "center";
      ctx2d.textBaseline = "top";
      ctx2d.fillText(BUCKET_LABELS[bi], labelX, chartY + barAreaH + 4);

      for (let pi = 0; pi < nPlayers; pi++) {
        const cnt = counts[pi][bi];
        if (cnt === 0) continue;
        const bh = (cnt / maxCount) * barAreaH;
        const bx = chartX + bi * bucketW + BAR_GAP + pi * (barW + BAR_GAP);
        const by = chartY + barAreaH - bh;
        ctx2d.fillStyle = playerColors[pi];
        ctx2d.fillRect(bx, by, barW, bh);

        // 柱顶数字（仅单玩家或柱子够宽时）
        if (nPlayers === 1 || barW >= 18) {
          ctx2d.fillStyle = "#2c3e50";
          ctx2d.font = `11px ${CJK_FONT_STACK}`;
          ctx2d.textAlign = "center";
          ctx2d.textBaseline = "bottom";
          ctx2d.fillText(cnt.toString(), bx + barW / 2, by - 1);
        }
      }
    }
  }

  /**
   * 答题节奏折线图
   * @param totalQ  本轮总题数（用于确定 X 轴范围）
   */
  private drawLineChart(
    ctx2d: any,
    participants: TrainingRenderData["participants"],
    playerColors: string[],
    chartX: number,
    chartY: number,
    chartW: number,
    chartH: number,
    xLabelH: number,
    totalQ: number,
  ) {
    const lineAreaH = chartH - xLabelH;
    const nPlayers = participants.length;

    // 计算 X/Y 轴范围
    let maxQi = Math.max(totalQ, 1);
    let maxElapsedMs = 1000;
    for (const p of participants) {
      for (const qi of p.questionIndices) maxQi = Math.max(maxQi, qi);
      for (const ms of p.correctTimesMs) maxElapsedMs = Math.max(maxElapsedMs, ms);
    }
    // Y 轴上限取整到 5 的倍数
    const rawMax = Math.ceil(maxElapsedMs / 1000);
    const maxElapsedS = Math.ceil(rawMax / 5) * 5 || 5;

    // Y 轴格线 & 标签
    const gridSteps = 4;
    for (let g = 0; g <= gridSteps; g++) {
      const s = (maxElapsedS / gridSteps) * g;
      const gy = chartY + lineAreaH - (s / maxElapsedS) * lineAreaH;
      ctx2d.strokeStyle = "#e8ecef";
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      ctx2d.moveTo(chartX, gy);
      ctx2d.lineTo(chartX + chartW, gy);
      ctx2d.stroke();

      ctx2d.fillStyle = "#999";
      ctx2d.font = `11px ${CJK_FONT_STACK}`;
      ctx2d.textAlign = "right";
      ctx2d.textBaseline = "middle";
      ctx2d.fillText(`${s.toFixed(0)}s`, chartX - 4, gy);
    }

    // X 轴标签（每隔若干题显示一个题号）
    const labelStep = Math.max(1, Math.ceil(maxQi / 12));
    for (let qi = 1; qi <= maxQi; qi += labelStep) {
      const px = chartX + ((qi - 1) / Math.max(maxQi - 1, 1)) * chartW;
      ctx2d.fillStyle = "#555";
      ctx2d.font = `11px ${CJK_FONT_STACK}`;
      ctx2d.textAlign = "center";
      ctx2d.textBaseline = "top";
      ctx2d.fillText(qi.toString(), px, chartY + lineAreaH + 4);
    }

    // 折线 & 数据点
    for (let pi = 0; pi < nPlayers; pi++) {
      const p = participants[pi];
      if (p.questionIndices.length === 0) continue;

      const color = playerColors[pi];

      // 按题号排序
      const pairs = p.questionIndices
        .map((qi, k) => ({ qi, ms: p.correctTimesMs[k] }))
        .sort((a, b) => a.qi - b.qi);

      // 折线
      ctx2d.strokeStyle = color;
      ctx2d.lineWidth = 2;
      ctx2d.lineJoin = "round";
      ctx2d.beginPath();
      let first = true;
      for (const { qi, ms } of pairs) {
        const px = chartX + ((qi - 1) / Math.max(maxQi - 1, 1)) * chartW;
        const py = chartY + lineAreaH - (ms / (maxElapsedS * 1000)) * lineAreaH;
        if (first) {
          ctx2d.moveTo(px, py);
          first = false;
        } else {
          ctx2d.lineTo(px, py);
        }
      }
      ctx2d.stroke();

      // 数据点（填充圆点）
      for (const { qi, ms } of pairs) {
        const px = chartX + ((qi - 1) / Math.max(maxQi - 1, 1)) * chartW;
        const py = chartY + lineAreaH - (ms / (maxElapsedS * 1000)) * lineAreaH;
        ctx2d.fillStyle = "#fff";
        ctx2d.beginPath();
        ctx2d.arc(px, py, 4, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.strokeStyle = color;
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.arc(px, py, 4, 0, Math.PI * 2);
        ctx2d.stroke();
      }
    }
  }
}
