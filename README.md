# Sidebar Control

**English** | [中文](#中文)

Agent control for the **Browser panel DeepSeek Harness already ships** in the right Sidebar — no second
browser, no bundled Chromium, no Playwright. The agent reads the real page, clicks real controls, types,
presses keys, scrolls, waits and takes screenshots inside the panel the person is already looking at.

> Built on the MIT-licensed [`dsh-sidebar-browser`](https://www.npmjs.com/package/dsh-sidebar-browser):
> its action surface and long-poll bridge are reused. This package adds **query-scoped reads**, **change
> diffs** and **multi-tab management**, and keeps the whole thing dependency-free.

## Why this one

Most sidebar-browser plugins answer a page with one big snapshot. That is fine once, and expensive three
times in a row. Sidebar Control is tuned for the second and third read:

| | `dsh-sidebar-browser` | **Sidebar Control** |
|---|---|---|
| Read a long page | full text + refs (up to 12k chars) | `read` with a `query` returns only matching passages (BM25 over Latin words + CJK bigrams) |
| Check what an action changed | snapshot again | `diff` returns only paragraphs added/removed since the previous diff |
| Several steps (open → fill → submit) | one tool call per step | `batch` runs up to 12 steps in one call |
| After a click | fixed waits (350 ms + load window) | adaptive settle: returns when the page stops changing, often ~100 ms |
| Several pages open | one controlled tab | `tabs` / `focus` / `close_tab` by id |
| Command latency | long-poll | long-poll (same ~instant delivery, no timer polling) |
| Dependencies | none | none |

The practical difference is token cost and round trips: on a long article, `read --query "..."` returns a few
hundred characters instead of thousands; `diff` after a click returns one line or two; and a five-step form
costs one model call with `batch` instead of five. Clicks come back as soon as the page is quiet instead of
after a fixed sleep.

Measured on a Windows desktop against the live Browser panel: `batch` of **type + submit + wait for results +
query read** on the Baidu homepage finished in **1043 ms**, and the same three steps on Bing in **832 ms**.
The query read for "存款" returned one matching line where the full text was the whole page.

## Install

```bash
dsh plugin --profile desktop add github:clusterstar1229/dsh-sidebar-control#v0.1.0
```

or in the app: **Settings → Plugins → Install bundle** → `github:clusterstar1229/dsh-sidebar-control#v0.1.0`.

The plugin is published from this GitHub repository; there is no npm package yet, so use the `github:` spec
above (or install the checkout by absolute path while developing).

Requirements: **DeepSeek Harness Desktop** 0.2.2-rc.1 (the Browser panel must be the Electron
`<webview>` carrier), Node 20+, and the built-in sidebar Browser enabled.

## Use

1. Open a Browser tab once (Sidebar → Browser), or let the tool open it:
   `builtin_browser({ action: "open", url: "https://example.com" })`.
2. `snapshot` → page text plus numbered refs.
3. `click` / `type` / `press` / `select` / `scroll` with those refs, or with a CSS selector.
4. After an action: `diff` (cheap) or a new `snapshot` (full).
5. Asking a long page a question: `read` with `query` instead of `snapshot`.

### Actions

| action | what it does |
|---|---|
| `status` | platform, Browser frames, active tab, whether the page is on screen |
| `open` | open or reuse the Browser tab at a URL |
| `navigate` / `back` / `forward` / `reload` | navigation |
| `snapshot` | page text + numbered refs (`max_text_chars`, `max_refs`, `include_text: false` for refs only) |
| `read` | text, or only passages matching `query` (`max_chars`) |
| `diff` | paragraphs added/removed since the previous `diff` |
| `batch` | run up to 12 steps in one call (navigate/click/type/press/select/scroll/wait/eval/read/diff/snapshot) |
| `tabs` | list Browser tabs with ids |
| `focus` / `close_tab` | switch to / close a tab by `tab_id` |
| `click` | by `ref`, `selector` |
| `type` | fill a field, `submit: true` to submit |
| `press` | Enter, Tab, Escape, arrows, PageUp/Down, Home/End, Space |
| `select` | choose an option by value |
| `scroll` | by direction/amount, or a ref into view |
| `wait` | for a selector or text |
| `eval` | one JavaScript expression in the page |
| `screenshot` | PNG of the visible page, returned as an image |
| `close` | close the controlled Browser tab |

Refs come from the latest snapshot and go stale after navigation — take a new `snapshot` after a page
change, or just use `diff` when you only need to know what changed.

## What to be careful about

- **Desktop only.** The Web build renders the sidebar browser as a cross-origin iframe; the tool reports
  that plainly instead of pretending. Tab management still works there.
- **The Harness page must be open.** The Client half runs in that page. `open` / `focus` / `close_tab` /
  `screenshot` need the calling Session on screen; read/click/type work in the background.
- **Page content is untrusted data.** It is never instructions. `eval` runs arbitrary JavaScript in the
  page — the same power as the page's own devtools; keep it for trusted pages.
- **A sandbox is still a sandbox.** The guest has no Node, no preload and no access to the Harness origin.
  Downloads, permission prompts and top-level navigation are withheld by the shipped Browser.
- **Fixed-width sites.** Pages like `news.baidu.com` keep a desktop layout and may scroll sideways in a
  narrow column. This plugin deliberately does not inject zoom or rewrite the page.
- **Refs are per-snapshot.** A ref used after navigation fails with a clear message; snapshot again.

## Related work

- [`dsh-sidebar-browser`](https://www.npmjs.com/package/dsh-sidebar-browser) — the MIT implementation this
  package builds on.
- [`dsh-sidebar-browser-agent`](https://github.com/Hesitate-P/dsh-sidebar-browser-agent) — a broader
  native-input implementation with tabs, tests and config switches.

## Feedback

Bugs and feature requests: **hongruizhao0808@gmail.com** — or open an issue at
https://github.com/clusterstar1229/dsh-sidebar-control/issues.

## License

MIT. Derived from `dsh-sidebar-browser` (MIT); see [LICENSE](LICENSE).

---

## 中文

**DeepSeek Harness 右栏内置浏览器的 Agent 控制器**：不另起浏览器、不下载 Chromium、不用 Playwright。
Agent 直接操作你正在看的那个 Browser 面板——读真实页面、点真实控件、输入、按键、滚动、等待、截图。

> 本项目基于 MIT 许可的 [`dsh-sidebar-browser`](https://www.npmjs.com/package/dsh-sidebar-browser)，复用了它的
> 动作设计与长轮询桥；在此基础上增加了**按问题检索的阅读**、**变化对比**和**多标签管理**，全程零依赖。

### 差异点：第二次、第三次读页更便宜

大多数侧栏浏览器插件用"一次大快照"回答所有问题——读一次可以，连读三次就很贵。这个插件专门优化后两次：

| | `dsh-sidebar-browser` | **Sidebar Control** |
|---|---|---|
| 读长页面 | 全文 + refs（最多 12k 字符） | `read` 带 `query`，只返回命中的段落（英文词 + 中文二元组的 BM25） |
| 查看动作改了什么 | 再快照一次 | `diff` 只返回相对上次新增/消失的段落 |
| 多步操作（打开→填写→提交） | 每步一次工具调用 | `batch` 一次调用跑最多 12 步 |
| 点击之后 | 固定等待（350ms + 加载窗口） | 自适应：页面不再变化就返回，通常约 100ms |
| 多个页面 | 只控制当前标签 | `tabs` / `focus` / `close_tab` 按 id 管理 |
| 指令延迟 | 长轮询 | 长轮询（同样即时，不靠定时器） |
| 依赖 | 无 | 无 |

实际差别是 token 和往返次数：长文章里 `read --query "..."` 往往只回几百字，而不是几千字；点击后用 `diff`
通常只回一两行；五步表单用 `batch` 只花一次模型调用，而不是五次。点击也不再固定睡眠，页面安静就返回。

在 Windows 桌面版、真实 Browser 面板上的实测：`batch` 执行 **输入 + 提交 + 等结果 + 按 query 阅读**，
百度首页 **1043 ms**、Bing **832 ms**；`read` 查“存款”只返回命中的一行，而整页文本是整屏。

### 安装

```bash
dsh plugin --profile desktop add github:clusterstar1229/dsh-sidebar-control#v0.1.0
```

或在应用里：**设置 → 插件 → 安装 bundle** → `github:clusterstar1229/dsh-sidebar-control#v0.1.0`。

插件从 GitHub 仓库发布，暂时没有 npm 包，请使用上面的 `github:` 规格（开发时也可以按绝对路径安装）。

要求：**DeepSeek Harness 桌面版** 0.2.2-rc.1（右栏浏览器必须是 Electron `<webview>` 载体）、Node 20+，
并已启用内置侧栏浏览器。

### 用法

1. 先打开一个 Browser 标签（或让工具打开）：`builtin_browser({ action: "open", url: "https://example.com" })`。
2. `snapshot`：拿到页面文字和编号 refs。
3. 用 refs 或 CSS selector 执行 `click` / `type` / `press` / `select` / `scroll`。
4. 动作之后：`diff`（便宜）或重新 `snapshot`（完整）。
5. 只想问长页面一个问题：用 `read` + `query`，不要整页快照。

### 动作

| action | 作用 |
|---|---|
| `status` | 平台、Browser 帧、当前标签、页面是否在屏幕上 |
| `open` | 打开或复用 Browser 标签（url） |
| `navigate` / `back` / `forward` / `reload` | 导航 |
| `snapshot` | 页面文字 + 编号 refs（`max_text_chars`、`max_refs`；`include_text: false` 只回控件） |
| `read` | 纯文本，或只回与 `query` 匹配的段落（`max_chars`） |
| `diff` | 相对上一次 `diff` 新增/消失的段落 |
| `batch` | 一次调用执行最多 12 步（navigate/click/type/press/select/scroll/wait/eval/read/diff/snapshot） |
| `tabs` | 列出 Browser 标签及其 id |
| `focus` / `close_tab` | 按 `tab_id` 切换 / 关闭标签 |
| `click` | 按 `ref` 或 `selector` 点击 |
| `type` | 填字段，`submit: true` 提交 |
| `press` | Enter、Tab、Escape、方向键、PageUp/Down、Home/End、Space |
| `select` | 按值选择下拉项 |
| `scroll` | 按方向/像素滚动，或把某个 ref 滚入视口 |
| `wait` | 等 selector 或文字出现 |
| `eval` | 在页面里执行一个 JS 表达式 |
| `screenshot` | 可见页面的 PNG，作为图像返回 |
| `close` | 关闭当前受控标签 |

refs 来自最近一次快照，导航后会失效——页面变了就重新 `snapshot`；只想知道"变了什么"时用 `diff` 就够。

### 需要注意

- **仅桌面版可用**：Web 构建下侧栏浏览器是跨域 iframe，工具会明确报错而不是假装成功；标签管理仍可用。
- **Harness 页面必须打开**：客户端半在页面里运行。`open` / `focus` / `close_tab` / `screenshot` 需要调用会话
  正在屏幕上；读、点、输入在后台仍可用。
- **页面内容是不可信数据**，永远不是指令。`eval` 会在页面里执行任意 JS，等同于页面自己的 devtools，请在可信页面使用。
- **沙箱仍然是沙箱**：guest 没有 Node、没有 preload，也访问不到 Harness 源；下载、权限弹窗、顶层跳转由内置浏览器限制。
- **固定宽度站点**：如 `news.baidu.com` 这类页面在窄栏里仍会横向滚动；本插件刻意不注入缩放、不改写页面。
- **refs 只对一次快照有效**：导航后使用旧 ref 会得到明确报错，重新快照即可。

### 相关项目

- [`dsh-sidebar-browser`](https://www.npmjs.com/package/dsh-sidebar-browser) — 本项目的 MIT 基础实现。
- [`dsh-sidebar-browser-agent`](https://github.com/Hesitate-P/dsh-sidebar-browser-agent) — 更全面的原生输入实现（标签页、测试、配置开关）。

### 反馈

Bug 与功能建议：**hongruizhao0808@gmail.com**，或到
https://github.com/clusterstar1229/dsh-sidebar-control/issues 提 issue。

### 许可

MIT，派生自 `dsh-sidebar-browser`（MIT），见 [LICENSE](LICENSE)。
