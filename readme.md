# Koishi Plugin - Sudoku Bot

数独答题游戏插件，支持积分系统、成就系统、排行榜等丰富功能。

## ⚠️ 重要提示

**安装前必读**：
1. ✅ 必须先安装 `@koishijs/plugin-canvas`（[详细说明](#canvas-依赖)）
2. ✅ 必须启用数据库插件（如 `database-sqlite`）
3. ✅ 插件加载顺序：canvas → database → sudoku-bot

**快速开始**：查看 [INSTALL_GUIDE.md](./INSTALL_GUIDE.md)

## 📦 安装与配置

### 安装方式

**方式一：External 插件（推荐）**

将插件放在 Koishi 项目的 `external` 文件夹中，Koishi 会自动识别并加载。

```
mybot1/
  external/
    sudoku-bot/
```

### 启用插件

1. 打开 Koishi 控制台（默认 http://localhost:5140）
2. 进入「插件配置」页面
3. 在插件列表中找到「sudoku-bot」
4. 点击插件名称前的开关启用插件（移除 `~` 符号）
5. 配置完成后点击「保存」

### 配置说明

插件启用后，在 Koishi 控制台中可以看到以下配置项：

#### 命令配置
- **开始游戏命令**（commandStart）：默认 `数独开始`
- **强制结束命令**（commandStop）：默认 `数独结束`（需管理员权限）
- **查看积分命令**（commandScore）：默认 `积分`
- **兑换头衔命令**（commandExchange）：默认 `兑换`
- **查看排行榜命令**（commandRank）：默认 `数独排行`
- **查看游戏进度命令**（commandProgress）：默认 `游戏进度`

#### 游戏配置
- **每题超时时间**（timeout）：默认 30 秒，范围 10-120 秒
- **每轮题目数量**（rounds）：默认 8 题，范围 1-20 题

#### 积分配置
- **答对基础分**（baseScore）：默认 10 分
- **答错扣分**（penalty）：默认 5 分
- **连续答对额外加分**（streakBonus）：默认 1 分

#### 其他配置
- **难度级别**（difficulty）：默认 medium，可选 easy/medium/hard
- **荣誉头衔有效期**（titleDuration）：默认 7 天，范围 1-365 天

## 🎮 使用方法

详细的功能介绍和使用说明请参考 [USER_GUIDE.md](./USER_GUIDE.md)

## 📋 依赖要求

### 核心依赖

| 依赖 | 版本 | 说明 | 安装方式 |
|------|------|------|----------|
| Koishi | ^4.17.0 | Koishi 核心 | - |
| **@koishijs/plugin-canvas** | latest | Canvas 服务（必需）⭐ | `npm install @koishijs/plugin-canvas` |
| puppeteer | latest | Canvas 后端（推荐） | `npm install puppeteer` |
| sudoku | ^0.0.3 | 数独生成器 | 自动安装 |
| database 服务 | - | 数据存储（必需） | 启用任一数据库插件 |

### ⚠️ Canvas 依赖

本插件**必须依赖** Koishi Canvas 服务才能渲染数独图片。

**快速安装**：
```bash
# 方法 1：通过 Koishi 控制台
# 进入「插件市场」搜索 canvas 并安装

# 方法 2：命令行
npm install @koishijs/plugin-canvas
npm install puppeteer
```

**详细说明**：
- [INSTALL_GUIDE.md](./INSTALL_GUIDE.md) - 完整安装步骤
- [CANVAS_SETUP.md](./CANVAS_SETUP.md) - Canvas 配置详解
- [CANVAS_FIX.md](./CANVAS_FIX.md) - 快速修复指南

## 🔧 开发

### 编译插件

```bash
cd external/sudoku-bot
npx tsc
```

### 类型检查

```bash
npx tsc --noEmit
```

## 📝 版本

当前版本：v0.0.9

**更新日志**：
- v0.0.9：**Canvas 多实现兼容**（关键修复）⭐ 支持所有 Canvas 插件
- v0.0.8：添加详细调试日志
- v0.0.7：修复图片显示、添加答案图片、优化群嘲条件
- v0.0.6：修复 Canvas 服务注入和图片发送问题

## 📄 许可证

MIT

## 🆘 常见问题

### Q: 插件安装后看不到配置项？

A: 请确保：
1. 插件在 `koishi.yml` 中没有被 `~` 禁用
2. 重启 Koishi 服务
3. 刷新浏览器页面

### Q: 提示缺少 database 服务？

A: 本插件需要数据库支持，请在 Koishi 中启用至少一个数据库插件（如 database-sqlite）

### Q: canvas 安装失败？

A: canvas 是一个 native 模块，可能需要：
- Windows: 安装 Windows Build Tools
- Linux: 安装 cairo 相关依赖
- macOS: 通常无需额外配置

详见：https://github.com/Automattic/node-canvas#installation
