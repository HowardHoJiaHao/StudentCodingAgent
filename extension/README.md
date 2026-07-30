# Howard Agent — VS Code extension

Sidebar chat that reads, searches, edits and runs code in the open workspace.
Talks to your proxy, never to DeepSeek directly.

## For you: build and ship it

Set the default endpoint first — students shouldn't have to type it:

```jsonc
// package.json → contributes.configuration
"howardAgent.endpoint": { "default": "https://api.yourdomain.com/v1" }
```

Try it before packaging: open this folder in VS Code and press **F5**. That
launches an Extension Development Host with the extension loaded. No build step
— it's plain CommonJS, no bundler, no `npm install`.

Package it:

```bash
npm install -g @vscode/vsce
vsce package          # → howard-agent-0.1.0.vsix
```

Send students the `.vsix`. They install with
**Extensions → ⋯ → Install from VSIX**, or:

```bash
code --install-extension howard-agent-0.1.0.vsix
```

Publishing to the Marketplace needs a publisher account; sending the file
directly is fine for a class and avoids review.

## For students: use it

1. Install the `.vsix`
2. `Ctrl+Shift+P` → **Howard Agent: Sign In** → paste the key
3. Open the Howard Agent icon in the activity bar
4. Open a project folder and ask it something

The key is stored in VS Code's SecretStorage, which is the OS keychain — not
`settings.json`, which syncs to GitHub and gets committed by accident.

## What it can do

| Tool | Asks first |
|---|---|
| `read_file` `list_dir` `glob_files` `grep` | no |
| `write_file` `edit_file` `run_command` | yes |

Read-only tools run silently. Anything that changes a file or runs a command
shows a modal first; **Always in this chat** allows that tool until the chat is
reset.

Settings under `howardAgent.*`:

- `endpoint` — proxy URL, must end in `/v1`
- `model` — `deepseek-chat` (use this) or `deepseek-reasoner`
- `autoApprove` — skip all prompts. Only in a repo you can `git checkout`.

## How it's put together

```
src/llm.js         streaming client — SSE parsing, tool-call reassembly
src/tools.js       the seven tools; `mutates: true` triggers the prompt
src/loop.js        the agent loop, UI behind callbacks
src/extension.js   VS Code wiring: webview, SecretStorage, modals
media/             webview UI, themed with var(--vscode-*)
```

`loop.js` and `tools.js` are the same design as the `howard-agent/` CLI in the
parent repository, so a fix in one ports directly. (Plain text, not a link — a
relative path out of this directory breaks once the extension is packaged.)

The loop, with the interface removed:

```js
while (true) {
  const reply = await streamChat({ messages, tools })
  messages.push(reply.assistantMessage)
  if (reply.toolCalls.length === 0) break
  for (const call of reply.toolCalls) {
    const result = await TOOLS[call.name].run(JSON.parse(call.arguments))
    messages.push({ role: 'tool', tool_call_id: call.id, content: result })
  }
}
```

Add a tool by appending to the array in `tools.js`; the schema list and dispatch
table derive from it.

## Known limits

- **`run_command` isn't sandboxed.** It runs with the student's privileges.
- **No context compaction** — long chats eventually error. Use **New Chat**.
- **No retry** on upstream 429/5xx; the turn fails.
- **Windows commands run through PowerShell**, so bash syntax from the model
  can fail. Tell students to mention their shell if it matters.
- **Chat isn't persisted** across window reloads.
