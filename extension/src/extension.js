/**
 * VS Code integration: chat UI, key storage, permission prompts.
 *
 * The student's key lives in SecretStorage (the OS keychain) — never in
 * settings.json, which syncs to GitHub and gets committed by accident.
 *
 * The chat renders in two places from one provider: the sidebar view and an
 * editor tab. Both share a transcript so they show the same conversation, and
 * the transcript is persisted to workspaceState — opening a folder reloads the
 * window and would otherwise throw the conversation away.
 */

'use strict'

const vscode = require('vscode')
const { runTurn, SYSTEM_PROMPT } = require('./loop')
const { fetchBudget } = require('./llm')

const KEY_SECRET = 'howardAgent.apiKey'
const STATE_MESSAGES = 'howardAgent.messages'
const STATE_TRANSCRIPT = 'howardAgent.transcript'
const STATE_TOKENS = 'howardAgent.tokens'

/**
 * autoApprove was a boolean before it became a three-way choice. A settings.json
 * written by the old build still holds true/false, so map those rather than
 * silently falling through to the default and changing behaviour on upgrade.
 */
function approvalMode(value) {
  if (value === true) return 'always'
  if (value === false || value == null) return 'never'
  return value === 'edits' || value === 'always' ? value : 'never'
}

function config() {
  const cfg = vscode.workspace.getConfiguration('howardAgent')
  return {
    endpoint: cfg.get('endpoint'),
    model: cfg.get('model'),
    autoApprove: approvalMode(cfg.get('autoApprove')),
  }
}

/**
 * What the student is looking at right now. The agent would otherwise have to
 * grep the workspace to rediscover it — slower, and it spends their budget.
 * Kept small on purpose: a path always, the selection only when there is one.
 */
function activeFileContext(root) {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.uri.scheme !== 'file') return null

  const full = editor.document.uri.fsPath
  const relative = full.startsWith(root) ? full.slice(root.length).replace(/^[\\/]/, '') : full

  const selection = editor.selection
  if (selection && !selection.isEmpty) {
    const text = editor.document.getText(selection)
    const capped = text.length > 4000 ? `${text.slice(0, 4000)}\n[selection truncated]` : text
    return (
      `The user is looking at ${relative}, lines ${selection.start.line + 1}-` +
      `${selection.end.line + 1}, with this selected:\n\n${capped}`
    )
  }
  return `The user currently has ${relative} open in the editor.`
}

function describe(name, args) {
  if (name === 'run_command') return args.command
  if (args && args.path) return args.path
  if (args && args.pattern) return args.pattern
  return ''
}

class ChatViewProvider {
  constructor(context) {
    this.context = context
    // Every live webview — the sidebar view and/or the editor panel. Messages
    // broadcast to all of them so the two stay in step.
    this.webviews = new Set()
    this.panel = null

    this.messages = context.workspaceState.get(STATE_MESSAGES) || null
    this.transcript = context.workspaceState.get(STATE_TRANSCRIPT) || []
    this.tokens = context.workspaceState.get(STATE_TOKENS) || { in: 0, out: 0 }

    this.always = new Set()
    this.controller = null
    this.pending = '' // assistant text streaming into the current bubble
    this.asks = new Map() // question id -> { resolve, reject }
    // Snapshots for Undo, in memory only: they can be large, and offering to
    // revert a file from a previous session would be a lie once it has been
    // edited by hand since.
    this.undoable = new Map() // batch id -> [{ path, before }]
  }

  /**
   * Open a file the agent touched, at the line it changed.
   *
   * Column One explicitly: the chat sits Beside, so without this the file
   * would replace the chat rather than appear next to it.
   */
  async openFile(relative, line) {
    const root = this.root
    if (!root) return

    const uri = vscode.Uri.joinPath(vscode.Uri.file(root), relative)
    try {
      const document = await vscode.workspace.openTextDocument(uri)
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      })

      if (line) {
        // Clamp: the file may have been edited by hand since.
        const index = Math.min(Math.max(0, line - 1), Math.max(0, document.lineCount - 1))
        const position = new vscode.Position(index, 0)
        editor.selection = new vscode.Selection(position, position)
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenter,
        )
      }
    } catch {
      vscode.window.showWarningMessage(`Howard Agent: can't open ${relative} — it may have moved.`)
    }
  }

  /**
   * Put every file back as it was before this turn. Later edits to the same
   * file overwrite earlier snapshots in the map, so the value held is always
   * the state from before the turn began.
   */
  async undo(batchId) {
    const entries = this.undoable.get(batchId)
    if (!entries || !entries.length) return

    const root = this.root
    if (!root) return

    let restored = 0
    let failed = 0

    for (const { path: relative, before } of entries) {
      const target = vscode.Uri.joinPath(vscode.Uri.file(root), relative)
      try {
        if (before === null) await vscode.workspace.fs.delete(target, { useTrash: true })
        else await vscode.workspace.fs.writeFile(target, Buffer.from(before, 'utf8'))
        restored++
      } catch {
        failed++
      }
    }

    this.undoable.delete(batchId)
    this.post({ type: 'undone', id: batchId })

    const summary =
      `Reverted ${restored} file${restored === 1 ? '' : 's'}` +
      (failed ? `, ${failed} could not be restored` : '')
    this.transcript.push({ type: 'notice', text: summary })
    this.post({ type: 'notice', text: summary })
    this.save()
  }

  /**
   * Put a question to the user and wait for the answer.
   *
   * The tool call is suspended on this promise, so it must always settle:
   * Stop rejects it, and a reload clears it via failAsks(). Leaving it pending
   * would hang the turn with no way out.
   */
  ask(question, options) {
    const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    return new Promise((resolve, reject) => {
      this.asks.set(id, { resolve, reject })
      this.transcript.push({ type: 'ask', id, question, options, answer: null })
      this.post({ type: 'ask', id, question, options })
    })
  }

  answer(id, value) {
    const entry = this.asks.get(id)
    if (!entry) return
    this.asks.delete(id)

    const record = this.transcript.find((e) => e.type === 'ask' && e.id === id)
    if (record) record.answer = value
    this.save()

    this.post({ type: 'answered', id, value })
    entry.resolve(value)
  }

  failAsks(reason) {
    for (const [, entry] of this.asks) entry.reject(new Error(reason))
    this.asks.clear()
  }

  save() {
    this.context.workspaceState.update(STATE_MESSAGES, this.messages)
    this.context.workspaceState.update(STATE_TRANSCRIPT, this.transcript)
    this.context.workspaceState.update(STATE_TOKENS, this.tokens)
  }

  post(message) {
    for (const webview of this.webviews) webview.postMessage(message)
  }

  reset() {
    this.failAsks('Chat cleared.')
    this.messages = null
    this.transcript = []
    this.always.clear()
    this.tokens = { in: 0, out: 0 }
    this.pending = ''
    this.save()
    this.post({ type: 'clear' })
  }

  /** Close off the assistant bubble being streamed, if any, into the transcript. */
  flush() {
    if (this.pending) {
      this.transcript.push({ type: 'assistant', text: this.pending })
      this.pending = ''
    }
  }

  /**
   * Wire a webview — used for both the sidebar view and the editor panel.
   * Replay happens on the webview's own 'ready' message rather than straight
   * after setting html: posts sent before its script attaches are dropped.
   */
  attach(webview) {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    }
    webview.html = this.html(webview)
    this.webviews.add(webview)

    webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        webview.postMessage({
          type: 'restore',
          entries: this.transcript,
          tokens: this.tokens,
          approval: config().autoApprove,
        })
        this.refreshBudget()
      } else if (msg.type === 'approval') {
        // Write it back to settings rather than holding it in the webview, so
        // the choice survives a reload and stays visible in the Settings UI.
        await vscode.workspace
          .getConfiguration('howardAgent')
          .update('autoApprove', msg.value, vscode.ConfigurationTarget.Global)
      } else if (msg.type === 'open') await this.openFile(msg.path, msg.line)
      else if (msg.type === 'undo') await this.undo(msg.id)
      else if (msg.type === 'answer') this.answer(msg.id, msg.value)
      else if (msg.type === 'send') await this.send(msg.text)
      else if (msg.type === 'stop') {
        this.failAsks('Stopped.')
        if (this.controller) this.controller.abort()
      }
      else if (msg.type === 'signin') await vscode.commands.executeCommand('howardAgent.setKey')
    })
  }

  /**
   * The Activity Bar icon is a shortcut to the editor tab, not a second place
   * to chat. Rendering the conversation twice in one window is confusing, and
   * a 300px-wide column is a poor fit for reading code, so the sidebar is a
   * launcher and the tab is the real UI.
   */
  resolveWebviewView(view) {
    view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] }
    view.webview.html = this.launcherHtml(view.webview)
    view.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'open') this.openInEditor()
    })

    this.openInEditor()
    // Fires when you click away to Explorer and back — reopen a tab the user
    // has since closed, so the icon always does the same thing.
    view.onDidChangeVisibility(() => {
      if (view.visible) this.openInEditor()
    })
  }

  /** Open the same chat as an editor tab, so it can sit beside your code. */
  openInEditor() {
    if (this.panel) {
      this.panel.reveal()
      return
    }

    this.panel = vscode.window.createWebviewPanel(
      'howardAgent.chatPanel',
      'Howard Agent',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        // Editor tabs are torn down when backgrounded unless we say otherwise.
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
      },
    )

    this.attach(this.panel.webview)

    this.panel.onDidDispose(() => {
      if (this.panel) this.webviews.delete(this.panel.webview)
      this.panel = null
    })
  }

  get root() {
    const folders = vscode.workspace.workspaceFolders
    return folders && folders.length ? folders[0].uri.fsPath : null
  }

  async approve(tool, args) {
    if (!tool.mutates) return true

    const mode = config().autoApprove
    if (mode === 'always') return true
    // "edits" trusts only the tools safePath() confines to the workspace.
    // run_command is not one of them, so it still asks.
    if (mode === 'edits' && tool.sandboxed) return true
    if (this.always.has(tool.name)) return true

    const detail = describe(tool.name, args)
    const choice = await vscode.window.showWarningMessage(
      `Allow ${tool.name}?`,
      {
        modal: true,
        detail: tool.sandboxed
          ? detail || JSON.stringify(args).slice(0, 300)
          : `${detail || JSON.stringify(args).slice(0, 300)}\n\n` +
            'Shell commands are not restricted to this folder and run with your ' +
            'full privileges.',
      },
      'Allow',
      'Always in this chat',
    )

    if (choice === 'Always in this chat') {
      this.always.add(tool.name)
      return true
    }
    return choice === 'Allow'
  }

  async send(text) {
    if (!text || !text.trim()) return

    const root = this.root
    if (!root) {
      this.post({ type: 'error', text: 'Open a folder first — the agent works inside a workspace.' })
      return
    }

    const apiKey = await this.context.secrets.get(KEY_SECRET)
    if (!apiKey) {
      this.post({ type: 'needkey' })
      return
    }

    // Rebuild the system prompt every turn rather than trusting the stored copy.
    // It ships with the extension and changes on upgrade, while this array is
    // persisted per workspace — a saved conversation would otherwise pin an old
    // build's instructions forever. The root can change between sessions too.
    if (!this.messages) {
      this.messages = [{ role: 'system', content: SYSTEM_PROMPT(root) }]
    } else if (this.messages[0] && this.messages[0].role === 'system') {
      this.messages[0].content = SYSTEM_PROMPT(root)
    } else {
      this.messages.unshift({ role: 'system', content: SYSTEM_PROMPT(root) })
    }

    // Attached as a system message rather than folded into the user's text, so
    // the transcript shows what they typed and nothing else.
    const context = activeFileContext(root)
    if (context) this.messages.push({ role: 'system', content: context })

    this.messages.push({ role: 'user', content: text })

    this.transcript.push({ type: 'user', text })
    this.post({ type: 'user', text })
    this.post({ type: 'busy', value: true })

    this.controller = new AbortController()
    let started = false

    // One undo batch per user turn, matching how people think about it: "put
    // back what it just did".
    const batchId = `batch-${Date.now()}`
    const snapshots = new Map() // path -> before, first write wins
    const touched = new Map() // path -> { added, removed, created }

    const ui = {
      onText: (chunk) => {
        if (!started) {
          started = true
          this.post({ type: 'assistantStart' })
        }
        this.pending += chunk
        this.post({ type: 'delta', text: chunk })
      },
      onToolStart: (name, args) => {
        const id = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        started = false // any following text starts a fresh bubble
        this.flush()
        const detail = describe(name, args)
        // Carried separately from `detail` so the UI knows this row points at a
        // real file and can make it clickable — grep's detail is a pattern, and
        // run_command's is a shell line.
        const file = args && typeof args.path === 'string' ? args.path : null
        this.transcript.push({ type: 'tool', id, name, detail, file, status: 'running' })
        this.post({ type: 'tool', id, name, detail, file })
        return id
      },
      onToolEnd: (id, status, _result, stats) => {
        const entry = this.transcript.find((e) => e.type === 'tool' && e.id === id)
        if (entry) {
          entry.status = status
          if (stats) entry.stats = stats
        }
        this.post({ type: 'toolEnd', id, status, stats })
      },
      onFileChange: (entry, stats) => {
        // Keep the earliest snapshot: undo means "before this turn", not
        // "before the last of several edits to the same file".
        if (!snapshots.has(entry.path)) snapshots.set(entry.path, entry.before)

        const running = touched.get(entry.path) || {
          added: 0,
          removed: 0,
          created: false,
          firstLine: null,
        }
        running.added += (stats && stats.added) || 0
        running.removed += (stats && stats.removed) || 0
        running.created = running.created || !!(stats && stats.created)
        // Earliest edit wins — that is the line to land on when the file opens.
        if (!running.firstLine && stats && stats.firstLine) running.firstLine = stats.firstLine
        touched.set(entry.path, running)
      },
      onRetry: (attempt, max) =>
        this.post({ type: 'notice', text: `Upstream busy — retrying (${attempt}/${max})…` }),
      onCompact: (trimmed, approxTokens) =>
        this.post({
          type: 'notice',
          text: `Trimmed ${trimmed} older tool result${trimmed === 1 ? '' : 's'} to stay within context (~${approxTokens.toLocaleString()} tokens).`,
        }),
      onUsage: (usage) => {
        this.tokens.in += usage.prompt_tokens || 0
        this.tokens.out += usage.completion_tokens || 0
        this.post({ type: 'usage', ...this.tokens })
      },
    }

    try {
      const { endpoint, model } = config()
      await runTurn({
        endpoint,
        apiKey,
        model,
        messages: this.messages,
        root,
        signal: this.controller.signal,
        ui,
        approve: (tool, args) => this.approve(tool, args),
        ask: (question, options) => this.ask(question, options),
      })
    } catch (err) {
      const text = err.name === 'AbortError' ? 'Stopped.' : err.message
      this.transcript.push({ type: 'error', text })
      this.post({ type: 'error', text })
    } finally {
      this.controller = null
      this.flush()

      if (touched.size) {
        const files = [...touched].map(([path, s]) => ({ path, ...s }))
        const totals = files.reduce(
          (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
          { added: 0, removed: 0 },
        )
        // Only offer Undo if we actually captured snapshots — a file too large
        // to snapshot must not get a button that would silently do nothing.
        const undoable = [...snapshots].map(([path, before]) => ({ path, before }))
        if (undoable.length) this.undoable.set(batchId, undoable)

        const change = {
          type: 'changes',
          id: batchId,
          files,
          ...totals,
          canUndo: undoable.length === files.length,
        }
        this.transcript.push(change)
        this.post(change)
      }

      this.save()
      this.post({ type: 'busy', value: false })
      this.post({ type: 'assistantEnd' })
      this.refreshBudget()
    }
  }

  /** Best-effort: the budget line is a nicety and must never break a turn. */
  async refreshBudget() {
    const apiKey = await this.context.secrets.get(KEY_SECRET)
    if (!apiKey) return
    const budget = await fetchBudget(config().endpoint, apiKey)
    if (budget) this.post({ type: 'budget', ...budget })
  }

  /** Sidebar contents: a signpost to the tab, in case it gets closed. */
  launcherHtml(webview) {
    const nonce = this.nonce()
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Howard Agent</title>
<style>
  body { padding: 16px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  p { opacity: 0.7; font-size: 0.9em; line-height: 1.5; }
  button {
    width: 100%; padding: 6px 12px; cursor: pointer; border: none; border-radius: 3px;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  }
</style>
</head>
<body>
  <p>Howard Agent opens as an editor tab so it can sit beside your code.</p>
  <button id="open">Open Chat</button>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi()
    document.getElementById('open').addEventListener('click', () =>
      vscode.postMessage({ type: 'open' }))
  </script>
</body>
</html>`
  }

  nonce() {
    return Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
        Math.floor(Math.random() * 62),
      ),
    ).join('')
  }

  html(webview) {
    const nonce = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
        Math.floor(Math.random() * 62),
      ),
    ).join('')

    const uri = (...parts) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...parts))

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri('media', 'style.css')}" rel="stylesheet">
<title>Howard Agent</title>
</head>
<body>
  <div id="log"></div>
  <div id="composer">
    <textarea id="input" rows="2" placeholder="Ask about your code…"></textarea>
    <div id="bar">
      <select id="approve" title="When to skip the approval prompt">
        <option value="never">Ask every time</option>
        <option value="edits">Auto-approve edits</option>
        <option value="always">Auto-approve all</option>
      </select>
      <span id="budget"></span>
      <span id="usage"></span>
      <button id="stop" hidden>Stop</button>
      <button id="send">Send</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${uri('media', 'main.js')}"></script>
</body>
</html>`
  }
}

function activate(context) {
  const provider = new ChatViewProvider(context)

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('howardAgent.chat', provider, {
      // Without this the sidebar webview is destroyed the moment you click
      // Explorer, and the conversation appears to vanish.
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand('howardAgent.openInEditor', () => provider.openInEditor()),

    vscode.commands.registerCommand('howardAgent.setKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'Howard Agent — sign in',
        prompt: 'Paste the key you were given',
        placeHolder: 'sk-...',
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) =>
          value && value.trim().startsWith('sk-') ? null : 'Keys start with "sk-"',
      })
      if (!key) return
      await context.secrets.store(KEY_SECRET, key.trim())
      provider.post({ type: 'status', text: 'Signed in.' })
      vscode.window.showInformationMessage('Howard Agent: signed in.')
    }),

    vscode.commands.registerCommand('howardAgent.signOut', async () => {
      await context.secrets.delete(KEY_SECRET)
      provider.reset()
      vscode.window.showInformationMessage('Howard Agent: signed out.')
    }),

    vscode.commands.registerCommand('howardAgent.newChat', () => provider.reset()),
  )
}

function deactivate() {}

module.exports = { activate, deactivate }
