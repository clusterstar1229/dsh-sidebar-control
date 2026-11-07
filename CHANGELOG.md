# Changelog

## 0.2.1 — 2026-11-08

Live browser-control campaign (90+ actions against the real sidebar Browser; fixture pages, Bing, DeepSeek,
example.com) then fixes. Full evidence: [`test/campaign-0.1.3.md`](test/campaign-0.1.3.md).

### Fixed — correctness

- `select` with an unknown value silently blanked the `<select>` and fired `change`; it now fails with the
  available `value=label` pairs, and matches labels trimmed and case-insensitively.
- `scroll` ignored `selector` (it scrolled by the default amount), `left`/`right` also moved vertically, and a
  no-op was reported as success. It now resolves `ref`/`selector`, scrolls only on the requested axis, and says
  when nothing moved.
- `wait` for a selector matched hidden elements (a closed `<details>` counted as "appeared"); it now requires a
  visible box. The wait is client-driven, so a navigation while waiting no longer kills it.
- `eval` accepted only a single expression and returned an opaque `Script failed to execute` for anything else.
  It now evaluates expressions and statement blocks (`eval` completion value), serialises DOM nodes, functions,
  BigInt and circular objects, and reports parse/runtime errors as readable messages.
- `type` on a non-input threw `Illegal invocation`; number/date/maxlength fields that rejected or truncated the
  text were reported as success. It now rejects unsupported targets, verifies the stored value, and presses
  Enter when the field is not inside a form.
- `click` on an input/textarea did not focus it, so `click` → `press` typed into `<body>`. Clicking a focusable
  field now focuses it, and the click reply names inputs by their label/placeholder instead of `""`.
- `open` could adopt a Browser frame owned by another Session and navigate it; frames are now scoped to the
  current Session, and `open` reports the tab id it actually uses.
- Snapshot ref attributes were never cleared, so a stale ref could hit a different element after a new
  snapshot. They are cleared before every snapshot.
- `focus` / `close_tab` accepted unknown ids and silently did nothing. Both validate against the current
  Session's Browser tabs and explain foreign/unknown ids.
- `tabs` listed other Sessions' tabs (duplicate ids) without context; it now lists this Session's tabs and
  counts hidden ones.
- Checkbox/radio labels showed the value (`"on"`) instead of the associated `<label>` text.
- `batch` steps bypassed host validation (relative URLs failed mid-batch); the host now validates every step
  before running any, the reply says `ran N of M`, and `read`/`diff`/`snapshot` payloads are kept.

### Fixed — robustness

- Long actions looked like disconnections: the client capped every command at 45 s while the host allowed 90 s
  (wait up to 300 s), and a busy page was reported as "no page connected". The client deadline now follows the
  requested timeout, and the host distinguishes busy from disconnected.
- `press` had no modifiers and a partial key table. It now supports `modifiers` (ctrl/alt/shift/meta), maps
  DOM key names to Electron accelerators (`ArrowDown` → `Down`, `Escape` → `Esc`), and no longer runs a second
  synthetic Enter pass that could submit twice.
- Screenshots larger than the bridge body limit are downscaled before sending instead of being dropped.
- `snapshot` hrefs are trimmed to 240 characters (Bing tracking URLs were dominating output).
- `snapshot` with `include_text: false` no longer prints an empty `text:` section; iframes on the page are
  reported as not traversed.

### Added

- `open` accepts `new_tab: true`, `about:blank`, Windows paths, and bare `localhost:port` URLs (treated as
  `http`). `file://` is accepted at the validation layer, but the current desktop Browser refuses to load local
  files; that failure now explains how to serve the file over http instead.
- `press` accepts `modifiers`.
- `screenshot` warns that `full_page` is not supported yet.
- `status` prints the plugin version, so a stale client after an update is obvious.
- `snapshot` / `read` / `diff` now report `N chars ≈ M tokens`, so the cost of a page read is visible in the
  result instead of being guessed.

### Docs

- README: 10-second demo GIF (`docs/demo.gif`), a measured token table, a "Built-in Browser vs this plugin"
  section, a three-column compatibility matrix, and two English plus two Chinese tutorials.
- `test/long-article.html` backs the token table; `test/record-demo.ps1` and `test/build-demo-gif.py` produced
  the demo GIF from a real window capture.

### Compatibility

Tested against DeepSeek Harness Desktop **0.2.2-rc.1** (the current release); `engines.dsh` allows 0.2.x.

## 0.1.3 — 2026-11-07

- First release on npm and GitHub: sidebar Browser control with snapshot refs, click/type/press/select/scroll,
  query-scoped `read` (BM25 over Latin words + CJK bigrams), `diff`, `batch`, multi-tab management, screenshots.

## 0.1.0 – 0.1.2 — 2026-11-07

- First iterations: packaging, MIT license, npm-first install docs and marketplace metadata.

