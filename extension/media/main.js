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

let current = null // the assistant bubble currently streaming into
let buffer = ''
const toolRows = new Map()

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

/** Minimal markdown: fenced code blocks, everything else plain text. */
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
    } else if (part) {
      const span = document.createElement('span')
      span.textContent = part
      el.appendChild(span)
    }
  })
}

/** Build a tool row. Shared by live streaming and transcript replay. */
function toolRow(msg) {
  const row = document.createElement('div')
  row.className = 'tool running'

  const name = document.createElement('span')
  name.className = 'tool-name'
  name.textContent = msg.name

  const detail = document.createElement('span')
  detail.className = 'tool-detail'
  detail.textContent = msg.detail || ''

  const status = document.createElement('span')
  status.className = 'tool-status'
  status.textContent = '…'

  row.append(name, detail, status)
  log.appendChild(row)
  return { row, status }
}

function setToolStatus(entry, status, stats) {
  entry.row.className = `tool ${status}`
  entry.status.textContent = status === 'ok' ? '✓' : status === 'denied' ? 'denied' : '✕'

  if (!stats) return
  const summary = document.createElement('span')
  summary.className = 'tool-diff'
  if (stats.created) {
    summary.textContent = `new file +${stats.added}`
  } else {
    const parts = []
    if (stats.added) parts.push(`+${stats.added}`)
    if (stats.removed) parts.push(`−${stats.removed}`)
    summary.textContent = parts.length ? parts.join(' ') : 'no change'
  }
  entry.row.insertBefore(summary, entry.status)
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
    } else if (entry.type === 'error') {
      bubble('error').textContent = entry.text
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
      current = bubble('assistant')
      buffer = ''
      break

    case 'delta':
      if (!current) {
        current = bubble('assistant')
        buffer = ''
      }
      buffer += msg.text
      render(current, buffer)
      scroll(false)
      break

    case 'assistantEnd':
      current = null
      break

    case 'tool': {
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
      break
    }

    case 'notice': {
      const el = bubble('notice')
      el.textContent = msg.text
      current = null
      break
    }

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
