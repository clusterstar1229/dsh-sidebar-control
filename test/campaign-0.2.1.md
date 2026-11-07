# 0.2.1 verification — live re-test (2026-11-08)

Same environment as the 0.1.3 campaign: DeepSeek Harness Desktop 0.2.2-rc.1, sidebar Browser
(`<webview>`), fixture pages at `http://127.0.0.1:8799/`, Bing, DeepSeek, example.com.

Method: every fix below was driven through the real tool after installing 0.2.1 into the desktop profile
(host reloaded via the plugin manager, client reloaded with a page refresh).

## Fixed defects re-tested

| # | Defect (0.1.3) | 0.2.1 evidence |
|---|---|---|
| 3 | `select` silently blanked the select | `select #fruit kiwi` → `No option matches "kiwi" … available: "apple"="Apple", …`; `select #fruit "dragon fruit"` → `Selected "Dragon fruit" ("dragonfruit", index 3)` |
| 2 | checkbox label was `"on"` | snapshot: `#5 <input> type=checkbox value="on" checked=false "I agree"` |
| 4 | `eval` accepted only an expression | `eval "const x = 2; x * 21"` → `42`; DOM node → `{node:"DIV",text:"Delayed content ready"}`; circular → `{self:"[circular]"}`; Bing (CSP blocks eval) statement → explicit CSP message, expression still works |
| 5 | `click` did not focus text fields | click `#name` then `press Q` → value `"中文输入测试Q"`, activeElement `name` |
| 6 | click reply showed `""` for inputs | click `#name` → `Clicked <input> "Name"` |
| 1 | `open` could adopt another Session's frame / report before ready | `open {new_tab:true}` → `Opened … in Browser tab tab68`, and the returned frame already had `url=…/fixture2.html loading=false`; no foreign frame touched |
| 1b | (found during re-test) dock replaces the webview while mounting | fixed by re-picking the active tab's frame each tick; verified with the same `open` |
| 7 | `scroll` ignored `selector`, `left` moved vertically | `scroll #tall-target` → `y=2309 … viewport top=817`; `scroll left 200` → `y=2309 (already at that position)` |
| 11 | `wait` matched hidden elements | `wait #details-body` → timed out; `wait #summary` → appeared; closed `<details>` no longer counts |
| 12 | `type` on a non-input threw `Illegal invocation`; rejected values looked successful | `type #fruit` → `Cannot type into <select>…`; injected `<input type=number>` + `abc` → `<input type="number"> did not keep the text…` |
| 8/9 | `focus`/`close_tab` accepted unknown ids | `focus tab999` / `close_tab tab999` → `No Browser tab "tab999" is open for this Session; open tabs: tab61` |
| 10 | `tabs` listed foreign Sessions with duplicate ids | `tabs` → `Browser tabs (1, * = active): * tab61 … (2 more belong to other Sessions and are hidden here.)`; after `target=_blank` click → correct 2 rows |
| 13 | no modifier support | `press a modifiers:["ctrl"]` → `Pressed "ctrl+a"`, input selection 0–5 (Electron needs `modifiers: string[]`) |
| 14 | batch bypassed validation, hid read payload, reported N not ran | batch `navigate 127.0.0.1:8799/fixture2.html` (bare host) + wait + read → `Batch: 3 of 3 step(s) ran`, read payload kept; failure case → `Batch: 1 of 2 step(s) ran … failed: step 2 … (remaining steps not run)` |
| 14b | (found during re-test) batch mutated frozen tool args | steps are now validated into a fresh array; the batch above works |
| 15 | long waits capped at 45 s | `wait` with `timeout_ms: 50000` and a missing text → `Timed out after 50000ms …` (host-side budget 65 s) |
| 18 | `open` could not create a tab | `open {new_tab:true}` created tab64/68 and reported the id; `tabs`/`focus`/`close_tab` handled it |
| — | `open file://` | host accepts the scheme, the Browser refuses local files (`ERR_FAILED`), and the reply explains how to serve the file over http |
| — | `click` on `target=_blank` | reply: `Clicked <a> …` + `A new Browser tab opened: tab65`, with the new tab's URL/title |
| — | screenshot | viewport PNG attached (863×916) after the changes |

## Not changed / still true

- `read`/`diff`/`snapshot`/`batch` performance is unchanged (batch of 3 steps ≈ 195 ms on the fixture).
- `target=_blank` and cross-Session frames: the tool only drives frames it can prove belong to the calling
  Session; when the Sidebar has several anonymous frames it asks for `open` instead of guessing.
- `full_page: true` is accepted but still captures the viewport only (the reply says so).
- The screenshot downscale path (base64 > 6 MB) was not triggered in this campaign; the viewport is 863×916.

## Post-campaign additions (also verified live)

- `snapshot` / `read` / `diff` now print `chars ≈ tokens` (Latin ≈4 chars/token, CJK ≈1.5), verified on the
  fixture, the long article and Bing.
- `tabs` / `focus` work while the right Sidebar shows an editor instead of a Browser; previously the shared
  frame guard rejected those commands before their own handler ran.
- Token table on the 15,521-character article: snapshot 12,000 chars ≈ 3,000 tokens; `read` "wall-clock"
  199 ≈ 50; `read` "batch latency" 3,906 ≈ 977; `diff` after one changed paragraph 288 ≈ 72.
- `docs/demo.gif`: a 10.0 s, 700×405, 3.0 MB window capture of type+submit → read → refs-only snapshot →
  screenshot, recorded with `test/record-demo.ps1` and assembled by `test/build-demo-gif.py`.

## Notes

- Host and client halves reload independently: a page refresh reloads the client, while the host needs a
  plugin disable/enable (or an app restart). Both were exercised here.
