import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { apply } from '../index.js'

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function harness(t, { foreground = 'B' } = {}) {
  const routes = new Map()
  let tool
  apply({
    effect: (register) => register(),
    tools: { register: (definition) => { tool = definition } },
    connection: { requestRejection: () => undefined },
    webServer: { register: ({ path, handler }) => routes.set(path, handler) },
    systemPrompt: { section: () => {} },
  })

  const frames = []
  const tabs = []
  const actions = []
  const activeIds = new Map()
  let expanded = true
  function addTab(sessionId, tabId, url) {
    const tab = { sessionId, tabId, kind: 'browser' }
    tabs.push(tab)
    activeIds.set(sessionId, tabId)
    const owner = { getAttribute: () => sessionId }
    const holder = { getAttribute: () => tabId }
    const frame = {
      isConnected: true,
      closest(selector) {
        if (selector === '[data-sidebar-right-session]') return sessionId === undefined ? null : owner
        if (selector === 'div[data-sidebar-right-tab]') return holder
        return sessionId === foreground && expanded ? null : owner
      },
      getURL: () => url,
      getTitle: () => sessionId + ' page',
      getClientRects: () => [{}],
      getBoundingClientRect: () => ({ width: 100, height: 100 }),
      isLoading: () => false,
      async loadURL(next) {
        actions.push(['navigate', sessionId, tabId])
        url = next
      },
      async executeJavaScript(script) {
        if (script === '1') return 1
        if (script === 'document.readyState') return 'complete'
        frame.onScript?.(script)
        return { ok: true, value: url }
      },
    }
    frames.push(frame)
    return frame
  }

  const side = {
    mounted: { getSnapshot: () => foreground },
    openTabs: { getSnapshot: () => tabs },
    active: () => ({ kind: 'browser', id: activeIds.get(foreground) }),
    isExpanded: () => expanded,
    openTab(_kind, { params }) {
      actions.push(['open', foreground])
      addTab(foreground, 'tab2', params.url)
      side.onOpen?.()
    },
    focus(tabId) {
      actions.push(['focus', foreground, tabId])
      activeIds.set(foreground, tabId)
      side.onFocus?.()
    },
    close(tabId) {
      side.closeIn(foreground, tabId)
    },
    closeIn(sessionId, tabId) {
      const index = tabs.findIndex((tab) => tab.sessionId === sessionId && tab.tabId === tabId)
      assert.notEqual(index, -1)
      actions.push(['close', sessionId, tabId])
      tabs.splice(index, 1)
      frames.splice(index, 1)
    },
    toggleExpanded() {
      actions.push(['expand', foreground])
      expanded = !expanded
    },
  }

  function fetch(url, { body, signal }) {
    return new Promise((resolve, reject) => {
      const request = Readable.from([Buffer.from(body)])
      request.method = 'POST'
      const response = new EventEmitter()
      const abort = () => {
        response.destroyed = true
        response.emit('close')
        reject(signal.reason)
      }
      // A poll can be aborted before the route finishes reading its request.
      response.on('newListener', (name) => {
        if (name === 'close' && response.destroyed) queueMicrotask(() => response.emit('close'))
      })
      response.writeHead = (status) => { response.status = status }
      response.end = (body) => {
        signal.removeEventListener('abort', abort)
        response.writableEnded = true
        resolve({ ok: response.status === 200, status: response.status, json: () => JSON.parse(body) })
      }
      signal.addEventListener('abort', abort, { once: true })
      routes.get(url.pathname)(request, response).catch(reject)
    })
  }

  runInNewContext(clientSource, {
    AbortController, URL, console, fetch, setTimeout, clearTimeout,
    document: {
      baseURI: 'http://harness.test/',
      querySelectorAll: () => frames,
      querySelector: () => frames[0] ?? null,
    },
    window: {
      __ModuleLoader__: { load: ({ factory }) => factory().apply({
        get: () => side,
        effect: (start) => t.after(start()),
      }) },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    },
  })

  return {
    actions,
    addTab,
    side,
    show: (sessionId) => { foreground = sessionId },
    collapse: () => { expanded = false },
    call: (sessionId, action, args = {}) => tool.execute(
      { action, timeout_ms: 8000, ...args },
      {
        agent: sessionId === undefined ? undefined : { session: { id: sessionId } },
        signal: new AbortController().signal,
      },
    ),
  }
}

test('a background caller only sees and changes its own tabs, even when tab IDs collide', async (t) => {
  const h = harness(t)
  const b = h.addTab('B', 'tab1', 'https://b.test/')
  const a = h.addTab('A', 'tab1', 'https://a.test/')
  h.addTab('B', 'tab-b', 'https://b.test/extra')
  for (const action of ['status', 'tabs']) {
    const { text } = await h.call('A', action)
    assert.match(text, /https:\/\/a\.test\//)
    assert.doesNotMatch(text, /https:\/\/b\.test\//)
  }
  await h.call('A', 'navigate', { url: '/next' })
  assert.equal(a.getURL(), 'https://a.test/next')
  await assert.rejects(h.call('A', 'close_tab', { tab_id: 'tab-b' }), /No Browser tab/)
  await assert.rejects(h.call('A', 'focus', { tab_id: 'tab1' }), /Bring the calling Harness Session on screen/)
  await assert.rejects(h.call('A', 'open', { url: 'https://a.test/', new_tab: true }), /Bring the calling Harness Session on screen/)
  await assert.rejects(h.call('A', 'screenshot'), /Bring the calling Harness Session on screen/)
  await h.call('A', 'close')
  assert.equal(b.getURL(), 'https://b.test/')
  assert.deepEqual(h.actions, [['navigate', 'A', 'tab1'], ['close', 'A', 'tab1']])
})

test('a missing caller or an unowned frame cannot fall back to the foreground browser', async (t) => {
  const h = harness(t)
  h.addTab(undefined, 'tab1', 'https://unowned.test/')
  h.addTab('B', 'tab1', 'https://b.test/')
  await assert.rejects(h.call(undefined, 'status'), /needs a calling Harness Session/)
  await assert.rejects(h.call('A', 'navigate', { url: 'https://a.test/' }), /No Browser page is available/)
  assert.deepEqual(h.actions, [])
})

test('each batch step keeps the original caller when the foreground Session changes', async (t) => {
  const h = harness(t, { foreground: 'A' })
  const b = h.addTab('B', 'tab1', 'https://b.test/')
  const a = h.addTab('A', 'tab1', 'https://a.test/')
  const scripts = []
  a.onScript = () => {
    scripts.push('A')
    h.show('B')
  }
  b.onScript = () => { scripts.push('B') }
  const { text } = await h.call('A', 'batch', {
    steps: [{ action: 'eval', script: '1' }, { action: 'eval', script: '2' }],
  })
  assert.match(text, /Batch: 2 of 2/)
  assert.deepEqual(scripts, ['A', 'A'])
})

test('a new tab stays the target when the foreground switches while it loads', async (t) => {
  const h = harness(t, { foreground: 'A' })
  const b = h.addTab('B', 'tab2', 'https://b.test/')
  h.addTab('A', 'tab1', 'https://a.test/')
  h.side.onOpen = () => h.show('B')
  const { text } = await h.call('A', 'open', { url: 'https://a.test/new', new_tab: true })
  assert.match(text, /Opened https:\/\/a\.test\/new in Browser tab tab2/)
  assert.doesNotMatch(text, /https:\/\/b\.test\//)
  assert.equal(b.getURL(), 'https://b.test/')
  assert.deepEqual(h.actions, [['open', 'A']])
})

test('revealing a screenshot cannot expand the next Session after a switch', async (t) => {
  const h = harness(t, { foreground: 'A' })
  h.addTab('B', 'tab1', 'https://b.test/')
  h.addTab('A', 'tab1', 'https://a.test/')
  h.collapse()
  h.side.onFocus = () => h.show('B')
  await assert.rejects(h.call('A', 'screenshot'), /Bring the calling Harness Session on screen/)
  assert.deepEqual(h.actions, [['focus', 'A', 'tab1']])
})
