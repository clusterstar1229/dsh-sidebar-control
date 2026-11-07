# Browser-control campaign — live testing of 0.1.3 (2026-11-08)

Environment: DeepSeek Harness Desktop, sidebar Browser (Electron `<webview>`), Windows.
Driver: the plugin's own `builtin_browser` tool. Fixture pages under `test/` served at
`http://127.0.0.1:8799/` (python http.server). Real sites: bing.com, deepseek.com, example.com.

Campaign length: 90+ tool actions across ~12 scenarios (open/navigate/back/forward/reload,
snapshot/read/diff, click/type/press/select/scroll/wait, tabs/focus/close_tab, screenshot,
batch, eval, error paths).

## What worked (no change needed)

| Action | Evidence |
|---|---|
| `open` / `navigate` | fixture, Bing, DeepSeek, example.com all load and settle |
| `back` / `forward` / `reload` | history traversal on fixture and Bing |
| `snapshot` | refs + text + scroll info; `include_text:false`, `max_refs`, `max_text_chars` honoured |
| `read` (query) | BM25 hit the zanzibar-quartz paragraph; Bing results; CJK query worked |
| `diff` | adds/removes after a button click (`Roll 0` → `Roll 1`) |
| `type` (+ `submit:true`) | Bing search box, CJK text in an input, multiline textarea; form submitted |
| `click` | buttons, links, checkbox via label; navigation settled |
| `press` | Tab moved focus; A/a/b typed into a focused input (native path works when the field has focus) |
| `select` | valid value and label ("Cherry") both work |
| `scroll` | vertical page scroll; `scroll` with `ref` |
| `wait` | existing and delayed text |
| `tabs` / `focus` / `close_tab` / `close` | happy path with two tabs, including a `target=_blank` link |
| `screenshot` | viewport PNG attached (863×916) |
| `batch` | 3-step click+wait+read in 195 ms; failed step reported with its index |
| `eval` | single expressions, JSON results |

## Defects found (all reproduced live)

| # | Sev | Defect | Repro |
|---|---|---|---|
| 1 | high | `open` may adopt a Browser frame owned by **another Session**; it also reports `Opened` before its own tab's frame exists | fresh open while two foreign frames existed: status showed frames from other sessions, activeTab had no frame yet |
| 2 | med | Checkbox/radio labels are useless: snapshot shows `"on"` (the value) instead of the `<label>` text | fixture `#agree` → `#5 <input type=checkbox value="on"> "on"` |
| 3 | high | `select` with an unknown value silently blanks the select, fires `change`, and reports success | `select #fruit kiwi` → `Selected value "" (index -1)` |
| 4 | high | `eval` accepts only an expression; any statement fails with the opaque `Script failed to execute` | `eval "const x = 2; x * 21"` |
| 5 | high | `click` on an input/textarea does not focus it, so a following `press` goes to `<body>` | click `#1`, press `Q`, value stays empty, activeElement=body |
| 6 | med | `click` reply shows an empty label for inputs (label logic uses `innerText` only) | click `#1` → `Clicked <input> ""` |
| 7 | high | `scroll` ignores `selector` (scrolls by the default amount); `left`/`right` also move vertically; ref scroll reports only page `y` | `scroll #tall-target` → y+600; `scroll left 200` → y=200 |
| 8 | med | `focus` with a stale/unknown tab id reports success and does nothing | `focus tab999` |
| 9 | med | `close_tab` with an unknown id reports success | `close_tab tab999` |
| 10 | med | `tabs` includes other Sessions' tabs (duplicate `tab2` rows) and cannot distinguish them; `*` marker relies on one id field | `tabs` → 4 rows, two identical `tab2` |
| 11 | high | `wait` for a selector matches hidden elements (closed `<details>`), so the next click is a no-op | `wait #details-body` → immediate `Appeared` |
| 12 | high | `type` on a non-input throws `Illegal invocation`; a field that rejects/truncates the text is reported as success | `type #fruit banana`; `<input type=number>` with `abc` |
| 13 | med | `press` has no modifier support (Ctrl+A, Ctrl+Enter), and the native key map is incomplete | no `modifiers` parameter |
| 14 | med | `batch` steps bypass host validation (relative URLs fail mid-batch), the header says N steps even when 1 ran, and read output is truncated to 3 lines | `batch [{click...},{wait...},{read...}]` showed only a 3-line read snippet |
| 15 | high | Long actions break the bridge: client hard-caps every action at 45 s while host allows 90 s (wait up to 300 s); after a >45 s action the next call wrongly says "No DeepSeek Harness page is connected" | `wait {timeout_ms:60000}` cannot finish; busy client misreported as disconnected |
| 16 | low | `snapshot` with `include_text:false` still prints an empty `text:` section | snapshot include_text=false |
| 17 | med | Snapshot hrefs are up to 500 chars (Bing tracking URLs), dominating token cost | Bing results snapshot |
| 18 | med | `open` cannot create a second tab; `file://` URLs are rejected although local HTML artifacts are a normal automation target | `open file:///...` → only http(s) accepted |
| 19 | low | `press Enter` runs a native event **and** a DOM pass that calls `requestSubmit`, risking double submission | code inspection; Bing test submitted once because `type` used requestSubmit |
| 20 | low | `screenshot` accepts `full_page` and silently ignores it | schema only |

## Notes

- `target=_blank` links do open a new Browser tab in this build (tab62); the click reply printed the old
  URL because it sampled the previous frame, and nothing told the model a new tab had appeared.
- The fixture page has no classic `h1` on `example.com`; a `wait h1` timeout there was correct behaviour.
- `read` on Bing returns CJK + Latin paragraphs with sensible ranking; `max_chars` bound respected.
