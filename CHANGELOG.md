# Changelog

## 0.2.3 — 2026-11-25

Tabs are now owned by the conversation that opened them, plus three usability fixes found while testing the
same flows. Live evidence: [`test/campaign-0.2.3.md`](test/campaign-0.2.3.md).

*This release includes the community fix from [#1](https://github.com/clusterstar1229/dsh-sidebar-control/pull/1)
by @k99k5 ("修复侧边栏浏览器跨会话操作的问题"), which brought the caller-Session plumbing, per-Session frame
resolution, on-screen guards and the six `node --test` regression tests. The tab-owner labels, `prune`, the
screenshot hint and the `eval` message below are this release's own work on top of it.*

### Fixed — conversations no longer share one tab strip

- `open` created Browser tabs in **the Session that was on screen**, so a background conversation's tab landed
  in whatever conversation the person was reading, and every conversation's strip filled with everyone else's
  tabs. Tabs are now created inside the calling Session's own layout through `openTabIn(sessionId, …)`.
- The host stamps every command with the calling Session id (`exec.agent.session.id`, falling back to
  `exec.agent.id`), and the client resolves Browser frames per Session, so a command can never fall back to the
  foreground conversation's page.
- `open` works from a background conversation; `focus` and `screenshot` explain that the calling conversation
  has to be on screen rather than silently acting on another one.
- `tabs` lists this conversation's tabs and labels each row `[this chat]` / `[chat 7a3c11]`; `tabs { all: true }`
  additionally lists other conversations read-only, saying explicitly that they are never driven.
- `focus` and `close_tab` resolve through the caller's tab list only: touching another conversation's tab fails
  with `No Browser tab … is open for this Session: it belongs to another conversation (Session …)`.
- `close` closes this conversation's own Browser tab instead of whatever right-Sidebar tab is in front.

### Added

- `tabs { prune: true }` closes the blank tabs (`about:blank`, never loaded) that one conversation accumulated;
  other conversations are untouched. A tab whose frame is not mounted is never pruned, because it cannot be
  inspected.
- `status` reports `tabs: N in this conversation, M in other conversations`, so the isolation can be checked in
  one call.

### Fixed — usability

- A screenshot of a hidden tab used to end in a bare "hidden" error; it now suggests `snapshot` / `read` (which
  need no visible panel) in the same message.
- `eval` printed a bare `null` when a mutation-only script returned nothing; it now says the script ran and
  suggests returning a value.
- `tabs` renders blank tabs as `(blank)` and uninspectable ones as `(untitled)` instead of an empty column.

### Tests

- `npm test` runs `test/session-isolation.test.js`: six simulated regressions covering duplicate tab ids across
  conversations, a background caller, a missing caller, foreground switches mid-batch, a tab loading across a
  switch, and screenshot reveal after a switch.

## 0.2.2 — 2026-11-16

Interaction and layout coverage; live-tested on the real panel (hover/click, open shadow DOM, stitched full
page, single-line reads, relative paths).

### Added

- `hover` (ref|selector) scrolls the element into view and sends a native mouseMove, so CSS `:hover` menus
  open; synthetic events are used only when the native pointer is unavailable. `batch` accepts `hover`.
- `snapshot`, `read`, `click`, `type`, `scroll`, `wait` and `select` now traverse **open shadow roots**; refs
  use a per-snapshot element registry (data attribute as fallback), and shadow text is collected from visible
  nodes only (style/script/hidden nodes skipped).
- `screenshot` gains `full_page` (scrolls viewport tiles, stitches them on a canvas, restores the original
  scroll position, caps at 20,000 px / 30 tiles) and `max_width` (downscales long captures).
- `select` accepts a 0-based `index` as an alternative to value/label.
- `type` accepts `clear: false` to append instead of replacing.
- `open` / `navigate` accept page-relative paths (`/settings`, `./next`, `?q=1`, `#top`) resolved against the
  current page; a relative `open` with no open page explains the problem.
- `read` splits a single-line/minified page into sentence-sized chunks (CJK punctuation included) and, when a
  query matches nothing, returns the page opening with a clear "no passage matched" header.

### Fixed

- Hover could fire `mouseenter` twice (synthetic plus native); the native pointer is now the only source when
  it works.
- Shadow-root text included `<style>` and hidden content; it is filtered to visible text nodes.
- Invalid CSS selectors now fail with "Invalid CSS selector …" in `click`/`type`/`hover`/`scroll` and in
  `wait` (instead of a 5-second timeout).
- Full-page captures are downscaled when the base64 payload would exceed the result body limit.

### Tests

- New fixtures `test/hover.html`, `test/shadow.html`, `test/singleline.html`; the 0.2.2 campaign lives in
  [`test/campaign-0.2.2.md`](test/campaign-0.2.2.md).

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

