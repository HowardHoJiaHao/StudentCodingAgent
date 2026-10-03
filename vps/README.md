# The server

LiteLLM proxy behind Caddy, with Postgres for spend history and Redis for rate
limits. Your DeepSeek key lives here and only here.

## Before you start

- A VPS with Docker and the compose plugin (Hetzner CX22 or a $6 DigitalOcean
  droplet is plenty for hundreds of students)
- A domain with an **A record already pointing at the VPS** — Caddy needs this
  to issue the certificate
- Ports 80 and 443 open

## Deploy

```bash
scp -r vps/ you@your-vps:~/agent-service
ssh you@your-vps
cd ~/agent-service

cp .env.example .env
nano .env          # DeepSeek key, generated secrets, your domain
```

Generate the three secrets properly — don't invent them by hand:

```bash
echo "LITELLM_MASTER_KEY=sk-$(openssl rand -hex 32)"
echo "LITELLM_SALT_KEY=$(openssl rand -hex 32)"
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
```

`LITELLM_SALT_KEY` encrypts stored credentials. **Changing it later makes
existing keys undecryptable** — set it once and back it up.

```bash
docker compose up -d
docker compose logs -f litellm      # watch for a clean start
curl https://api.yourdomain.com/health/liveliness
```

TLS is automatic once DNS resolves. If the certificate fails, it's almost always
DNS not propagated or port 80 blocked.

## Lock down the admin surface

`Caddyfile` blocks `/ui` and `/key/*` to a single IP, and it currently reads
`1.2.3.4`. **Change it to your real IP before going live** — anyone who reaches
`/key/generate` with the master key can mint themselves unlimited credit.

```bash
curl ifconfig.me                          # your IP
nano Caddyfile                            # replace 1.2.3.4
docker compose restart caddy
```

Manage students over SSH rather than exposing the admin API at all — that's why
`students.sh` runs on the box.

## Managing students

The script lives at the top level and works against either deployment. Configure
it once with `admin.env` (see `../admin.env.example`) — it needs only the proxy
URL and the master key, never your DeepSeek key.

```bash
cd ..
./students.sh check            # verify everything before handing out keys
./students.sh new ali 5        # approve Ali for $5 / 30 days → prints their key
./students.sh list             # everyone, with spend so far
./students.sh show ali         # one student in detail
./students.sh topup ali 10     # raise a budget
./students.sh block ali        # stop them, keep the history
./students.sh unblock ali
./students.sh delete ali
./students.sh spend            # spend per student, with totals
```

`jq` is required for anything that looks a student up by name:
`apt install -y jq`.

Send a student exactly two lines:

```
Endpoint:  https://api.yourdomain.com/v1
Key:       sk-...
```

## What the limits do

Set in `students.sh` when a key is created, and in `config.yaml` globally.

| Setting | Value | Why |
|---|---|---|
| `max_budget` | $5 | what they paid for |
| `budget_duration` | 30d | auto-resets; no work from you |
| `max_parallel_requests` | 5 | **your real cost ceiling** — see below |
| `rpm_limit` | 60 | protects the box from one noisy key |
| `max_tokens` (config.yaml) | 8000 | caps a single runaway request |
| `max_budget` (config.yaml) | $500 | proxy-wide kill switch |

Sharing keys with friends is fine by design — the budget is the constraint, not
identity. Twenty students on one key burn the same $5, just faster. That's also
what makes a leaked key a $5 problem instead of an unbounded one.

Because LiteLLM checks budget before a request without reserving, concurrent
requests can overshoot slightly. Worst case is about
`max_parallel_requests × max_tokens` of output — roughly 40k tokens, i.e. cents.
Set budgets a little under what you can absorb and it never matters.

## Operations

```bash
docker compose logs -f litellm     # tail
docker compose pull && docker compose up -d    # update
docker compose down                # stop (volumes survive)
```

Back up Postgres — it holds every key and all spend history:

```bash
docker compose exec -T postgres pg_dump -U litellm litellm | gzip > backup-$(date +%F).sql.gz
```

Worth a weekly cron. Also back up `.env`, especially `LITELLM_SALT_KEY`.

## If something breaks

| Symptom | Usual cause |
|---|---|
| Cert never issues | DNS not pointing here yet, or port 80 blocked |
| `401` from a student | key blocked, deleted, or mistyped |
| `400` mentioning budget | budget spent — `./students.sh topup` |
| Answers arrive all at once | `flush_interval -1` missing from `Caddyfile` |
| LiteLLM won't start | check `docker compose logs litellm`; a rejected `config.yaml` key usually means the schema moved — see https://docs.litellm.ai/docs/proxy/configs |
