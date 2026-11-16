# 0.2.2 verification — live campaign (2026-11-16)

Environment: DeepSeek Harness Desktop 0.2.2-rc.1, right-Sidebar Browser (`<webview>`), Windows.
Server: `python -m http.server 8799 --bind 127.0.0.1 --directory test`. New fixtures: `hover.html`,
`shadow.html`, `singleline.html`; regressions on `fixture.html`, `long-article.html`.

## New features verified

| Feature | Evidence |
|---|---|
| `hover` opens CSS `:hover` menus with a native pointer | `hover #hbtn` → background `rgb(255, 0, 0)`, menu `display: block`, `mouseenter` count **1** (fallback path counted 2 before the fix) |
| `hover` + `click` in one `batch` | `Batch: 2 of 2 step(s) ran in 365 ms`; menu item click updated the page |
| hover hidden target | hidden button → `The target element is hidden, so hovering it would do nothing.` |
| Open shadow root refs | `snapshot` on `shadow.html` lists `#1 <button> "Shadow Button"`, `#2 <input> "shadow input"`, note `1 open shadow root(s) traversed` |
| Shadow text in snapshot/read | `read {query:"kumquat"}` → 75 chars ≈ 19 tokens; style/hidden text filtered out |
| Shadow click/type/select via ref and selector | clicking ref 1 set `out` to `shadow button clicked`; typing ref 2 and selector `#sinput` with `clear:false` produced `"hello shadowby selector"` |
| `select {index}` | `select #fruit index 2` → `Selected "Cherry" ("cherry", index 2).` |
| `type {clear:false}` | type `abc` then `def` → value `"abcdef"` |
| Page-relative URLs | `navigate "/fixture2.html"` and `open "/fixture.html"` resolved against the current page |
| `screenshot full_page` | long article → `575×7388` at `max_width:600`, then `400×5139` at `max_width:400`; scroll restored to 0 |
| `screenshot max_width` viewport | `300×367` |
| `read` single-line chunking | 7,104-char page, query `quartz-lantern` → 796 chars ≈ 199 tokens (one sentence chunk) |
| `read` no-match fallback | `No passage matched "zebra-nonexistent"; showing the page beginning.` + opening text |
| Invalid selector | `click/type` → `Invalid CSS selector "##bad": …`; `wait` fails immediately instead of timing out |

## Regression tests (0.2.1 behaviour kept)

| Test | Result |
|---|---|
| `snapshot` labels/refs on `fixture.html` | 11 refs, checkbox label `"I agree"`, select label `"Fruit"` |
| `wait` hidden vs visible | `#details-body` timed out; `#summary` appeared |
| `select` unknown option | lists `"apple"="Apple" …` and fails |
| `type` into `<input type=number>` with `abc` | reports the field rejected the value |
| `diff` baseline → click → diff | `added: Roll 1 / removed: Roll 0` |
| `batch` failure counting | `Batch: 1 of 2 step(s) ran … failed: step 2 …` |
| `eval` statements | `const n = …; ({links, doubled})` returned JSON |
| `open new_tab` + `tabs` + `close_tab` | new tab returned with a real URL, listed, focused, closed |
| `screenshot` viewport | 300×367 after `max_width`, image attached |

## Defect found during this campaign

1. **Hover double `mouseenter`** — the first build dispatched synthetic events *and* sent a native mouseMove,
   so a page counter incremented twice (menu could toggle closed). Fixed by making the native pointer the only
   source and using synthetic events only when `sendInputEvent` is unavailable. Re-test: count 1.
2. **Shadow text leaked `<style>`/hidden text** — the first cut used `ShadowRoot.textContent`; switched to a
   visible-text walker that skips style/script/template and zero-size/hidden nodes. Re-test: snapshot text
   contains only the shadow paragraph.
