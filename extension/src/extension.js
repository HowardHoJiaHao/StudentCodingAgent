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
        })
      } else if (msg.type === 'send') await this.send(msg.text)
      else if (msg.type === 'stop' && this.controller) this.controller.abort()
      else if (msg.type === 'signin') await vscode.commands.executeCommand('howardAgent.setKey')
    })
  }

  resolveWebviewView(view) {
    this.attach(view.webview)
    view.onDidDispose(() => this.webviews.delete(view.webview))
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

    if (!this.messages) this.messages = [{ role: 'system', content: SYSTEM_PROMPT(root) }]
    this.messages.push({ role: 'user', content: text })

    this.transcript.push({ type: 'user', text })
    this.post({ type: 'user', text })
    this.post({ type: 'busy', value: true })

    this.controller = new AbortController()
    let started = false

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
        this.transcript.push({ type: 'tool', id, name, detail, status: 'running' })
        this.post({ type: 'tool', id, name, detail })
        return id
      },
      onToolEnd: (id, status) => {
        const entry = this.transcript.find((e) => e.type === 'tool' && e.id === id)
        if (entry) entry.status = status
        this.post({ type: 'toolEnd', id, status })
      },
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
      })
    } catch (err) {
      const text = err.name === 'AbortError' ? 'Stopped.' : err.message
      this.transcript.push({ type: 'error', text })
      this.post({ type: 'error', text })
    } finally {
      this.controller = null
      this.flush()
      this.save()
      this.post({ type: 'busy', value: false })
      this.post({ type: 'assistantEnd' })
    }
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
