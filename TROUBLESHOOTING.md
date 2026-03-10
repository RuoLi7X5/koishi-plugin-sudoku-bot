# Sudoku Bot 故障排查指南

## ⚠️ 常见问题和解决方案

### 问题 1：插件被标记为"不安全"

**截图特征**：
- 插件显示警告图标 ⚠️
- 提示"此插件未严格配置版本"

**原因分析**：
- `peerDependencies` 中的版本范围过于宽泛或过于严格
- 缺少必要的包元信息（author、license 等）
- 依赖版本与 Koishi 核心不兼容

**解决方案**：

1. **检查 package.json 配置**

确保以下字段存在且正确：

```json
{
  "name": "koishi-plugin-sudoku-bot",
  "version": "0.0.3",
  "main": "lib/index.js",
  "typings": "lib/index.d.ts",
  "license": "MIT",
  "author": "Your Name",
  
  "peerDependencies": {
    "koishi": "^4.17.0"  // 使用较宽松的版本范围
  },
  
  "dependencies": {
    "canvas": "^2.11.2",  // 使用稳定版本
    "sudoku": "^0.0.3"
  }
}
```

2. **重新编译插件**

```bash
cd external/sudoku-bot
rm -rf lib
npx tsc
```

3. **重启 Koishi**

完全重启 Koishi 服务，而不是热重载。

---

### 问题 2：没有可配置项

**截图特征**：
- 插件详情页面显示"过滤条件"
- 没有任何配置选项显示

**原因分析**：
1. `Config` Schema 导出不正确
2. 插件未正确编译
3. Koishi 缓存问题
4. 插件加载失败但未报错

**解决方案**：

#### 步骤 1：验证插件导出

运行验证脚本：

```bash
cd external/sudoku-bot
node verify-plugin.js
```

应该看到：
```
✅ 插件导出正确！
插件名称: sudoku-bot
Config 类型: function
apply 类型: function
```

如果验证失败，重新编译插件。

#### 步骤 2：检查编译输出

确保 `lib/index.js` 存在且包含以下导出：

```javascript
exports.name = "sudoku-bot";
exports.Config = koishi_1.Schema.intersect([...]);
exports.apply = apply;
```

#### 步骤 3：清除 Koishi 缓存

**Windows:**
```powershell
# 停止 Koishi
# 删除缓存（在 Koishi 根目录）
Remove-Item -Recurse -Force node_modules/.cache -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force .koishi -ErrorAction SilentlyContinue

# 重启 Koishi
```

**Linux/macOS:**
```bash
# 停止 Koishi
rm -rf node_modules/.cache
rm -rf .koishi

# 重启 Koishi
```

#### 步骤 4：检查插件状态

1. 打开 Koishi 控制台
2. 进入「日志」页面
3. 查找与 `sudoku-bot` 相关的错误信息
4. 常见错误：
   - `Cannot find module 'canvas'` → 安装 canvas 依赖
   - `database service not found` → 启用数据库插件
   - `Schema validation failed` → Schema 定义有误

#### 步骤 5：强制重新加载

1. 在插件列表中**禁用**插件（添加 `~` 前缀）
2. 保存配置
3. 等待几秒
4. **启用**插件（移除 `~` 前缀）
5. 保存配置

---

### 问题 3：插件启动失败

**查看日志位置**：
- 控制台：「日志」页面
- 终端：直接运行 Koishi 的命令行输出

**常见错误及解决**：

#### Error: Cannot find module 'canvas'

```bash
cd external/sudoku-bot
npm install canvas@2.11.2
```

如果安装失败，参考 canvas 安装指南：

**Windows:**
```bash
npm install --global windows-build-tools
npm install canvas@2.11.2
```

**Ubuntu/Debian:**
```bash
sudo apt-get install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
npm install canvas@2.11.2
```

#### Error: Database service not found

启用数据库插件：

在 `koishi.yml` 中确保有：

```yaml
plugins:
  group:storage:
    database-sqlite:xxxxx:
      path: data/koishi.db
```

#### Error: Command already registered

命令冲突，修改 `commandStart` 等配置项使用不同的命令名称。

---

### 问题 4：配置项显示但无法保存

**原因**：
- 配置项类型定义与实际值不匹配
- Schema 验证规则过于严格

**解决方案**：

1. 检查配置值是否在有效范围内：
   - `timeout`: 10-120
   - `rounds`: 1-20
   - `baseScore`: ≥1
   - `penalty`: ≥0
   - `titleDuration`: 1-365

2. 字符串类型配置不能为空

3. 查看浏览器控制台错误（F12）

---

### 问题 5：插件功能异常

#### 发送命令无响应

**检查清单**：
- [ ] 插件已启用（无 `~` 前缀）
- [ ] 数据库插件已启用
- [ ] 机器人已连接到聊天平台
- [ ] 命令名称正确（检查配置）
- [ ] 有足够的权限（某些命令需要管理员）

#### Canvas 渲染失败

**症状**：游戏开始但没有图片

**解决**：
```bash
cd external/sudoku-bot
npm install canvas@2.11.2 --force
```

重启 Koishi。

---

## 🔧 调试模式

### 启用详细日志

在 `koishi.yml` 中：

```yaml
logLevel: 3  # 0=fatal, 1=error, 2=warn, 3=info, 4=debug
```

### 测试插件加载

```javascript
// 在 external/sudoku-bot 目录下
node -e "
const plugin = require('./lib/index.js');
console.log('Name:', plugin.name);
console.log('Config:', !!plugin.Config);
console.log('Apply:', typeof plugin.apply);
"
```

---

## 📋 完整检查清单

- [ ] `lib/index.js` 文件存在且有内容
- [ ] `package.json` 配置正确（有 author、license）
- [ ] `peerDependencies` 版本兼容（`^4.17.0`）
- [ ] canvas 依赖已安装
- [ ] 数据库插件已启用
- [ ] 插件无 `~` 前缀（已启用）
- [ ] 清除过缓存
- [ ] 完全重启过 Koishi
- [ ] 日志中无错误信息
- [ ] 验证脚本通过

---

## 🆘 仍然无法解决？

### 收集诊断信息

1. **Koishi 版本**：
   ```bash
   npm list koishi
   ```

2. **插件验证结果**：
   ```bash
   node verify-plugin.js
   ```

3. **日志输出**：
   从 Koishi 控制台「日志」页面复制相关错误

4. **package.json 内容**：
   ```bash
   cat package.json
   ```

5. **文件结构**：
   ```bash
   ls -R external/sudoku-bot
   ```

将以上信息整理后进行排查。

---

## ✅ 成功标志

当一切正常时，你应该看到：

1. **插件列表中**：
   - ✅ sudoku-bot（无警告图标）
   - 版本号显示：0.0.3

2. **插件详情页**：
   - 显示 4 个配置分组
   - 命令配置（6项）
   - 游戏配置（3项）
   - 积分配置（3项）
   - 其他配置（1项）

3. **日志中**：
   ```
   [I] plugin sudoku-bot loaded
   ```

4. **聊天测试**：
   发送「数独开始」能收到回复并看到数独图片

---

*最后更新：2026-03-11*
