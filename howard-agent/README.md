# howard-agent

A coding agent in ~600 lines of plain JavaScript. Runs on **DeepSeek**, or any
OpenAI-compatible API. No dependencies, no build step, no framework.

```
› add a --version flag to the CLI

  grep version ok
  read_file src/cli.js ok

! edit_file src/cli.js
  allow? [y]es / [n]o / [a]lways: y
  edit_file src/cli.js ok
  run_command node src/cli.js --version ok

Added. `node src/cli.js --version` prints 0.1.0.
```

## Setup

Node 18+ is the only requirement. Get a key at
[platform.deepseek.com](https://platform.deepseek.com).

```bash
cd howard-agent
cp .env.example .env      # then paste your key into .env
node agent.mjs
```

Or set it in the shell instead of a `.env` file:

```powershell
$env:DEEPSEEK_API_KEY = "sk-your-key"      # PowerShell
```
```bash
export DEEPSEEK_API_KEY=sk-your-key        # bash
```

Verify the local half works without spending any tokens:

```bash
node selftest.mjs        # 16 checks, no network
```

## Usage

```bash
node agent.mjs                          # interactive, in the current directory
node agent.mjs --cwd ../my-project      # point it at another project
node agent.mjs -p "fix the failing test"  # one-shot, then exit
node agent.mjs --yolo                   # skip permission prompts
node agent.mjs --provider ollama        # local model instead
```

In the REPL: `/help` `/clear` `/tools` `/model` `/cost` `/exit`.
Ctrl+C interrupts a response, Ctrl+D quits.

## Tools

| Tool | Asks first |
|---|---|
| `read_file` `list_dir` `glob_files` `grep` | no |
| `write_file` `edit_file` `run_command` | yes |

Read-only tools run silently; anything that mutates prompts you first. `a`
allows that tool for the rest of the session. Pressing Enter denies — the safe
default. When stdin isn't a terminal the agent auto-denies rather than acting
unattended, so `-p` in a script needs `--yolo` to make changes.

File paths are resolved inside the workspace root and `..` escapes are rejected.
`run_command` is **not** sandboxed — it runs whatever the model asks. Read the
prompts, and don't use `--yolo` on anything you can't `git checkout`.

## Switching models

```bash
node agent.mjs --provider openrouter --model deepseek/deepseek-chat
node agent.mjs --provider groq
AGENT_BASE_URL=http://127.0.0.1:8080/v1 node agent.mjs --provider ollama
```

Providers live in one table at the top of [`llm.mjs`](llm.mjs). Adding one is a
base URL, an env var name, and a default model — they all speak the same
chat-completions wire format.

Notes: `deepseek-chat` (V3) is the one to use for agent work. `deepseek-reasoner`
(R1) exposes its chain of thought via `reasoning_content`, which is captured, but
its tool-calling support is weaker — expect it to be less reliable in the loop.

## How it works

Three files:

- **`llm.mjs`** — provider table and the streaming client. The fiddly part is
  reassembling tool calls, which arrive as fragments spread across many SSE
  chunks and have to be concatenated per `index`.
- **`tools.mjs`** — each tool is a JSON schema the model sees plus a `run()`
  executed locally. `mutates: true` is what triggers the permission prompt.
- **`agent.mjs`** — the REPL and the loop.

The loop, with the interface stripped away, is the whole idea:

```js
while (true) {
  const reply = await streamChat({ messages, tools })
  messages.push(reply.assistantMessage)

  if (reply.toolCalls.length === 0) break     // model is done, hand back to user

  for (const call of reply.toolCalls) {
    const result = await TOOLS[call.name].run(JSON.parse(call.arguments))
    messages.push({ role: 'tool', tool_call_id: call.id, content: result })
  }
}
```

That's it. Every coding agent is this loop; the difference between one and a
commercial product is the tools, the prompt, and a few hundred files of UI.

## Extending it

**Add a tool** — append to the array in `tools.mjs`:

```js
{
  name: 'git_diff',
  mutates: false,
  description: 'Show the current unstaged diff.',
  parameters: { type: 'object', properties: {} },
  async run(_args, { root }) {
    return TOOL_BY_NAME.run_command.run({ command: 'git diff' }, { root })
  },
}
```

The schema and dispatch table are derived from that array, so nothing else
changes.

**Change the personality** — edit `SYSTEM_PROMPT` in `agent.mjs`.

**Obvious next steps** — conversation history across runs, context compaction
when the transcript grows past the window, parallel execution of read-only
tools, an `AGENTS.md` the agent reads on startup for project conventions.

MIT.
