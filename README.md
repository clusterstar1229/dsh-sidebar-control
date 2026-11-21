# Sidebar Control

[![npm version](https://img.shields.io/npm/v/dsh-sidebar-control?label=npm&color=cb3837)](https://www.npmjs.com/package/dsh-sidebar-control)
[![npm downloads](https://img.shields.io/npm/dm/dsh-sidebar-control?label=downloads)](https://www.npmjs.com/package/dsh-sidebar-control)
[![GitHub stars](https://img.shields.io/github/stars/clusterstar1229/dsh-sidebar-control?style=flat&label=stars)](https://github.com/clusterstar1229/dsh-sidebar-control/stargazers)
[![license](https://img.shields.io/npm/l/dsh-sidebar-control?color=blue)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.5%2B-4b6bfb)](https://github.com/deepseek-ai/deepseek-harness)

[![Star this project](https://img.shields.io/badge/⭐_Star_this_project-help_it_grow-yellow)](https://github.com/clusterstar1229/dsh-sidebar-control)
[![Awesome DSH](https://img.shields.io/badge/awesome--dsh--plugin-listed-orange)](https://awesome-dsh-plugin.com/p/clusterstar1229/dsh-sidebar-control/)
[![dshopen](https://img.shields.io/badge/dshopen.org-verified-2ea44f)](https://dshopen.org/zh/plugins/dsh-sidebar-control/)

**English** | [中文](#中文)

Agent control for the **Browser panel DeepSeek Harness already ships** in the right Sidebar — no second
browser, no bundled Chromium, no Playwright. The agent reads the real page, clicks real controls, types,
presses keys, scrolls, waits and takes screenshots inside the panel the person is already looking at.

![10-second demo: the agent types a Bing query, submits it, reads the results and takes a screenshot inside the Harness sidebar](https://raw.githubusercontent.com/clusterstar1229/dsh-sidebar-control/main/docs/demo.gif)

*10-second screen capture (no cuts): `type` + `submit`, `read`, a refs-only `snapshot`, and a `screenshot` —
all inside the right-Sidebar Browser the user is already watching.*

> Built on the MIT-licensed [`dsh-sidebar-browser`](https://www.npmjs.com/package/dsh-sidebar-browser):
> its action surface and long-poll bridge are reused. This package adds **query-scoped reads**, **change
> diffs** and **multi-tab management**, and keeps the whole thing dependency-free.

**If this saves you tokens, please [Star the repository](https://github.com/clusterstar1229/dsh-sidebar-control) ⭐**

### Why a star helps

This plugin is maintained in the open, alone, on evenings and weekends. A star is not vanity here — it is the
signal other Harness users look for before they install an agent that can click inside their signed-in browser:
"someone else read the code and trusted it." Concretely:

- ⭐ **Stars get it found.** `dshmarket` and the community indexes sort and recommend partly by stars, so each
  one puts this plugin in front of more people who are about to write their own script.
- 🐛 **Stars bring bug reports.** The 0.2.1 and 0.2.3 fixes came from real usage reports; more eyes mean the
  next rough edge is found before it bites you.
- ⏱️ **Stars buy testing time.** Every release here ships with a live campaign against the real sidebar Browser
  (see [`test/`](test/)); the more visible the project, the longer those campaigns can be.

One click, no account state changes, and you can un-star later — [**⭐ Star now**](https://github.com/clusterstar1229/dsh-sidebar-control)
· [watch releases](https://github.com/clusterstar1229/dsh-sidebar-control/subscription) · [open an issue](https://github.com/clusterstar1229/dsh-sidebar-control/issues)

## Why this one

Most sidebar-browser plugins answer a page with one big snapshot. That is fine once, and expensive three
times in a row. Sidebar Control is tuned for the second and third read:

| | `dsh-sidebar-browser` | **Sidebar Control** |
|---|---|---|
| Read a long page | full text + refs (up to 12k chars) | `read` with a `query` returns only matching passages (BM25 over Latin words + CJK bigrams) |
| Check what an action changed | snapshot again | `diff` returns only paragraphs added/removed since the previous diff |
| Several steps (open → fill → submit) | one tool call per step | `batch` runs up to 12 steps in one call |
| After a click | fixed waits (350 ms + load window) | adaptive settle: returns when the page stops changing, often ~100 ms |
| Several pages open | one controlled tab | `tabs` / `focus` / `close_tab` by id, scoped to the calling conversation |

Because each conversation owns its own tab strip, several chats can drive the sidebar at the same time without
seeing — or stepping on — each other's pages. This is the 0.2.3 headline fix.
| Command latency | long-poll | long-poll (same ~instant delivery, no timer polling) |
| Dependencies | none | none |

The practical difference is token cost and round trips: on a long article, `read --query "..."` returns a few
hundred characters instead of thousands; `diff` after a click returns one line or two; and a five-step form
costs one model call with `batch` instead of five. Clicks come back as soon as the page is quiet instead of
after a fixed sleep.

Measured on a Windows desktop against the live Browser panel: `batch` of **type + submit + wait for results +
query read** on the Baidu homepage finished in **1043 ms**, and the same three steps on Bing in **832 ms**.

## Token measurements

Exact character counts from the plugin's own `… chars ≈ … tokens` note, on a **15,521-character** article
fixture ([`test/long-article.html`](https://github.com/clusterstar1229/dsh-sidebar-control/blob/main/test/long-article.html))
and a **7,104-character single-line** page ([`test/singleline.html`](https://github.com/clusterstar1229/dsh-sidebar-control/blob/main/test/singleline.html)):

| Task | Returned | Approx. tokens |
|---|---|---|
| `snapshot` (default 12k cap) | 12,000 chars, truncated | **≈ 3,000** |
| `read { query: "wall-clock" }` | 199 chars · 1 of 1 passage | **≈ 50** |
| `read { query: "batch latency" }` | 3,906 chars · 11 of 15 passages | **≈ 977** |
| `read { query: "quartz-lantern" }` on the single-line page | 796 chars · 1 of 1 sentence chunk | **≈ 199** |
| `diff` after one paragraph changed | 288 chars | **≈ 72** |

That is a **98%** reduction for a targeted question versus a full snapshot, and a **~40×** difference on
`diff`. The estimator counts Latin text at ~4 characters/token and CJK at ~1.5 characters/token, so treat the
token column as an order of magnitude, not a tokenizer: the character counts are exact. Re-run the same
experiment with `python -m http.server 8799 --bind 127.0.0.1 --directory test` and the fixture above.

## Conversations own their tabs

The most requested fix, shipped in 0.2.3. Before it, the right Sidebar had **one** tab strip per window: a
background conversation that called `open` created its tab in whichever conversation was on screen, and its
`tabs` / `focus` / `close_tab` could reach into yours. Two chats working at once turned the strip into a pile
where nobody could tell which tab belonged to whom.

Now every tab is written into the calling conversation's own layout and every tab operation is scoped to it:

| What you see | Meaning |
|---|---|
| `tabs` lists only your tabs, `[this chat]` on each row | the default view: your conversation's pages |
| `[chat 7a3c11]` rows | those tabs belong to another conversation; shown only with `tabs { all: true }`, and never driven |
| `focus` / `close_tab` on someone else's tab | fails with the owner's id instead of moving or closing it |
| `tabs { prune: true }` | closes the blank tabs **this** conversation accumulated; others are untouched |
| `status` → `tabs: 2 in this conversation, 10 in other conversations` | a one-line sanity check |

Parallel conversations can now drive the sidebar at the same time, each in its own strip. Closing your tab
never closes the page someone else is reading.

## Built-in Browser vs this plugin

DSH 0.2.2-rc.5 ships the right-Sidebar Browser as an **app surface**: a tab host plus an Electron
`<webview>`, with its own tabs, address bar and session. In this build we found no model-facing tool
registered for that surface — the panel is UI-only until something exposes it to the agent.

This package is that something. It registers exactly one model-facing tool, and it is deliberately called
`builtin_browser`: it drives the built-in panel. Consequences:

- **Same tab, same cookies.** `open` / `navigate` / `click` act on the page the person is already looking at,
  including signed-in sessions. There is no second browser profile and no automation browser to log in again.
- **No extra binaries.** Nothing is downloaded and no Chromium/Playwright process starts; the Electron
  `<webview>` DSH already renders is the only engine.
- **Name overlap, not a fork.** If a future Harness build registers its own tool with the same name, do not
  enable both at once — two registrations with one name compete. Keep one; the action surface here stays
  compatible in spirit (`status`, `open`, `snapshot`, `click`, `type`, …).
- **The panel chrome is unchanged.** This plugin adds read/diff/batch and validation on the tool side; it does
  not replace the Browser UI, inject CSS or zoom pages.

## Versions and updates

| Version | Date | What this version solved |
|---|---|---|
| **0.2.3** | 2026-11-22 | **Tabs belong to the conversation that opened them.** Parallel conversations used to share one tab strip: `open` created tabs in whichever Session was on screen, so a background chat dropped its tab into the chat you were reading, and `tabs` / `focus` / `close_tab` / `close` could reach across conversations. Tabs are now written into the calling Session's own layout (`openTabIn`), every tab operation is scoped to the caller, `tabs` labels each row with its owner (`[this chat]` / `[chat 7a3c11]`), `tabs { all: true }` shows other conversations read-only, and `tabs { prune: true }` closes only this conversation's blank tabs. Also: a failed screenshot now suggests `snapshot` / `read` instead of a dead end, `eval` says when a script ran but returned nothing, and `status` reports the tab split plus the calling Session. |
| 0.2.2 | 2026-11-16 | **Interaction and layout coverage.** `hover` opens menus and tooltips before a click; `snapshot` / `read` / `click` / `type` / `scroll` / `wait` now traverse **open shadow roots**, and shadow text is filtered to visible content; `screenshot` gains `full_page` (stitched viewport tiles) and `max_width`; `select` accepts a 0-based `index`; `type` gains `clear: false` to append; `open` / `navigate` accept page-relative paths; `read` splits a single-line page into sentence chunks and falls back to the page opening when nothing matches; `batch` accepts `hover`. |
| 0.2.1 | 2026-11-08 | **Live-campaign hardening.** A 110-action run against the real panel found 20 defects; this release fixes them. *Correctness:* `select` fails on an unknown option instead of blanking the control, `scroll` honours `selector` and axis, `wait` requires a visible element, `eval` accepts statements and serialises real data, `click` focuses text fields, `type` verifies the stored value. *Safety:* `open` / `tabs` / `focus` / `close_tab` are Session-scoped, and stale snapshot refs are cleared. *Reliability:* client deadlines follow the requested timeout (long waits no longer break), a busy page is no longer reported as disconnected, `batch` validates every step and reports `ran N of M`, oversized screenshots are downscaled, and results now state their size (`chars ≈ tokens`). |
| 0.1.3 | 2026-11-07 | First stable public release on npm and GitHub: sidebar Browser control with snapshot refs, `click` / `type` / `press` / `select` / `scroll`, query-scoped `read` (BM25 over Latin words + CJK bigrams), `diff`, `batch`, multi-tab management and screenshots. Superseded by 0.2.x for daily use. |
| 0.1.0 – 0.1.2 | 2026-11-07 | First iterations: packaging, the MIT license, npm-first install docs and marketplace metadata. |

**Current release: 0.2.3.** **Upgrading from 0.1.x or 0.2.x:** install 0.2.3 with the same command (or the Plugin
Manager **Update** button); there is no configuration or data migration. If you installed from a checkout,
reinstall from npm so the Plugin Manager can offer future updates. Per-fix detail lives in
[CHANGELOG.md](CHANGELOG.md); the live evidence is in
[`test/campaign-0.2.3.md`](https://github.com/clusterstar1229/dsh-sidebar-control/blob/main/test/campaign-0.2.3.md),
[`test/campaign-0.2.2.md`](https://github.com/clusterstar1229/dsh-sidebar-control/blob/main/test/campaign-0.2.2.md),
[`test/campaign-0.2.1.md`](https://github.com/clusterstar1229/dsh-sidebar-control/blob/main/test/campaign-0.2.1.md)
and the original defect matrix in
[`test/campaign-0.1.3.md`](https://github.com/clusterstar1229/dsh-sidebar-control/blob/main/test/campaign-0.1.3.md).

## Compatibility

| DSH / platform | Status | Notes |
|---|---|---|
| Desktop **0.2.2-rc.5** (current) | ✅ Tested | Full action set, screenshots (incl. full_page), multi-tab, session scoping, shadow DOM; campaigns on 2026-11-08 and 2026-11-16 |
| Desktop 0.2.x (later) | ✅ Expected | `engines.dsh` allows `>=0.2.2-rc.5 <0.3.0`; requires the right-Sidebar Browser `<webview>` carrier |
| Desktop < 0.2.2-rc.5 | ❌ Unsupported | No right-Sidebar Browser service for the Client half to drive |
| Web build (`dsh web`) | ⚠️ Tabs only | The panel is a cross-origin iframe: no page JS, refs or capture; `tabs` / `focus` still work |
| macOS / Linux desktop | ⚠️ Expected | Same Electron webview path, not exercised in this Windows campaign |

## Install

```bash
dsh plugin --profile desktop add dsh-sidebar-control@0.2.3
```

or in the app: **Settings → Plugins → Install bundle** → `dsh-sidebar-control@0.2.3`.

An npm install gives the Plugin Manager an **Update** button for later releases. Prefer a checkout?
Use `github:clusterstar1229/dsh-sidebar-control#v0.2.3` instead.

Requirements: **DeepSeek Harness Desktop** 0.2.2-rc.5, Node 20+, and the built-in sidebar Browser enabled.

## Use

1. Open a Browser tab once (Sidebar → Browser), or let the tool open it:
   `builtin_browser({ action: "open", url: "https://example.com" })`.
2. `snapshot` → page text plus numbered refs.
3. `click` / `type` / `press` / `select` / `scroll` with those refs, or with a CSS selector.
4. After an action: `diff` (cheap) or a new `snapshot` (full).
5. Asking a long page a question: `read` with `query` instead of `snapshot`.

### Actions (as of 0.2.3)

| action | what it does | since |
|---|---|---|
| `status` | platform, Browser frames, active tab, whether the page is on screen, plugin version | 0.1.x |
| `open` | open or reuse a Browser tab **in this conversation's own layout**; `new_tab: true` opens a separate tab and returns once it has a real document; page-relative paths resolve | 0.1.x / `new_tab` 0.2.1 / relative 0.2.2 / per-conversation 0.2.3 |
| `navigate` / `back` / `forward` / `reload` | navigation (relative paths resolve against the current page) | 0.1.x / relative 0.2.2 |
| `snapshot` | page text + numbered refs (`max_text_chars`, `max_refs`, `include_text: false` for refs only); open shadow roots traversed | 0.1.x / size note 0.2.1 / shadow 0.2.2 |
| `read` | text, or only passages matching `query` (`max_chars`); reports `chars ≈ tokens`; long single-line pages chunked by sentence; falls back to the page opening on no match | 0.1.x / size note 0.2.1 / chunk+fallback 0.2.2 |
| `diff` | paragraphs added/removed since the previous `diff`; includes shadow-rendered text | 0.1.x / size note 0.2.1 / shadow 0.2.2 |
| `batch` | run up to 12 steps in one call (navigate/click/hover/type/press/select/scroll/wait/eval/read/diff/snapshot) | 0.1.x / validation+payload 0.2.1 / hover 0.2.2 |
| `tabs` | list **this conversation's** Browser tabs with ids and owner labels; `all: true` lists other conversations read-only; `prune: true` closes this conversation's blank tabs | 0.1.x / scoped 0.2.1 / owner labels+prune 0.2.3 |
| `focus` / `close_tab` | switch to / close a tab by `tab_id`; never reaches another conversation's tab | 0.1.x / validated 0.2.1 / caller-scoped 0.2.3 |
| `click` | by `ref` or `selector`; focuses text fields; works inside open shadow roots | 0.1.x / focus 0.2.1 / shadow 0.2.2 |
| `hover` | move a native pointer over a `ref` / `selector` to open menus and tooltips | 0.2.2 |
| `type` | fill a field; the value is verified, `submit: true` submits the form or presses Enter; `clear: false` appends | 0.1.x / verification 0.2.1 / append 0.2.2 |
| `press` | Enter, Tab, Escape, arrows, PageUp/Down, Home/End, Space, plus `modifiers` (ctrl/alt/shift/meta) | 0.1.x / modifiers 0.2.1 |
| `select` | choose by option value, label or 0-based `index`; an unknown option is an error listing the options | 0.1.x / error report 0.2.1 / index 0.2.2 |
| `scroll` | by direction/amount, or a `ref`/`selector` into view | 0.1.x / selector 0.2.1 / shadow 0.2.2 |
| `wait` | for a visible selector and/or text; selectors resolve into open shadow roots | 0.1.x / visibility 0.2.1 / shadow 0.2.2 |
| `eval` | a JavaScript expression or statement block in the page | 0.1.x / statements 0.2.1 |
| `screenshot` | PNG of the visible page; `full_page: true` stitches the whole page; `max_width` downscales | 0.1.x / downscale 0.2.1 / full_page+max_width 0.2.2 |
| `close` | close the controlled Browser tab | 0.1.x |

Refs come from the latest snapshot and go stale after navigation — take a new `snapshot` after a page
change, or just use `diff` when you only need to know what changed.

### Tutorial 1 — search once, read only the passages you need

One `batch` call does the whole search flow: fill the box, submit, wait for results, and read only the
passages that answer the question.

```js
builtin_browser({
  action: "batch",
  steps: [
    { action: "type", selector: "#sb_form_q", text: "DeepSeek Harness", submit: true },
    { action: "wait", text: "DeepSeek Harness" },
    { action: "read", query: "deepseek harness plugin", max_chars: 700 },
  ],
})
```

A real reply from the Bing results page:

```text
Batch: 3 of 3 step(s) ran in 276 ms.
1. type: Typed 16 characters into <input>. Submitted the form. · url: https://www.bing.com/search?q=DeepSeek+Harness …
2. wait: Appeared: {"found":true,"text":"DeepSeek Harness"}
3. read: Read 14 of 42 matching passage(s) for "DeepSeek Harness plugin". · 700 chars ≈ 206 tokens
```

The model never asked for the full page: the result block is 700 characters instead of a 12k snapshot.

### Tutorial 2 — read a local HTML report

`file://` is blocked by the current desktop build, so serve the folder over loopback and let the Browser
open it like any site:

```bash
python -m http.server 8000 --bind 127.0.0.1 --directory ./out
```

```js
builtin_browser({ action: "open", url: "http://127.0.0.1:8000/report.html" })
builtin_browser({ action: "snapshot", max_refs: 20 })          // controls + a size note
builtin_browser({ action: "read", query: "Q3 revenue", max_chars: 800 })
builtin_browser({ action: "screenshot" })                      // PNG of the visible report
```

Use `snapshot` when you need to click a chart control, `read` when you only need the numbers, and
`screenshot` when the model should see the layout.

### Tutorial 3 — open a menu, then capture the whole page

Menus that appear on hover need `hover` first; their items are not in the snapshot while the menu is closed.

```js
builtin_browser({ action: "hover", selector: "#account-menu" })
builtin_browser({ action: "snapshot", include_text: false, max_refs: 40 })
builtin_browser({ action: "click", ref: 3 })
builtin_browser({ action: "screenshot", full_page: true, max_width: 1200 })
```

`full_page` scrolls the page in viewport tiles and stitches them, then restores the original scroll position.
Fixed headers repeat in the stitched image, and `max_width` keeps a very long capture small.

## What to be careful about

- **Tabs are per conversation.** A tab opened by another conversation is listed only with `tabs { all: true }`
  and cannot be focused or closed from here; switch conversations to work on it.
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
- **Shadow DOM is traversed only when it is open.** Refs, text and selectors see open shadow roots; closed
  shadow DOM and iframes are not reachable, and the tool reports their counts so a missing element makes sense.
- **Full-page screenshots repeat fixed headers.** `full_page` stitches viewport tiles; a sticky header appears
  once per tile. `max_width` downscales the result for long pages.
- **Local `file://` pages may be blocked.** The current desktop build refuses them; serve local HTML over
  http. If your build allows them, only open local HTML you trust.

## Related work

- [`dsh-sidebar-browser`](https://www.npmjs.com/package/dsh-sidebar-browser) — the MIT implementation this
  package builds on (Copyright (c) 2026 The dsh-sidebar-browser authors); the `read`/`diff`/`tabs` additions
  are this package's own work.
- [`dsh-sidebar-browser-agent`](https://github.com/Hesitate-P/dsh-sidebar-browser-agent) — a broader
  native-input implementation with tabs, tests and config switches.

## Development

```bash
npm run check                 # node --check on both halves
python -m http.server 8799 --bind 127.0.0.1 --directory test   # fixture pages
```

`test/fixture.html` exercises every action; `long-article.html` and `singleline.html` back the token table;
`hover.html` covers menu hovers and `shadow.html` covers open shadow roots. The campaign files record the live
matrix and the fixes — `campaign-0.2.3.md` holds the two-conversation isolation matrix.
`test/record-demo.ps1` + `test/build-demo-gif.py` produced `docs/demo.gif` (10-second capture, 700×405, 3.0 MB).

## Feedback

Bugs and feature requests: **hongruizhao0808@gmail.com** — or open an issue at
https://github.com/clusterstar1229/dsh-sidebar-control/issues.

## License

MIT. Derived from `dsh-sidebar-browser` (MIT); see [LICENSE](LICENSE).

---

## 中文

**DeepSeek Harness 右栏内置浏览器的 Agent 控制器**：不另起浏览器、不下载 Chromium、不用 Playwright。
Agent 直接操作你正在看的那个 Browser 面板——读真实页面、点真实控件、输入、按键、滚动、等待、截图。

![10 秒演示：Agent 在 Harness 侧栏里输入 Bing 搜索、提交、读取结果并截图](https://raw.githubusercontent.com/clusterstar1229/dsh-sidebar-control/main/docs/demo.gif)

*10 秒真实录屏（未剪辑）：`type` + `submit`、`read`、只回 refs 的 `snapshot`、最后 `screenshot`，全部发生在你正在看的右栏 Browser 里。*

> 本项目基于 MIT 许可的 [`dsh-sidebar-browser`](https://www.npmjs.com/package/dsh-sidebar-browser)，复用了它的
> 动作设计与长轮询桥；在此基础上增加了**按问题检索的阅读**、**变化对比**和**多标签管理**，全程零依赖。

**如果它帮你省了 token，欢迎[点个 Star](https://github.com/clusterstar1229/dsh-sidebar-control) ⭐**

### 为什么值得点星

这个插件是个人在业余时间维护的开源项目。Star 在这里不是虚荣指标，而是别的 Harness 用户决定要不要装一个
"能在已登录浏览器里点来点去"的 Agent 之前，会去找的那个信号——"已经有人读过代码并且信任它"。具体来说：

- ⭐ **Star 决定它被不被看见。** `dshmarket` 与社区索引会参考 Star 排序和推荐，多一个 Star 就多一批本来要自己写脚本的人看到它。
- 🐛 **Star 带来问题反馈。** 0.2.1 和 0.2.3 的修复都来自真实使用反馈；看的人越多，下一个坑越早被发现。
- ⏱️ **Star 换来测试时间。** 每个版本都带一轮真实侧栏 Browser 的现场测试（见 [`test/`](test/)），项目越受关注，这些测试就能做得更扎实。

点一下即可，不改任何账号状态，以后也可以取消——[**⭐ 现在点 Star**](https://github.com/clusterstar1229/dsh-sidebar-control)
· [订阅新版本](https://github.com/clusterstar1229/dsh-sidebar-control/subscription) · [提 issue](https://github.com/clusterstar1229/dsh-sidebar-control/issues)

### 差异点：第二次、第三次读页更便宜

大多数侧栏浏览器插件用"一次大快照"回答所有问题——读一次可以，连读三次就很贵。这个插件专门优化后两次：

| | `dsh-sidebar-browser` | **Sidebar Control** |
|---|---|---|
| 读长页面 | 全文 + refs（最多 12k 字符） | `read` 带 `query`，只返回命中的段落（英文词 + 中文二元组的 BM25） |
| 查看动作改了什么 | 再快照一次 | `diff` 只返回相对上次新增/消失的段落 |
| 多步操作（打开→填写→提交） | 每步一次工具调用 | `batch` 一次调用跑最多 12 步 |
| 点击之后 | 固定等待（350ms + 加载窗口） | 自适应：页面不再变化就返回，通常约 100ms |
| 多个页面 | 只控制当前标签 | `tabs` / `focus` / `close_tab` 按 id，且只作用于调用方对话 |
| 指令延迟 | 长轮询 | 长轮询（同样即时，不靠定时器） |
| 依赖 | 无 | 无 |

实际差别是 token 和往返次数：长文章里 `read --query "..."` 往往只回几百字，而不是几千字；点击后用 `diff`
通常只回一两行；五步表单用 `batch` 只花一次模型调用，而不是五次。点击也不再固定睡眠，页面安静就返回。

在 Windows 桌面版、真实 Browser 面板上的实测：`batch` 执行 **输入 + 提交 + 等结果 + 按 query 阅读**，
百度首页 **1043 ms**、Bing **832 ms**。

### Token 实测

以下字符数来自插件自己输出的 `… chars ≈ … tokens`，测试页是 **15,521 字符**的
[`test/long-article.html`](https://github.com/clusterstar1229/dsh-sidebar-control/blob/main/test/long-article.html)
和 **7,104 字符单行**的
[`test/singleline.html`](https://github.com/clusterstar1229/dsh-sidebar-control/blob/main/test/singleline.html)：

| 任务 | 返回 | 约合 token |
|---|---|---|
| `snapshot`（默认 12k 上限） | 12,000 字符，已截断 | **≈ 3,000** |
| `read { query: "wall-clock" }` | 199 字符 · 1/1 段命中 | **≈ 50** |
| `read { query: "batch latency" }` | 3,906 字符 · 11/15 段命中 | **≈ 977** |
| 单行页 `read { query: "quartz-lantern" }` | 796 字符 · 1/1 个句子块 | **≈ 199** |
| `diff`（改一段之后） | 288 字符 | **≈ 72** |

同一页面上，针对性问题比整页快照少 **98%**，`diff` 少约 **40 倍**。估算规则是英文约 4 字符/token、
中文约 1.5 字符/token，因此 token 列看数量级即可，字符数是精确值。用
`python -m http.server 8799 --bind 127.0.0.1 --directory test` 打开同一个 fixture 可以复现。

### 对话各自拥有标签（0.2.3 核心修复）

以前右侧栏在一个窗口里只有**一条**标签栏：后台对话调用 `open` 时，标签会被建到"屏幕上那个对话"的布局里，
它的 `tabs` / `focus` / `close_tab` 也可能伸进你的对话。两个对话同时工作，标签栏就混成一堆，谁也说不清哪个
标签是谁的。

现在每个标签都写进调用方对话自己的布局，所有标签操作也按调用方隔离：

| 你会看到 | 含义 |
|---|---|
| `tabs` 只列你的标签，每行带 `[this chat]` | 默认视图：本对话的页面 |
| `[chat 7a3c11]` 行 | 属于其他对话；只有 `tabs { all: true }` 才显示，而且绝不会被操作 |
| 对别人的标签执行 `focus` / `close_tab` | 直接报出归属 id，而不是悄悄移动或关闭 |
| `tabs { prune: true }` | 只关闭**本**对话积累的空白标签，其他对话不受影响 |
| `status` → `tabs: 2 in this conversation, 10 in other conversations` | 一行自检 |

多个对话可以同时操控侧栏，各自在自己的标签栏里；关闭你的标签，也不会关掉别人正在读的页面。

### 与宿主内置 Browser 的关系

DSH 0.2.2-rc.5 自带右栏 Browser 这个**界面**：标签宿主 + Electron `<webview>`，有自己的标签、地址栏和会话。
在我们检查的这个构建里，它**没有**向模型注册同名工具——面板先是一个纯 UI，需要插件把它暴露出来。

本插件就是那个"暴露层"：只注册一个面向模型的工具，名字就叫 `builtin_browser`，因为它驱动的是内置面板。
由此带来几个事实：

- **同一个标签、同一份 cookie**：`open` / `navigate` / `click` 操作的是用户正在看的页面（含已登录会话），
  不存在第二个浏览器配置，也不需要重新登录。
- **不下载额外二进制**：不启动 Chromium/Playwright 进程，DSH 已经渲染的 Electron `<webview>` 就是唯一引擎。
- **同名不是分叉**：如果未来 Harness 自己注册了 `builtin_browser`，不要同时启用两个——同名注册会互相竞争。
  留一个即可，动作面（`status`、`open`、`snapshot`、`click`、`type`……）保持兼容。
- **面板 UI 不变**：本插件只在工具侧增加 read/diff/batch 与校验，不替换 Browser 界面，也不注入 CSS 或缩放页面。

### 版本与更新

| 版本 | 日期 | 这个版本解决了什么 |
|---|---|---|
| **0.2.3** | 2026-11-22 | **标签归属于开启它的对话。** 以前多个对话共用一条标签栏：`open` 把标签建在「屏幕上那个会话」的布局里，于是后台对话的标签会掉进你正在读的对话里，`tabs` / `focus` / `close_tab` / `close` 也可能跨对话操作。现在标签写入调用方会话自己的布局（`openTabIn`），所有标签操作按调用方隔离，`tabs` 每行标注归属（`[this chat]` / `[chat 7a3c11]`），`tabs { all: true }` 只读列出其他对话，`tabs { prune: true }` 只清理本对话的空白标签。此外：截图失败会提示改用 `snapshot` / `read`，`eval` 脚本无返回值时会说明已执行，`status` 会报告本对话/其他对话的标签数与调用会话。 |
| 0.2.2 | 2026-11-16 | **交互与版面覆盖。** 新增 `hover`，可先打开悬停菜单/提示再点击；`snapshot` / `read` / `click` / `type` / `scroll` / `wait` 现在会遍历**开放的 shadow root**，且 shadow 文本只收集可见内容；`screenshot` 支持 `full_page`（分块拼接整页）和 `max_width`；`select` 支持从 0 开始的 `index`；`type` 支持 `clear: false` 追加；`open` / `navigate` 支持相对路径；`read` 会把单行长页拆成句子块，并在无命中时回退显示页面开头；`batch` 支持 `hover`。 |
| 0.2.1 | 2026-11-08 | **现场实战加固。** 在真实面板上跑了 110 步自动化，发现 20 个缺陷并全部修复。*正确性：*`select` 选不存在的值会明确报错而不是清空控件，`scroll` 支持 `selector` 与单一滚动轴，`wait` 只认可见元素，`eval` 支持语句块并返回可读数据，`click` 会聚焦输入框，`type` 会校验实际写入值。*安全性：*`open` / `tabs` / `focus` / `close_tab` 按会话隔离，快照旧 ref 会被清除。*可靠性：*客户端超时跟随请求的 timeout（长等待不再断），忙状态不再被误报为页面未连接，`batch` 会先校验步骤并报告 `ran N of M`，超大截图自动降采样，结果会标注 `chars ≈ tokens`。 |
| 0.1.3 | 2026-11-07 | 首个 npm / GitHub 正式公开版本：侧栏 Browser 控制、快照 refs、`click` / `type` / `press` / `select` / `scroll`、按问题检索的 `read`（英文词 + 中文二元组 BM25）、`diff`、`batch`、多标签与截图。日常使用请升级到 0.2.x。 |
| 0.1.0 – 0.1.2 | 2026-11-07 | 最初几次迭代：打包、MIT 许可、npm 优先的安装文档与市场元数据。 |

**当前发布：0.2.3。** **从 0.1.x 或 0.2.x 升级：** 用同样的命令安装 0.2.3（或在插件管理器点 **Update**）；没有配置或
数据迁移。若当初是从源码 checkout 安装的，请改用 npm 安装，这样以后才能收到更新。逐条修复见
[CHANGELOG.md](CHANGELOG.md)，现场证据见
[`test/campaign-0.2.3.md`](https://github.com/clusterstar1229/dsh-sidebar-control/blob/main/test/campaign-0.2.3.md)、
[`test/campaign-0.2.2.md`](https://github.com/clusterstar1229/dsh-sidebar-control/blob/main/test/campaign-0.2.2.md)、
[`test/campaign-0.2.1.md`](https://github.com/clusterstar1229/dsh-sidebar-control/blob/main/test/campaign-0.2.1.md)，
最初的缺陷清单见
[`test/campaign-0.1.3.md`](https://github.com/clusterstar1229/dsh-sidebar-control/blob/main/test/campaign-0.1.3.md)。

### 兼容矩阵

| DSH / 平台 | 状态 | 说明 |
|---|---|---|
| 桌面版 **0.2.2-rc.5**（当前） | ✅ 已实测 | 完整动作集、截图（含整页）、多标签、会话隔离、shadow DOM；2026-11-08 与 2026-11-16 均有现场测试 |
| 桌面版 0.2.x（后续） | ✅ 预期可用 | `engines.dsh` 允许 `>=0.2.2-rc.5 <0.3.0`；需要右栏 Browser 的 `<webview>` 载体 |
| 桌面版 < 0.2.2-rc.5 | ❌ 不支持 | 没有可供客户端半驱动的右栏 Browser 服务 |
| Web 构建（`dsh web`） | ⚠️ 仅标签管理 | 面板是跨域 iframe：没有页面 JS、refs 或截图；`tabs` / `focus` 仍可用 |
| macOS / Linux 桌面版 | ⚠️ 预期可用 | 同一 Electron webview 路径，本次 Windows 测试未覆盖 |

### 安装

```bash
dsh plugin --profile desktop add dsh-sidebar-control@0.2.3
```

或在应用里：**设置 → 插件 → 安装 bundle** → `dsh-sidebar-control@0.2.3`。

从 npm 安装后，插件管理器会为后续版本提供 **Update** 按钮。想用仓库源码，也可以改用
`github:clusterstar1229/dsh-sidebar-control#v0.2.3`。

要求：**DeepSeek Harness 桌面版** 0.2.2-rc.5、Node 20+，并已启用内置侧栏浏览器。

### 用法

1. 先打开一个 Browser 标签（或让工具打开）：`builtin_browser({ action: "open", url: "https://example.com" })`。
2. `snapshot`：拿到页面文字和编号 refs。
3. 用 refs 或 CSS selector 执行 `click` / `type` / `press` / `select` / `scroll`。
4. 动作之后：`diff`（便宜）或重新 `snapshot`（完整）。
5. 只想问长页面一个问题：用 `read` + `query`，不要整页快照。

#### 动作（0.2.3）

| action | 作用 | 起始版本 |
|---|---|---|
| `status` | 平台、Browser 帧、当前标签、页面是否在屏幕上、插件版本 | 0.1.x |
| `open` | 在**本对话自己的布局**里打开或复用 Browser 标签；`new_tab: true` 另开一个，并在真正有文档后返回；支持相对路径 | 0.1.x / `new_tab` 0.2.1 / 相对路径 0.2.2 / 按对话隔离 0.2.3 |
| `navigate` / `back` / `forward` / `reload` | 导航（相对路径基于当前页面解析） | 0.1.x / 相对路径 0.2.2 |
| `snapshot` | 页面文字 + 编号 refs（`max_text_chars`、`max_refs`；`include_text: false` 只回控件）；遍历开放 shadow root | 0.1.x / 大小标注 0.2.1 / shadow 0.2.2 |
| `read` | 纯文本，或只回与 `query` 匹配的段落（`max_chars`），并标注 `chars ≈ tokens`；单行长页按句子分块；无命中时回退页面开头 | 0.1.x / 大小标注 0.2.1 / 分块+回退 0.2.2 |
| `diff` | 相对上一次 `diff` 新增/消失的段落；包含 shadow 渲染文本 | 0.1.x / 大小标注 0.2.1 / shadow 0.2.2 |
| `batch` | 一次调用执行最多 12 步（navigate/click/hover/type/press/select/scroll/wait/eval/read/diff/snapshot） | 0.1.x / 校验与内容保留 0.2.1 / hover 0.2.2 |
| `tabs` | 列出**本对话**的 Browser 标签、id 与归属；`all: true` 只读列出其他对话；`prune: true` 关闭本对话的空白标签 | 0.1.x / 会话隔离 0.2.1 / 归属+prune 0.2.3 |
| `focus` / `close_tab` | 按 `tab_id` 切换 / 关闭标签，绝不跨对话 | 0.1.x / 校验 0.2.1 / 调用方隔离 0.2.3 |
| `click` | 按 `ref` 或 `selector` 点击；会聚焦输入框；可进入开放 shadow root | 0.1.x / 聚焦 0.2.1 / shadow 0.2.2 |
| `hover` | 用原生指针悬停 `ref` / `selector`，先打开菜单和提示 | 0.2.2 |
| `type` | 填字段并校验写入结果，`submit: true` 提交表单，无表单则按 Enter；`clear: false` 追加 | 0.1.x / 校验 0.2.1 / 追加 0.2.2 |
| `press` | Enter、Tab、Escape、方向键、PageUp/Down、Home/End、Space，支持 `modifiers`（ctrl/alt/shift/meta） | 0.1.x / 修饰键 0.2.1 |
| `select` | 按值、标签或从 0 开始的 `index` 选择；不存在的选项会报错并列出可选项 | 0.1.x / 报错 0.2.1 / index 0.2.2 |
| `scroll` | 按方向/像素滚动，或用 `ref`/`selector` 滚入视口 | 0.1.x / selector 0.2.1 / shadow 0.2.2 |
| `wait` | 等可见的 selector 和/或文字；selector 会进入开放 shadow root | 0.1.x / 可见性 0.2.1 / shadow 0.2.2 |
| `eval` | 在页面里执行 JS 表达式或语句块 | 0.1.x / 语句块 0.2.1 |
| `screenshot` | 可见页面的 PNG；`full_page: true` 拼接整页；`max_width` 降采样 | 0.1.x / 降采样 0.2.1 / full_page+max_width 0.2.2 |
| `close` | 关闭当前受控标签 | 0.1.x |

refs 来自最近一次快照，导航后会失效——页面变了就重新 `snapshot`；只想知道"变了什么"时用 `diff` 就够。

#### 教程 1 —— 一次 batch 完成搜索，只读命中的段落

```js
builtin_browser({
  action: "batch",
  steps: [
    { action: "type", selector: "#sb_form_q", text: "DeepSeek Harness", submit: true },
    { action: "wait", text: "DeepSeek Harness" },
    { action: "read", query: "deepseek harness plugin", max_chars: 700 },
  ],
})
```

Bing 结果页上的真实返回：

```text
Batch: 3 of 3 step(s) ran in 276 ms.
1. type: Typed 16 characters into <input>. Submitted the form. · url: https://www.bing.com/search?q=DeepSeek+Harness …
2. wait: Appeared: {"found":true,"text":"DeepSeek Harness"}
3. read: Read 14 of 42 matching passage(s) for "DeepSeek Harness plugin". · 700 chars ≈ 206 tokens
```

模型不需要整页：结果块是 700 字符，而不是 12k 的整页快照。

#### 教程 2 —— 读取本地 HTML 报告

当前桌面版会拦截 `file://`，所以用 loopback http 把目录提供出来：

```bash
python -m http.server 8000 --bind 127.0.0.1 --directory ./out
```

```js
builtin_browser({ action: "open", url: "http://127.0.0.1:8000/report.html" })
builtin_browser({ action: "snapshot", max_refs: 20 })          // 控件 + 大小标注
builtin_browser({ action: "read", query: "Q3 revenue", max_chars: 800 })
builtin_browser({ action: "screenshot" })                      // 可见报告的 PNG
```

需要点图表控件时用 `snapshot`，只需要数字时用 `read`，需要看版式时用 `screenshot`。

#### 教程 3 —— 先打开悬停菜单，再截整页

只在悬停时出现的菜单要先 `hover`，否则菜单项不在快照里：

```js
builtin_browser({ action: "hover", selector: "#account-menu" })
builtin_browser({ action: "snapshot", include_text: false, max_refs: 40 })
builtin_browser({ action: "click", ref: 3 })
builtin_browser({ action: "screenshot", full_page: true, max_width: 1200 })
```

`full_page` 会按视口分块滚动截图再拼接，完成后恢复原来的滚动位置；固定头部会在拼图中重复一次，
`max_width` 用来把很长的页面压小。

### 需要注意

- **标签按对话隔离**：别的对话开的标签只有 `tabs { all: true }` 才显示，也不能在这里 focus 或关闭；请切到对应对话处理。
- **仅桌面版可用**：Web 构建下侧栏浏览器是跨域 iframe，工具会明确报错而不是假装成功；标签管理仍可用。
- **Harness 页面必须打开**：客户端半在页面里运行。`open` / `focus` / `close_tab` / `screenshot` 需要调用会话
  正在屏幕上；读、点、输入在后台仍可用。
- **页面内容是不可信数据**，永远不是指令。`eval` 会在页面里执行任意 JS，等同于页面自己的 devtools，请在可信页面使用。
- **沙箱仍然是沙箱**：guest 没有 Node、没有 preload，也访问不到 Harness 源；下载、权限弹窗、顶层跳转由内置浏览器限制。
- **固定宽度站点**：如 `news.baidu.com` 这类页面在窄栏里仍会横向滚动；本插件刻意不注入缩放、不改写页面。
- **refs 只对一次快照有效**：导航后使用旧 ref 会得到明确报错，重新快照即可。
- **只遍历开放的 shadow DOM**：refs、文本和 selector 能看到 open shadow root；closed shadow DOM 和 iframe 不可达，
  工具会报告它们的数量，方便判断元素为什么找不到。
- **整页截图会重复固定头部**：`full_page` 是视口分块拼接，sticky 头部每块出现一次；长页面用 `max_width` 压小。
- **`file://` 可能被构建禁止**：当前桌面版会拒绝本地文件；请用 http 提供本地 HTML。

### 相关项目

- [`dsh-sidebar-browser`](https://www.npmjs.com/package/dsh-sidebar-browser) — 本项目的 MIT 基础实现
  （Copyright (c) 2026 The dsh-sidebar-browser authors）；`read`/`diff`/`tabs` 等增量为本项目原创。
- [`dsh-sidebar-browser-agent`](https://github.com/Hesitate-P/dsh-sidebar-browser-agent) — 更全面的原生输入实现（标签页、测试、配置开关）。

### 开发

```bash
npm run check                 # 对 host/client 两半做 node --check
python -m http.server 8799 --bind 127.0.0.1 --directory test   # 测试 fixture
```

`test/fixture.html` 覆盖所有动作；`long-article.html` 与 `singleline.html` 是 token 表格的测试页；
`hover.html` 覆盖悬停菜单，`shadow.html` 覆盖开放 shadow root。campaign 文件记录现场测试与修复，其中 `campaign-0.2.3.md` 是两对话隔离矩阵。
`test/record-demo.ps1` + `test/build-demo-gif.py` 生成 `docs/demo.gif`（10 秒、700×405、3.0 MB）。

### 反馈

Bug 与功能建议：**hongruizhao0808@gmail.com**，或到
https://github.com/clusterstar1229/dsh-sidebar-control/issues 提 issue。

### 许可

MIT，派生自 `dsh-sidebar-browser`（MIT），见 [LICENSE](LICENSE)。
