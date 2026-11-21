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
    const VERSION = '0.2.3'
    const DEFAULT_ACTION_BUDGET_MS = 85000
    const MAX_ACTION_BUDGET_MS = 295000
    /* Actions a batch may contain. A batch is one tool call for several steps,
       so it saves the model a round trip per step; it may not nest or open tabs. */
    const BATCH_ACTIONS = new Set(['navigate', 'click', 'hover', 'type', 'press', 'select', 'scroll', 'wait', 'eval', 'read', 'diff', 'snapshot'])

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
        if (element.closest('[hidden], [inert]') !== null) return false
        /* Chromium still lays out content of a closed <details> here, so its
           rect is non-zero even though the person cannot see it. */
        const details = element.closest('details:not([open])')
        if (details !== null && element.tagName !== 'SUMMARY') return false
        const rect = element.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) return false
        const style = getComputedStyle(element)
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
      }
      const labelOf = (element) => {
        let raw = element.getAttribute('aria-label') || element.getAttribute('title') || ''
        if (raw === '' && element.labels !== undefined && element.labels !== null && element.labels.length > 0) {
          raw = element.labels[0].innerText
        }
        if (raw === '' && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')) raw = element.getAttribute('placeholder') || ''
        if (raw === '') raw = element.innerText || element.getAttribute('alt') || ''
        if (raw === '' && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')) raw = element.value || ''
        if (raw === '') raw = element.getAttribute('name') || ''
        return String(raw).replace(/\s+/g, ' ').trim().slice(0, 160)
      }
      const refs = []
      let refsTruncated = false
      /* Snapshot refs are positional. Clear numbers from an older snapshot first,
         otherwise an element skipped this time keeps a number that a fresh ref
         may now own, and a stale ref could hit the wrong element. */
      const roots = [document]
      const seenRoots = new Set([document])
      let shadowRoots = 0
      const collectRoots = () => {
        let scanned = 0
        const walk = (root) => {
          let nodes
          try {
            nodes = root.querySelectorAll('*')
          } catch {
            return
          }
          for (const node of nodes) {
            const shadow = node.shadowRoot
            if (shadow !== null && shadow !== undefined && seenRoots.has(shadow) !== true) {
              seenRoots.add(shadow)
              roots.push(shadow)
              shadowRoots += 1
              if (shadowRoots < 30) walk(shadow)
            }
            scanned += 1
            if (scanned > 8000) break
          }
        }
        walk(document)
      }
      collectRoots()
      for (const root of roots) {
        for (const stale of root.querySelectorAll('[data-dsh-bc-ref]')) stale.removeAttribute('data-dsh-bc-ref')
      }
      window.__dshScRefs = new Map()
      const collectCandidates = function* () {
        for (const root of roots) {
          let nodes
          try {
            nodes = root.querySelectorAll(selector)
          } catch {
            continue
          }
          for (const node of nodes) yield node
        }
      }
      for (const element of collectCandidates()) {
        if (refs.length >= maxRefs) {
          refsTruncated = true
          break
        }
        if (!isVisible(element) || element.disabled === true) continue
        const ref = refs.length + 1
        element.setAttribute('data-dsh-bc-ref', String(ref))
        window.__dshScRefs.set(String(ref), element)
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
          if (href !== null) {
            const text = String(href)
            entry.href = text.length > 240 ? text.slice(0, 240) + '…' : text
          }
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
      const includeText = options.includeText !== false
      let rawText = includeText && document.body !== null ? String(document.body.innerText || '') : ''
      if (includeText && shadowRoots > 0) {
        /* Shadow-rendered text is not part of body.innerText; add each root once. */
        for (const root of roots.slice(1)) {
          const shadowText = pageShadowText(root)
          if (shadowText.length > 0 && rawText.includes(shadowText) !== true) rawText += '\n' + shadowText
        }
      }
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
        shadowRoots,
        iframes: document.querySelectorAll('iframe').length,
        includeText,
        text: text.slice(0, maxTextChars),
        textTruncated: text.length > maxTextChars,
      }
    }

    function pageFind(options) {
      if (options.ref !== undefined && options.ref !== null) {
        const key = String(options.ref)
        const known = window.__dshScRefs && typeof window.__dshScRefs.get === 'function' ? window.__dshScRefs.get(key) : undefined
        if (known !== undefined && known.isConnected !== false) return known
        return document.querySelector('[data-dsh-bc-ref="' + key + '"]')
      }
      if (typeof options.selector === 'string' && options.selector.length > 0) {
        const selector = options.selector
        let first
        try {
          first = document.querySelector(selector)
        } catch (error) {
          throw new Error('Invalid CSS selector ' + JSON.stringify(selector) + ': ' + (error && error.message ? error.message : String(error)))
        }
        if (first !== null) return first
        /* Open shadow roots are invisible to document.querySelector; walk them. */
        const roots = []
        const seen = new Set()
        let scanned = 0
        const walk = (root) => {
          if (root === null || root === undefined || seen.has(root)) return
          seen.add(root)
          let nodes
          try {
            nodes = root.querySelectorAll('*')
          } catch {
            return
          }
          for (const node of nodes) {
            if (node.shadowRoot !== null && node.shadowRoot !== undefined) {
              roots.push(node.shadowRoot)
              if (roots.length < 30) walk(node.shadowRoot)
            }
            scanned += 1
            if (scanned > 8000) break
          }
        }
        walk(document)
        for (const root of roots) {
          let hit
          try {
            hit = root.querySelector(selector)
          } catch {
            continue
          }
          if (hit !== null) return hit
        }
        return null
      }
      return null
    }

    /** Visible text inside a shadow root, skipping style/script and hidden nodes. */
    function pageShadowText(root) {
      let out = ''
      const visit = (node) => {
        if (node === null || node === undefined) return
        if (node.nodeType === 3) {
          out += String(node.nodeValue || '') + ' '
          return
        }
        if (node.nodeType !== 1) return
        const tag = node.tagName
        if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return
        const rect = node.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) return
        const style = getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden') return
        for (const child of node.childNodes) visit(child)
      }
      for (const child of root.childNodes) visit(child)
      return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    }

    /** Visible text of the top document plus any open shadow roots it renders. */
    function pageText() {
      let raw = document.body === null ? '' : String(document.body.innerText || '')
      let shadowRoots = 0
      let scanned = 0
      const seen = new Set([document])
      const visit = (root) => {
        let nodes
        try {
          nodes = root.querySelectorAll('*')
        } catch {
          return
        }
        for (const node of nodes) {
          const shadow = node.shadowRoot
          if (shadow !== null && shadow !== undefined && seen.has(shadow) !== true) {
            seen.add(shadow)
            shadowRoots += 1
            const extra = pageShadowText(shadow)
            if (extra.length > 0 && raw.includes(extra) !== true) raw += '\n' + extra
            if (shadowRoots < 30) visit(shadow)
          }
          scanned += 1
          if (scanned > 8000) break
        }
      }
      visit(document)
      return {
        text: raw.replace(/\n[ \t]+\n/g, '\n\n').replace(/\n{3,}/g, '\n\n').trim(),
        shadowRoots,
        iframes: document.querySelectorAll('iframe').length,
      }
    }

    function pageClick(options) {
      const element = pageFind(options)
      if (element === null) {
        const iframes = document.querySelectorAll('iframe').length
        const hint = iframes > 0
          ? ' (the page has ' + String(iframes) + ' iframe(s); refs and selectors only see the top document)'
          : ''
        throw new Error((options.ref !== undefined
          ? 'No element has ref ' + String(options.ref) + ' on this page; take a new snapshot.'
          : 'No element matches selector ' + String(options.selector) + '.') + hint)
      }
      const describe = (node) => {
        const label = node.getAttribute('aria-label')
          || node.getAttribute('title')
          || (node.labels !== undefined && node.labels !== null && node.labels.length > 0 ? node.labels[0].innerText : '')
          || node.innerText
          || node.getAttribute('placeholder')
          || node.getAttribute('alt')
          || node.value
          || ''
        return { tag: node.tagName.toLowerCase(), label: String(label).replace(/\s+/g, ' ').trim().slice(0, 120) }
      }
      element.scrollIntoView({ block: 'center', inline: 'center' })
      const target = element.closest('a,button,label,summary,[role="button"],[role="link"]') || element
      target.click()
      /* element.click() on an input does not focus it, so a following press would
         land on <body>. Clicking with a mouse focuses text fields; do the same. */
      if (element.matches('input,textarea,select,[contenteditable="true"]') && typeof element.focus === 'function') {
        try {
          element.focus({ preventScroll: true })
        } catch {
          element.focus()
        }
      }
      const info = describe(target)
      const href = target.tagName === 'A' ? String(target.getAttribute('href') || '') : ''
      return { clicked: { tag: info.tag, label: info.label, ...(href === '' ? {} : { href }) }, url: String(location.href) }
    }

    function pageHover(options) {
      const element = pageFind(options)
      if (element === null) {
        throw new Error(options.ref !== undefined
          ? 'No element has ref ' + String(options.ref) + ' on this page; take a new snapshot.'
          : 'No element matches selector ' + String(options.selector) + '.')
      }
      element.scrollIntoView({ block: 'center', inline: 'center' })
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (rect.width < 1 || rect.height < 1 || style.display === 'none' || style.visibility === 'hidden') {
        throw new Error('The target element is hidden, so hovering it would do nothing.')
      }
      const x = Math.round(rect.left + rect.width / 2)
      const y = Math.round(rect.top + rect.height / 2)
      if (options.synthetic === true) {
        /* Fallback for builds where a native mouseMove is unavailable. */
        const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }
        element.dispatchEvent(new MouseEvent('mouseover', init))
        element.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }))
        element.dispatchEvent(new MouseEvent('mousemove', init))
      }
      const label = element.getAttribute('aria-label')
        || element.getAttribute('title')
        || (element.labels !== undefined && element.labels !== null && element.labels.length > 0 ? element.labels[0].innerText : '')
        || element.innerText
        || element.getAttribute('placeholder')
        || element.value
        || ''
      return {
        hovered: { tag: element.tagName.toLowerCase(), label: String(label).replace(/\s+/g, ' ').trim().slice(0, 120) },
        x,
        y,
        url: String(location.href),
      }
    }

    function pageType(options) {
      const unsupported = new Set(['file', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image'])
      const element = pageFind(options)
      if (element === null) {
        const iframes = document.querySelectorAll('iframe').length
        const hint = iframes > 0
          ? ' (the page has ' + String(iframes) + ' iframe(s); refs and selectors only see the top document)'
          : ''
        throw new Error((options.ref !== undefined
          ? 'No element has ref ' + String(options.ref) + ' on this page; take a new snapshot.'
          : 'No element matches selector ' + String(options.selector) + '.') + hint)
      }
      const tag = element.tagName
      const editable = element.isContentEditable === true
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && editable !== true) {
        throw new Error('Cannot type into <' + tag.toLowerCase() + '>; use a text input, textarea or contenteditable element (for a <select> use action "select").')
      }
      const type = tag === 'INPUT' ? String(element.type || '').toLowerCase() : ''
      if (unsupported.has(type)) {
        throw new Error('Cannot type into <input type="' + type + '">; use action "click" to toggle it (for a <select> use action "select").')
      }
      const incoming = String(options.text)
      const clear = options.clear !== false
      element.scrollIntoView({ block: 'center' })
      if (typeof element.focus === 'function') element.focus()
      if (editable === true) {
        const current = clear === false ? String(element.textContent || '') : ''
        const text = current + incoming
        element.textContent = text
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: incoming }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
      } else {
        const current = clear === false ? String(element.value ?? '') : ''
        const text = current + incoming
        const prototype = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')
        if (setter !== undefined && typeof setter.set === 'function') setter.set.call(element, text)
        else element.value = text
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
        /* A number/date/maxlength field silently drops or truncates text. Report
           that instead of claiming success. */
        const applied = String(element.value ?? '')
        if (applied !== text) {
          const shown = applied.length > 120 ? applied.slice(0, 120) + '…' : applied
          throw new Error('<' + tag.toLowerCase() + (type === '' ? '' : ' type="' + type + '"') + '> did not keep the text: value is ' + JSON.stringify(shown) + '. The field may reject, mask or truncate this value.')
        }
      }
      let submitted = ''
      if (options.submit === true) {
        if (element.form !== null && element.form !== undefined && typeof element.form.requestSubmit === 'function') {
          element.form.requestSubmit()
          submitted = 'form'
        } else {
          submitted = 'enter'
        }
      }
      return { typed: incoming.length, target: tag.toLowerCase(), submitted, url: String(location.href) }
    }

    function pagePress(options) {
      const KEY_CODES = {
        Enter: 13, Tab: 9, Escape: 27, Esc: 27, Backspace: 8, Delete: 46, Home: 36, End: 35,
        PageUp: 33, PageDown: 34, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
        ' ': 32, Space: 32,
      }
      const key = String(options.key)
      const mods = Array.isArray(options.modifiers) ? options.modifiers : []
      const target = document.activeElement || document.body
      const named = KEY_CODES[key] || 0
      const upper = key.length === 1 ? key.toUpperCase() : key
      const keyCode = named || (key.length === 1 ? upper.charCodeAt(0) : 0)
      const code = key.length === 1 && /[a-z0-9]/i.test(key) ? 'Key' + upper : (key === ' ' || key === 'Space' ? 'Space' : key)
      const init = {
        key,
        code,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
        ctrlKey: mods.includes('ctrl'),
        altKey: mods.includes('alt'),
        shiftKey: mods.includes('shift'),
        metaKey: mods.includes('meta'),
      }
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
      const normalize = (value) => String(value === undefined || value === null ? '' : value).trim()
      const list = Array.from(element.options)
      let index
      if (options.index !== undefined && options.index !== null) {
        index = Number(options.index)
        if (!Number.isInteger(index) || index < 0 || index >= list.length) {
          throw new Error('Option index ' + JSON.stringify(options.index) + ' is out of range for this <select> (' + String(list.length) + ' option(s)).')
        }
      } else {
        const want = String(options.value)
        index = list.findIndex((option) => option.value === want)
        if (index < 0) index = list.findIndex((option) => normalize(option.label || option.text) === want)
        if (index < 0) index = list.findIndex((option) => normalize(option.label || option.text).toLowerCase() === want.toLowerCase())
        if (index < 0) {
          const shown = list.slice(0, 40).map((option) => JSON.stringify(option.value) + '=' + JSON.stringify(normalize(option.label || option.text)))
          throw new Error('No option matches ' + JSON.stringify(want) + ' in this <select>; available: '
            + shown.join(', ') + (list.length > 40 ? ', …' : '') + '.')
        }
      }
      element.selectedIndex = index
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return { value: element.value, label: normalize(list[index].label || list[index].text), selectedIndex: index }
    }

    function pageScroll(options) {
      const direction = String(options.direction || 'down')
      const amount = Number(options.amount) > 0 ? Number(options.amount) : 600
      if (options.ref !== undefined && options.ref !== null) {
        const element = pageFind(options)
        if (element === null) throw new Error('No element has ref ' + String(options.ref) + '; take a new snapshot.')
        element.scrollIntoView({ block: 'center' })
        const rect = element.getBoundingClientRect()
        return {
          x: Math.round(window.scrollX), y: Math.round(window.scrollY),
          target: { ref: options.ref, tag: element.tagName.toLowerCase() }, rectTop: Math.round(rect.top),
        }
      }
      if (typeof options.selector === 'string' && options.selector.length > 0) {
        const element = pageFind({ selector: options.selector })
        if (element === null) throw new Error('No element matches selector ' + options.selector + '.')
        element.scrollIntoView({ block: 'center' })
        const rect = element.getBoundingClientRect()
        return {
          x: Math.round(window.scrollX), y: Math.round(window.scrollY),
          target: { selector: options.selector, tag: element.tagName.toLowerCase() }, rectTop: Math.round(rect.top),
        }
      }
      const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0
      const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0
      const beforeX = Math.round(window.scrollX)
      const beforeY = Math.round(window.scrollY)
      window.scrollBy({ left: dx, top: dy, behavior: 'instant' })
      const x = Math.round(window.scrollX)
      const y = Math.round(window.scrollY)
      return { x, y, moved: x !== beforeX || y !== beforeY }
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
      const raw = pageText().text
      const base = raw.split(/\n+/)
        .map((part) => part.replace(/[ \t]+/g, ' ').trim())
        .filter((part) => part.length > 0)
        .slice(0, 800)
      /* A single-line SPA or a minified block is one giant paragraph; split it
         into sentence-sized chunks so a query can rank inside it. */
      const paragraphs = []
      for (const part of base) {
        if (part.length <= 800) {
          paragraphs.push(part)
        } else {
          const sentences = part.split(/(?<=[.!?。！？])\s*/)
          let current = ''
          for (const sentence of sentences) {
            const piece = sentence.trim()
            if (piece.length === 0) continue
            if (current.length > 0 && current.length + piece.length > 800) {
              paragraphs.push(current)
              current = ''
            }
            current = current.length === 0 ? piece : current + ' ' + piece
            while (current.length > 800) {
              paragraphs.push(current.slice(0, 800))
              current = current.slice(800)
            }
            if (paragraphs.length > 1200) break
          }
          if (current.length > 0) paragraphs.push(current)
        }
        if (paragraphs.length > 1200) break
      }
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
      if (picked.length === 0) {
        /* Never answer a question with nothing when the page has text: show the
           opening and say the query did not match. */
        const fallback = paragraphs.slice(0, 3).join('\n\n').slice(0, budget)
        return {
          url: String(location.href),
          title: String(document.title || ''),
          mode: 'query',
          query,
          matched: 0,
          candidates: scored.length,
          fallback: true,
          text: fallback,
          truncated: paragraphs.length > 3,
        }
      }
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
      const raw = pageText().text
      const paragraphs = raw.split(/\n+/)
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
      /* Never adopt a frame that belongs to another Session: driving it would
         navigate/click a page the person is not looking at. */
      const own = frames.filter((frame) => frameTabInfo(ctx, frame).same !== false)
      if (own.length === 0) return undefined
      const visibleFrames = own.filter(frameIsVisible)
      /* A frame proven ours by an earlier command wins; otherwise a visible one;
         a single candidate is unambiguous; several without an active tab is not,
         and guessing could drive another Session's page. */
      if (state.last !== undefined && state.last.isConnected === true && own.includes(state.last)) return state.last
      if (visibleFrames.length > 0) return visibleFrames[visibleFrames.length - 1]
      if (own.length === 1) return own[0]
      return undefined
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

    /** A freshly mounted webview answers frameReady before it has an address, and
        starts on about:blank while the requested URL is still loading. The dock
        may also replace the tab body while it loads, so re-pick every tick. */
    async function waitPageReady(state, ctx, frame, timeoutMs, allowBlank) {
      const deadline = Date.now() + timeoutMs
      let current = frame
      let seen = ''
      while (Date.now() < deadline) {
        const picked = pickFrame(state, ctx)
        if (picked !== undefined) current = picked
        const url = String(safe(() => current.getURL()) || '')
        if (url !== '' && (allowBlank === true || url !== 'about:blank')) {
          if (seen === '') seen = url
          if (safe(() => current.isLoading()) !== true) {
            const ready = await safe(() => current.executeJavaScript('document.readyState', true))
            if (ready === 'complete' || ready === 'interactive') return { frame: current, url }
          }
        }
        await sleep(150)
      }
      return { frame: current, url: seen }
    }

    function sidebarRightOf(ctx) {
      if (typeof ctx.get === 'function') return ctx.get('sidebarRight')
      return ctx.sidebarRight
    }

    /**
     * Ask the right Sidebar for a Browser tab and wait until *its* frame exists.
     * Foreign Session frames are ignored: they are not the tab we just asked for.
     */
    async function openBrowserTab(ctx, url, previousTabId, sessionId) {
      const sidebarRight = sidebarRightOf(ctx)
      if (sidebarRight === undefined || sidebarRight === null) {
        throw new Error('The right Sidebar is unavailable in this Harness page, so a Browser tab cannot be opened (Desktop app required for Browser control).')
      }
      let opened
      try {
        opened = openTabInSession(ctx, sessionId, 'browser', { url })
      } catch (error) {
        throw new Error('Could not open the right-Sidebar Browser: ' + (error instanceof Error ? error.message : String(error)))
      }
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const tab = activeBrowserTab(ctx)
        const tabId = tab === undefined || tab.id === undefined || tab.id === null ? undefined : String(tab.id)
        const own = browserFrames().filter((frame) => frameTabInfo(ctx, frame).same !== false)
        const exact = tab === undefined ? undefined : frameForTab(tab)
        const fresh = previousTabId === undefined || tabId === undefined || tabId !== previousTabId
        if (exact !== undefined && fresh) return { frame: exact, tabId, targeted: opened.targeted }
        const visible = own.filter(frameIsVisible)
        if (visible.length > 0 && fresh) return { frame: visible[visible.length - 1], tabId, targeted: opened.targeted }
        await sleep(150)
      }
      throw new Error('A Browser tab was requested for ' + url + ' in Session ' + String(sessionId ?? '(unknown)')
        + ' but no Browser frame appeared within 20s. '
        + 'The tab may still be loading; call action "status" in a moment.')
    }

    async function activeFrame(state, ctx, options) {
      const frame = pickFrame(state, ctx)
      if (frame === undefined) {
        const total = browserFrames().length
        const foreign = browserFrames().filter((candidate) => frameTabInfo(ctx, candidate).same === false).length
        throw new Error('No Browser tab is available for this Session'
          + (foreign > 0 ? ' (' + String(foreign) + ' Browser tab(s) belong to other Sessions and are left alone)' : '')
          + (total > 0 ? '. ' + String(total) + ' Browser frame(s) exist but none can be proven to belong here; pass a url to action "open" to establish one.' : '. Call action "open" with a url first.'))
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
        const hint = active === undefined
          ? ''
          : ' Active right-Sidebar tab: ' + String(active.kind) + ' ' + String(active.id) + '.'
        throw new Error('The Browser tab is hidden (collapsed, inert, or another tab is in front), so a screenshot would be blank.'
          + hint + ' Open the Browser panel visibly, then retry.')
      }
    }

    /**
     * Make the tab visible before capturing, and tell the person how.
     *
     * A screenshot of a hidden tab is blank, so the capture has to be shown
     * rather than silently returning an empty image. This expands the right
     * Sidebar and focuses the owner tab; when that is impossible it says which
     * tab to bring forward instead of a bare "hidden" error.
     */
    async function revealForCapture(ctx, frame) {
      try {
        await revealFrame(ctx, frame)
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(message + '\nTip: action "snapshot" or "read" works without showing the panel — '
          + 'use it when you only need the page content, and keep "screenshot" for a visible panel.')
      }
    }

    function runPage(frame, fn, args) {
      const code = '(async () => { try {'
        + ' const pageFind = ' + pageFind.toString() + ';'
        + ' const pageText = ' + pageText.toString() + ';'
        + ' const pageShadowText = ' + pageShadowText.toString() + ';'
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

    async function isLoading(frame) {
      try {
        return frame.isLoading() === true
      } catch {
        return false
      }
    }

    /* Electron's accelerator names differ from DOM key names. */
    const ACCEL_KEY = new Map([
      ['ArrowUp', 'Up'], ['ArrowDown', 'Down'], ['ArrowLeft', 'Left'], ['ArrowRight', 'Right'],
      ['Escape', 'Esc'], [' ', 'Space'], ['Space', 'Space'], ['Spacebar', 'Space'],
    ])
    const MODIFIER_NAMES = { ctrl: 'control', alt: 'alt', shift: 'shift', meta: 'meta' }

    function modifierList(modifiers) {
      const list = []
      for (const name of Array.isArray(modifiers) ? modifiers : []) {
        const mapped = MODIFIER_NAMES[name]
        if (mapped !== undefined && list.includes(mapped) !== true) list.push(mapped)
      }
      return list
    }

    function sendKey(frame, key, modifiers) {
      const accel = ACCEL_KEY.get(key) || key
      const mods = modifierList(modifiers)
      try {
        frame.focus()
        /* Electron expects modifiers as a string[] such as ['control','shift'],
           not a bitmask. */
        frame.sendInputEvent({ type: 'keyDown', keyCode: accel, modifiers: mods })
        const plain = /^.$/.test(key) && mods.length === 0
        if (plain) frame.sendInputEvent({ type: 'char', keyCode: key })
        frame.sendInputEvent({ type: 'keyUp', keyCode: accel, modifiers: mods })
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

    /**
     * Return as soon as the page stops changing instead of sleeping a fixed
     * interval: a click that only focuses a field settles in about a tenth of a
     * second, and a page that navigates settles when the address and the
     * document stop moving. This is the latency difference a person feels when
     * clicking through a form.
     */
    async function settleFast(frame, options) {
      const budget = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 2500
      const quiet = Number(options?.quietMs) > 0 ? Number(options.quietMs) : 180
      const floor = Number(options?.minMs) > 0 ? Number(options.minMs) : 80
      const start = Date.now()
      try {
        await frame.executeJavaScript('(() => { if (!window.__dshScObs) { window.__dshScMutations = 0; window.__dshScObs = new MutationObserver(() => { window.__dshScMutations += 1 }); window.__dshScObs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true }) } return 1 })()', true)
      } catch {
        /* a page between documents keeps the polling fallback below */
      }
      let last = ''
      let changedAt = start
      while (Date.now() - start < budget) {
        let probe = null
        try {
          probe = await frame.executeJavaScript('({ url: location.href, ready: document.readyState, n: window.__dshScMutations || 0, len: document.body ? document.body.innerText.length : 0 })', true)
        } catch {
          /* navigation in flight: poll again */
        }
        if (probe !== null && typeof probe === 'object') {
          const signature = String(probe.url) + '|' + String(probe.ready) + '|' + String(probe.n) + '|' + String(probe.len)
          if (signature !== last) {
            last = signature
            changedAt = Date.now()
          }
          if (probe.ready !== 'loading' && Date.now() - changedAt >= quiet && Date.now() - start >= floor) return
        }
        await sleep(60)
      }
    }

    function resolveUrl(frame, url) {
      const raw = String(url || '')
      if (/^(https?|file|about):/i.test(raw)) return raw
      if (!/^(\/|\.\/|\.\.\/|[?#])/.test(raw)) return raw
      const base = String(safe(() => frame.getURL()) || '')
      if (base.length === 0) return raw
      try {
        return new URL(raw, base).href
      } catch {
        return raw
      }
    }

    async function navigateTo(frame, url) {
      const target = resolveUrl(frame, url)
      try {
        await frame.loadURL(target)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/ERR_ABORTED/.test(message)) {
          if (/^file:/i.test(target) && /ERR_FAILED|ERR_ACCESS_DENIED|ERR_FILE_NOT_FOUND|ERR_UNKNOWN_URL_SCHEME/i.test(message)) {
            throw new Error('This Browser build refuses to load local files (' + message + '). '
              + 'Serve the file over http — for example "python -m http.server 8000" — and open http://127.0.0.1:8000/… instead.')
          }
          throw new Error('Navigation to ' + target + ' failed: ' + message)
        }
      }
      await settle(frame, 150)
      await frameReady(frame, 10000)
    }

    function estimateTokens(text) {
      const value = String(text || '')
      let latin = 0
      let cjk = 0
      let other = 0
      for (const ch of value) {
        const code = ch.codePointAt(0)
        if (code >= 0x4e00 && code <= 0x9fff) cjk += 1
        else if (code < 0x80) latin += 1
        else other += 1
      }
      return Math.ceil(latin / 4 + cjk / 1.5 + other / 2)
    }

    function sizeNote(text) {
      const value = String(text || '')
      return value.length + ' chars ≈ ' + estimateTokens(value) + ' tokens'
    }

    function formatSnapshot(snapshot) {
      const lines = []
      lines.push('url: ' + snapshot.url)
      lines.push('title: ' + (snapshot.title.length > 0 ? snapshot.title : '(untitled)'))
      lines.push('scroll: y=' + String(snapshot.scroll.y) + ' pageHeight=' + String(snapshot.scroll.height))
      lines.push('refs: ' + String(snapshot.refs.length) + (snapshot.refsTruncated ? ' (truncated; refine with eval or selector)' : ''))
      if (snapshot.includeText !== false) lines.push('size: ' + sizeNote(snapshot.text) + (snapshot.textTruncated ? ' (truncated)' : ''))
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
      if (snapshot.shadowRoots > 0) {
        lines.push('(note: ' + String(snapshot.shadowRoots) + ' open shadow root(s) traversed for refs and text)')
      }
      if (snapshot.iframes > 0) {
        lines.push('(note: ' + String(snapshot.iframes) + ' iframe(s) on the page are not traversed by refs or text)')
      }
      if (snapshot.includeText !== false) {
        lines.push('')
        lines.push('text:')
        lines.push(snapshot.text.length > 0 ? snapshot.text : '(empty page text)')
        if (snapshot.textTruncated) lines.push('(text truncated; use eval to read a specific region)')
      }
      return lines.join('\n')
    }

    function statusText(ctx, caller) {
      const frames = browserFrames()
      const sidebarRight = sidebarRightOf(ctx)
      const lines = []
      lines.push('plugin: ' + VERSION)
      lines.push('platform: ' + (globalThis.dshDesktop === undefined ? 'web' : 'desktop'))
      if (typeof caller === 'string' && caller.length > 0) lines.push('callingSession: ' + shortSession(caller))
      lines.push('onScreenSession: ' + shortSession(currentSessionId(ctx)))
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
      const own = browserTabs(ctx, caller).rows
      const every = browserTabs(ctx, caller).all
      lines.push('tabs: ' + String(own.length) + ' in this conversation, ' + String(Math.max(0, every.length - own.length)) + ' in other conversations')
      return lines.join('\n')
    }

    /**
     * Wait from the client: each probe is a fresh injection, so a navigation that
     * replaces the document does not tear the wait down. A selector must be
     * visible (a hidden dialog is not "appeared"); a text wait compares visible
     * text. With both, both must match.
     */
    async function waitFor(frame, options, timeoutMs) {
      const hasSelector = typeof options.selector === 'string' && options.selector.length > 0
      const hasText = typeof options.text === 'string' && options.text.length > 0
      const deadline = Date.now() + timeoutMs
      const wanted = hasSelector && hasText
        ? 'selector ' + options.selector + ' and text ' + JSON.stringify(String(options.text))
        : hasSelector ? 'selector ' + options.selector : 'text ' + JSON.stringify(String(options.text))
      while (Date.now() < deadline) {
        let probe = null
        try {
          probe = await frame.executeJavaScript('(() => {'
            + ' const selector = ' + JSON.stringify(hasSelector ? options.selector : '') + ';'
            + ' const text = ' + JSON.stringify(hasText ? options.text : '') + ';'
            + ' const roots = [document]; const seen = new Set([document]); let scanned = 0;'
            + ' const walk = (root) => { let nodes; try { nodes = root.querySelectorAll("*") } catch { return }'
            + '   for (const node of nodes) { const shadow = node.shadowRoot;'
            + '     if (shadow !== null && shadow !== undefined && seen.has(shadow) !== true) { seen.add(shadow); roots.push(shadow); if (roots.length < 30) walk(shadow) }'
            + '     scanned += 1; if (scanned > 8000) break } };'
            + ' walk(document);'
            + ' const deepQuery = (sel) => { try { const direct = document.querySelector(sel); if (direct !== null) return direct } catch (error) { throw error }'
            + '   for (const root of roots) { let hit; try { hit = root.querySelector(sel) } catch { continue } if (hit !== null) return hit } return null };'
            + ' const visible = (element) => { if (element === null || element === undefined) return false;'
            + '   if (element.closest("[hidden], [inert]") !== null) return false;'
            + '   const closed = element.closest("details:not([open])");'
            + '   if (closed !== null && element.tagName !== "SUMMARY") return false;'
            + '   const rect = element.getBoundingClientRect();'
            + '   if (rect.width < 1 || rect.height < 1) return false;'
            + '   const style = getComputedStyle(element);'
            + '   return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 };'
            + ' let allText = document.body === null ? "" : String(document.body.innerText || "");'
            + ' for (const root of roots.slice(1)) allText += "\\n" + String(root.textContent || "");'
            + ' let hit = null;'
            + ' if (selector !== "") { try { hit = deepQuery(selector) } catch (error) { return { error: String(error && error.message ? error.message : error) } } }'
            + ' const found = selector === "" ? document.body !== null : visible(hit);'
            + ' const matched = text === "" ? true : allText.includes(text);'
            + ' return { found, matched }; })()', true)
        } catch {
          probe = null
        }
        if (probe !== null && probe !== undefined && typeof probe.error === 'string' && probe.error.length > 0) {
          throw new Error('Invalid CSS selector ' + JSON.stringify(String(options.selector)) + ': ' + probe.error)
        }
        if (probe !== null && probe !== undefined && probe.found === true && probe.matched === true) {
          return { found: true, ...(hasSelector ? { selector: options.selector } : {}), ...(hasText ? { text: options.text } : {}) }
        }
        await sleep(150)
      }
      throw new Error('Timed out after ' + String(timeoutMs) + 'ms waiting for ' + wanted + '.')
    }

    async function captureImage(frame) {
      if (typeof frame.capturePage !== 'function') throw new Error('This Harness build does not expose capturePage on the Browser frame.')
      /* capturePage can never settle for an occluded guest; a deadline turns a
         wedged call into an answer instead of a bridge stuck for minutes. */
      let timer
      const image = await Promise.race([
        frame.capturePage(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('the screenshot did not finish within 10s — is the Harness window visible?')), 10000)
        }),
      ]).finally(() => clearTimeout(timer))
      if (image === undefined || image === null) throw new Error('The Browser frame returned no screenshot.')
      if (typeof image.isEmpty === 'function' && image.isEmpty()) throw new Error('The Browser frame returned an empty screenshot.')
      const prefix = 'data:image/png;base64,'
      const dataUrl = String(image.toDataURL())
      if (!dataUrl.startsWith(prefix)) throw new Error('The screenshot used an unexpected encoding.')
      const size = typeof image.getSize === 'function' ? image.getSize() : { width: 0, height: 0 }
      return { base64: dataUrl.slice(prefix.length), width: size.width, height: size.height, image }
    }

    async function capture(frame, maxWidth) {
      let shot = await captureImage(frame)
      let image = shot.image
      const prefix = 'data:image/png;base64,'
      const resize = (width) => {
        if (typeof image.resize !== 'function') return false
        const scaled = image.resize({ width, quality: 'good' })
        if (scaled === undefined || scaled === null || typeof scaled.toDataURL !== 'function') return false
        const url = String(scaled.toDataURL())
        if (!url.startsWith(prefix)) return false
        const size = typeof scaled.getSize === 'function' ? scaled.getSize() : { width, height: 0 }
        image = scaled
        shot = { base64: url.slice(prefix.length), width: size.width, height: size.height, image: scaled }
        return true
      }
      if (Number(maxWidth) > 0 && shot.width > Number(maxWidth)) resize(Number(maxWidth))
      /* A 4K viewport can exceed the bridge's JSON body limit; downscale before
         sending rather than letting the result POST fail silently. */
      if (shot.base64.length > 6000000 && shot.width > 1600) resize(1600)
      return { base64: shot.base64, width: shot.width, height: shot.height }
    }

    async function captureFullPage(frame, maxWidth) {
      const metrics = await frame.executeJavaScript('({ vw: innerWidth, vh: innerHeight, sh: document.documentElement === null ? 0 : document.documentElement.scrollHeight, sy: scrollY })', true)
      if (metrics === null || metrics === undefined || !(Number(metrics.vw) > 0) || !(Number(metrics.vh) > 0)) {
        throw new Error('Could not measure the page for a full-page screenshot.')
      }
      const maxHeight = 20000
      const totalHeight = Math.min(Number(metrics.sh) || 0, maxHeight)
      if (totalHeight < 1) throw new Error('The page has no scrollable height to capture.')
      const tiles = []
      let y = 0
      try {
        while (y < totalHeight) {
          await frame.executeJavaScript('window.scrollTo(0, ' + y + ')', true)
          await sleep(120)
          tiles.push({ y, tile: await captureImage(frame) })
          y += Number(metrics.vh)
          if (tiles.length > 30) break
        }
      } finally {
        await frame.executeJavaScript('window.scrollTo(0, ' + Math.round(Number(metrics.sy) || 0) + ')', true).catch(() => {})
      }
      const first = tiles[0].tile
      const scale = first.width / Number(metrics.vw)
      const canvas = document.createElement('canvas')
      canvas.width = first.width
      canvas.height = Math.max(1, Math.min(Math.round(totalHeight * scale), Math.round(20000 * scale)))
      const context = canvas.getContext('2d')
      if (context === null) throw new Error('Could not create a canvas for the full-page screenshot.')
      for (const entry of tiles) {
        const image = new Image()
        image.src = 'data:image/png;base64,' + entry.tile.base64
        try {
          await image.decode()
        } catch {
          continue
        }
        const destY = Math.round(entry.y * scale)
        const destH = Math.min(image.height, canvas.height - destY)
        if (destH > 0) {
          context.drawImage(
            image,
            0, 0, image.width, Math.min(image.height, Math.round(Number(metrics.vh) * scale)),
            0, destY, canvas.width, destH,
          )
        }
      }
      let base64 = String(canvas.toDataURL('image/png')).split(',')[1]
      let width = canvas.width
      let height = canvas.height
      if (Number(maxWidth) > 0 && width > Number(maxWidth)) {
        const scaled = document.createElement('canvas')
        scaled.width = Number(maxWidth)
        scaled.height = Math.max(1, Math.round(height * Number(maxWidth) / width))
        const scaledContext = scaled.getContext('2d')
        if (scaledContext !== null) {
          scaledContext.drawImage(canvas, 0, 0, scaled.width, scaled.height)
          base64 = String(scaled.toDataURL('image/png')).split(',')[1]
          width = scaled.width
          height = scaled.height
        }
      }
      /* Keep a very tall page under the result body limit. */
      if (base64.length > 8000000 && width > 1000) {
        const scaled = document.createElement('canvas')
        scaled.width = 1000
        scaled.height = Math.max(1, Math.round(height * 1000 / width))
        const scaledContext = scaled.getContext('2d')
        if (scaledContext !== null) {
          scaledContext.drawImage(canvas, 0, 0, scaled.width, scaled.height)
          base64 = String(scaled.toDataURL('image/png')).split(',')[1]
          width = scaled.width
          height = scaled.height
        }
      }
      return { base64, width, height, truncated: Number(metrics.sh) > maxHeight }
    }

    function currentSessionId(ctx) {
      const sidebarRight = sidebarRightOf(ctx)
      if (sidebarRight === undefined || sidebarRight === null) return undefined
      const mounted = safe(() => sidebarRight.mounted?.getSnapshot())
      const current = safe(() => sidebarRight.focusedTarget?.())
      const active = safe(() => sidebarRight.active())
      return (current === undefined || current === null ? undefined : current.sessionId)
        ?? mounted
        ?? (active === undefined || active === null ? undefined : active.sessionId)
    }

    /** The Session that issued the command: the tool call's own agent id. */
    function callerSessionId(state, ctx) {
      const stated = state.caller
      return typeof stated === 'string' && stated.length > 0 ? stated : currentSessionId(ctx)
    }

    /**
     * Open a Browser tab INSIDE a named Session's layout.
     *
     * `sidebarRight.openTab(kind, …)` targets the Session currently on screen —
     * that is Harness behaviour, not ours — so a second conversation running in
     * the background would otherwise drop its tab into whatever conversation the
     * person happens to be looking at, and every conversation's tab strip would
     * fill with everyone else's tabs. `openTabIn(sessionId, kind, …)` writes the
     * target Session's own layout instead, which is what this call needs.
     */
    function openTabInSession(ctx, sessionId, kind, params) {
      const sidebarRight = sidebarRightOf(ctx)
      if (sidebarRight === undefined || sidebarRight === null) {
        throw new Error('The right Sidebar is unavailable in this Harness page, so a Browser tab cannot be opened (Desktop app required).')
      }
      const options = params === undefined ? {} : { params }
      if (sessionId !== undefined && typeof sidebarRight.openTabIn === 'function') {
        try {
          sidebarRight.openTabIn(sessionId, kind, options)
          return { targeted: true, via: 'openTabIn' }
        } catch (error) {
          if (!/no session surface is mounted|not mounted/i.test(String(error && error.message))) throw error
        }
      }
      /* No adopted surface for that Session (it was never on screen in this
         process): fall back to the on-screen one and say so in the result. */
      sidebarRight.openTab(kind, options)
      return { targeted: false, via: 'openTab' }
    }

    /** Browser tabs split into "this Session" and "all" so tab ids with the same
        value in another Session are never silently focused or closed. */
    function browserTabs(ctx, sessionId) {
      const side = sidebarRightOf(ctx)
      const open = side === undefined || side === null ? undefined : safe(() => side.openTabs?.getSnapshot())
      const current = sessionId ?? currentSessionId(ctx)
      const all = (Array.isArray(open) ? open : []).filter((tab) => tab.kind === 'browser')
      const rows = all.filter((tab) => current === undefined || tab.sessionId === undefined || tab.sessionId === current)
      return { rows, all, sessionId: current }
    }

    function findBrowserTab(ctx, rawId, sessionId) {
      const id = String(rawId)
      const { rows, all } = browserTabs(ctx, sessionId)
      const hit = rows.find((tab) => String(tab.tabId ?? tab.id ?? '') === id)
      if (hit !== undefined) return hit
      const foreign = all.find((tab) => String(tab.tabId ?? tab.id ?? '') === id)
      if (foreign !== undefined) {
        throw new Error('Browser tab ' + JSON.stringify(id) + ' belongs to another conversation (Session '
          + String(foreign.sessionId) + '); it is left alone. Use action "open" to get a tab of your own, '
          + 'or action "tabs" with all:true to see it.')
      }
      const available = rows.map((tab) => String(tab.tabId ?? tab.id ?? '')).filter((value) => value !== '')
      throw new Error('No Browser tab ' + JSON.stringify(id) + ' is open for this conversation'
        + (available.length > 0 ? '; open tabs: ' + available.join(', ') : '. Use action "open" to create one.'))
    }

    /** Short, stable label so a person can tell which conversation owns a tab. */
    function shortSession(sessionId) {
      const raw = String(sessionId ?? '')
      if (raw.length === 0) return 'unknown'
      return raw.length <= 10 ? raw : raw.slice(-6)
    }

    async function executeCommand(state, command) {
      const action = String(command.action)
      const args = command.args !== null && typeof command.args === 'object' ? command.args : {}
      const ctx = state.ctx

      if (action === 'status') return { text: statusText(ctx, callerSessionId(state, ctx)) }

      if (action === 'open') {
        const requested = String(args.url || '')
        const side = sidebarRightOf(ctx)
        if (side === undefined || side === null) throw new Error('The right Sidebar is unavailable in this Harness page, so a Browser tab cannot be opened (Desktop app required).')
        const mine = callerSessionId(state, ctx)
        const existing = pickFrame(state, ctx)
        const existingInfo = existing === undefined ? undefined : frameTabInfo(ctx, existing)
        const base = existing !== undefined ? existing : pickFrame(state, ctx)
        const url = base === undefined ? requested : resolveUrl(base, requested)
        if (!/^(https?|file|about):/i.test(url) && /^(\/|\.\/|\.\.\/|[?#])/.test(url)) {
          throw new Error('The relative URL ' + JSON.stringify(requested) + ' needs an open Browser page to resolve against; open an absolute URL first.')
        }
        /* Reuse only a visible tab that belongs to this conversation: navigating a
           hidden or foreign tab would change a page the person cannot see, and
           would mix one conversation's page into another's tab strip. */
        if (args.new_tab !== true && existing !== undefined && frameIsVisible(existing) && existingInfo.same !== false) {
          await navigateTo(existing, url)
          state.last = existing
          return { text: 'Opened ' + url + '\n' + statusText(ctx, mine) }
        }
        const previousTab = activeBrowserTab(ctx)
        const previousTabId = previousTab === undefined || previousTab.id === undefined || previousTab.id === null
          ? undefined
          : String(previousTab.id)
        const opened = await openBrowserTab(ctx, url, args.new_tab === true ? previousTabId : undefined, mine)
        await frameReady(opened.frame, 8000).catch(() => {})
        const ready = await waitPageReady(state, ctx, opened.frame, 15000, /^about:/i.test(url))
        state.last = ready.frame
        const owner = opened.targeted === true
          ? ' (in this conversation)'
          : ' (this Harness page has no live layout for chat ' + shortSession(mine) + ', so the tab landed in the conversation on screen)'
        return {
          text: 'Opened ' + url + (opened.tabId === undefined ? '' : ' in Browser tab ' + opened.tabId) + owner + '\n' + statusText(ctx, mine),
        }
      }

      /* Sidebar-only actions must work even when the visible right-Sidebar tab is
         an editor/terminal and no single Browser frame can be chosen. */
      const needsFrame = ['navigate', 'back', 'forward', 'reload', 'snapshot', 'read', 'diff', 'click', 'hover', 'type', 'press', 'select', 'scroll', 'wait', 'eval', 'screenshot'].includes(action)
      const frame = needsFrame ? await activeFrame(state, ctx, {}) : undefined

      switch (action) {
        case 'navigate': {
          const url = resolveUrl(frame, String(args.url || ''))
          await navigateTo(frame, url)
          return { text: 'Navigated to ' + url + '\n' + statusText(ctx, callerSessionId(state, ctx)) }
        }
        case 'back': {
          if (safe(() => frame.canGoBack()) !== true) throw new Error('The Browser tab has no back history.')
          safe(() => frame.goBack())
          await settle(frame, 200)
          await frameReady(frame, 10000)
          return { text: 'Went back.\n' + statusText(ctx, callerSessionId(state, ctx)) }
        }
        case 'forward': {
          if (safe(() => frame.canGoForward()) !== true) throw new Error('The Browser tab has no forward history.')
          safe(() => frame.goForward())
          await settle(frame, 200)
          await frameReady(frame, 10000)
          return { text: 'Went forward.\n' + statusText(ctx, callerSessionId(state, ctx)) }
        }
        case 'reload': {
          safe(() => frame.reload())
          await settle(frame, 250)
          await frameReady(frame, 15000)
          return { text: 'Reloaded the page.\n' + statusText(ctx, callerSessionId(state, ctx)) }
        }
        case 'snapshot': {
          const snapshot = await runPage(frame, pageSnapshot, {
            maxRefs: Number(args.max_refs) > 0 ? Math.min(Number(args.max_refs), LIST_LIMIT) : 80,
            maxTextChars: Number(args.max_text_chars) > 0 ? Number(args.max_text_chars) : 12000,
            includeText: args.include_text !== false,
          })
          return { text: formatSnapshot(snapshot) }
        }
        case 'read': {
          const result = await runPage(frame, pageRead, {
            query: args.query,
            maxChars: Number(args.max_chars) > 0 ? Number(args.max_chars) : 4000,
          })
          const header = result.mode === 'query'
            ? (result.fallback === true
              ? 'No passage matched ' + JSON.stringify(String(result.query)) + '; showing the page beginning.'
              : 'Read ' + String(result.matched) + ' of ' + String(result.candidates) + ' matching passage(s) for ' + JSON.stringify(String(result.query)) + '.')
            : 'Read the visible text.'
          return {
            text: header + ' · ' + sizeNote(result.text) + '\n' + String(result.url) + '\n# ' + String(result.title)
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
              + ' · ' + sizeNote(result.text)
              + '\n' + String(result.url) + '\n# ' + String(result.title)
              + (String(result.text).length > 0 ? '\n\n' + String(result.text) : ''),
          }
        }
        case 'tabs': {
          const side = sidebarRightOf(ctx)
          if (side === undefined || side === null) throw new Error('The right Sidebar is unavailable in this Harness page.')
          const active = safe(() => side.active())
          const mine = callerSessionId(state, ctx)
          const { rows, all } = browserTabs(ctx, mine)
          /* A long conversation accumulates one Browser tab per `open`, and a
             blank one (about:blank, no title) is never useful again. `prune`
             closes those of THIS conversation only. */
          if (args.prune === true) {
            const doomed = rows.filter((tab) => {
              const id = String(tab.tabId ?? tab.id ?? '')
              const holder = id === '' ? undefined : frameForTab({ id })
              const url = String(tab.url ?? tab.address ?? (holder === undefined ? '' : safe(() => holder.getURL())) ?? '')
              return url === '' || url === 'about:blank' || /^about:blank#/.test(url)
            })
            const closed = []
            for (const tab of doomed) {
              const id = String(tab.tabId ?? tab.id ?? '')
              const owner = tab.sessionId ?? mine
              try {
                if (owner !== undefined && typeof side.closeIn === 'function') side.closeIn(owner, id)
                else side.close(id)
                closed.push(id)
              } catch {
                // A tab that cannot be closed now (mid-load) is skipped.
              }
            }
            if (closed.length > 0) state.last = undefined
            return {
              text: 'Pruned ' + String(closed.length) + ' blank Browser tab(s) of this conversation'
                + (closed.length > 0 ? ': ' + closed.join(', ') : ' (none were blank).')
                + '\n' + (browserTabs(ctx, mine).rows.length === 0
                  ? 'No Browser tab is left for this conversation; use action "open" with a url.'
                  : String(browserTabs(ctx, mine).rows.length) + ' tab(s) remain.'),
            }
          }
          const visible = args.all === true ? all : rows
          if (visible.length === 0) {
            return { text: 'No Browser tab is open for this conversation'
              + (all.length > 0 ? ' (' + String(all.length) + ' Browser tab(s) belong to other conversations; pass all:true to list them).' : '')
              + ' Use action "open" with a url.' }
          }
          const activeId = active === undefined || active === null ? undefined : String(active.id)
          const onScreen = currentSessionId(ctx)
          const lines = visible.map((tab) => {
            const id = String(tab.tabId ?? tab.id ?? '')
            const holder = id === '' ? undefined : frameForTab({ id })
            const url = String(tab.url ?? tab.address ?? (holder === undefined ? '' : safe(() => holder.getURL())) ?? '')
            const title = String((tab.title ?? tab.label ?? (holder === undefined ? '' : safe(() => holder.getTitle()))) || '')
            const mineTab = tab.sessionId === undefined || tab.sessionId === mine
            const mark = activeId !== undefined && (activeId === id || activeId === String(tab.id ?? '')) ? '*' : ' '
            const owner = mineTab ? 'this chat' : 'chat ' + shortSession(tab.sessionId)
              + (tab.sessionId === onScreen ? ' (on screen)' : '')
            const blank = url === '' || url === 'about:blank' || /^about:blank#/.test(url)
            const shown = blank ? '(blank)' : (title.length > 0 ? title : '(untitled)')
            return [mark, id, '[' + owner + ']', shown, blank ? '' : url].filter((part) => part !== '').join('  ')
          })
          const blankCount = rows.filter((tab) => {
            const id = String(tab.tabId ?? tab.id ?? '')
            const holder = id === '' ? undefined : frameForTab({ id })
            const url = String(tab.url ?? tab.address ?? (holder === undefined ? '' : safe(() => holder.getURL())) ?? '')
            return url === '' || url === 'about:blank' || /^about:blank#/.test(url)
          }).length
          const others = all.length - rows.length
          return {
            text: 'Browser tabs (' + String(visible.length) + ', * = active, [owner] = conversation):\n' + lines.join('\n')
              + (blankCount > 0 ? '\n(' + String(blankCount) + ' blank tab(s) in this conversation; pass prune:true to close them.)' : '')
              + (args.all === true
                ? (others > 0 ? '\n(' + String(others) + ' tab(s) above belong to other conversations; this tool never drives them.)' : '')
                : (others > 0 ? '\n(' + String(others) + ' more belong to other conversations and are hidden; pass all:true to list them.)' : '')),
          }
        }
        case 'focus': {
          const side = sidebarRightOf(ctx)
          if (side === undefined || side === null) throw new Error('The right Sidebar is unavailable in this Harness page.')
          const mine = callerSessionId(state, ctx)
          const target = findBrowserTab(ctx, args.tab_id, mine)
          const targetId = String(target.tabId ?? target.id)
          /* Focusing a tab of a conversation that is not on screen would need a
             Session switch; say that instead of silently focusing nothing. */
          if (target.sessionId !== undefined && target.sessionId !== currentSessionId(ctx)) {
            throw new Error('Browser tab ' + JSON.stringify(targetId) + ' belongs to chat ' + shortSession(target.sessionId)
              + ', which is not the conversation on screen, so it cannot be focused from here. '
              + 'Switch to that conversation, or open your own tab with action "open".')
          }
          side.focus(targetId)
          await sleep(250)
          return { text: 'Focused Browser tab ' + targetId + '.\n' + statusText(ctx, mine) }
        }
        case 'close_tab': {
          const side = sidebarRightOf(ctx)
          if (side === undefined || side === null) throw new Error('The right Sidebar is unavailable in this Harness page.')
          const mine = callerSessionId(state, ctx)
          const target = findBrowserTab(ctx, args.tab_id, mine)
          const targetId = String(target.tabId ?? target.id)
          const owner = target.sessionId ?? mine
          if (owner !== undefined && typeof side.closeIn === 'function') side.closeIn(owner, targetId)
          else side.close(targetId)
          state.last = undefined
          return { text: 'Closed Browser tab ' + targetId + '.' }
        }
        case 'click': {
          const before = activeBrowserTab(ctx)
          const beforeId = before === undefined || before.id === undefined || before.id === null ? undefined : String(before.id)
          const outcome = await runPage(frame, pageClick, { ref: args.ref, selector: args.selector })
          await settleFast(frame)
          const after = activeBrowserTab(ctx)
          const afterId = after === undefined || after.id === undefined || after.id === null ? undefined : String(after.id)
          const openedTab = afterId !== undefined && afterId !== beforeId ? afterId : ''
          const active = openedTab === '' ? frame : (pickFrame(state, ctx) || frame)
          state.last = active
          return {
            text: 'Clicked <' + outcome.clicked.tag + '> ' + JSON.stringify(outcome.clicked.label)
              + (openedTab === '' ? '' : '\nA new Browser tab opened: ' + openedTab)
              + '\nurl: ' + String(safe(() => active.getURL()) || outcome.url)
              + '\ntitle: ' + JSON.stringify(String(safe(() => active.getTitle()) || ''))
              + '\nTake a new snapshot before the next ref-based action.',
          }
        }
        case 'hover': {
          const outcome = await runPage(frame, pageHover, { ref: args.ref, selector: args.selector })
          let native = false
          try {
            /* Move away first so the guest always sees a real pointer enter. */
            frame.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 })
            await sleep(40)
            frame.sendInputEvent({ type: 'mouseMove', x: outcome.x, y: outcome.y })
            native = true
          } catch {
            native = false
          }
          if (native !== true) await runPage(frame, pageHover, { ref: args.ref, selector: args.selector, synthetic: true })
          await settleFast(frame, { quietMs: 120 })
          return {
            text: 'Hovered <' + outcome.hovered.tag + '> ' + JSON.stringify(outcome.hovered.label)
              + ' at ' + String(outcome.x) + ',' + String(outcome.y) + (native ? ' (native pointer)' : ' (synthetic events only)')
              + '\nurl: ' + String(safe(() => frame.getURL()) || outcome.url)
              + '\nTake a new snapshot before the next ref-based action.',
          }
        }
        case 'type': {
          const outcome = await runPage(frame, pageType, {
            ref: args.ref,
            selector: args.selector,
            text: args.text,
            submit: args.submit === true,
            clear: args.clear !== false,
          })
          let submitted = ''
          if (args.submit === true) {
            if (outcome.submitted === 'enter') {
              sendKey(frame, 'Enter')
              submitted = ' Pressed Enter (the field is not inside a form).'
            } else if (outcome.submitted === 'form') {
              submitted = ' Submitted the form.'
            }
          }
          await settleFast(frame, { quietMs: 150 })
          return {
            text: 'Typed ' + String(outcome.typed) + ' characters into <' + outcome.target + '>.' + submitted
              + '\nurl: ' + String(safe(() => frame.getURL()) || outcome.url)
              + '\ntitle: ' + JSON.stringify(String(safe(() => frame.getTitle()) || '')),
          }
        }
        case 'press': {
          const key = String(args.key)
          const modifiers = Array.isArray(args.modifiers) ? args.modifiers : []
          const label = (modifiers.length > 0 ? modifiers.join('+') + '+' : '') + key
          if (sendKey(frame, key, modifiers) === 'dom') {
            const outcome = await runPage(frame, pagePress, { key, modifiers })
            await settleFast(frame, { quietMs: 120 })
            return { text: 'Pressed ' + JSON.stringify(label) + ' on <' + outcome.active + '> (DOM event fallback).' }
          }
          await settleFast(frame, { quietMs: 120 })
          return {
            text: 'Pressed ' + JSON.stringify(label) + '.'
              + '\nurl: ' + String(safe(() => frame.getURL()) || '')
              + '\ntitle: ' + JSON.stringify(String(safe(() => frame.getTitle()) || '')),
          }
        }
        case 'select': {
          const outcome = await runPage(frame, pageSelect, { ref: args.ref, selector: args.selector, value: args.value, index: args.index })
          await settleFast(frame, { quietMs: 120 })
          return {
            text: 'Selected ' + JSON.stringify(outcome.label) + ' (' + JSON.stringify(outcome.value) + ', index ' + String(outcome.selectedIndex) + ').'
              + '\nurl: ' + String(safe(() => frame.getURL()) || ''),
          }
        }
        case 'scroll': {
          const outcome = await runPage(frame, pageScroll, {
            ref: args.ref,
            selector: args.selector,
            direction: args.direction,
            amount: args.amount,
          })
          const parts = ['Scrolled to y=' + String(outcome.y === undefined ? '?' : outcome.y)]
          if (outcome.x !== undefined && outcome.x !== 0) parts.push('x=' + String(outcome.x))
          if (outcome.target !== undefined) parts.push('target <' + outcome.target.tag + '>')
          if (outcome.rectTop !== undefined) parts.push('viewport top=' + String(outcome.rectTop))
          if (outcome.moved === false) parts.push('(already at that position)')
          return { text: parts.join(' ') }
        }
        case 'wait': {
          const timeoutMs = Number(args.timeout_ms) > 0 ? Number(args.timeout_ms) : 5000
          const outcome = await waitFor(frame, { selector: args.selector, text: args.text }, timeoutMs)
          return { text: 'Appeared: ' + JSON.stringify(outcome) }
        }
        case 'eval': {
          const script = String(args.script)
          const serialize = '(value) => {'
            + ' if (value === undefined) return null;'
            + ' if (value !== null && typeof value === "object" && typeof value.nodeType === "number") {'
            + '   return { node: String(value.nodeName || ""), text: String(value.innerText !== undefined && value.innerText !== null ? value.innerText : (value.textContent || "")).slice(0, 4000), ...(typeof value.value === "string" ? { value: value.value.slice(0, 500) } : {}) };'
            + ' }'
            + ' if (typeof value === "function") return String(value);'
            + ' if (typeof value === "bigint" || typeof value === "symbol") return String(value);'
            + ' const seen = new WeakSet();'
            + ' try { const json = JSON.stringify(value, (key, item) => { if (item !== null && typeof item === "object") { if (seen.has(item)) return "[circular]"; seen.add(item) } return item }); return json === undefined ? String(value) : JSON.parse(json) } catch { return String(value) }'
            + ' }'
          const wrap = (body) => '(async () => { try { const __v = await (' + body + '); return { ok: true, value: (' + serialize + ')(__v) } }'
            + ' catch (error) { return { ok: false, name: error && error.name ? String(error.name) : "Error", message: error && error.message ? String(error.message) : String(error) } } })()'
          /* eval() returns the completion value, so expressions and statement
             blocks both work; a page CSP may forbid it, in which case a plain
             expression is still evaluated. */
          let outcome = await frame.executeJavaScript(wrap('(0, eval)(' + JSON.stringify(script) + ')'), true)
          const failed = outcome === null || typeof outcome !== 'object' || outcome.ok !== true
          if (failed) {
            const name = outcome !== null && typeof outcome === 'object' ? String(outcome.name || '') : ''
            const message = outcome !== null && typeof outcome === 'object' ? String(outcome.message || '') : 'the page returned no value'
            if (/EvalError|Content Security Policy|unsafe-eval/i.test(name + ' ' + message)) {
              try {
                outcome = await frame.executeJavaScript(wrap('(' + script + ')'), true)
              } catch {
                throw new Error('This page\'s Content Security Policy blocks eval(), so only a single expression can be evaluated here. '
                  + 'Pass an expression, or use read/snapshot instead.')
              }
            } else if (/SyntaxError/i.test(name) || /SyntaxError/i.test(message)) {
              throw new Error('The script could not be parsed: ' + message + '. Pass an expression or a statement block.')
            } else {
              throw new Error(message)
            }
          }
          if (outcome === null || typeof outcome !== 'object' || outcome.ok !== true) {
            const message = outcome !== null && typeof outcome === 'object' ? String(outcome.message || '') : 'the page returned no value'
            throw new Error(message)
          }
          const text = JSON.stringify(outcome.value, null, 2)
          if (outcome.value === null || outcome.value === undefined) {
            /* A mutation-only script legitimately returns nothing; say so rather
               than printing a bare "null" that looks like a failure. */
            return {
              text: 'The script ran and returned nothing (null). '
                + 'Add a value — for example `{ ok: true }` or the element you changed — to read the result.',
            }
          }
          return { text: text.length > 20000 ? text.slice(0, 20000) + '\n(truncated)' : text }
        }
        case 'screenshot': {
          await revealForCapture(ctx, frame)
          const maxWidth = Number(args.max_width) > 0 ? Number(args.max_width) : undefined
          if (args.full_page === true) {
            const image = await captureFullPage(frame, maxWidth)
            const note = image.truncated === true ? 'The page is taller than 20,000 px; captured the top part.\n' : ''
            return {
              text: note + 'Captured the full Browser page (' + String(image.width) + '×' + String(image.height) + ').\n' + statusText(ctx, callerSessionId(state, ctx)),
              png: image,
            }
          }
          const image = await capture(frame, maxWidth)
          return {
            text: 'Captured the visible Browser page (' + String(image.width) + '×' + String(image.height) + ').\n' + statusText(ctx, callerSessionId(state, ctx)),
            png: image,
          }
        }
        case 'close': {
          const sidebarRight = sidebarRightOf(ctx)
          if (sidebarRight === undefined || sidebarRight === null) throw new Error('The right Sidebar is unavailable in this Harness page.')
          const mine = callerSessionId(state, ctx)
          /* Close this conversation's own Browser tab, not whatever happens to be
             in front: a person reading another conversation must not lose their
             page because a background chat asked to close "the" tab. */
          const { rows } = browserTabs(ctx, mine)
          const active = safe(() => sidebarRight.active())
          const activeId = active === undefined || active === null ? undefined : String(active.id)
          const own = rows.find((tab) => String(tab.tabId ?? tab.id ?? '') === activeId) ?? rows[rows.length - 1]
          if (own !== undefined) {
            const id = String(own.tabId ?? own.id)
            const owner = own.sessionId ?? mine
            if (owner !== undefined && typeof sidebarRight.closeIn === 'function') sidebarRight.closeIn(owner, id)
            else sidebarRight.close(id)
            state.last = undefined
            return { text: 'Closed Browser tab ' + id + '.' }
          }
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
          throw new Error('This conversation has no Browser tab to close. Use action "tabs" to see which tabs exist.')
        }
        case 'batch': {
          const steps = Array.isArray(args.steps) ? args.steps.slice(0, 12) : []
          if (steps.length === 0) throw new Error('"batch" needs a non-empty steps array')
          const started = Date.now()
          const lines = []
          let failed = ''
          let ran = 0
          for (let index = 0; index < steps.length; index += 1) {
            const step = steps[index] !== null && typeof steps[index] === 'object' ? steps[index] : {}
            const sub = String(step.action || '')
            if (BATCH_ACTIONS.has(sub) !== true) {
              failed = 'step ' + String(index + 1) + ': ' + JSON.stringify(sub) + ' is not allowed inside batch'
              break
            }
            try {
              const result = await executeCommand(state, { action: sub, args: step })
              ran += 1
              const raw = String(result?.text || '')
              /* A read/diff/snapshot in a batch is usually the point of the
                 batch, so keep its payload; other steps only need a summary. */
              const text = ['read', 'diff', 'snapshot'].includes(sub)
                ? raw.slice(0, 3000) + (raw.length > 3000 ? '…' : '')
                : raw.split('\n').filter((line) => line !== '').slice(0, 3).join(' · ').slice(0, 300)
              lines.push(String(index + 1) + '. ' + sub + ': ' + text)
            } catch (error) {
              failed = 'step ' + String(index + 1) + ' (' + sub + '): ' + (error instanceof Error ? error.message : String(error))
              break
            }
          }
          return {
            text: 'Batch: ' + String(ran) + ' of ' + String(steps.length) + ' step(s) ran in ' + String(Date.now() - started) + ' ms.'
              + (failed === '' ? '' : '\nfailed: ' + failed + ' (remaining steps not run)')
              + '\n' + lines.join('\n'),
          }
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

    /** Run a promise with a deadline, so one wedged action never blocks the bridge. */
    async function withDeadline(promise, ms, label) {
      let timer
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(label + ' did not finish within ' + String(Math.round(ms / 1000)) + 's')), ms)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }

    function apply(ctx) {
      const state = { ctx, last: undefined, running: true }
      /* A plugin reload can leave the previous poll loop alive for a moment. The
         newest instance owns the bridge; older ones stop before taking a command
         they would execute with stale code. */
      const generation = (globalThis.__dshScGeneration = (globalThis.__dshScGeneration || 0) + 1)

      async function post(name, payload, signal) {
        const url = new URL('sidebar-control/' + name, document.baseURI)
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
          if (globalThis.__dshScGeneration !== generation) return
          try {
            const outcome = await post('poll', { instance, waitMs: POLL_WAIT_MS }, signal)
            if (signal.aborted || state.running === false) return
            const commands = Array.isArray(outcome && outcome.commands) ? outcome.commands : []
            for (const command of commands) {
              if (signal.aborted || state.running === false) return
              let message
              try {
                /* Give up a few seconds before the host deadline so the failure
                   is a readable client message instead of a host timeout. */
                const budget = Number(command.deadlineMs) > 0 ? Number(command.deadlineMs) : DEFAULT_ACTION_BUDGET_MS
                const closed = Math.max(5000, Math.min(budget - 5000, MAX_ACTION_BUDGET_MS))
                /* The command carries the Session that called the tool; every
                   tab operation is scoped to it so parallel conversations stop
                   sharing one tab strip. */
                const previousCaller = state.caller
                state.caller = typeof command.sessionId === 'string' && command.sessionId.length > 0 ? command.sessionId : undefined
                try {
                  message = { ok: true, value: await withDeadline(executeCommand(state, command), closed, 'The action "' + String(command.action) + '"') }
                } finally {
                  state.caller = previousCaller
                }
              } catch (error) {
                message = {
                  ok: false,
                  error: { message: error instanceof Error ? error.message : String(error) },
                }
              }
              try {
                await post('result', { instance, commandId: command.id, ...message }, signal)
              } catch (error) {
                // The Host may have timed the command out; the next poll recovers.
                console.warn('[sidebar-control] the result could not be delivered', error)
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
          console.error('[sidebar-control] poll loop stopped', error)
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
