import { Context, Logger } from "koishi";
import { join } from "path";

// ── Canvas 模块发现 ──────────────────────────────────────────────────────────
// 按优先级逐一尝试，直到找到可用的模块实例。
//
// 底层模块对应关系：
//   koishi-plugin-skia-canvas  →  @ahdg/canvas  （当前使用）
//   koishi-plugin-canvas       →  @napi-rs/canvas（已废弃）
//   旧版                       →  canvas
//
// @ahdg/canvas 是 @napi-rs/canvas 的 Skia 分支，GlobalFonts API 完全兼容。
let NativeCanvas: any = null;

(function discoverCanvasModule() {
  // 1. @ahdg/canvas 直接 require（koishi-plugin-skia-canvas 的底层库）
  try { NativeCanvas = require("@ahdg/canvas"); if (NativeCanvas) return; } catch {}

  // 2. 经由 koishi-plugin-skia-canvas 定位（@ahdg/canvas 嵌套在其 node_modules 下时）
  try {
    const { dirname } = require("path") as typeof import("path");
    const skiaEntry = require.resolve("koishi-plugin-skia-canvas");
    const nativePath = require.resolve("@ahdg/canvas", {
      paths: [dirname(skiaEntry), dirname(dirname(skiaEntry))],
    });
    NativeCanvas = require(nativePath);
    if (NativeCanvas) return;
  } catch {}

  // 3. 兜底：@napi-rs/canvas（旧版 koishi-plugin-canvas 用户）
  try { NativeCanvas = require("@napi-rs/canvas"); if (NativeCanvas) return; } catch {}

  // 4. 经由 koishi-plugin-canvas 定位（已废弃插件，仅做兼容）
  try {
    const { dirname } = require("path") as typeof import("path");
    const canvasEntry = require.resolve("koishi-plugin-canvas");
    const nativePath = require.resolve("@napi-rs/canvas", {
      paths: [dirname(canvasEntry), dirname(dirname(canvasEntry))],
    });
    NativeCanvas = require(nativePath);
    if (NativeCanvas) return;
  } catch {}

  // 5. 最终降级：legacy node-canvas
  try { NativeCanvas = require("canvas"); } catch {}
})();

// ── 中文字体候选文件表 ────────────────────────────────────────────────────────
// 每条记录：[字体文件绝对路径, 注册到 Canvas 的字族名（与 CJK_FONT_STACK 对应）]
// 注意：别名必须与字体文件的真实字族名一致，否则 canvas 渲染时会找不到该字体。
// DroidSansFallback.ttf 的真实字族名是 "Droid Sans Fallback"，不是 "Droid Sans"。
const CJK_FONT_FILES: Array<[string, string]> = [
  // ── CentOS / RHEL / Aliyun ───────────────────────────────────────────────
  ["/usr/share/fonts/google-droid/DroidSansFallback.ttf",      "Droid Sans Fallback"],
  ["/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc",              "WenQuanYi Zen Hei"],
  ["/usr/share/fonts/wqy-microhei/wqy-microhei.ttc",          "WenQuanYi Micro Hei"],
  ["/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc","Noto Sans CJK SC"],
  // ── Debian / Ubuntu ──────────────────────────────────────────────────────
  ["/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",            "WenQuanYi Zen Hei"],
  ["/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",          "WenQuanYi Micro Hei"],
  ["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",  "Noto Sans CJK SC"],
  ["/usr/share/fonts/truetype/droid/DroidSansFallback.ttf",   "Droid Sans Fallback"],
  // ── 通用路径 ─────────────────────────────────────────────────────────────
  ["/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",       "Noto Sans CJK SC"],
  ["/usr/local/share/fonts/wqy-zenhei.ttc",                   "WenQuanYi Zen Hei"],
  // ── macOS ────────────────────────────────────────────────────────────────
  ["/System/Library/Fonts/PingFang.ttc",                      "PingFang SC"],
  // ── Windows ──────────────────────────────────────────────────────────────
  ["C:\\Windows\\Fonts\\msyh.ttc",                            "Microsoft YaHei"],
  ["C:\\Windows\\Fonts\\simsun.ttc",                          "SimSun"],
];

/** Canvas font-family 字符串，ctx2d.font 全部使用此值确保中文可渲染 */
export const CJK_FONT_STACK = [
  // koishi-plugin-skia-canvas 默认下载并加载的 CJK 字体，优先使用
  '"LXGW WenKai Lite"',
  // 系统字体兜底
  '"Microsoft YaHei"',
  '"WenQuanYi Zen Hei"',
  '"WenQuanYi Micro Hei"',
  // "Noto Sans CJK SC"：官方完整包；"Noto Sans SC"：@fontsource web 子集包
  '"Noto Sans CJK SC"',
  '"Noto Sans SC"',
  '"PingFang SC"',
  '"Droid Sans Fallback"',
  "Arial",
  "sans-serif",
].join(", ");

/**
 * 向 Canvas 注册 CJK 字体。
 * - 优先用与 createCanvas 同一模块实例的 GlobalFonts（ctx.canvas）
 * - 回退到直接 require 的 NativeCanvas.GlobalFonts
 * - 返回成功注册的文件数；输出详细诊断日志便于排查
 */
function loadCJKFonts(
  extraDirs: string[] = [],
  logger?: Logger,
  koishiCanvas?: any,
): number {
  const { existsSync, readFileSync, readdirSync } = require("fs") as typeof import("fs");

  const gf: any = koishiCanvas?.GlobalFonts ?? NativeCanvas?.GlobalFonts ?? null;
  const hasRegisterFromPath = typeof gf?.registerFromPath === "function";

  // 每次启动输出一行诊断，便于快速定位问题
  logger?.info(
    `[字体] canvas=${NativeCanvas ? "✓" : "✗"}  ` +
    `GlobalFonts=${gf ? "✓" : "✗"}  ` +
    `registerFromPath=${hasRegisterFromPath ? "✓" : "✗"}`
  );

  if (!gf) {
    logger?.warn(
      "[字体] GlobalFonts API 不可用，中文将显示为方块。\n" +
      `  NativeCanvas: ${NativeCanvas ? "已加载但无 GlobalFonts 属性" : "require('@ahdg/canvas') 失败"}\n` +
      `  ctx.canvas:   ${koishiCanvas ? "已注入但无 GlobalFonts 属性" : "未注入（canvas 服务未就绪？）"}`
    );
    return 0;
  }

  let loaded = 0;
  const registered: string[] = [];

  // ── 1. 逐文件显式注册（family 名由我们控制，最可靠）────────────────────────
  for (const [filePath, family] of CJK_FONT_FILES) {
    try {
      if (!existsSync(filePath)) continue;
      const ok: boolean = hasRegisterFromPath
        ? (gf.registerFromPath(filePath, family) as boolean)
        : (gf.register(readFileSync(filePath), family), true);
      if (ok !== false) { loaded++; registered.push(family); }
    } catch {}
  }

  // ── 2. 扫描用户自定义目录（支持手动放置任意字体）────────────────────────────
  for (const dir of extraDirs) {
    try {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir) as string[]) {
        if (!/\.(ttf|otf|ttc|woff|woff2)$/i.test(file)) continue;
        const fullPath = join(dir, file);
        const alias = file.replace(/\.[^.]+$/, "");
        try {
          const ok: boolean = hasRegisterFromPath
            ? (gf.registerFromPath(fullPath, alias) as boolean)
            : (gf.register(readFileSync(fullPath), alias), true);
          if (ok !== false) { loaded++; registered.push(alias); }
        } catch {}
      }
    } catch {}
  }

  // ── 结果汇报 ────────────────────────────────────────────────────────────
  if (loaded > 0) {
    logger?.info(`[字体] 注册成功 ${loaded} 个：${[...new Set(registered)].join("、")}`);
  } else {
    const foundFiles = CJK_FONT_FILES.filter(([p]) => existsSync(p)).map(([p]) => p);
    if (foundFiles.length > 0) {
      logger?.warn(
        `[字体] 发现 ${foundFiles.length} 个候选文件但全部注册失败：\n` +
        foundFiles.map(p => `  ${p}`).join("\n") + "\n" +
        "  可能原因：registerFromPath 返回 false，或字体文件损坏。"
      );
    } else {
      logger?.warn(
        "[字体] 未发现任何 CJK 字体文件，中文将显示为方块。\n" +
        "  修复方法（任选其一）：\n" +
        "    ① yum install google-droid-sans-fonts   （CentOS/RHEL/Aliyun）\n" +
        "    ② apt-get install fonts-wqy-zenhei       （Debian/Ubuntu）\n" +
        "    ③ 将 .ttf/.otf 文件放入 Koishi 数据目录下的 fonts/ 子目录"
      );
    }
  }

  // ── 检查 CJK_FONT_STACK 中哪些字族名实际可用（含 skia-canvas 加载的字体）────
  if (typeof gf.has === "function") {
    const CJK_CHECK = [
      "LXGW WenKai Lite", "Microsoft YaHei", "WenQuanYi Zen Hei",
      "WenQuanYi Micro Hei", "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC",
      "Droid Sans Fallback", "SimSun",
    ];
    const available = CJK_CHECK.filter(name => gf.has(name));
    if (available.length > 0) {
      logger?.info(`[字体] CJK 字族可用（含系统字体）：${available.join("、")}`);
    } else {
      logger?.warn("[字体] CJK_FONT_STACK 中无可用字族，中文可能仍显示为方块。");
    }
  }

  return loaded;
}

/**
 * 兜底方案：从 CDN 下载 Noto Sans SC 简体子集（约 1.2 MB）并缓存。
 *
 * - cacheDir：插件专属缓存目录，下次启动直接读缓存。
 * - canvasFontDir：koishi-plugin-skia-canvas 的字体目录（可选）；
 *   若指定且目录不存在对应文件，则额外复制一份到该目录，
 *   使 skia-canvas 在下次重启时自动加载，无需我们再次注册。
 * - 下载成功后立即注册到 gf，当次渲染即可生效。
 */
async function downloadAndCacheCJKFont(
  cacheDir: string,
  gf: any,
  logger?: Logger,
  canvasFontDir?: string,
): Promise<void> {
  const fsp = require("fs").promises as typeof import("fs").promises;
  const FONT_NAME = "NotoSansSC-Regular.woff2";
  const cachedPath = join(cacheDir, FONT_NAME);

  // ── 已缓存则直接注册，无需下载 ──────────────────────────────────────────────
  try {
    const buf = await fsp.readFile(cachedPath);
    gf.register(buf, "Noto Sans SC");
    logger?.info(`[字体] 从缓存加载 Noto Sans SC（${(buf.length / 1024).toFixed(0)} KB）`);
    // 顺便确保 canvas 字体目录里也有一份
    if (canvasFontDir) {
      const dest = join(canvasFontDir, FONT_NAME);
      fsp.access(dest).catch(() => fsp.copyFile(cachedPath, dest).catch(() => {}));
    }
    return;
  } catch {}

  // ── CDN 列表（按国内可达性排序）────────────────────────────────────────────
  // jsDelivr 在国内有 CDN 节点，通常最快；npm.elemecdn.com 是饿了么镜像，也很稳
  const FONT_URLS = [
    "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5/files/noto-sans-sc-chinese-simplified-400-normal.woff2",
    "https://npm.elemecdn.com/@fontsource/noto-sans-sc@5/files/noto-sans-sc-chinese-simplified-400-normal.woff2",
    "https://unpkg.com/@fontsource/noto-sans-sc@5/files/noto-sans-sc-chinese-simplified-400-normal.woff2",
  ];

  const fetchUrl = (url: string): Promise<Buffer> =>
    new Promise<Buffer>((resolve, reject) => {
      const lib: typeof import("https") = url.startsWith("https") ? require("https") : require("http");
      const req = lib.get(url, { timeout: 30_000 } as any, (res: any) => {
        if (res.statusCode >= 301 && res.statusCode <= 303 && res.headers.location) {
          res.resume();
          reject(new Error(`REDIRECT:${res.headers.location}`));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("请求超时")); });
    });

  for (const url of FONT_URLS) {
    logger?.info(`[字体] 尝试下载 Noto Sans SC：${url.replace(/.*npm\//, "")}`);
    try {
      const buf = await fetchUrl(url);

      // 写入插件缓存目录
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(cachedPath, buf);

      // 同步一份到 canvas 字体目录（供 skia-canvas 下次重启自动加载）
      if (canvasFontDir) {
        try {
          await fsp.mkdir(canvasFontDir, { recursive: true });
          await fsp.copyFile(cachedPath, join(canvasFontDir, FONT_NAME));
          logger?.info(`[字体] 已复制到 canvas 字体目录：${canvasFontDir}`);
        } catch {}
      }

      // 立即注册，当前会话直接生效
      gf.register(buf, "Noto Sans SC");
      logger?.info(`[字体] 下载成功（${(buf.length / 1024).toFixed(0)} KB），Noto Sans SC 已注册`);
      return;
    } catch (err: any) {
      logger?.warn(`[字体] 下载失败：${err?.message}`);
    }
  }

  logger?.warn(
    "[字体] 自动下载全部失败，中文将持续显示为方块。\n" +
    "  手动解决方案（任选其一）：\n" +
    "    ① yum install google-droid-sans-fonts   （CentOS/RHEL/Aliyun）\n" +
    "    ② apt-get install fonts-wqy-zenhei       （Debian/Ubuntu）\n" +
    "    ③ 将字体文件手动放入 Koishi 数据目录 fonts/ 子目录后重启"
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

      const loaded = loadCJKFonts(extraDirs, logger, ctx.canvas);

      // canvas 字体目录（koishi-plugin-skia-canvas 的默认 fontPath）
      const canvasFontDir = ctx.baseDir
        ? join(ctx.baseDir, "node-rs", "canvas", "font")
        : null;

      // 无论是否有系统字体，只要 canvas 字体目录尚无 Noto Sans SC，就异步补充下载
      // 这样下次重启 skia-canvas 也能自动加载该字体，无需再依赖系统字体
      const gf: any =
        ctx.canvas?.GlobalFonts ??
        NativeCanvas?.GlobalFonts ??
        null;
      if (gf) {
        const cacheDir = ctx.baseDir
          ? join(ctx.baseDir, "data", "sudoku", "fonts")
          : join(require("os").tmpdir(), "sudoku-fonts");

        if (loaded === 0) {
          logger.warn("[字体] 未找到系统 CJK 字体，尝试自动下载 Noto Sans SC…");
        }

        // 若 canvas 字体目录里已有该字体则只注册缓存，否则下载并同步到 canvas 目录
        const canvasFontFile = canvasFontDir
          ? join(canvasFontDir, "NotoSansSC-Regular.woff2")
          : null;
        const canvasFontExists = canvasFontFile
          ? (() => { try { return require("fs").existsSync(canvasFontFile); } catch { return false; } })()
          : false;

        if (loaded === 0 || !canvasFontExists) {
          downloadAndCacheCJKFont(
            cacheDir, gf, logger,
            canvasFontExists ? undefined : (canvasFontDir ?? undefined),
          ).catch(() => {});
        }
      } else if (loaded === 0) {
        logger.warn(
          "[字体] GlobalFonts API 不可用，无法自动下载字体。\n" +
          "  请安装系统字体或将字体文件放入 Koishi 数据目录下的 fonts/ 子目录。"
        );
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

  /**
   * 过滤中途参与玩家的首次异常数据。
   * 若玩家第一条答对用时比其余记录均值高出 >10s，则视为"中途参与异常"，将其从时间数组中排除。
   * 只检测第一条记录；后续记录无论多大波动均保留。
   * correctTimesMs 与 questionIndices 是同长并行数组，同步过滤。
   */
  private filterFirstOutlier(
    timesMs: number[],
    questionIndices: number[],
  ): { timesMs: number[]; questionIndices: number[] } {
    if (timesMs.length <= 1) return { timesMs, questionIndices };
    const restMs = timesMs.slice(1);
    const avgRest = restMs.reduce((s, t) => s + t, 0) / restMs.length;
    if (timesMs[0] - avgRest > 10_000) {
      return { timesMs: restMs, questionIndices: questionIndices.slice(1) };
    }
    return { timesMs, questionIndices };
  }

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
    // 同时构建过滤后的 participants 供图表使用（过滤中途参与首次异常数据）
    const filteredParticipants = data.participants.map((p) => {
      const { timesMs, questionIndices } = this.filterFirstOutlier(
        p.correctTimesMs,
        p.questionIndices,
      );
      return { ...p, correctTimesMs: timesMs, questionIndices };
    });

    for (let i = 0; i < nPlayers; i++) {
      const p = data.participants[i];
      const fp = filteredParticipants[i];
      const color = playerColors[i];
      const total = p.correct + p.wrong;
      const accuracy = total === 0 ? "—" : `${((p.correct / total) * 100).toFixed(1)}%`;
      // 时间统计使用过滤后的数据
      const avgMs =
        fp.correctTimesMs.length > 0
          ? fp.correctTimesMs.reduce((s, t) => s + t, 0) / fp.correctTimesMs.length
          : 0;
      const minMs = fp.correctTimesMs.length > 0 ? Math.min(...fp.correctTimesMs) : 0;
      const maxMs = fp.correctTimesMs.length > 0 ? Math.max(...fp.correctTimesMs) : 0;

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

      // 统计数据：答对道数（原始值）、答错道数、正确率及时间统计（过滤后）
      ctx2d.font = `13px ${CJK_FONT_STACK}`;
      const stats = [
        { color: "#27ae60", text: `正确${p.correct}道` },
        { color: "#e74c3c", text: `错误${p.wrong}道` },
        { color: "#2c3e50", text: `正确率${accuracy}` },
        { color: "#2c3e50", text: `均用时${(avgMs / 1000).toFixed(2)}秒` },
        { color: "#2c3e50", text: `最快${(minMs / 1000).toFixed(2)}秒` },
        { color: "#2c3e50", text: `最慢${(maxMs / 1000).toFixed(2)}秒` },
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
    // 直方图图例（多玩家时，与折线图图例格式一致）
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

    this.drawHistogram(
      ctx2d,
      filteredParticipants,
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
      filteredParticipants,
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
   * 时间分布图（答对用时直方图）
   *
   * 根据玩家数量自动选择最优图表形式：
   *   1 人   → 柱状图（单色，直观）
   *   2–3 人 → 分组柱状图（Grouped Bars）：并排柱子，可直接对比高度
   *   4+ 人  → 频率折线图（Frequency Polygon）：
   *            各玩家一条彩色折线叠加在同一坐标系，半透明面积填充 + 数据圆点 + 计数标签，
   *            可视觉比较分布形态，且柱宽/圆点大小不随人数变化。
   *
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

    // ── 各玩家各桶计数 ──────────────────────────────────────────────────────
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

    // Y 轴最大值以单玩家最大桶计数为基准，各玩家在同一标尺下可直接比较
    const maxCount = Math.max(1, ...counts.flat());
    const bucketW = chartW / N_BUCKETS;

    // ── Y 轴格线 & 标签（三种图表通用）──────────────────────────────────────
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

    // ── X 轴标签（三种图表通用）──────────────────────────────────────────────
    for (let bi = 0; bi < N_BUCKETS; bi++) {
      ctx2d.fillStyle = "#555";
      ctx2d.font = `11px ${CJK_FONT_STACK}`;
      ctx2d.textAlign = "center";
      ctx2d.textBaseline = "top";
      ctx2d.fillText(
        BUCKET_LABELS[bi],
        chartX + bi * bucketW + bucketW / 2,
        chartY + barAreaH + 4,
      );
    }

    if (nPlayers >= 4) {
      // ── 频率折线图（频率多边形，4+ 人）────────────────────────────────────
      // 桶中心 X / 对应 Y（高度由计数决定）
      const cx = (bi: number) => chartX + bi * bucketW + bucketW / 2;
      const cy = (cnt: number) => chartY + barAreaH - (cnt / maxCount) * barAreaH;

      // 第一遍：画所有玩家的半透明面积填充（先画，避免遮挡后绘的折线和圆点）
      for (let pi = 0; pi < nPlayers; pi++) {
        ctx2d.beginPath();
        ctx2d.moveTo(cx(0), chartY + barAreaH);
        for (let bi = 0; bi < N_BUCKETS; bi++) ctx2d.lineTo(cx(bi), cy(counts[pi][bi]));
        ctx2d.lineTo(cx(N_BUCKETS - 1), chartY + barAreaH);
        ctx2d.closePath();
        ctx2d.globalAlpha = 0.10;
        ctx2d.fillStyle = playerColors[pi];
        ctx2d.fill();
        ctx2d.globalAlpha = 1;
      }

      // 第二遍：画折线 + 数据点 + 计数标签
      for (let pi = 0; pi < nPlayers; pi++) {
        const color = playerColors[pi];

        // 折线（经过所有桶中心，包括计数为 0 的桶）
        ctx2d.strokeStyle = color;
        ctx2d.lineWidth = 2;
        ctx2d.lineJoin = "round";
        ctx2d.beginPath();
        for (let bi = 0; bi < N_BUCKETS; bi++) {
          const px = cx(bi), py = cy(counts[pi][bi]);
          if (bi === 0) ctx2d.moveTo(px, py); else ctx2d.lineTo(px, py);
        }
        ctx2d.stroke();

        // 数据点 + 计数标签：所有桶均绘制（含 0 计数桶）
        for (let bi = 0; bi < N_BUCKETS; bi++) {
          const cnt = counts[pi][bi];
          const px = cx(bi);
          const py = cy(cnt); // cnt=0 时 py = 基线 chartY + barAreaH
          const isZero = cnt === 0;
          const dotR = isZero ? 3 : 4;

          // 白心 + 彩色边框圆点（0 计数时圆点略小）
          ctx2d.fillStyle = "#fff";
          ctx2d.beginPath();
          ctx2d.arc(px, py, dotR, 0, Math.PI * 2);
          ctx2d.fill();
          ctx2d.strokeStyle = color;
          ctx2d.lineWidth = isZero ? 1.5 : 2;
          ctx2d.beginPath();
          ctx2d.arc(px, py, dotR, 0, Math.PI * 2);
          ctx2d.stroke();

          // 计数标签（与折线颜色相同）
          // 0 计数时：多人共享同一 X 位置（基线），水平错开避免重叠
          ctx2d.fillStyle = color;
          ctx2d.font = `bold 10px ${CJK_FONT_STACK}`;
          ctx2d.textBaseline = "bottom";
          if (isZero) {
            // 各玩家以桶中心为轴左右错开，步长 8px，确保标签不重叠
            const hOffset = (pi - (nPlayers - 1) / 2) * 8;
            ctx2d.textAlign = "center";
            ctx2d.fillText("0", px + hOffset, py - dotR - 2);
          } else {
            ctx2d.textAlign = "center";
            ctx2d.fillText(cnt.toString(), px, py - 7);
          }
        }
      }
    } else {
      // ── 分组柱状图（1–3 人）────────────────────────────────────────────────
      // 分组逻辑：X 轴以时间区间为主分组，每个区间内各玩家的柱子并排排列
      //   每个时间桶宽度 = bucketW
      //   桶内布局：[左间距 BAR_GAP] [P1柱] [柱间距 BAR_GAP] [P2柱] [柱间距 BAR_GAP] [P3柱] [右间距 BAR_GAP]
      //   桶间距由相邻桶的右间距+左间距自然形成（BAR_GAP * 2 = 10px）
      //
      // 对于计数为 0 的玩家：绘制空心占位轮廓柱，保证每个时间桶内的位置关系固定不变，
      // 让观看者始终能识别"左柱 = P1、中柱 = P2、右柱 = P3"
      const BAR_GAP = 5;
      const innerW = bucketW - BAR_GAP * 2;
      const barW = nPlayers > 1
        ? (innerW - BAR_GAP * (nPlayers - 1)) / nPlayers
        : innerW;

      for (let bi = 0; bi < N_BUCKETS; bi++) {
        for (let pi = 0; pi < nPlayers; pi++) {
          const cnt = counts[pi][bi];
          const bx = chartX + bi * bucketW + BAR_GAP + pi * (barW + BAR_GAP);
          const baseY = chartY + barAreaH;
          // 多玩家时标签用玩家色（方便对应），单玩家用深灰
          const labelColor = nPlayers > 1 ? playerColors[pi] : "#2c3e50";
          const showLabel = nPlayers === 1 || barW >= 18;

          if (cnt === 0) {
            // 高度为 0：在基线绘制一条玩家颜色细线，表示该桶底边（0 高度的柱子）
            ctx2d.strokeStyle = playerColors[pi];
            ctx2d.lineWidth = 2;
            ctx2d.beginPath();
            ctx2d.moveTo(bx, baseY - 1);
            ctx2d.lineTo(bx + barW, baseY - 1);
            ctx2d.stroke();
            // "0" 标签
            if (showLabel) {
              ctx2d.fillStyle = labelColor;
              ctx2d.font = `11px ${CJK_FONT_STACK}`;
              ctx2d.textAlign = "center";
              ctx2d.textBaseline = "bottom";
              ctx2d.fillText("0", bx + barW / 2, baseY - 5);
            }
          } else {
            const bh = (cnt / maxCount) * barAreaH;
            const by = baseY - bh;
            ctx2d.fillStyle = playerColors[pi];
            ctx2d.fillRect(bx, by, barW, bh);
            // 柱顶计数标签
            if (showLabel) {
              ctx2d.fillStyle = labelColor;
              ctx2d.font = `11px ${CJK_FONT_STACK}`;
              ctx2d.textAlign = "center";
              ctx2d.textBaseline = "bottom";
              ctx2d.fillText(cnt.toString(), bx + barW / 2, by - 1);
            }
          }
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
