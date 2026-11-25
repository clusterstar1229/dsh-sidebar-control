# 0.2.3 verification — conversation tab isolation (2026-11-25)

Environment: DeepSeek Harness Desktop **0.2.2-rc.5**, right-Sidebar Browser (`<webview>`), Windows.
Fixtures served at `http://127.0.0.1:8799/`. Several other conversations were live in the same window with
their own Browser tabs, which is exactly the situation the fix targets.

## Provenance

Two independent attempts at the same bug were merged:

1. This branch's first cut — host stamping `exec.agent.id`, `openTabIn`, caller-scoped tab lists, owner
   labels, `prune`, screenshot/eval/status polish.
2. Community PR [#1](https://github.com/clusterstar1229/dsh-sidebar-control/pull/1) by @k99k5 — caller-Session
   plumbing with per-Session frame resolution, `requireSessionOnScreen` guards, v2 poll/result routes, and six
   `node --test` regressions.

The merged code takes the PR's isolation core and keeps the owner labels / `prune` / hints on top.

## The reported problem

With several conversations driving the sidebar, every conversation showed every tab: `open` created tabs in the
Session that was on screen (`sidebarRight.openTab` → `controller.require()` → the **mounted** Session), so a
background conversation's tab appeared in the conversation being read, and tab ids from one conversation were
reachable from another. Nothing in the output said who owned what.

Source evidence (DSH 0.2.2-rc.5, `@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js`):

```js
openTab(kind, options = {}) { const { sessionId, actions } = this.require(); this.placeTab(sessionId, actions, kind, options) }
require() { const sessionId = this.mounted.getSnapshot(); … }          // ← "on screen", not "the caller"
openTabIn(sessionId, kind, options = {}) { const actions = this.actionsFor(sessionId); … }   // ← what we needed
```

## Fix

- Host stamps `sessionId` (`exec.agent.id`) on each command; client stores it while executing.
- `open` → `openTabIn(sessionId, 'browser', { params: { url } })` with a stated fallback.
- `tabs` / `focus` / `close_tab` / `close` resolve through the caller's tabs only.

## Verified live

| Check | Result |
|---|---|
| `status` | `plugin: 0.2.3` · `tabs: 2 in this conversation, 11 in other conversations` |
| `open` into the calling conversation | `Opened https://example.com/ in Browser tab tab96` · `tabs: 3 in this conversation, 11 in other conversations` |
| `tabs` default view | only `[this chat]` rows, plus `(11 more belong to other conversations and are hidden; pass all:true to list them.)` |
| `tabs { all: true }` | 13 rows including `[chat 4a64ae]`, `[chat 28f220]`, `[chat 69ccb9]`, `[chat 28e5f5]`, `[chat 9ebbd9]`, `[chat c9bbda]` + `(11 tab(s) above belong to other conversations; this tool never drives them.)` |
| `close_tab` on another conversation's tab | `No Browser tab "tab2" is open for this Session: it belongs to another conversation (Session session-197c7600-…) and is left alone.` — tab stayed open |
| `close_tab` on own tab | `Closed Browser tab tab97.` — other conversations untouched |
| `tabs { prune: true }` with only uninspectable tabs | `Pruned 0 blank Browser tab(s) of this Session (none were blank). 2 tab(s) remain.` (a tab whose frame is not mounted is never pruned) |
| `tabs` blank/unknown rendering | `(untitled)` for tabs without a readable address, `(blank)` only for a known `about:blank` |
| `snapshot` | `300 chars ≈ 112 tokens` (truncated), correct refs and labels |
| `eval` expression | `document.title` → `"Example Domain"` |
| `eval` throwing script | `Cannot set properties of null (setting 'textContent')` surfaced readably |
| `eval` no return value | `The script ran and returned nothing (null). …` |
| `screenshot` | `Captured the visible Browser page (320×510)` with the image attached |

## Automated regressions (`npm test`)

`test/session-isolation.test.js`, six tests, all passing against the merged code:

```
✔ a background caller only sees and changes its own tabs, even when tab IDs collide
✔ plain open creates a tab in the retained background caller without opening it in the foreground
✔ a missing caller or an unowned frame cannot fall back to the foreground browser
✔ each batch step keeps the original caller when the foreground Session changes
✔ a new tab stays the target when the foreground switches while it loads
✔ revealing a screenshot cannot expand the next Session after a switch
ℹ pass 6  fail 0
```

## Not changed

- Tab persistence, the Sidebar UI itself, and `dsh-better-sidebar` are untouched: this fix only chooses which
  Session a tab is written into and which Session's tabs an action may resolve.
- `focus` on a tab whose conversation is not on screen still refuses (Harness needs a Session switch for that);
  the message names the owner instead of failing silently.

## Notes

- Host and client halves reload independently: the client comes back with a page refresh, the host needs a
  plugin disable/enable or an app restart. Both were exercised here.
- Two bugs were introduced and caught by this campaign, both fixed before the commit: `tabs { prune: true }`
  treated uninspectable tabs (no mounted frame) as blank, and the version string carried the PR branch's
  `0.2.2`.
