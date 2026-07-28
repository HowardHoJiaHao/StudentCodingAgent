# Student coding-agent service

Your DeepSeek key lives in exactly one place. The agent itself runs on the
student's laptop, not on your server.

```
  YOUR SERVER — a metering gateway          STUDENT LAPTOP — where the agent runs
  ┌──────────────────────────────┐          ┌─────────────────────────────────┐
  │  LiteLLM + Postgres + Redis  │          │  VS Code + extension/           │
  │                              │          │                                 │
  │  validate the student's key  │◄─ HTTPS ─┤  THE AGENT LOOP RUNS HERE:      │
  │  check budget + rate limit   │  sk-abc  │  reads, edits, greps files and  │
  │  attach YOUR DeepSeek key    │          │  runs shell commands on THIS    │
  │  stream back, record spend   │          │  machine, in their workspace    │
  └───────────┬──────────────────┘          └─────────────────────────────────┘
              │
              ▼                              Only prompts and replies cross the
       api.deepseek.com                      network. Your server never touches
                                             a student's files or runs their code.

  KEYS                sk-deepseek-real-xxx   →  server env var, never leaves
                      sk-litellm-abc…        →  one per student, revocable
```

That split matters: the server is dumb infrastructure that meters tokens. All
the agent behaviour — the tool loop, the file edits, the shell — is local. You
can restart or migrate the server without touching a single student machine.

| Directory | What it is | Runs on |
|---|---|---|
| [vps/](vps/) | Self-hosted: LiteLLM + Caddy via Docker Compose | your server |
| [railway/](railway/) | Managed alternative — same stack, no Caddy | Railway |
| [extension/](extension/) | VS Code sidebar chat — **the agent** | student machines |
| [howard-agent/](howard-agent/) | CLI agent — your test client | anywhere |

Pick **one** of `vps/` or `railway/`:

|  | vps/ | railway/ |
|---|---|---|
| Setup | ~30 min, you manage the box | ~10 min, managed |
| Cost | ~$5/mo | usage-based, more |
| TLS | Caddy, automatic | Railway, automatic |
| Admin API | **IP-allowlisted** | public, master-key only |

The admin API difference is the real one — see
[railway/README.md](railway/README.md#the-security-difference--read-this).

## Where the DeepSeek key goes

**One place: `vps/.env` on the server.** Nowhere else. Not in the extension, not
on a student machine, not in git.

Students never receive a DeepSeek key. They get a *virtual key* issued by
LiteLLM that maps to a budget and a rate limit. If one leaks, you revoke that
key alone — your DeepSeek key is untouched and never needs rotating.

## Checklist

Do these in order. Each step is verifiable before you move on.

**1 — Secrets**

- [ ] Rotate your DeepSeek key if it has ever been pasted anywhere but the server
- [ ] `openssl rand -hex 32` → `LITELLM_MASTER_KEY` (prefix it `sk-`)
- [ ] `openssl rand -hex 32` → `LITELLM_SALT_KEY` — **set once**, changing it
      later makes existing student keys undecryptable
- [ ] Confirm `.gitignore` covers `.env` and `admin.env` before any `git init`

**2 — Deploy the server** — [railway/README.md](railway/README.md) or
[vps/README.md](vps/README.md)

- [ ] Push `railway/` to GitHub, create the Railway project
- [ ] Add Postgres and Redis services
- [ ] Set variables (`DEEPSEEK_API_KEY`, master key, salt key, the two
      `${{...}}` reference variables)
- [ ] Generate a domain

**3 — Verify before anyone gets a key**

```bash
cp admin.env.example admin.env      # proxy URL + master key
./students.sh check
```

Checks reachability, master key, model config, a real completion, streaming,
tool calling, and that **spend is actually recorded**. That last one is the one
that matters — if metering is broken, students burn your tokens for free.

**4 — Prove it with the CLI** before touching the extension

```bash
./students.sh new test 1

AGENT_BASE_URL=https://your-url/v1 \
DEEPSEEK_API_KEY=sk-the-key-it-printed \
node howard-agent/agent.mjs --provider deepseek
```

If that streams a reply and edits a file, the entire backend is correct.

**5 — Ship the extension** — [extension/README.md](extension/README.md)

- [ ] Set `howardAgent.endpoint` default in `extension/package.json` to your URL + `/v1`
- [ ] Open `extension/` in VS Code, press **F5**, try it in the dev host
- [ ] `npm install -g @vscode/vsce && vsce package`
- [ ] Send students the `.vsix` and their two lines (endpoint + key)

**6 — Before charging anyone**

- [ ] Read DeepSeek's developer terms on reselling (see below)
- [ ] Run the disconnect-billing test (see below)
- [ ] Decide your price against real observed cost, not a guess

## The three secrets

| Secret | What it does | Lives where |
|---|---|---|
| `DEEPSEEK_API_KEY` | your real upstream key — what actually costs money | **server only** |
| `LITELLM_MASTER_KEY` | admin credential: mints/revokes student keys, and can call the model with **no budget limit** | **server** + your `admin.env` |
| `LITELLM_SALT_KEY` | encrypts credentials LiteLLM stores in Postgres | **server only** |

None of them ever go in a file you push, in the extension, or to a student.
`config.yaml` refers to them as `os.environ/NAME` — a *reference* to the
variable, never the value.

Generate them yourself — never reuse an example from a doc:

```bash
openssl rand -hex 32                    # Git Bash / Linux / macOS
```
```powershell
$b = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
($b | ForEach-Object { '{0:x2}' -f $_ }) -join ''
```

**`LITELLM_MASTER_KEY`** — prefix it `sk-`. Anyone holding it can mint themselves
unlimited credit against your DeepSeek account, so treat it like the root
password. If it leaks: change it on the server, update `admin.env`. Student keys
are unaffected.

**`LITELLM_SALT_KEY`** — **set once and never change it.** It's the encryption
key for stored credentials; changing it makes everything encrypted under the old
one unreadable. Save a copy somewhere safe before you deploy. Your laptop never
needs it — `students.sh` doesn't use it.

## Pushing to GitHub

**One private repo for everything.** Railway builds from a subdirectory, so you
don't need to split anything out.

| Path | Push it? | Why |
|---|---|---|
| [railway/](railway/) | **required** | Railway builds from here |
| [extension/](extension/) | yes | version it; ship `.vsix` separately |
| [howard-agent/](howard-agent/) | yes | no secrets, MIT, yours |
| [vps/](vps/) | yes, minus `.env` | `.env` is gitignored |
| `students.sh`, `*.example` | yes | templates only |
| `vps/.env`, `admin.env` | **never** | your live secrets |
| `howardcodingAgent/` | **never** | not yours to redistribute |

Make it **private**. Not because the code is sensitive, but because your Railway
URL and setup would otherwise be public — no reason to hand anyone a target.

In Railway: **Service → Settings → Root Directory → `railway`**. It builds only
that folder and ignores the rest of the repo.

Before the first push, check what git actually staged:

```bash
git init && git add -A
git status --short | grep -Ei '\.env$|admin\.env|howardcodingAgent' && echo "STOP — secrets staged" || echo "clean"
git ls-files | xargs grep -lE 'sk-[a-f0-9]{20,}' 2>/dev/null && echo "STOP — key in a tracked file" || echo "no keys"
```

Both should report clean. If a secret ever does get committed, rotate the key —
removing it from history is not enough once it's been pushed.

## Running it day to day

```bash
./students.sh new ali 5      # Ali paid → prints the key to send them
./students.sh list           # everyone, with spend
./students.sh topup ali 10   # raise a budget
./students.sh block ali      # stopped paying
./students.sh check          # after any config change
```

Budgets reset every 30 days on their own, so a continuing student needs nothing
from you.

## Two things to do before charging anyone

**Read DeepSeek's developer terms.** Reselling API access is restricted by some
providers, and "students pay me, I relay to DeepSeek" is the pattern those
clauses target. If it's a problem, the fix is BYOK — students bring their own
key and you charge for the tooling instead. That changes what you sell, not how
any of this is built.

**Run these two tests** against your live proxy:

```bash
# 1. Does spend get recorded when a client disconnects mid-stream?
#    If not, Ctrl+C makes requests free and students will find out.
curl -N -X POST https://api.yourdomain.com/v1/chat/completions \
  -H "Authorization: Bearer sk-test-key" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"count to 500"}]}' &
sleep 2 && kill %1
./students.sh show test        # did spend go up?

# 2. Can parallel requests race past the budget?
#    Fire 10 at a key near its limit and see where it lands.
```

LiteLLM checks budget *before* a request but doesn't reserve, so some overshoot
is expected. `max_parallel_requests: 5` bounds it at roughly
`5 × 8000 output tokens` — cents, not dollars. Confirm that empirically rather
than trusting the arithmetic.

## Known gaps

Carried over honestly from what isn't built:

- **`run_command` is not sandboxed.** The agent runs shell commands with the
  student's own privileges. Real isolation needs containers or seccomp.
- **No context compaction.** Long chats grow until the model errors rather than
  degrading gracefully. `New Chat` is the workaround.
- **No retry/backoff.** A single upstream 429 or 5xx kills the turn.
- **Single VPS.** One box, no failover. If students depend on this for
  coursework, that's a real availability risk.
- **Prompt injection.** Text in a repo the agent reads can steer its tool calls.
  Open problem; nothing here defends against it.
