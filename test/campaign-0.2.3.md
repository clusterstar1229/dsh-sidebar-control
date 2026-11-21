# 0.2.3 verification — conversation tab isolation (2026-11-22)

Environment: DeepSeek Harness Desktop **0.2.2-rc.5**, right-Sidebar Browser (`<webview>`), Windows.
Fixtures served at `http://127.0.0.1:8799/`. Several other conversations were live in the same window with
their own Browser tabs, which is exactly the situation the fix targets.

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
| `status` before/after | `callingSession: 7a3c11` · `onScreenSession: 7a3c11` · `tabs: 2 in this conversation, 10 in other conversations` |
| `open` into the calling conversation | `Opened http://127.0.0.1:8799/fixture.html in Browser tab tab94 (in this conversation)` |
| `tabs` default view | 13 rows at first, all labelled `[this chat]`, with the closing note `(10 more belong to other conversations and are hidden; pass all:true to list them.)` |
| `tabs { all: true }` | 12 rows including `[chat 4a64ae]`, `[chat 28f220]`, `[chat 69ccb9]`, `[chat 28e5f5]`, `[chat 9ebbd9]`, `[chat c9bbda]` + `(10 tab(s) above belong to other conversations; this tool never drives them.)` |
| `focus` on another conversation's tab | `Browser tab "tab2" belongs to another conversation (Session session-197c7600-…); it is left alone.` |
| `close_tab` on another conversation's tab | same refusal — the tab stayed open |
| `close_tab` on own tab | `Closed Browser tab tab95.` (the other conversations' tabs were untouched) |
| `tabs { prune: true }` | `Pruned 11 blank Browser tab(s) of this conversation: tab61, tab67, tab72, tab73, tab75, tab81, tab83, tab84, tab86, tab91, tab92` then `2 tab(s) remain.` |
| `tabs { prune: true }` with nothing blank | `Pruned 0 blank Browser tab(s) of this conversation (none were blank).` |
| `tabs` blank rendering | `(blank)` instead of an empty column, plus `(11 blank tab(s) in this conversation; pass prune:true to close them.)` |

## Usability fixes verified

| Check | Result |
|---|---|
| `eval` with no return value | `document.getElementById('inc').click()` → `The script ran and returned nothing (null). Add a value — for example { ok: true } …` |
| `eval` returning a value | same click plus `document.getElementById('roll').textContent` → `"2"` |
| `screenshot` on a visible tab | `Captured the visible Browser page (400×637)` with the image attached |
| `screenshot` on a hidden tab | error text now ends with `Tip: action "snapshot" or "read" works without showing the panel …` |
| `snapshot` after the changes | 11 refs, correct labels (`"I agree"`, `"Fruit"`), size note `400 chars ≈ 100 tokens` |

## Not changed

- Tab persistence, the Sidebar UI itself, and `dsh-better-sidebar` are untouched: this fix only chooses which
  Session a tab is written into and which Session's tabs an action may resolve.
- `focus` on a tab whose conversation is not on screen still refuses (Harness needs a Session switch for that);
  the message now names the owner instead of failing silently.

## Notes

- Host and client halves reload independently: the client comes back with a page refresh, the host needs a
  plugin disable/enable or an app restart. Both were exercised here.
