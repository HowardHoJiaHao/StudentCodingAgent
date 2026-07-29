// Webview UI. Everything is built with textContent / createElement — model
// output is never assigned to innerHTML, so a code block containing markup
// can't execute in the panel.

const vscode = acquireVsCodeApi()

const log = document.getElementById('log')
const input = document.getElementById('input')
const sendBtn = document.getElementById('send')
const stopBtn = document.getElementById('stop')
const usageEl = document.getElementById('usage')
const approveEl = document.getElementById('approve')
const budgetEl = document.getElementById('budget')
const editsEl = document.getElementById('edits')

let current = null // the assistant bubble currently streaming into
let buffer = ''
let repaintQueued = false
let thinkingEl = null
const toolRows = new Map()

/**
 * A visible sign the turn is alive. Streaming text is its own feedback, so
 * this shows only while nothing else is happening — before the first token,
 * and in the gaps between tool calls.
 */
function setThinking(on, label) {
  if (!on) {
    if (thinkingEl) thinkingEl.remove()
    thinkingEl = null
    return
  }
  if (!thinkingEl) {
    thinkingEl = document.createElement('div')
    thinkingEl.className = 'thinking'
    const dots = document.createElement('span')
    dots.className = 'dots'
    dots.append(
      document.createElement('i'),
      document.createElement('i'),
      document.createElement('i'),
    )
    const text = document.createElement('span')
    text.className = 'thinking-text'
    thinkingEl.append(dots, text)
  }
  thinkingEl.querySelector('.thinking-text').textContent = label || 'Working…'
  log.appendChild(thinkingEl)
  scroll(true)
}

function scheduleRender() {
  if (repaintQueued) return
  repaintQueued = true
  requestAnimationFrame(() => {
    repaintQueued = false
    if (!current) return
    render(current, buffer)
    scroll(false)
  })
}

function atBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 60
}

function scroll(force) {
  if (force || atBottom()) log.scrollTop = log.scrollHeight
}

function bubble(kind) {
  const el = document.createElement('div')
  el.className = `msg ${kind}`
  log.appendChild(el)
  scroll(true)
  return el
}

/**
 * Inline spans: `code`, **bold**, *italic*. Built as DOM nodes rather than
 * innerHTML, so a model that emits markup can't execute anything.
 * Code is matched first — asterisks inside a code span stay literal.
 */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)/g

function inline(parent, text) {
  let last = 0
  let match
  INLINE.lastIndex = 0

  while ((match = INLINE.exec(text))) {
    if (match.index > last) {
      parent.appendChild(document.createTextNode(text.slice(last, match.index)))
    }
    const token = match[0]
    if (token.startsWith('`')) {
      const code = document.createElement('code')
      code.className = 'inline-code'
      code.textContent = token.slice(1, -1)
      parent.appendChild(code)
    } else if (token.startsWith('**') || token.startsWith('__')) {
      const strong = document.createElement('strong')
      strong.textContent = token.slice(2, -2)
      parent.appendChild(strong)
    } else {
      const em = document.createElement('em')
      em.textContent = token.slice(1, -1)
      parent.appendChild(em)
    }
    last = match.index + token.length
  }

  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)))
}

/** Block level: headings, lists, quotes, rules, paragraphs. */
function blocks(parent, text) {
  const lines = text.split('\n')
  let i = 0

  const flushList = (ordered, items) => {
    const list = document.createElement(ordered ? 'ol' : 'ul')
    for (const item of items) {
      const li = document.createElement('li')
      inline(li, item)
      list.appendChild(li)
    }
    parent.appendChild(list)
  }

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i++
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      const h = document.createElement('h' + Math.min(heading[1].length + 2, 6))
      inline(h, heading[2])
      parent.appendChild(h)
      i++
      continue
    }

    if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) {
      parent.appendChild(document.createElement('hr'))
      i++
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement('blockquote')
      const buf = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      inline(quote, buf.join('\n'))
      parent.appendChild(quote)
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      flushList(false, items)
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''))
        i++
      }
      flushList(true, items)
      continue
    }

    // Anything else is a paragraph, running until a blank line or a new block.
    const buf = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|\s*[-*+]\s|\s*\d+[.)]\s|\s*>|---+$)/.test(lines[i])
    ) {
      buf.push(lines[i])
      i++
    }
    const p = document.createElement('p')
    inline(p, buf.join('\n'))
    parent.appendChild(p)
  }
}

/** Markdown: fenced code blocks split out, the rest parsed as blocks. */
function render(el, text) {
  el.textContent = ''
  const parts = text.split(/```/)

  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const wrap = document.createElement('div')
      wrap.className = 'code-wrap'

      const pre = document.createElement('pre')
      const code = document.createElement('code')
      // Drop a leading language tag on the fence line.
      code.textContent = part.replace(/^[a-zA-Z0-9_+-]*\n/, '')
      pre.appendChild(code)

      const copy = document.createElement('button')
      copy.className = 'copy'
      copy.textContent = 'Copy'
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(code.textContent)
        copy.textContent = 'Copied'
        setTimeout(() => (copy.textContent = 'Copy'), 1200)
      })

      wrap.append(pre, copy)
      el.appendChild(wrap)
    } else if (part.trim()) {
      blocks(el, part)
    }
  })
}

// What the tool did, in the user's terms rather than the API's.
const VERBS = {
  write_file: 'Created',
  edit_file: 'Edited',
  read_file: 'Read',
  list_dir: 'Listed',
  glob_files: 'Searched',
  grep: 'Searched',
  run_command: 'Ran',
}

/**
 * A workspace path that opens the file at the line that changed.
 * The line is set on the element rather than captured, because it is only
 * known once the tool finishes — the row is drawn when it starts.
 */
function fileLink(path, line) {
  const el = document.createElement('span')
  el.className = 'file-link'
  el.textContent = path
  el.title = `${path} — click to open`
  el.tabIndex = 0
  el.dataset.line = line || ''

  const open = () =>
    vscode.postMessage({ type: 'open', path, line: Number(el.dataset.line) || null })

  el.addEventListener('click', open)
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      open()
    }
  })
  return el
}

/** Build a tool row. Shared by live streaming and transcript replay. */
function toolRow(msg) {
  const row = document.createElement('div')
  row.className = 'tool running'

  const name = document.createElement('span')
  name.className = 'tool-name'
  name.textContent = VERBS[msg.name] || msg.name

  // A row that names a real file gets a link; grep patterns and shell lines
  // are shown as plain text.
  const detail = msg.file
    ? fileLink(msg.file, null)
    : (() => {
        const span = document.createElement('span')
        span.textContent = msg.detail || ''
        if (msg.detail) span.title = msg.detail
        return span
      })()
  detail.classList.add('tool-detail')

  const status = document.createElement('span')
  status.className = 'tool-status'
  status.textContent = '…'

  row.append(name, detail, status)
  log.appendChild(row)
  return { row, status, link: msg.file ? detail : null }
}

function setToolStatus(entry, status, stats) {
  entry.row.className = `tool ${status}`
  entry.status.textContent = status === 'ok' ? '✓' : status === 'denied' ? 'denied' : '✕'

  if (!stats) return
  // Now that the edit has run we know where it landed, so the link can jump there.
  if (entry.link && stats.firstLine) entry.link.dataset.line = String(stats.firstLine)
  entry.row.insertBefore(diffBadge(stats), entry.status)
}

/** Git-style +added / −removed, coloured like a diff. */
function diffBadge(stats) {
  const badge = document.createElement('span')
  badge.className = 'diff'

  if (!stats.added && !stats.removed) {
    badge.textContent = 'no change'
    badge.classList.add('none')
    return badge
  }

  if (stats.added) {
    const plus = document.createElement('span')
    plus.className = 'diff-add'
    plus.textContent = `+${stats.added}`
    badge.appendChild(plus)
  }
  if (stats.removed) {
    const minus = document.createElement('span')
    minus.className = 'diff-del'
    minus.textContent = `−${stats.removed}`
    badge.appendChild(minus)
  }
  return badge
}

/**
 * Outstanding edits, pinned above the composer rather than scrolling away in
 * the log. The files are already written — Keep dismisses and releases the
 * snapshots, Undo puts them back.
 */
function renderEdits(msg) {
  editsEl.textContent = ''

  if (!msg.files || !msg.files.length) {
    editsEl.hidden = true
    return
  }
  editsEl.hidden = false

  const head = document.createElement('div')
  head.className = 'edits-head'

  const label = document.createElement('span')
  label.className = 'edits-label'
  label.textContent = `${msg.files.length} file${msg.files.length === 1 ? '' : 's'} changed`

  const spacer = document.createElement('span')
  spacer.className = 'edits-spacer'

  head.append(label, diffBadge({ added: msg.added, removed: msg.removed }), spacer)

  const keep = document.createElement('button')
  keep.textContent = 'Keep'
  keep.addEventListener('click', () => vscode.postMessage({ type: 'keep' }))
  head.appendChild(keep)

  if (msg.canUndo) {
    const undo = document.createElement('button')
    undo.className = 'secondary'
    undo.textContent = 'Undo'
    undo.addEventListener('click', () => {
      undo.disabled = true
      keep.disabled = true
      undo.textContent = 'Undoing…'
      vscode.postMessage({ type: 'undo' })
    })
    head.appendChild(undo)
  } else {
    const note = document.createElement('span')
    note.className = 'edits-note'
    note.title = 'A file was too large to snapshot, so this batch cannot be reverted.'
    note.textContent = "can't undo"
    head.appendChild(note)
  }

  editsEl.appendChild(head)

  const list = document.createElement('div')
  list.className = 'edits-list'

  for (const file of msg.files) {
    const row = document.createElement('div')
    row.className = 'edits-file'

    const verb = document.createElement('span')
    verb.className = 'edits-verb'
    verb.textContent = file.created ? 'new' : 'edited'

    const name = fileLink(file.path, file.firstLine)
    name.classList.add('edits-name')

    row.append(verb, name, diffBadge(file))
    list.appendChild(row)
  }

  editsEl.appendChild(list)
}

/**
 * A question from the model: the options it offered, plus a free-text box so
 * the user is never boxed into a choice that doesn't fit.
 * `answered` pre-fills a past question when replaying the transcript.
 */
function askBlock(msg, answered) {
  const el = bubble('ask')

  const q = document.createElement('div')
  q.className = 'ask-q'
  q.textContent = msg.question
  el.appendChild(q)

  const choices = document.createElement('div')
  choices.className = 'ask-options'
  el.appendChild(choices)

  const finish = (value) => {
    choices.textContent = ''
    const chosen = document.createElement('div')
    chosen.className = 'ask-answer'
    chosen.textContent = `→ ${value}`
    choices.appendChild(chosen)
  }

  if (answered != null) {
    finish(answered)
    return el
  }

  const pick = (value) => {
    if (!value || !String(value).trim()) return
    finish(value)
    vscode.postMessage({ type: 'answer', id: msg.id, value: String(value).trim() })
  }

  for (const option of msg.options || []) {
    const button = document.createElement('button')
    button.className = 'ask-option'
    button.textContent = option
    button.addEventListener('click', () => pick(option))
    choices.appendChild(button)
  }

  const other = document.createElement('div')
  other.className = 'ask-other'

  const field = document.createElement('input')
  field.type = 'text'
  field.placeholder = msg.options && msg.options.length ? 'Other — type your own…' : 'Your answer…'
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      pick(field.value)
    }
  })

  const submit = document.createElement('button')
  submit.className = 'inline'
  submit.textContent = 'Reply'
  submit.addEventListener('click', () => pick(field.value))

  other.append(field, submit)
  choices.appendChild(other)

  scroll(true)
  field.focus()
  return el
}

/** Budget spent against the cap, so a student sees the wall before they hit it. */
function setBudget(spend, max) {
  if (max == null) {
    budgetEl.textContent = `$${spend.toFixed(4)}`
    budgetEl.className = ''
    return
  }
  const left = Math.max(0, max - spend)
  budgetEl.textContent = `$${left.toFixed(2)} left`
  budgetEl.className = left <= 0 ? 'spent' : left / max < 0.15 ? 'low' : ''
  budgetEl.title = `$${spend.toFixed(4)} of $${max.toFixed(2)} used`
}

/** Repaint a whole conversation after the webview was rebuilt. */
function restore(entries, tokens) {
  log.textContent = ''
  toolRows.clear()
  thinkingEl = null
  current = null

  for (const entry of entries) {
    if (entry.type === 'user') {
      bubble('user').textContent = entry.text
    } else if (entry.type === 'assistant') {
      render(bubble('assistant'), entry.text)
    } else if (entry.type === 'tool') {
      const row = toolRow(entry)
      if (entry.status && entry.status !== 'running') setToolStatus(row, entry.status, entry.stats)
      else toolRows.set(entry.id, row)
    } else if (entry.type === 'ask') {
      // A question still unanswered when the window reloaded can't be revived —
      // its promise died with the old extension host — so show it as skipped.
      askBlock(entry, entry.answer == null ? '(unanswered)' : entry.answer)
    } else if (entry.type === 'error') {
      bubble('error').textContent = entry.text
    } else if (entry.type === 'notice') {
      bubble('notice').textContent = entry.text
    } else if (entry.type === 'status') {
      bubble('status').textContent = entry.text
    }
  }

  if (tokens && (tokens.in || tokens.out)) {
    usageEl.textContent = `${tokens.in.toLocaleString()} in · ${tokens.out.toLocaleString()} out`
  }
  scroll(true)
}

function send() {
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  vscode.postMessage({ type: 'send', text })
}

sendBtn.addEventListener('click', send)
stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }))

approveEl.addEventListener('change', () =>
  vscode.postMessage({ type: 'approval', value: approveEl.value }),
)

input.addEventListener('keydown', (event) => {
  // Enter sends, Shift+Enter makes a newline.
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    send()
  }
})

window.addEventListener('message', (event) => {
  const msg = event.data

  switch (msg.type) {
    case 'user': {
      const el = bubble('user')
      el.textContent = msg.text
      current = null
      break
    }

    case 'assistantStart':
      // Tokens are arriving; they are their own progress indicator.
      setThinking(false)
      current = bubble('assistant')
      buffer = ''
      break

    case 'delta':
      if (!current) {
        current = bubble('assistant')
        buffer = ''
      }
      buffer += msg.text
      // Reparsing the whole message per token is wasteful now that it is real
      // markdown; one repaint per frame keeps it smooth on long replies.
      scheduleRender()
      break

    case 'assistantEnd':
      if (current) {
        render(current, buffer)
        scroll(false)
      }
      current = null
      break

    case 'tool': {
      setThinking(false)
      toolRows.set(msg.id, toolRow(msg))
      current = null
      scroll(true)
      break
    }

    case 'toolEnd': {
      const entry = toolRows.get(msg.id)
      if (!entry) break
      setToolStatus(entry, msg.status, msg.stats)
      toolRows.delete(msg.id)
      // The tool is done but the model has not replied yet — that gap is
      // exactly where it looked frozen before.
      setThinking(true, 'Thinking…')
      break
    }

    case 'notice': {
      const el = bubble('notice')
      el.textContent = msg.text
      current = null
      break
    }

    case 'ask':
      askBlock(msg, null)
      current = null
      break

    case 'edits':
      renderEdits(msg)
      break

    case 'budget':
      setBudget(msg.spend, msg.max)
      break

    case 'restore':
      restore(msg.entries || [], msg.tokens)
      if (msg.approval) approveEl.value = msg.approval
      break

    case 'error': {
      const el = bubble('error')
      el.textContent = msg.text
      current = null
      break
    }

    case 'status': {
      const el = bubble('status')
      el.textContent = msg.text
      current = null
      break
    }

    case 'needkey': {
      const el = bubble('status')
      el.textContent = 'You need to sign in first. '
      const button = document.createElement('button')
      button.textContent = 'Sign in'
      button.className = 'inline'
      button.addEventListener('click', () => vscode.postMessage({ type: 'signin' }))
      el.appendChild(button)
      current = null
      break
    }

    case 'usage':
      usageEl.textContent = `${msg.in.toLocaleString()} in · ${msg.out.toLocaleString()} out`
      break

    case 'busy':
      sendBtn.disabled = msg.value
      stopBtn.hidden = !msg.value
      setThinking(msg.value, 'Thinking…')
      break

    case 'clear':
      log.textContent = ''
      usageEl.textContent = ''
      current = null
      toolRows.clear()
      break
  }
})

// Ask for the transcript once our listener is attached. Anything the extension
// posts before this point is dropped on the floor, so the replay has to be
// pulled from here rather than pushed when the html is set.
vscode.postMessage({ type: 'ready' })
