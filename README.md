# Howard Agent

An AI coding assistant for VS Code that you can run for a whole class.

Students chat with an agent that reads, searches, edits and runs code in the
project folder they have open. The AI model is DeepSeek. Only one real DeepSeek
API key exists, and it stays on a small metering server that you run. Each
student gets their own revocable key, and each key has its own spending limit.

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

## Features

- **Chat inside VS Code.** Use the sidebar or an editor tab. Replies stream in
  token by token and render as markdown.
- **Tools that do real work.** The agent can read, list, find and search files,
  write and edit files, run shell commands, and ask you a clarifying question.
- **Asks before it changes anything.** It needs your approval before editing a
  file or running a command, and you choose how strict that is.
- **Undo per turn.** Every file the agent changed appears above the message
  box with **Keep** and **Undo** buttons. File paths are clickable and open at
  the changed line.
- **Budget display.** Shows how much of your key's budget is left.
- **Handles errors and long chats.** It retries on rate limits (429) and server
  errors (5xx). In long chats it trims old tool output instead of failing.
- **Metered backend.** A [LiteLLM](https://docs.litellm.ai/) proxy enforces a
  budget for each key, rate limits, and a spending cap for the whole server.
- **CLI with no dependencies.** The same agent runs in the terminal in about
  600 lines of Node. It works with DeepSeek, OpenAI, Groq, OpenRouter or a
  local Ollama model.
- **No build step.** Everything is plain JavaScript, with no `npm install`,
  bundler or framework.

## How it works

The system has two halves. The **gateway** is a server that only meters
tokens. The **agent** runs on each student's own laptop.

```
  GATEWAY — your server                    AGENT — student's laptop
  ┌──────────────────────────────┐         ┌─────────────────────────────────┐
  │  LiteLLM + Postgres + Redis  │         │  VS Code + Howard Agent         │
  │                              │         │                                 │
  │  1. check the student's key  │◄─HTTPS──┤  the agent loop runs here:      │
  │  2. check budget + rate limit│ sk-abc… │  reads, edits and greps files,  │
  │  3. add the real DeepSeek key│         │  runs shell commands, on THIS   │
  │  4. stream the reply back    │         │  machine, in the open folder    │
  │  5. record the spend         │         │                                 │
  └──────────────┬───────────────┘         └─────────────────────────────────┘
                 │
                 ▼                         Only the conversation crosses the
          api.deepseek.com                 network, including any file the
                                           agent has read. The server never
                                           browses a student's disk or runs
                                           their code.
```

**On the student's laptop:** the extension, the gateway's HTTPS address (you
build it in when you package the extension), and the student's own key.
Nothing else from the server is installed there.

**On the server:** the real DeepSeek key, the master key, and the database of
student keys and spending.

Because of this split, you can restart, move or redeploy the server without
touching any student's machine. The upstream key never leaves the server, so a
leaked student key costs at most that key's budget.

### The agent loop

Every coding agent is built around this loop. Here it is with the UI removed:

```js
while (true) {
  const reply = await streamChat({ messages, tools })   // ask the model
  messages.push(reply.assistantMessage)

  if (reply.toolCalls.length === 0) break               // no tools requested: done

  for (const call of reply.toolCalls) {                 // run each tool locally
    const result = await TOOLS[call.name].run(JSON.parse(call.arguments))
    messages.push({ role: 'tool', tool_call_id: call.id, content: result })
  }
}
```

The real version is [extension/src/loop.js](extension/src/loop.js). On top of
this loop it adds approval prompts, a limit of 60 steps per turn, and trimming
of old tool output when the conversation gets long.

### What gets sent to the model

The model remembers nothing between requests. The extension keeps the chat as
a list of messages and sends the whole list every time. One message from a
student can take several requests, one for each tool step, and each request
carries the full history.

| Part | What it holds |
|---|---|
| System prompt | Fixed instructions, the open folder's full path and the operating system. It has no file listing. |
| Editor note | The name of the file open in the editor, and the selected text if there is any (up to 4000 characters). Replaced on every message. |
| Earlier messages | What the student typed and what the model replied, including its tool calls. Code the model writes is part of these. |
| Tool results | The output of every tool that has run: file contents, search results, command output. |
| Tool list | The name, description and inputs of the eight tools. The same on every request. |

The model only sees the files it chooses to read. It finds out what is in the
project by calling `list_dir` and `glob_files`.

This has three consequences:

- **Any file the agent reads goes through the gateway to DeepSeek.** That
  includes files such as `.env` if the agent decides to read them.
- **Long chats cost more,** because each request sends the history again.
  Start a **New Chat** when you switch to an unrelated task.
- **The folder's full path is sent,** and it often contains the user's name,
  for example `C:\Users\ali\todo-app`.

The student's key goes to the gateway in the request header, and the gateway
swaps it for the real one, so DeepSeek never sees it. Undo copies, token
counts and settings stay on the laptop.

### Tools

| Tool | What it does | Asks first |
|---|---|---|
| `read_file` | Read a file, with line numbers | no |
| `list_dir` | List a directory | no |
| `glob_files` | Find files by pattern, e.g. `**/*.py` | no |
| `grep` | Search file contents with a regex | no |
| `ask_user` | Ask you a question with 2–4 suggested answers | no |
| `write_file` | Create or overwrite a file | **yes** |
| `edit_file` | Replace text in an existing file | **yes** |
| `run_command` | Run a shell command (PowerShell on Windows) | **yes** |

File tools only work inside the open folder. A path that tries to get out with
`..` is rejected. Shell commands are **not** limited this way (see
[Security](#security)).

## Repository layout

```
.
├── extension/          VS Code extension: the agent students use
│   ├── src/
│   │   ├── extension.js   VS Code wiring: webview, commands, key storage, approvals
│   │   ├── loop.js        the agent loop and system prompt
│   │   ├── llm.js         streaming client, retries, budget lookup
│   │   └── tools.js       the eight tools
│   └── media/             chat UI (HTML/CSS/JS, uses VS Code theme colours)
├── howard-agent/       CLI version of the same agent; also the backend test client
├── railway/            gateway deployment on Railway (Dockerfile + LiteLLM config)
├── vps/                gateway deployment on your own server (Docker Compose + Caddy)
├── students.sh         admin script: create, list, top up, block keys; health check
├── test-as-student.mjs opens the packaged extension in a clean VS Code, as a student sees it
├── admin.env.example   settings template for students.sh
└── STUDENT-SETUP.md    one-page install guide to send each student
```

Each folder has its own README with more detail.

## Getting started

Pick the path that matches what you want to do:

| You want to… | Path | Time |
|---|---|---|
| Try the agent with your own key | [1. CLI](#1-run-the-cli) | 2 min |
| Work on the extension | [2. Extension from source](#2-run-the-extension-from-source) | 5 min |
| Run it for a class | [3. Full deployment](#3-deploy-for-a-class) | 30 min |
| Check what students get | [4. Test as a student](#4-test-the-extension-as-a-student) | 2 min |

### Prerequisites

- **Node.js 18+** for the CLI. The extension runs inside VS Code and needs
  nothing extra.
- **VS Code 1.85+**
- **A DeepSeek API key** from [platform.deepseek.com](https://platform.deepseek.com)
- **For deployment only:** a [Railway](https://railway.app) account, or a VPS
  with Docker and a domain name. To run `students.sh` you also need `bash`,
  `curl`, `jq` and `openssl`. On Windows, use WSL (Ubuntu), which usually has
  them already (`sudo apt install jq` if not). Git Bash also works once you run
  `winget install jqlang.jq`.

### 1. Run the CLI

```bash
git clone https://github.com/HowardHoJiaHao/CodingAgentVersion2.git
cd CodingAgentVersion2/howard-agent

cp .env.example .env      # then paste your DeepSeek key into .env
node selftest.mjs         # 16 checks, offline, costs nothing
node agent.mjs            # chat with the agent in the current directory
```

| Flag | Effect |
|---|---|
| `--cwd <path>` | Work in another folder (default: current directory) |
| `-p "<prompt>"` | Run one prompt and exit |
| `--provider <name>` | `deepseek` (default), `openai`, `groq`, `openrouter`, `ollama` |
| `--model <name>` | Override the provider's default model |
| `--yolo` | Skip approval prompts. Only use this in a repo you can reset with `git checkout`. |

Commands inside the REPL: `/help` `/clear` `/tools` `/model` `/cost` `/exit`.
Press Ctrl+C to interrupt a reply and Ctrl+D to quit.

To send the CLI through your gateway instead of straight to DeepSeek, set
`AGENT_BASE_URL=https://<your-gateway>/v1` and use a student key as
`DEEPSEEK_API_KEY`.

To test for free with a local model, run [Ollama](https://ollama.com) and use
`--provider ollama`. Use a model of 7B or larger, such as
`ollama pull qwen2.5-coder:7b`. Very small models (around 1–2B) usually can't
use the tools and just reply with text.

### 2. Run the extension from source

1. Open the repository folder in VS Code. Opening `extension/` on its own also
   works.
2. Press **F5**. A second window opens (the Extension Development Host) with
   the extension loaded from source.
3. In that window, go to **Settings → Howard Agent → Endpoint** and set your
   gateway URL, ending in `/v1`.

   > For a quick test without a gateway, use `https://api.deepseek.com/v1` with
   > your own DeepSeek key. The budget display stays empty, but everything else
   > works.
4. `Ctrl+Shift+P` → **Howard Agent: Sign In** → paste your key.
5. Open a folder, click the **`< • >`** icon in the Activity Bar, and start
   chatting.

### 3. Deploy for a class

Do these steps in order. You can check each one before moving on.

**Step 1: Generate the server secrets.**

```bash
echo "LITELLM_MASTER_KEY=sk-$(openssl rand -hex 32)"
echo "LITELLM_SALT_KEY=$(openssl rand -hex 32)"
```

Save the salt key somewhere safe. If you change it later, every stored key
becomes unreadable.

**Step 2: Deploy the gateway.** Choose one option:

|  | [railway/](railway/README.md) | [vps/](vps/README.md) |
|---|---|---|
| Setup | ~10 min, managed for you | ~30 min, you look after the server |
| Cost | Pay per use, usually more | ~$5/month |
| TLS | Automatic | Automatic (Caddy + Let's Encrypt) |
| Admin API | Public, protected by the master key only | **Restricted to your IP address** |

Follow the README in the folder you choose.

> **Railway free plan:** Railway only accepts free-plan services that are
> serverless. Open your service → **Settings** → turn on **Serverless** → click
> **Deploy** to apply it. The server then sleeps after about 10 minutes without
> traffic, and the first request after that is slow while it wakes up.

**Step 3: Check the deployment** before you give anyone a key. Start with a
quick look from any terminal:

```bash
curl https://<your-gateway>/health/liveliness   # → "I'm alive!"
curl https://<your-gateway>/health/readiness    # → {"status":"healthy","db":"connected"}
curl https://<your-gateway>/v1/models           # → 401: requests without a key are refused
```

Then run the full check. Copy the settings template and fill it in. On Railway,
your master key is under your service → **Variables** → `LITELLM_MASTER_KEY`.

```bash
cp admin.env.example admin.env      # set PROXY and LITELLM_MASTER_KEY
./students.sh check                 # ends with "All good. Safe to hand out keys."
```

This checks that the server is reachable, the master key works, the models are
configured, a real completion succeeds, streaming works, tool calling works,
and **spend is recorded**. The last check matters most. If metering is broken,
students use your tokens for free.

**Step 4: Test end to end with the CLI.**

```bash
./students.sh new test 1            # prints a key with a $1 budget

AGENT_BASE_URL=https://<your-gateway>/v1 \
DEEPSEEK_API_KEY=<the key it printed> \
node howard-agent/agent.mjs
```

If the reply streams and the agent can edit a file, the backend is working.

**Step 5: Package the extension.**

1. Set the default `howardAgent.endpoint` in
   [extension/package.json](extension/package.json) to your gateway URL ending
   in `/v1`. This way students don't have to enter it.
2. Package it:

   ```bash
   npm install -g @vscode/vsce
   cd extension && vsce package      # → howard-agent-0.1.0.vsix
   ```

   If `vsce` asks about a missing `repository` field, answer `y`.
3. Try the package the way a student will. See
   [4. Test the extension as a student](#4-test-the-extension-as-a-student).

**Step 6: Onboard students.** Send each student three things:

- the `.vsix` file, which is the same for everyone
- their own key, created with `./students.sh new <name> <budget>`. Send it
  privately. It is shown only once, so make a new one if it's lost.
- [STUDENT-SETUP.md](STUDENT-SETUP.md)

The `.vsix` is a VS Code add-on, not a separate program. Students install it
inside VS Code with `Ctrl+Shift+P` → **Extensions: Install from VSIX...** →
pick the file. Then they reload, sign in with **Howard Agent: Sign In** and
open a folder. They don't
need Node or anything else. To ship an update, rebuild the `.vsix` and send it
again. Installing it replaces the old version. Never send `admin.env`,
`students.sh` or the `extension/` folder itself.

### 4. Test the extension as a student

F5 runs the extension from source, inside your own VS Code setup. Before you
send the `.vsix`, test the exact file students get in a clean VS Code:

```bash
node test-as-student.mjs                   # package the .vsix, install it, open a separate VS Code
node test-as-student.mjs "C:\my project"   # the same, but open your own folder
node test-as-student.mjs --reset           # start over: signed out, like a new student
node test-as-student.mjs --no-build        # test the .vsix you already built
```

Options combine, for example `node test-as-student.mjs --reset "C:\my project"`.

You can also pick **Test as student** in the **Run and Debug** panel and press
F5.

The window that opens has its own settings and extensions folder, so nothing
from your own VS Code carries over: no settings, no other extensions, no
signed-in key. Without a folder name, it opens an empty practice folder inside
the test profile. `--reset` deletes that practice folder along with the
profile, so keep real work in your own folder. It never deletes a folder you
name. In that window:

1. If VS Code asks whether you trust the folder, choose **Yes, I trust the
   authors**. The extension doesn't run in Restricted Mode.
2. `Ctrl+Shift+P` → **Howard Agent: Sign In** → paste a student key, for
   example one made with `./students.sh new demo-student 1`.
3. Click the **`< • >`** icon and ask it to write some code.

The test profile is kept in your system's temp folder, outside the repository.

## Configuration

### Extension settings

| Setting | Default | Description |
|---|---|---|
| `howardAgent.endpoint` | (set in `package.json`) | Gateway URL. Must end in `/v1`. |
| `howardAgent.model` | `deepseek-chat` | `deepseek-chat` (V3) is the one to use for agent work. `deepseek-reasoner` (R1) reasons more but is less reliable at calling tools. |
| `howardAgent.autoApprove` | `never` | `never` asks every time. `edits` approves file edits automatically (they stay inside the folder) but still asks for commands. `always` asks for nothing. |

The student's key is kept in VS Code's SecretStorage, which is the operating
system's keychain. It is never written to `settings.json`.

Commands: **Sign In**, **Sign Out**, **New Chat**, **Open Chat in Editor**.

### Gateway environment variables

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | The real upstream key. This is what costs money. |
| `LITELLM_MASTER_KEY` | Admin credential. It can create keys and use the model with **no budget limit**. |
| `LITELLM_SALT_KEY` | Encrypts credentials stored in Postgres. Set it once and never change it. |
| `DATABASE_URL` | Postgres connection, which stores keys and spend |
| `REDIS_URL`, or `REDIS_HOST` + `REDIS_PORT` | Redis connection, used for rate limiting |
| `STORE_MODEL_IN_DB` | `True` |
| `POSTGRES_PASSWORD`, `DOMAIN`, `ACME_EMAIL` | VPS only. See [vps/.env.example](vps/.env.example). |

[`config.yaml`](vps/config.yaml) refers to these by name
(`os.environ/NAME`), so the values never appear in a file.

### Limits

| Limit | Value | Set in | Why |
|---|---|---|---|
| Budget per key | chosen per student | `students.sh new` | what the student paid for |
| Budget period | 30 days | `students.sh` | resets automatically |
| Parallel requests per key | 5 | `students.sh` | caps how far a budget can be overshot |
| Requests per minute per key | 60 | `students.sh` | stops one key from overloading the server |
| `max_tokens` per request | 8000 | `config.yaml` | caps the cost of one runaway reply |
| Total spend for the whole server | $500 / 30 days | `config.yaml` | emergency cap if the master key leaks |

## Managing students

[students.sh](students.sh) runs on your own machine and talks to the gateway's
admin API. It needs only `admin.env` (the gateway URL and master key), never
the DeepSeek key.

```bash
./students.sh check              # check the deployment
./students.sh new ali 5          # $5 every 30 days; prints the key to send
./students.sh list               # everyone, with spend so far
./students.sh show ali           # details for one student
./students.sh topup ali 10       # raise the budget to $10
./students.sh block ali          # suspend, keeping history
./students.sh unblock ali
./students.sh delete ali         # remove permanently
./students.sh spend              # spend per student, with totals
```

## How spend is calculated

The gateway works out the cost of every request. `students.sh` and the
extension's budget display only show the totals it records.

### The formula

For every request, DeepSeek reports how many tokens it used. **Input** tokens
are everything that was sent: the chat history, file contents and the tool
list. **Output** tokens are what the model wrote. LiteLLM multiplies each by a
fixed rate:

```
cost = input tokens × input rate + output tokens × output rate
```

### The rates are preset

You don't enter prices anywhere, not per student and not per request. LiteLLM
has a built-in price list for every model and applies it automatically. This
deployment charged:

| Token type | Rate per token | Rate per million tokens |
|---|---|---|
| Input | $0.00000015 | $0.15 |
| Output | $0.0000006 | $0.60 |

These rates were measured from the gateway's request logs in October 2026. The
price list ships inside the LiteLLM image, so the rates can change when the
image updates. To choose them yourself, see
[Setting your own rates](#setting-your-own-rates).

### Example: one short question

This is a real request from a test key. It used 1,109 input tokens and 48 output
tokens:

| | Tokens | × Rate | = Cost |
|---|---|---|---|
| Input | 1,109 | $0.00000015 | $0.00016635 |
| Output | 48 | $0.0000006 | $0.0000288 |
| **Total** | | | **$0.00019515** |

`./students.sh spend` rounds this to `$0.0002`.

### Example: a coding task

One message from a student can take several requests, one for each tool step,
and each request sends the whole chat again (see
[What gets sent to the model](#what-gets-sent-to-the-model)). Suppose a task
takes 10 requests that average 8,000 input tokens and 300 output tokens each:

| | Tokens | × Rate | = Cost |
|---|---|---|---|
| Input | 10 × 8,000 = 80,000 | $0.15 per million | $0.0120 |
| Output | 10 × 300 = 3,000 | $0.60 per million | $0.0018 |
| **Total** | | | **$0.0138** |

At that size, a $5 budget covers about 360 tasks. These examples ignore
DeepSeek's cheaper rate for input it has cached from earlier requests, so actual
costs can be lower.

### How it adds up

Each request's cost is added to that student's running total. Before every
request, LiteLLM checks that the total is below the student's budget, and
refuses the request if it isn't. On the reset date, the total goes back to $0.

`./students.sh spend` shows those totals:

| Column | Meaning |
|---|---|
| `SPENT` | The student's running total for this budget period |
| `BUDGET` | The student's limit |
| `LEFT` | `BUDGET` minus `SPENT`, never below $0 |
| `RESETS` | The date the budget period starts again |
| `TOTAL` | Each column added up across all students |
| `Whole server` | Every request, including `check` runs and deleted keys, against the $500 cap |

To see the tokens and cost of each request:

```bash
curl "https://<your-gateway>/spend/logs?summarize=false&start_date=2026-10-01&end_date=2026-10-31" \
  -H "Authorization: Bearer <your master key>"
```

### Setting your own rates

Budgets are only accurate if the preset rates match what DeepSeek charges you.
Check DeepSeek's current prices before you charge students. To set the rates
yourself, add them to each model in `railway/config.yaml` (or `vps/config.yaml`)
and redeploy:

```yaml
  - model_name: deepseek-chat
    litellm_params:
      model: deepseek/deepseek-chat
      api_key: os.environ/DEEPSEEK_API_KEY
      max_tokens: 8000
      input_cost_per_token: 0.00000028    # example value: use DeepSeek's current price
      output_cost_per_token: 0.00000042   # example value: use DeepSeek's current price
```

## Guardrails

There are two kinds. **Instructions in the system prompt** ask the model to
behave a certain way. It usually does, but nothing enforces them, and text in a
file the agent reads can steer it away from them. **Checks in the code** run
every time, whatever the model says.

### Instructions in the system prompt

The full prompt is in [extension/src/loop.js](extension/src/loop.js). It tells
the model to:

- say it is Howard Agent running on DeepSeek when asked what it is
- use its tools instead of guessing or asking the student to paste code
- read a file before changing it, and prefer `edit_file` over rewriting the
  whole file with `write_file`
- run the tests or build after a change
- fix the cause when a command fails instead of retrying it
- make ordinary decisions itself, and use `ask_user` only when the answer
  changes what it builds
- keep answers short and say when it's done

The prompt has no rules about harmful requests, secrets or dangerous commands.

### Checks in the extension

| Guardrail | What it does | Code |
|---|---|---|
| Approval prompt | `write_file`, `edit_file` and `run_command` wait for the student to click **Allow**. If they refuse, the model is told to stop and ask what they want instead. **Always in this chat** stops asking for that tool until the chat is cleared. | `extension.js` |
| Folder limit | File tools reject any path outside the open folder. | `tools.js` |
| Commands still ask | **Auto-approve edits** skips the prompt only for the file tools. `run_command` still asks, and warns that it isn't limited to the folder. | `extension.js` |
| Step limit | A message stops after 60 requests to the model. | `loop.js` |
| Command timeout | A command is killed after 2 minutes by default, or 10 minutes at most. | `tools.js` |
| Output limits | A tool result is cut off at 30,000 characters. `read_file` returns up to 2000 lines, `grep` up to 200 matches and `glob_files` up to 500 files. | `tools.js` |
| Context trimming | At about 55k tokens, the oldest large tool results are replaced with a short placeholder. | `loop.js` |
| Selection limit | The editor note sends at most 4000 characters of selected text. | `extension.js` |
| Bad tool calls | An unknown tool name or broken arguments run nothing. The model gets an error message instead. | `loop.js` |
| Undo | **Undo** puts every changed file back the way it was before the agent touched it. Files over 1 MB can't be undone, and then the button is hidden. | `extension.js`, `tools.js` |
| Plain-text display | The chat window shows the model's output as text, never as HTML, so any markup it writes can't run. | `media/main.js` |
| Key storage | The key is kept in the operating system's keychain, never in `settings.json`. | `extension.js` |

The CLI has the same approval prompt, folder limit, step limit, command timeout
and 30,000-character output limit. `--yolo` turns its approval prompt off. When
it has no terminal to ask on, it refuses instead.

### Checks on the gateway

These limit cost rather than behaviour. The values are in [Limits](#limits).

| Guardrail | What it does | Set in |
|---|---|---|
| Key check | Requests with an unknown, blocked or deleted key are refused. | LiteLLM |
| Budget per key | Requests are refused once a student's budget for the period is used up. | `students.sh` |
| Model list | Each key can use only `deepseek-chat` and `deepseek-reasoner`. | `students.sh` |
| Rate limits | 5 requests at once and 60 per minute for each key. | `students.sh` |
| Reply size | One reply is capped at 8000 tokens. | `config.yaml` |
| Server-wide cap | All keys together stop at $500 every 30 days. | `config.yaml` |
| Admin lock | On the VPS, the admin pages answer only your IP address, once you've set it. | `Caddyfile` |

### What is not covered

- **No content filter.** Nothing checks what a student asks for or what the
  model writes. That is left to DeepSeek's own training.
- **No command sandbox or blocklist.** The approval prompt is the only check
  on `run_command`.
- **No defence against prompt injection.** Text in a file the agent reads can
  steer the model away from its instructions.
- **No secret filter.** The agent can read a `.env` file and send it to
  DeepSeek like any other file.
- **Symbolic links.** The folder limit checks the path as written, so a link
  inside the folder that points outside it is followed.
- **Stop doesn't end a running command.** It cancels the model's reply, but a
  command that has started runs until it finishes or times out.
- **Approval can be turned off.** **Auto-approve all** in the extension, and
  `--yolo` in the CLI, skip every prompt.

## Security

**Where each secret lives:**

| Secret | Server | `admin.env` (your machine) | Student | Git |
|---|---|---|---|---|
| `DEEPSEEK_API_KEY` | ✅ | ❌ | ❌ | ❌ |
| `LITELLM_MASTER_KEY` | ✅ | ✅ | ❌ | ❌ |
| `LITELLM_SALT_KEY` | ✅ | ❌ | ❌ | ❌ |
| Student key | stored, hashed | ❌ | ✅ their own | ❌ |

`.env`, `.env.*` and `admin.env` are listed in `.gitignore`. Only the
`*.example` templates are committed, and they contain placeholders only.

Keep these in mind:

- **The master key is like a root password.** Anyone who has it can create
  unlimited credit on your DeepSeek account. On the VPS, Caddy blocks the
  admin routes for every IP address except yours. Railway has no such layer,
  so there the master key is the only protection.
- **`run_command` is not sandboxed.** Shell commands run with the student's
  normal user permissions and can reach outside the project folder. Only the
  file tools are limited to the workspace. The approval prompt is the safety
  check, so read it before clicking Allow.
- **Prompt injection is not handled.** Text inside a repository the agent reads
  can steer what it does with its tools.
- **If a secret is ever committed, rotate it.** Deleting it from git history is
  not enough once it has been pushed.

## Before charging money

- **Read DeepSeek's developer terms on reselling.** Some providers restrict
  reselling API access, and a setup where students pay you while you relay
  their requests to DeepSeek is what those clauses target. If that is a
  problem, switch to bring-your-own-key: students use their own DeepSeek key
  and you charge for the tooling. The code works the same either way.
- **Check that billing survives a disconnect.** Start a long streaming request,
  kill it after two seconds, then run `./students.sh show <name>`. If spend
  didn't go up, pressing Ctrl+C makes requests free.
- **Check the token rates.** Make sure the preset rates match DeepSeek's
  current prices (see [Setting your own rates](#setting-your-own-rates)).
  Otherwise student budgets won't match your real bill.
- **Expect small budget overshoots.** LiteLLM checks the budget before each
  request but doesn't reserve it, so parallel requests can go slightly over.
  The worst case is about 5 parallel requests × 8000 tokens, which is cents.
  Measure it rather than trusting the arithmetic.

## Known limitations

- `run_command` is not sandboxed (see [Security](#security)).
- Nothing defends against prompt injection.
- On Windows, commands run through PowerShell, so bash syntax from the model
  can fail.
- The CLI has no retries and doesn't trim long chats. The extension does both.
- There is a single gateway with no failover. If it goes down, every student is
  affected.
- On Railway's free plan the gateway sleeps when idle, so the first request
  after a quiet period is slow.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Key rejected" (401) | Key is mistyped, blocked or deleted. Run **Sign In** again. |
| "Budget used up" | Run `./students.sh topup <name> <amount>` |
| Replies appear all at once instead of streaming | The proxy is buffering. Check `flush_interval -1` in the [Caddyfile](vps/Caddyfile). |
| LiteLLM won't start | A config key was rejected. Compare `config.yaml` with the [LiteLLM docs](https://docs.litellm.ai/docs/proxy/configs). |
| VPS TLS certificate never issues | DNS doesn't point at the server yet, or port 80 is blocked |
| Railway shows only "Starting Container" | Check the deploy logs. `PYTHONUNBUFFERED=1` is already set so crash messages appear. |
| Railway: `"Application not found"` (404) | The service isn't running. Check your plan and credits, turn on **Serverless** if you're on the free plan, then **Redeploy**. |
| Railway: `"Application failed to respond"` (502) | LiteLLM crashed, or it listens on a different port from the domain. In the **Deploy Logs**, find `Uvicorn running on http://0.0.0.0:<port>` and set the same port on the domain (**Settings → Networking**). Also check that Postgres and Redis are running. |
| First reply after a quiet period is slow | The server was asleep (Serverless) and is waking up. Later replies are normal speed. |
| `No admin.env here` | Run `cp admin.env.example admin.env`, then fill it in |
| `master key rejected` | `LITELLM_MASTER_KEY` in `admin.env` doesn't exactly match the server's |

## License

[MIT](LICENSE) © 2026 Howard Ho Jia Hao
