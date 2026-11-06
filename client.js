/**
 * Client half of the Sidebar Browser Control bundle.
 *
 * It runs in the Harness page, long-polls the Host half over the private
 * Connection channel, and executes each command against the right-Sidebar
 * Browser frame. On Desktop that frame is an Electron <webview>, so page
 * scripts can be evaluated inside the guest and the visible page can be
 * captured — the Host never gets DOM access itself.
 */

window.__ModuleLoader__.load({
  id: 'dsh-sidebar-control',
  factory(require) {
    const POLL_WAIT_MS = 25000
    const FRAME_SELECTOR = 'webview[data-sidebar-browser-frame]'
    const LIST_LIMIT = 120

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    function safe(read) {
      try {
        return read()
      } catch {
        return undefined
      }
    }

    //#region Guest page helpers — stringified and evaluated inside the Browser frame.
    function pageSnapshot(options) {
      const maxRefs = Number(options.maxRefs) > 0 ? Number(options.maxRefs) : 80
      const maxTextChars = Number(options.maxTextChars) > 0 ? Number(options.maxTextChars) : 12000
      const selector = [
        'a[href]',
        'button',
        'input:not([type="hidden"])',
        'textarea',
        'select',
        'summary',
        '[role="button"]',
        '[role="link"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="option"]',
        '[role="switch"]',
        '[contenteditable="true"]',
      ].join(',')
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) return false
        const style = getComputedStyle(element)
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
      }
      const labelOf = (element) => {
        const raw = element.getAttribute('aria-label')
          || element.getAttribute('title')
          || element.getAttribute('placeholder')
          || element.getAttribute('alt')
          || element.innerText
          || element.value
          || element.getAttribute('name')
          || ''
        return String(raw).replace(/\s+/g, ' ').trim().slice(0, 160)
      }
      const refs = []
      let refsTruncated = false
      const candidates = document.querySelectorAll(selector)
      for (const element of candidates) {
        if (refs.length >= maxRefs) {
          refsTruncated = true
          break
        }
        if (!isVisible(element) || element.disabled === true) continue
        const ref = refs.length + 1
        element.setAttribute('data-dsh-bc-ref', String(ref))
        const tag = element.tagName.toLowerCase()
        const entry = { ref, tag }
        const role = element.getAttribute('role')
        if (role !== null) entry.role = role
        const type = element.getAttribute('type')
        if (type !== null) entry.type = type
        const label = labelOf(element)
        if (label.length > 0) entry.label = label
        if (tag === 'a') {
          const href = element.getAttribute('href')
          if (href !== null) entry.href = String(href).slice(0, 500)
          if (label.length === 0) {
            const image = element.querySelector('img[alt]')
            const alt = image === null ? '' : String(image.getAttribute('alt') || '').replace(/\s+/g, ' ').trim()
            if (alt.length === 0) continue
            entry.label = alt.slice(0, 160)
          }
        }
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          if (element.value !== undefined && element.value !== '') entry.value = String(element.value).slice(0, 300)
          if (element.type === 'checkbox' || element.type === 'radio') entry.checked = element.checked === true
          if (tag === 'select') {
            entry.options = Array.from(element.options).slice(0, 40).map((option) => ({
              value: option.value,
              label: String(option.label || option.text || '').slice(0, 120),
              selected: option.selected === true,
            }))
          }
        }
        refs.push(entry)
      }
      const rawText = document.body === null ? '' : String(document.body.innerText || '')
      const text = rawText.replace(/\n[ \t]+\n/g, '\n\n').replace(/\n{3,}/g, '\n\n').trim()
      return {
        url: String(location.href),
        title: String(document.title || ''),
        readyState: String(document.readyState),
        scroll: {
          x: Math.round(window.scrollX),
          y: Math.round(window.scrollY),
          height: document.documentElement === null ? 0 : document.documentElement.scrollHeight,
        },
        refs,
        refsTruncated,
        text: text.slice(0, maxTextChars),
        textTruncated: text.length > maxTextChars,
      }
    }

    function pageFind(options) {
      if (options.ref !== undefined && options.ref !== null) {
        return document.querySelector('[data-dsh-bc-ref="' + String(options.ref) + '"]')
      }
      if (typeof options.selector === 'string' && options.selector.length > 0) {
        return document.querySelector(options.selector)
      }
      return null
    }

    function pageClick(options) {
      const element = pageFind(options)
      if (element === null) {
        throw new Error(options.ref !== undefined
          ? 'No element has ref ' + String(options.ref) + ' on this page; take a new snapshot.'
          : 'No element matches selector ' + String(options.selector) + '.')
      }
      const label = String(element.innerText || element.getAttribute('aria-label') || element.getAttribute('title') || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)
      element.scrollIntoView({ block: 'center', inline: 'center' })
      const target = element.closest('a,button,label,summary,[role="button"],[role="link"]') || element
      target.click()
      return { clicked: { tag: target.tagName.toLowerCase(), label }, url: String(location.href) }
    }

    function pageType(options) {
      const element = pageFind(options)
      if (element === null) {
        throw new Error(options.ref !== undefined
          ? 'No element has ref ' + String(options.ref) + ' on this page; take a new snapshot.'
          : 'No element matches selector ' + String(options.selector) + '.')
      }
      const text = String(options.text)
      element.scrollIntoView({ block: 'center' })
      if (typeof element.focus === 'function') element.focus()
      if (element.isContentEditable === true) {
        element.textContent = text
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
      } else {
        const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')
        if (setter !== undefined && typeof setter.set === 'function') setter.set.call(element, text)
        else element.value = text
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
      }
      if (options.submit === true) {
        if (element.form !== null && element.form !== undefined && typeof element.form.requestSubmit === 'function') element.form.requestSubmit()
        else element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
      }
      return { typed: text.length, target: element.tagName.toLowerCase(), url: String(location.href) }
    }

    function pagePress(options) {
      const key = String(options.key)
      const target = document.activeElement || document.body
      const keyCode = key === 'Enter' ? 13
        : key === 'Tab' ? 9
          : key === 'Escape' ? 27
            : key === 'ArrowDown' ? 40
              : key === 'ArrowUp' ? 38
                : key === 'ArrowLeft' ? 37
                  : key === 'ArrowRight' ? 39
                    : key === ' ' || key === 'Space' ? 32
                      : 0
      const init = { key, code: key === ' ' ? 'Space' : key, keyCode, which: keyCode, bubbles: true, cancelable: true }
      target.dispatchEvent(new KeyboardEvent('keydown', init))
      target.dispatchEvent(new KeyboardEvent('keyup', init))
      if (key === 'Enter' && target.form !== null && target.form !== undefined && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        try {
          target.form.requestSubmit()
        } catch {
          // A form without a submitter still keeps the dispatched key event.
        }
      }
      return { pressed: key, active: target === null ? 'body' : target.tagName.toLowerCase() }
    }

    function pageSelect(options) {
      const element = pageFind(options)
      if (element === null) throw new Error('No select element matches the given ref or selector.')
      if (element.tagName !== 'SELECT') throw new Error('The target element is <' + element.tagName.toLowerCase() + '>, not a <select>.')
      const value = String(options.value)
      element.value = value
      if (element.value !== value) {
        const option = Array.from(element.options).find((candidate) => candidate.text === value || candidate.label === value)
        if (option !== undefined) element.value = option.value
      }
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return { value: element.value, selectedIndex: element.selectedIndex }
    }

    function pageScroll(options) {
      if (options.ref !== undefined && options.ref !== null) {
        const element = pageFind(options)
        if (element === null) throw new Error('No element has ref ' + String(options.ref) + '; take a new snapshot.')
        element.scrollIntoView({ block: 'center' })
        return { scrolledTo: { ref: options.ref }, y: Math.round(window.scrollY) }
      }
      const amount = Number(options.amount) > 0 ? Number(options.amount) : 600
      const direction = String(options.direction || 'down')
      const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0
      const dy = direction === 'up' ? -amount : amount
      window.scrollBy({ left: dx, top: dy, behavior: 'instant' })
      return { x: Math.round(window.scrollX), y: Math.round(window.scrollY) }
    }

    async function pageWait(options) {
      const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (typeof options.selector === 'string' && options.selector.length > 0) {
          if (document.querySelector(options.selector) !== null) return { found: true, kind: 'selector', selector: options.selector }
        } else if (typeof options.text === 'string' && options.text.length > 0) {
          const bodyText = document.body === null ? '' : String(document.body.innerText || '')
          if (bodyText.includes(options.text)) return { found: true, kind: 'text', text: options.text }
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      throw new Error('Timed out after ' + String(timeoutMs) + 'ms waiting for '
        + (typeof options.selector === 'string' && options.selector.length > 0 ? 'selector ' + options.selector : 'text ' + String(options.text)) + '.')
    }

    /**
     * Read the page the way a person answers a question: split it into
     * paragraphs and return only the ones that match the query (BM25 over
     * Latin words and CJK bigrams). On a long article this is a fraction of a
     * full snapshot; with no query it is the plain text.
     */
    function pageRead(options) {
      const tokenize = (value) => {
        const text = String(value || '').toLowerCase()
        const out = []
        const latin = text.match(/[a-z0-9_]+/g) || []
        for (const word of latin) out.push(word)
        const cjk = text.match(/[\u4e00-\u9fff]+/g) || []
        for (const run of cjk) {
          if (run.length === 1) out.push(run)
          for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2))
        }
        return out
      }
      const query = String(options.query || '').trim()
      const budget = Number(options.maxChars) > 0 ? Math.min(Number(options.maxChars), 20000) : 4000
      const raw = document.body === null ? '' : String(document.body.innerText || '')
      const paragraphs = raw.split(/\n{2,}/)
        .map((part) => part.replace(/[ \t]+/g, ' ').trim())
        .filter((part) => part.length > 0)
        .slice(0, 800)
      const whole = paragraphs.join('\n\n')
      if (query === '') {
        return {
          url: String(location.href),
          title: String(document.title || ''),
          mode: 'text',
          text: whole.slice(0, budget),
          truncated: whole.length > budget,
          matched: null,
          candidates: paragraphs.length,
        }
      }
      const terms = tokenize(query)
      const docs = paragraphs.map((part) => tokenize(part))
      const df = new Map()
      for (const doc of docs) for (const term of new Set(doc)) df.set(term, (df.get(term) || 0) + 1)
      const count = docs.length || 1
      const avg = docs.reduce((sum, doc) => sum + doc.length, 0) / count || 1
      const scored = []
      for (let i = 0; i < docs.length; i += 1) {
        const doc = docs[i]
        if (doc.length === 0) continue
        const tf = new Map()
        for (const term of doc) tf.set(term, (tf.get(term) || 0) + 1)
        let score = 0
        for (const term of terms) {
          const frequency = tf.get(term) || 0
          if (frequency === 0) continue
          const idf = Math.log(1 + (count - (df.get(term) || 0) + 0.5) / ((df.get(term) || 0) + 0.5))
          score += idf * (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * doc.length / avg))
        }
        if (score > 0) scored.push({ index: i, score })
      }
      scored.sort((left, right) => right.score - left.score)
      const picked = []
      let used = 0
      for (const hit of scored) {
        const paragraph = paragraphs[hit.index]
        if (used + paragraph.length > budget && picked.length > 0) continue
        picked.push(hit.index)
        used += paragraph.length
        if (used >= budget) break
      }
      picked.sort((left, right) => left - right)
      return {
        url: String(location.href),
        title: String(document.title || ''),
        mode: 'query',
        query,
        matched: picked.length,
        candidates: scored.length,
        text: picked.map((index) => paragraphs[index]).join('\n\n').slice(0, budget),
        truncated: scored.length > picked.length,
      }
    }

    /**
     * Compare the page with the previous diff (paragraph sets): what appeared
     * and what disappeared since the last call, instead of the whole page.
     */
    function pageDiff(options) {
      const budget = Number(options.maxChars) > 0 ? Math.min(Number(options.maxChars), 20000) : 4000
      const raw = document.body === null ? '' : String(document.body.innerText || '')
      const paragraphs = raw.split(/\n{2,}/)
        .map((part) => part.replace(/[ \t]+/g, ' ').trim())
        .filter((part) => part.length > 0)
        .slice(0, 800)
      const previous = Array.isArray(window.__dshScParagraphs) ? window.__dshScParagraphs : []
      const prevSet = new Set(previous)
      const nextSet = new Set(paragraphs)
      const added = []
      const removed = []
      for (const part of paragraphs) {
        if (prevSet.has(part) !== true) added.push(part.slice(0, 300))
        if (added.length >= 40) break
      }
      for (const part of previous) {
        if (nextSet.has(part) !== true) removed.push(part.slice(0, 300))
        if (removed.length >= 40) break
      }
      window.__dshScParagraphs = paragraphs
      let text = ''
      if (added.length > 0) text += 'added:\n+ ' + added.join('\n+ ') + '\n'
      if (removed.length > 0) text += (text === '' ? '' : '\n') + 'removed:\n- ' + removed.join('\n- ') + '\n'
      return {
        url: String(location.href),
        title: String(document.title || ''),
        first: previous.length === 0,
        changed: added.length > 0 || removed.length > 0,
        added,
        removed,
        text: text.slice(0, budget),
      }
    }
    //#endregion

    function frameIsVisible(element) {
      try {
        if (element.isConnected !== true) return false
        if (element.closest('[hidden], [aria-hidden="true"], [inert]') !== null) return false
        if (element.getClientRects().length === 0) return false
        const rect = element.getBoundingClientRect()
        if (rect.width < 2 || rect.height < 2) return false
        const style = window.getComputedStyle(element)
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
      } catch {
        return false
      }
    }

    function browserFrames() {
      return Array.from(document.querySelectorAll(FRAME_SELECTOR))
    }

    function activeBrowserTab(ctx) {
      const sidebarRight = sidebarRightOf(ctx)
      if (sidebarRight === undefined || sidebarRight === null || typeof sidebarRight.active !== 'function') return undefined
      const tab = safe(() => sidebarRight.active())
      if (tab === undefined || tab === null || tab.kind !== 'browser') return undefined
      return tab
    }

    function frameForTab(tab) {
      if (tab === undefined || tab === null || tab.id === undefined || tab.id === null) return undefined
      const escape = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(String(tab.id)) : String(tab.id)
      return document.querySelector('div[data-sidebar-right-tab="' + escape + '"] ' + FRAME_SELECTOR)
        || undefined
    }

    function pickFrame(state, ctx) {
      const tab = activeBrowserTab(ctx)
      if (tab !== undefined) {
        const exact = frameForTab(tab)
        if (exact !== undefined) return exact
      }
      const frames = browserFrames()
      if (frames.length === 0) return undefined
      const visibleFrames = frames.filter(frameIsVisible)
      if (state.last !== undefined && state.last.isConnected === true && visibleFrames.includes(state.last)) return state.last
      if (visibleFrames.length > 0) return visibleFrames[visibleFrames.length - 1]
      if (state.last !== undefined && state.last.isConnected === true) return state.last
      return frames[frames.length - 1]
    }

    async function frameReady(frame, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      let lastError
      while (Date.now() < deadline) {
        try {
          if (frame.isConnected === false) throw new Error('the Browser tab was closed')
          const ping = await frame.executeJavaScript('1', true)
          if (ping === 1) return true
        } catch (error) {
          lastError = error
        }
        await sleep(150)
      }
      throw new Error('The Browser frame is not ready'
        + (lastError instanceof Error && lastError.message ? ': ' + lastError.message : '. Open or reload the Browser tab and retry.'))
    }

    function sidebarRightOf(ctx) {
      if (typeof ctx.get === 'function') return ctx.get('sidebarRight')
      return ctx.sidebarRight
    }

    async function openBrowserTab(ctx, url) {
      const sidebarRight = sidebarRightOf(ctx)
      if (sidebarRight === undefined || sidebarRight === null) {
        throw new Error('The right Sidebar is unavailable in this Harness page, so a Browser tab cannot be opened (Desktop app required for Browser control).')
      }
      try {
        sidebarRight.openTab('browser', { params: { url } })
      } catch (error) {
        throw new Error('Could not open the right-Sidebar Browser: ' + (error instanceof Error ? error.message : String(error)))
      }
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const tab = activeBrowserTab(ctx)
        const frame = (tab === undefined ? undefined : frameForTab(tab))
          || browserFrames().filter(frameIsVisible)[0]
          || browserFrames()[0]
        if (frame !== undefined) return frame
        await sleep(150)
      }
      throw new Error('The Browser tab was requested but no Browser frame appeared. Check that the right Sidebar Browser is enabled in this Harness build.')
    }

    async function settleActiveFrame(state, ctx, fallback) {
      let frame = pickFrame(state, ctx) || fallback
      if (frame === undefined) return undefined
      await frameReady(frame, 15000)
      await waitForHttpPage(frame, 30000)
      const latest = pickFrame(state, ctx)
      if (latest !== undefined && latest !== frame) {
        // The dock re-created the tab body while loading (new occurrence/lease).
        frame = latest
        await frameReady(frame, 15000)
        await waitForHttpPage(frame, 30000)
      }
      state.last = frame
      return frame
    }

    async function activeFrame(state, ctx, options) {
      let frame = pickFrame(state, ctx)
      if (frame === undefined && options.openUrl !== undefined) frame = await openBrowserTab(ctx, options.openUrl)
      if (frame === undefined) {
        throw new Error('No Browser tab is open in the right Sidebar. Call the browser tool with action "open" and a url first.')
      }
      await frameReady(frame, options.readyTimeoutMs === undefined ? 15000 : options.readyTimeoutMs)
      state.last = frame
      return frame
    }

    function tabIdOfFrame(frame) {
      const holder = frame.closest('div[data-sidebar-right-tab]')
      if (holder === null) return undefined
      return holder.getAttribute('data-sidebar-right-tab') || undefined
    }

    function frameTabInfo(ctx, frame) {
      const tabId = tabIdOfFrame(frame)
      const holder = frame.closest('[data-sidebar-right-session]')
      const frameSession = holder === null ? undefined : holder.getAttribute('data-sidebar-right-session') || undefined
      const fallback = { same: true, tabId, browserTab: undefined, current: undefined, frameSession }
      const sidebarRight = sidebarRightOf(ctx)
      if (sidebarRight === undefined || sidebarRight === null) return fallback
      const mounted = safe(() => sidebarRight.mounted?.getSnapshot())
      const current = safe(() => sidebarRight.focusedTarget?.())
      const tabs = safe(() => sidebarRight.openTabs?.getSnapshot())
      const currentSession = (current === undefined || current === null ? undefined : current.sessionId) ?? mounted
      const same = currentSession === undefined || frameSession === undefined ? true : frameSession === currentSession
      let browserTab
      if (Array.isArray(tabs)) {
        const candidates = tabs.filter((tab) => tab.kind === 'browser' && tab.tabId === tabId)
        browserTab = candidates.find((tab) => tab.sessionId === currentSession) || candidates[candidates.length - 1]
      }
      return { same, tabId, browserTab, current, frameSession }
    }

    /** Bring the frame into the visible, expanded right Sidebar so capturePage is not blank. */
    async function revealFrame(ctx, frame) {
      if (frameIsVisible(frame)) return
      const sidebarRight = sidebarRightOf(ctx)
      const info = frameTabInfo(ctx, frame)
      if (!info.same) {
        throw new Error('The Browser page belongs to another Session than the one on screen, so it cannot be shown or captured here. '
          + 'Bring that Session on screen, or call action "open" to open the page in the current Session.')
      }
      const tabId = info.tabId
      if (sidebarRight !== undefined && sidebarRight !== null && tabId !== undefined && typeof sidebarRight.focus === 'function') {
        try {
          sidebarRight.focus(tabId)
        } catch {
          // Focus is best-effort; expansion below still runs.
        }
        const deadline = Date.now() + 2000
        while (Date.now() < deadline && !frameIsVisible(frame)) await sleep(100)
      }
      if (frameIsVisible(frame)) return
      if (sidebarRight !== undefined && sidebarRight !== null
        && safe(() => sidebarRight.isExpanded()) !== true
        && typeof sidebarRight.toggleExpanded === 'function') {
        try {
          sidebarRight.toggleExpanded()
        } catch (error) {
          throw new Error('The Browser tab is hidden and the right Sidebar could not be expanded: '
            + (error instanceof Error ? error.message : String(error)))
        }
        const deadline = Date.now() + 3000
        while (Date.now() < deadline && !frameIsVisible(frame)) await sleep(100)
      }
      if (!frameIsVisible(frame)) {
        const active = safe(() => sidebarRight?.active())
        throw new Error('The Browser tab is hidden (collapsed, inert, or another tab is in front), so a screenshot would be blank.'
          + (active === undefined ? '' : ' Active right-Sidebar tab: ' + String(active.kind) + ' ' + String(active.id) + '.')
          + ' Open the Browser panel visibly, then retry.')
      }
    }

    /**
     * Make a frame capturable. When the frame is hidden behind another right-Sidebar
     * tab (or belongs to a Session that is no longer on screen), reopen the same page
     * in a fresh Browser tab of the on-screen Session so the capture is never blank.
     */
    async function ensureScreenshotFrame(state, ctx, frame) {
      try {
        await revealFrame(ctx, frame)
        return frame
      } catch (error) {
        const url = String(safe(() => frame.getURL()) || '')
        if (!/^https?:/i.test(url)) throw error
        let fresh
        try {
          await openBrowserTab(ctx, url)
          fresh = await settleActiveFrame(state, ctx, undefined)
        } catch {
          throw error
        }
        if (fresh === undefined) throw error
        await revealFrame(ctx, fresh)
        return fresh
      }
    }

    function runPage(frame, fn, args) {
      const code = '(async () => { try {'
        + ' const pageFind = ' + pageFind.toString() + ';'
        + ' const value = await (' + fn.toString() + ')(' + JSON.stringify(args === undefined ? {} : args) + ');'
        + ' return value === undefined ? null : value;'
        + ' } catch (error) { return { __dshError: error && error.message ? String(error.message) : String(error) } } })()'
      return frame.executeJavaScript(code, true).then((value) => {
        if (value !== null && typeof value === 'object' && typeof value.__dshError === 'string') {
          throw new Error(value.__dshError)
        }
        return value
      })
    }

    async function waitForHttpPage(frame, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const url = safe(() => frame.getURL())
        if (typeof url === 'string' && /^https?:/i.test(url) && safe(() => frame.isLoading()) !== true) {
          const state = await safe(() => frame.executeJavaScript('document.readyState', true))
          if (state === 'complete' || state === 'interactive') return url
        }
        await sleep(150)
      }
      return safe(() => frame.getURL())
    }

    async function isLoading(frame) {
      try {
        return frame.isLoading() === true
      } catch {
        return false
      }
    }

    function sendKey(frame, key) {
      try {
        frame.focus()
        frame.sendInputEvent({ type: 'keyDown', keyCode: key })
        if (key.length === 1) frame.sendInputEvent({ type: 'char', keyCode: key })
        frame.sendInputEvent({ type: 'keyUp', keyCode: key })
        return 'native'
      } catch {
        return 'dom'
      }
    }

    async function settle(frame, quietMs, waitStartMs) {
      const start = Date.now()
      await sleep(quietMs)
      const startWindow = waitStartMs === undefined ? 1500 : waitStartMs
      let sawLoading = await isLoading(frame)
      while (Date.now() - start < 15000) {
        const loading = await isLoading(frame)
        if (loading) sawLoading = true
        else if (sawLoading || Date.now() - start > quietMs + startWindow) break
        await sleep(120)
      }
      await sleep(150)
    }

    async function navigateTo(frame, url) {
      try {
        await frame.loadURL(url)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/ERR_ABORTED/.test(message)) throw new Error('Navigation to ' + url + ' failed: ' + message)
      }
      await settle(frame, 150)
      await frameReady(frame, 10000)
    }

    function formatSnapshot(snapshot) {
      const lines = []
      lines.push('url: ' + snapshot.url)
      lines.push('title: ' + (snapshot.title.length > 0 ? snapshot.title : '(untitled)'))
      lines.push('scroll: y=' + String(snapshot.scroll.y) + ' pageHeight=' + String(snapshot.scroll.height))
      lines.push('refs: ' + String(snapshot.refs.length) + (snapshot.refsTruncated ? ' (truncated; refine with eval or selector)' : ''))
      for (const ref of snapshot.refs) {
        const details = []
        if (ref.role !== undefined && ref.role !== '') details.push('role=' + ref.role)
        if (ref.type !== undefined && ref.type !== '') details.push('type=' + ref.type)
        if (ref.value !== undefined && ref.value !== '') details.push('value=' + JSON.stringify(ref.value))
        if (ref.checked !== undefined) details.push('checked=' + String(ref.checked))
        if (ref.label !== undefined && ref.label !== '') details.push(JSON.stringify(ref.label))
        if (ref.href !== undefined) details.push('-> ' + ref.href)
        if (ref.options !== undefined) {
          const shown = ref.options.slice(0, 8).map((option) => option.value + (option.selected ? '*' : ''))
          details.push('options[' + String(ref.options.length) + ']=' + shown.join('|') + (ref.options.length > 8 ? '|...' : ''))
        }
        lines.push('#' + String(ref.ref) + ' <' + ref.tag + '> ' + details.join(' '))
      }
      if (snapshot.refs.length === 0) lines.push('(no visible interactive elements)')
      lines.push('')
      lines.push('text:')
      lines.push(snapshot.text.length > 0 ? snapshot.text : '(empty page text)')
      if (snapshot.textTruncated) lines.push('(text truncated; use eval to read a specific region)')
      return lines.join('\n')
    }

    function statusText(ctx) {
      const frames = browserFrames()
      const sidebarRight = sidebarRightOf(ctx)
      const lines = []
      lines.push('platform: ' + (globalThis.dshDesktop === undefined ? 'web' : 'desktop'))
      lines.push('browserFrames: ' + String(frames.length))
      let activeTab
      if (sidebarRight !== undefined && sidebarRight !== null && typeof sidebarRight.active === 'function') {
        const tab = safe(() => sidebarRight.active())
        if (tab !== undefined && tab !== null) {
          activeTab = { id: tab.id, kind: tab.kind, title: tab.title }
          lines.push('activeTab: ' + JSON.stringify(activeTab))
          lines.push('rightbarExpanded: ' + String(safe(() => sidebarRight.isExpanded()) === true))
        }
      }
      frames.forEach((frame, index) => {
        const info = frameTabInfo(ctx, frame)
        lines.push('frame[' + String(index) + '] visible=' + String(frameIsVisible(frame))
          + ' url=' + String(safe(() => frame.getURL()) || '(unknown)')
          + ' title=' + JSON.stringify(String(safe(() => frame.getTitle()) || ''))
          + ' loading=' + String(safe(() => frame.isLoading()) === true)
          + (info.same ? '' : ' (Session ' + String(info.frameSession) + ' is not the one on screen)'))
      })
      if (frames.length === 0) lines.push('No Browser frame is mounted. Use action "open" with a url to create the tab.')
      return lines.join('\n')
    }

    async function capture(frame) {
      if (typeof frame.capturePage !== 'function') throw new Error('This Harness build does not expose capturePage on the Browser frame.')
      const image = await frame.capturePage()
      if (image === undefined || image === null) throw new Error('The Browser frame returned no screenshot.')
      if (typeof image.isEmpty === 'function' && image.isEmpty()) throw new Error('The Browser frame returned an empty screenshot.')
      const dataUrl = String(image.toDataURL())
      const prefix = 'data:image/png;base64,'
      if (!dataUrl.startsWith(prefix)) throw new Error('The screenshot used an unexpected encoding.')
      const size = typeof image.getSize === 'function' ? image.getSize() : { width: 0, height: 0 }
      return { base64: dataUrl.slice(prefix.length), width: size.width, height: size.height }
    }

    async function executeCommand(state, command) {
      const action = String(command.action)
      const args = command.args !== null && typeof command.args === 'object' ? command.args : {}
      const ctx = state.ctx

      if (action === 'status') return { text: statusText(ctx) }

      if (action === 'open') {
        const url = String(args.url || '')
        let frame = pickFrame(state, ctx)
        let visible = frame !== undefined
        if (frame !== undefined) {
          await frameReady(frame, 15000)
          await navigateTo(frame, url)
          try {
            await revealFrame(ctx, frame)
          } catch {
            visible = false
          }
        }
        if (!visible) {
          await openBrowserTab(ctx, url)
          const settled = await settleActiveFrame(state, ctx, undefined)
          if (settled === undefined) throw new Error('The Browser tab was requested but no Browser frame appeared.')
          frame = settled
        }
        state.last = frame
        return { text: 'Opened ' + url + '\n' + statusText(ctx) }
      }

      const frame = await activeFrame(state, ctx, {})

      switch (action) {
        case 'navigate': {
          const url = String(args.url || '')
          await navigateTo(frame, url)
          return { text: 'Navigated to ' + url + '\n' + statusText(ctx) }
        }
        case 'back': {
          if (safe(() => frame.canGoBack()) !== true) throw new Error('The Browser tab has no back history.')
          safe(() => frame.goBack())
          await settle(frame, 200)
          await frameReady(frame, 10000)
          return { text: 'Went back.\n' + statusText(ctx) }
        }
        case 'forward': {
          if (safe(() => frame.canGoForward()) !== true) throw new Error('The Browser tab has no forward history.')
          safe(() => frame.goForward())
          await settle(frame, 200)
          await frameReady(frame, 10000)
          return { text: 'Went forward.\n' + statusText(ctx) }
        }
        case 'reload': {
          safe(() => frame.reload())
          await settle(frame, 250)
          await frameReady(frame, 15000)
          return { text: 'Reloaded the page.\n' + statusText(ctx) }
        }
        case 'snapshot': {
          const snapshot = await runPage(frame, pageSnapshot, {
            maxRefs: Number(args.max_refs) > 0 ? Math.min(Number(args.max_refs), LIST_LIMIT) : 80,
            maxTextChars: Number(args.max_text_chars) > 0 ? Number(args.max_text_chars) : 12000,
          })
          return { text: formatSnapshot(snapshot) }
        }
        case 'read': {
          const result = await runPage(frame, pageRead, {
            query: args.query,
            maxChars: Number(args.max_chars) > 0 ? Number(args.max_chars) : 4000,
          })
          const header = result.mode === 'query'
            ? 'Read ' + String(result.matched) + ' of ' + String(result.candidates) + ' matching passage(s) for ' + JSON.stringify(String(result.query)) + '.'
            : 'Read the visible text.'
          return {
            text: header + '\n' + String(result.url) + '\n# ' + String(result.title)
              + '\n\n' + String(result.text) + (result.truncated === true ? '\n…(truncated)' : ''),
          }
        }
        case 'diff': {
          const result = await runPage(frame, pageDiff, { maxChars: Number(args.max_chars) > 0 ? Number(args.max_chars) : 4000 })
          if (result.first === true) {
            return { text: 'First diff: this page is the baseline now. Run "diff" again after an action to see what changed.\n' + String(result.url) }
          }
          return {
            text: (result.changed === true ? 'Changed since the previous diff.' : 'No visible change since the previous diff.')
              + '\n' + String(result.url) + '\n# ' + String(result.title)
              + (String(result.text).length > 0 ? '\n\n' + String(result.text) : ''),
          }
        }
        case 'tabs': {
          const side = sidebarRightOf(ctx)
          if (side === undefined || side === null) throw new Error('The right Sidebar is unavailable in this Harness page.')
          const open = safe(() => side.openTabs?.getSnapshot())
          const active = safe(() => side.active())
          const rows = (Array.isArray(open) ? open : []).filter((tab) => tab.kind === 'browser')
          if (rows.length === 0) return { text: 'No Browser tab is open. Use action "open" with a url.' }
          const lines = rows.map((tab) => {
            const mark = active !== undefined && active !== null && active.id === tab.id ? '*' : ' '
            return mark + ' ' + String(tab.id) + '  ' + String(tab.title || '') + '  ' + String(tab.url || '')
          })
          return { text: 'Browser tabs (' + String(rows.length) + ', * = active):\n' + lines.join('\n') }
        }
        case 'focus': {
          const side = sidebarRightOf(ctx)
          if (side === undefined || side === null) throw new Error('The right Sidebar is unavailable in this Harness page.')
          side.focus(String(args.tab_id))
          await sleep(250)
          return { text: 'Focused Browser tab ' + String(args.tab_id) + '.\n' + statusText(ctx) }
        }
        case 'close_tab': {
          const side = sidebarRightOf(ctx)
          if (side === undefined || side === null) throw new Error('The right Sidebar is unavailable in this Harness page.')
          side.close(String(args.tab_id))
          state.last = undefined
          return { text: 'Closed Browser tab ' + String(args.tab_id) + '.' }
        }
        case 'click': {
          const outcome = await runPage(frame, pageClick, { ref: args.ref, selector: args.selector })
          await settle(frame, 350, 4500)
          return {
            text: 'Clicked <' + outcome.clicked.tag + '> ' + JSON.stringify(outcome.clicked.label)
              + '\nurl: ' + String(safe(() => frame.getURL()) || outcome.url)
              + '\ntitle: ' + JSON.stringify(String(safe(() => frame.getTitle()) || ''))
              + '\nTake a new snapshot before the next ref-based action.',
          }
        }
        case 'type': {
          const outcome = await runPage(frame, pageType, { ref: args.ref, selector: args.selector, text: args.text, submit: args.submit === true })
          await settle(frame, 300, 4500)
          return {
            text: 'Typed ' + String(outcome.typed) + ' characters into <' + outcome.target + '>.'
              + (args.submit === true ? ' Submitted the form.' : '')
              + '\nurl: ' + String(safe(() => frame.getURL()) || outcome.url)
              + '\ntitle: ' + JSON.stringify(String(safe(() => frame.getTitle()) || '')),
          }
        }
        case 'press': {
          const key = String(args.key)
          if (sendKey(frame, key) === 'dom') {
            const outcome = await runPage(frame, pagePress, { key })
            await settle(frame, 300, 4500)
            return { text: 'Pressed ' + JSON.stringify(outcome.pressed) + ' on <' + outcome.active + '> (DOM event fallback).' }
          }
          if (key === 'Enter' || key === ' ' || key === 'Space') {
            // Native key events drive page handlers; the DOM pass also submits a
            // focused form when the guest swallowed the native default action.
            try {
              await runPage(frame, pagePress, { key })
            } catch {
              // The guest may already be navigating.
            }
          }
          await settle(frame, 300, 4500)
          return {
            text: 'Pressed ' + JSON.stringify(key) + '.'
              + '\nurl: ' + String(safe(() => frame.getURL()) || '')
              + '\ntitle: ' + JSON.stringify(String(safe(() => frame.getTitle()) || '')),
          }
        }
        case 'select': {
          const outcome = await runPage(frame, pageSelect, { ref: args.ref, selector: args.selector, value: args.value })
          await settle(frame, 250)
          return { text: 'Selected value ' + JSON.stringify(outcome.value) + ' (index ' + String(outcome.selectedIndex) + ').'
            + '\ntitle: ' + JSON.stringify(String(safe(() => frame.getTitle()) || '')) }
        }
        case 'scroll': {
          const outcome = await runPage(frame, pageScroll, {
            ref: args.ref,
            selector: args.selector,
            direction: args.direction,
            amount: args.amount,
          })
          return { text: 'Scrolled to y=' + String(outcome.y === undefined ? '?' : outcome.y) }
        }
        case 'wait': {
          const outcome = await runPage(frame, pageWait, {
            selector: args.selector,
            text: args.text,
            timeoutMs: Number(args.timeout_ms) > 0 ? Number(args.timeout_ms) : 5000,
          })
          return { text: 'Appeared: ' + JSON.stringify(outcome) }
        }
        case 'eval': {
          const script = String(args.script)
          const code = '(async () => { const value = (' + script + '); const resolved = await value;'
            + ' try { return JSON.parse(JSON.stringify(resolved === undefined ? null : resolved)) } catch { return String(resolved) } })()'
          const value = await frame.executeJavaScript(code, true)
          const text = JSON.stringify(value, null, 2)
          return { text: text.length > 20000 ? text.slice(0, 20000) + '\n(truncated)' : text }
        }
        case 'screenshot': {
          let image
          let firstError
          for (let attempt = 0; attempt < 2 && image === undefined; attempt++) {
            try {
              const target = await ensureScreenshotFrame(state, ctx, frame)
              image = await capture(target)
            } catch (error) {
              if (firstError === undefined) firstError = error
              if (attempt === 0) await sleep(400)
            }
          }
          if (image === undefined) throw firstError instanceof Error ? firstError : new Error('The screenshot could not be captured.')
          const text = 'Captured the visible Browser page.\n' + statusText(ctx)
          return { text, png: image }
        }
        case 'close': {
          const sidebarRight = sidebarRightOf(ctx)
          if (sidebarRight === undefined || sidebarRight === null) throw new Error('The right Sidebar is unavailable in this Harness page.')
          const tab = safe(() => sidebarRight.active())
          if (tab !== undefined && tab !== null && tab.kind === 'browser' && tab.id !== undefined && tab.id !== null) {
            sidebarRight.close(tab.id)
            state.last = undefined
            return { text: 'Closed Browser tab ' + String(tab.id) + '.' }
          }
          // The Browser tab may sit behind another tab or in a Session that is no longer
          // on screen; close the tab that owns our frame instead of the visible one.
          const frame = pickFrame(state, ctx)
          const info = frame === undefined ? undefined : frameTabInfo(ctx, frame)
          if (info !== undefined && info.frameSession !== undefined && info.tabId !== undefined
            && typeof sidebarRight.closeIn === 'function') {
            try {
              sidebarRight.closeIn(info.frameSession, info.tabId)
              state.last = undefined
              return { text: 'Closed Browser tab ' + String(info.tabId) + '.' }
            } catch (error) {
              throw new Error('Could not close the Browser tab: ' + (error instanceof Error ? error.message : String(error)))
            }
          }
          if (tab !== undefined && tab !== null) throw new Error('The active right-Sidebar tab is "' + String(tab.kind) + '", not a Browser tab.')
          throw new Error('There is no active right-Sidebar tab to close.')
        }
        default:
          throw new Error('Unsupported browser action ' + JSON.stringify(action) + '.')
      }
    }

    function randomInstanceId() {
      try {
        return 'page-' + crypto.randomUUID()
      } catch {
        return 'page-' + String(Date.now()) + '-' + String(Math.random()).slice(2)
      }
    }

    function apply(ctx) {
      const state = { ctx, last: undefined, running: true }

      async function post(name, payload, signal) {
        const url = new URL('sidebar-browser-control/' + name, document.baseURI)
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload === undefined ? {} : payload),
          credentials: 'same-origin',
          signal,
        })
        if (response.ok !== true) throw new Error('Sidebar Browser Control request failed: HTTP ' + String(response.status))
        return await response.json()
      }

      async function loop(signal) {
        const instance = randomInstanceId()
        while (state.running === true && signal.aborted === false) {
          try {
            const outcome = await post('poll', { instance, waitMs: POLL_WAIT_MS }, signal)
            if (signal.aborted || state.running === false) return
            const commands = Array.isArray(outcome && outcome.commands) ? outcome.commands : []
            for (const command of commands) {
              if (signal.aborted || state.running === false) return
              let message
              try {
                message = { ok: true, value: await executeCommand(state, command) }
              } catch (error) {
                message = {
                  ok: false,
                  error: { message: error instanceof Error ? error.message : String(error) },
                }
              }
              try {
                await post('result', { instance, commandId: command.id, ...message }, signal)
              } catch {
                // The Host may have timed the command out; the next poll recovers.
              }
            }
          } catch (error) {
            if (signal.aborted || state.running === false) return
            await sleep(900)
          }
        }
      }

      ctx.effect(() => {
        const controller = new AbortController()
        loop(controller.signal).catch((error) => {
          console.error('[sidebar-browser-control] poll loop stopped', error)
        })
        return () => {
          state.running = false
          controller.abort()
        }
      }, 'sidebar-browser-control: command poller')
    }

    return {
      inject: [],
      apply,
    }
  },
})
