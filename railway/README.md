# Deploying on Railway

The managed alternative to [`../vps/`](../vps/). Railway runs the three services
and handles TLS, so there's no Caddy and no server to patch.

**Pick one path, not both.** Railway is faster to stand up and costs more per
month; the VPS is cheaper and gives you IP-level control of the admin API.

## What runs where

```
  RAILWAY PROJECT                          STUDENT LAPTOP
  ┌──────────────────────────┐             ┌────────────────────────┐
  │ ┌──────────────────────┐ │             │  VS Code + extension   │
  │ │ LiteLLM (this dir)   │◄├─── HTTPS ───┤                        │
  │ │  validate key        │ │   sk-abc    │  the AGENT LOOP runs   │
  │ │  check budget        │ │             │  HERE — reads, edits,  │
  │ │  attach YOUR key     │ │             │  greps, runs commands  │
  │ └───┬──────────┬───────┘ │             │  on THIS machine       │
  │     │          │         │             └────────────────────────┘
  │ ┌───▼────┐ ┌───▼─────┐   │
  │ │Postgres│ │  Redis  │   │             Only prompts and replies
  │ │ keys,  │ │  rate   │   │             cross the network. Your
  │ │ spend  │ │  limits │   │             server never executes any
  │ └────────┘ └─────────┘   │             student code.
  └──────────┬───────────────┘
             ▼
      api.deepseek.com
```

The server is a metering gateway. Nothing agentic happens on it.

## Deploy

Railway's template catalog changes, so this is the manual route — it works
regardless and is about ten minutes.

**1. Push this directory to GitHub** (its own repo, or a subdirectory you point
Railway's root at).

**2. Create the project and add Postgres + Redis**

New Project → Deploy from GitHub repo → pick it. Then **+ New → Database →
Postgres**, and again for **Redis**.

**3. Point the service at this folder**

Service → Settings → set **Root Directory** to `railway` if the repo has this as
a subdirectory. Railway picks up the `Dockerfile` automatically.

**4. Set the variables** — Service → Variables:

```
DEEPSEEK_API_KEY   = sk-your-real-deepseek-key
LITELLM_MASTER_KEY = sk-<openssl rand -hex 32>
LITELLM_SALT_KEY   = <openssl rand -hex 32>
STORE_MODEL_IN_DB  = True
DATABASE_URL       = ${{Postgres.DATABASE_URL}}
REDIS_URL          = ${{Redis.REDIS_URL}}
```

The last two are Railway **reference variables** — type them exactly, braces and
all, and Railway resolves them to the internal connection strings. Adjust the
service names if yours differ.

`LITELLM_SALT_KEY` encrypts stored credentials. **Changing it later makes
existing keys undecryptable.** Set it once, save a copy somewhere safe.

**5. Generate a domain** — Settings → Networking → Generate Domain. You'll get
something like `litellm-production.up.railway.app`. If it asks for a port, use
the one in the deploy log line `Uvicorn running on http://0.0.0.0:<port>`. If
the two don't match, every request gets `Application failed to respond` (502).

**6. On the free plan, turn on Serverless** — Settings → **Serverless** → on, then
click **Deploy** to apply the change. Railway refuses free-plan deployments
without it. The service then sleeps after ~10 minutes with no traffic and wakes
on the next request (see [Cost](#cost)).

**7. Check it's alive**

```bash
curl https://litellm-production.up.railway.app/health/liveliness   # "I'm alive!"
curl https://litellm-production.up.railway.app/health/readiness    # {"status":"healthy","db":"connected"}
```

If the domain answers `Application not found` (404), no service is running
behind it. That usually means the plan or credits ran out, or Serverless is off
on the free plan. Fix that, then **Deployments → ⋮ → Redeploy**.

## Managing students

[`../students.sh`](../students.sh) lives at the top level and drives either
deployment. Run it from your own machine — it never needs your DeepSeek key:

```bash
cd ..
cp admin.env.example admin.env
```

```ini
# admin.env
PROXY=https://litellm-production.up.railway.app
LITELLM_MASTER_KEY=sk-the-same-master-key-you-set-in-railway
```

Then verify the deployment **before** handing out a single key:

```bash
./students.sh check
```

That checks reachability, master key, model config, a real completion, streaming,
tool calling, and — most importantly — that spend is actually being recorded. If
metering is broken, students burn your tokens for free, and this is what catches
it.

```bash
./students.sh new ali 5
./students.sh list
```

## The security difference — read this

On the VPS, [`Caddyfile`](../vps/Caddyfile) restricts `/ui` and `/key/*` to your
IP. **Railway has no equivalent layer**, so your admin API is on the public
internet, guarded only by `LITELLM_MASTER_KEY`.

That key is real authentication and a 64-char hex secret is not guessable, so
this is acceptable — but it's one layer instead of two. Compensate:

- **Generate the master key with `openssl rand -hex 32`.** Never something you
  typed. Anyone who has it can mint themselves unlimited credit against your
  DeepSeek account.
- **Never put it in the extension**, a student-facing doc, or a screenshot.
- **Consider disabling the admin UI** and doing everything through
  `students.sh`, so there's no login page to find. Check your LiteLLM version
  for the current flag (`DISABLE_ADMIN_UI` at time of writing).
- **Keep `litellm_settings.max_budget: 500`** in `config.yaml` — the proxy-wide
  ceiling is what limits the damage if the master key ever does leak.

If that trade bothers you, use the VPS path. Docker Compose plus Caddy on a $5
box gets you IP allowlisting back.

## Cost

Railway bills usage across three services; Postgres and Redis run continuously,
so expect meaningfully more than a $5/mo VPS. For a handful of students the
convenience is usually worth it — check Railway's current pricing.

**The free plan works, with two catches.** Serverless is mandatory, so the
service sleeps when idle and the first request after a quiet period is slow —
to a student that looks like a hang. And the free allowance is small: when it
runs out, Railway stops the services and the domain answers
`Application not found`. For a class that depends on it, use a paid plan with
Serverless off.

## Verify before shipping the extension

Prove the backend with the CLI first:

```bash
AGENT_BASE_URL=https://litellm-production.up.railway.app/v1 \
DEEPSEEK_API_KEY=sk-key-from-students.sh \
node ../howard-agent/agent.mjs --provider deepseek
```

If that streams a reply, the whole server side is correct and the extension is
just packaging. Then set `howardAgent.endpoint` in
[`../extension/package.json`](../extension/package.json) to your Railway URL
with `/v1` on the end.
