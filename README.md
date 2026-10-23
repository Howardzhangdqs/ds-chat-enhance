# DeepSeek Chat Enhance

一个运行在 `chat.deepseek.com` 的 userscript：把对话里的 **SVG / HTML 代码块自动渲染成可见内容**，并提供「预览 / 源码」一键切换。

模型在回答里画结构图、流程图、示意图时，通常只能输出代码块。这个脚本让代码块默认以渲染结果呈现，不必再复制到本地文件里查看。

| 项目信息 | 值 |
| --- | --- |
| 当前版本 | `0.7.2` |
| 运行形态 | Userscript（Tampermonkey / Violentmonkey） |
| 作用域 | `https://chat.deepseek.com/*` |
| 技术栈 | TypeScript · Vite · vite-plugin-monkey |
| 运行时依赖 | 无 |
| 构建产物 | `dist/ds-chat-enhance.user.js` |

---

## 目录

- [项目简介](#项目简介)
- [功能特性](#功能特性)
- [安装](#安装)
- [使用](#使用)
- [工作原理](#工作原理)
- [项目结构](#项目结构)
- [开发](#开发)
- [测试](#测试)
- [发布](#发布)
- [可调参数](#可调参数)
- [安全模型](#安全模型)
- [常见问题](#常见问题)
- [路线图](#路线图)
- [贡献](#贡献)
- [致谢](#致谢)

---

## 项目简介

DeepSeek 网页版会把模型输出中的 fenced code block 渲染成带语法高亮的代码块。对于 `svg`、`html` 这类**本身就是可视化产物**的代码，阅读体验并不好：需要人工在脑中执行一遍，或者复制出去用浏览器打开。

DeepSeek Chat Enhance 在页面侧完成三件事：

1. **识别**：判断代码块语言是否为 `svg` / `html` / `htm`（流式阶段语言标签缺失时，按代码内容推断）。
2. **渲染**：把代码解析成 DOM，放进一个隔离的 `iframe` 中实时呈现。
3. **维持同步**：模型流式输出、React 重渲染、窗口缩放时，持续保证预览与代码一致。

渲染与源码查看互不干扰：默认展示预览，点右侧眼睛按钮即可切回源码。

## 功能特性

- **默认渲染 SVG / HTML 代码块**：无需手动点击「运行」。
- **预览 / 源码一键切换**：按钮位于代码块原生工具栏最右侧，保持原有交互布局。
- **流式增量渲染**：`CodeScanner` 只解析新增文本，`DomBuilder` 只追加新节点，避免每次输出都全量重解析（整体复杂度从 O(n²) 降到 O(n)）。
- **生成完成后原样重建**：代码稳定一段时间后，用模型给的原始代码重建一次，避免增量过程留下的结构偏差。
- **高度自适应**：按内容实测高度设置 iframe，SVG 按比例撑满可用宽度；窗口或侧栏宽度变化后自动重算。
- **主题融合**：SVG 预览背景取自代码块的实际背景色，深色模式下不会出现突兀白底。
- **HTML 预览白底 + 内边距**：适配常规网页片段。
- **安全隔离**：iframe 使用 `sandbox="allow-same-origin"`，不授予脚本执行权限。
- **多实例接管**：通过 `data-dsce-owner` 标记保证同一页面只有一个实例在渲染，重复安装不会出现双份控件。
- **SPA 友好**：`MutationObserver` + 周期对账，兼容 DeepSeek 的消息流式插入与节点替换。

## 安装

### 前置条件

- Chrome / Edge / Firefox 等支持扩展的浏览器
- [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey

### 从源码构建并安装

```bash
# 1. 安装依赖
bun install

# 2. 构建 userscript
bun run build

# 3. 安装产物
#    dist/ds-chat-enhance.user.js
```

安装方式任选：

- 把 `dist/ds-chat-enhance.user.js` 直接拖进浏览器窗口，脚本管理器会弹出安装页；
- 或在脚本管理器中新建脚本，把文件内容整体粘贴进去并保存。

安装后打开（或刷新）`https://chat.deepseek.com/` 即可生效。

### 开发模式

```bash
bun install
bun run dev
```

Vite 会启动开发服务器，并按 `vite-plugin-monkey` 的方式提供可安装的开发版 userscript。修改源码后按终端提示更新脚本并刷新页面即可。

> 生产构建会先执行 `tsc` 做类型检查，再交给 Vite 打包。

## 使用

让模型输出一个带语言标记的代码块即可：

````markdown
```svg
<svg viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg">
  <rect width="400" height="200" fill="#111"/>
  <text x="24" y="60" fill="#fff" font-size="24">Hello SVG</text>
</svg>
```
````

````markdown
```html
<div style="padding:16px;font-family:sans-serif">
  <h2>Hello HTML</h2>
  <p>这是一个 HTML 预览。</p>
</div>
```
````

行为说明：

- 预览默认开启，源码默认隐藏；
- 点击代码块右上角的眼睛按钮切换「预览 / 源码」；
- 流式生成过程中预览会逐步补齐，未闭合的标签由扫描器暂存，不会把半截标签塞进 DOM；
- 支持的语言标识：`svg`、`html`、`htm`。其他语言（`text`、`js`、`python` 等）保持原样。

## 工作原理

### 总体流程

```text
MutationObserver (subtree)
        │
        ▼
      scan()
        │  查找 .md-code-block
        ▼
   detectLang()  ── banner 语言 / 内容推断 ──► 'svg' | 'html'
        │
        ▼
   CodeScanner.feed(text)          增量扫描，缓存已解析前缀
        │  tokens: open / close / selfclose / text / comment
        ▼
   DomBuilder.apply(scanner)       只追加新增节点
        │
        ▼
   iframe[sandbox]  ◄── srcdoc 外壳（背景 / 布局）
        │
        ▼
   fitFrame()                      实测内容高度 → 设置 iframe 高度
        │
        └─ 代码稳定 1s ─► renderRaw()  用原始代码精确重建一次
```

### 核心模块

| 模块 | 职责 |
| --- | --- |
| `src/main.ts` | 生命周期、语言识别、iframe 外壳、高度测量、按钮注入、观察与对账 |
| `src/scanner.ts` | 增量 HTML/SVG 扫描器，输出 token 流与补齐闭合标签后的完整文本 |
| `src/dombuilder.ts` | 消费 token 流，增量构建 iframe 内 DOM |

### 为什么用 iframe

- **样式隔离**：模型输出的 CSS 不会污染 DeepSeek 页面，页面样式也不会意外影响预览。
- **结构隔离**：预览 DOM 与聊天消息 DOM 分离，React 重渲染不会破坏已渲染内容。
- **安全边界**：`sandbox` 不授予 `allow-scripts`，预览中的 `<script>` 不会执行。

### 增量渲染与最终重建

流式输出时，每个字符都可能触发更新。为避免整段重新解析：

1. `CodeScanner` 记录已消费位置，只处理新增部分；遇到未写完的标签/注释就停下等待。
2. 内容被非追加式改写时，扫描器版本号自增，构建器据此整体重建。
3. 代码稳定 `SETTLE_MS` 后，`renderRaw()` 用模型原始代码重建一次，保证最终结果与代码完全一致。

### 高度测量

`fitFrame()` 取以下三者的最大值作为内容高度：

- `body.scrollHeight`
- `documentElement.scrollHeight`
- SVG 元素的 `getBoundingClientRect().height`

SVG 只有 `viewBox` 时，`scrollHeight` 可能取整偏小，因此额外用实际 rect 高度兜底。高度上限按语言区分：SVG 为 4000px（图片语义，避免截断），HTML 为 640px（超出后由 iframe 内部滚动）。

> 曾经的一个缺陷：外壳同时给 `html` 和 `body` 设置 `display:flex`，使 `body` 变成 shrink-to-fit 的 flex 项；而 SVG 又依赖 `max-width:100%`，形成循环依赖，`body` 与 `svg` 双双塌成 `0×0`，`fitFrame()` 只好回落到 40px 下限。现在只让 `body` 作为 flex 容器并显式 `width:100%`。

## 项目结构

```text
.
├── src/
│   ├── main.ts          # 入口：观察、识别、渲染、对账、UI 注入
│   ├── scanner.ts       # 增量扫描器（token 化）
│   ├── dombuilder.ts    # 增量 DOM 构建器
│   ├── style.css        # 预留样式文件（当前未引用）
│   └── vite-env.d.ts
├── test/
│   └── scanner.test.ts  # 扫描器行为与流式一致性测试
├── dist/                # 构建产物（git 忽略）
├── vite.config.ts       # vite-plugin-monkey 配置
├── tsconfig.json
├── tsconfig.node.json
├── package.json
└── bun.lock
```

## 开发

### 环境

- Bun（推荐）或 Node.js 20+
- TypeScript 6
- Vite 8

### 常用命令

```bash
bun install        # 安装依赖
bun run dev        # 开发服务器
bun run build      # 类型检查 + 生产构建
bun run test       # 运行扫描器测试
```

### 工程约定

- 严格 TypeScript（`strict`、`noUnusedLocals`、`noUnusedParameters`）。
- 渲染逻辑不引入第三方运行时依赖，保持 userscript 体积可控。
- 所有对页面 DOM 的写入都必须可被 `destroy()` 撤销。
- 新增页面选择器时，优先做「找不到就降级/退出」，不要抛错中断整个扫描。
- 修改扫描器或构建器后，必须保证分块喂入与一次性喂入结果一致。

## 测试

测试使用 Bun 直接运行，无需额外测试框架：

```bash
bun run test
```

覆盖内容：

- 完整 SVG / HTML 原样输出
- 未闭合标签补齐
- 半截标签丢弃与续传
- 文本中的 `<`、注释、属性内特殊字符
- 分块喂入与一次性喂入的一致性（覆盖所有前缀）
- token 流结构正确性

## 发布

发布通过 GitHub Actions 手动触发，构建与 Release 创建在同一条流水线里完成。

### 步骤

1. 修改 `package.json` 中的 `version` 并提交、推送（这是**唯一**版本来源，userscript 头部与运行时版本都由它派生）。
2. 打开仓库的 **Actions → Release → Run workflow**。
3. 按需勾选：
   - `draft`：先创建草稿 Release，确认后再发布；
   - `prerelease`：标记为预发布。
4. 运行后工作流会依次执行：
   - 校验 `package.json` 版本为合法 semver；
   - 检查 `v<version>` 标签是否已存在（存在则失败，避免覆盖历史版本）；
   - `bun install --frozen-lockfile` + `bun run build`；
   - 校验产物存在且 `@version` 与版本一致；
   - 创建 `v<version>` 标签与 GitHub Release，并上传 `dist/ds-chat-enhance.user.js`。

Release 的说明由 GitHub 自动生成（`--generate-notes`），产物直接附带在 Release 附件中，用户可一键下载安装。

> 标签不存在时才允许发布，因此重复触发同一版本会直接失败；升级版本请先更新 `package.json`。

## 可调参数

集中在 `src/main.ts` 顶部：

| 常量 | 默认值 | 说明 |
| --- | --- | --- |
| `UPDATE_DEBOUNCE_MS` | `250` | 流式期间的更新节流 |
| `RECONCILE_MS` | `1000` | 兜底对账周期 |
| `SETTLE_MS` | `1000` | 代码稳定多久视为生成完成 |
| `MAX_FRAME_HEIGHT` | `640` | HTML 预览高度上限（超出内部滚动） |
| SVG 高度上限 | `4000` | SVG 预览高度上限，避免截断 |
| `PREVIEW_LANGS` | `svg` / `html` / `htm` | 触发渲染的语言集合 |

## 安全模型

- 预览运行在独立 `iframe` 中，`sandbox="allow-same-origin"`，**不允许脚本执行**。
- 因此 HTML 预览里的 `<script>`、事件处理器属性不会生效；这是有意为之。
- `allow-same-origin` 仅用于测量内容高度（`contentDocument`）。
- 脚本不发起网络请求，不收集、不上传任何对话内容。
- 脚本只在 `chat.deepseek.com` 域名下运行。

## 常见问题

**Q：代码块没有渲染，仍然是源码？**

依次检查：

1. 代码块语言是否为 `svg` / `html` / `htm`；
2. 脚本管理器中脚本是否启用、版本是否为最新；
3. 控制台是否输出 `[ds-chat-enhance] svg/html preview ready v...`；
4. DeepSeek 是否改版导致 `.md-code-block` / `.md-code-block-banner` 选择器失效。

**Q：预览区域是空白，但 DOM 里有 iframe？**

通常是内容高度被算成 0。检查 iframe 内部 `body` 与根 `svg` 的 `getBoundingClientRect()`：若宽度为 0，说明高度/宽度测量链路异常，而不是代码本身的问题。

**Q：SVG 被截断了？**

检查是否超过高度上限（SVG 4000px / HTML 640px）。HTML 超限时可在预览内滚动；SVG 为保持图片完整性给了更大的上限。

**Q：HTML 里的 JavaScript 为什么不执行？**

沙箱设计如此。渲染只做静态展示，不执行模型生成的脚本。

**Q：为什么预览和源码按钮会重复？**

同一页面同时存在多个脚本实例。当前实现通过 `data-dsce-owner` 让最新实例接管、旧实例自行退出；若仍重复，重新加载页面即可。

**Q：切换对话或滚动后预览消失？**

DeepSeek 会重建消息节点。脚本通过 `MutationObserver` 与周期对账重新挂载；若节点被完全替换，会为新节点建立独立状态。

**Q：会影响页面性能吗？**

每个需要渲染的代码块对应一个 iframe。正常情况下开销可接受；长对话中大量 SVG/HTML 代码块会累积 iframe，可通过刷新页面释放。

## 路线图

- [ ] Mermaid / 数学公式等更多可视化语言
- [ ] 预览全屏查看
- [ ] 导出渲染结果为 PNG / SVG
- [ ] 每站点可配置的语言白名单
- [ ] 更细粒度的主题适配（跟随 DeepSeek 明暗主题变量）
- [ ] 自动化 E2E 测试（真实页面 DOM 回归）

## 贡献

欢迎提交 Issue 与 Pull Request。

1. Fork 并创建分支：`feat/xxx`、`fix/xxx`；
2. 保持改动聚焦，避免顺带重构无关代码；
3. 提交前执行：

   ```bash
   bun run test
   bun run build
   ```

4. 提交信息建议使用 Conventional Commits：`fix: ...`、`feat: ...`、`docs: ...`；
5. 在 PR 描述中说明：改动动机、行为变化、验证方式。

如果遇到 DeepSeek 改版导致的失效，请在 Issue 中附上：

- 浏览器与脚本管理器版本；
- 失效代码块的 HTML 结构（可脱敏）；
- 控制台报错与 `iframe` 的实际尺寸。

## 致谢

- [DeepSeek](https://chat.deepseek.com/)：对话与代码块渲染的宿主环境
- [vite-plugin-monkey](https://github.com/lisonge/vite-plugin-monkey)：userscript 构建与开发体验
- [Tampermonkey](https://www.tampermonkey.net/) / [Violentmonkey](https://violentmonkey.github.io/)：脚本运行时
