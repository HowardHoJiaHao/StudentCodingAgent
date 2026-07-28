#!/usr/bin/env node
/**
 * A coding agent in about 250 lines.
 *
 * The whole idea lives in runTurn() below: send the conversation plus the tool
 * schemas to a model, run whatever tools it asks for, append the results, and
 * repeat until it stops asking. Everything else in this file is interface.
 *
 * Usage:
 *   node agent.mjs                       interactive
 *   node agent.mjs -p "fix the tests"    one-shot
 *   node agent.mjs --provider ollama     different backend
 */

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import { PROVIDERS, resolveProvider, streamChat } from './llm.mjs'
import { TOOL_BY_NAME, TOOL_SCHEMAS, TOOLS } from './tools.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MAX_STEPS = 60 // Ceiling on tool calls per user turn, so a loop can't run away.

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
}

// --- config -----------------------------------------------------------------

/** Minimal .env loader; avoids a dependency for the one thing we need it for. */
function loadEnv() {
  for (const dir of [process.cwd(), HERE]) {
    const file = path.join(dir, '.env')
    if (!fs.existsSync(file)) continue

    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/)
      if (!match || line.trimStart().startsWith('#')) continue
      const [, key, rawValue] = match
      process.env[key] ??= rawValue.replace(/^["']|["']$/g, '')
    }
  }
}

function parseArgs(argv) {
  const options = {
    provider: process.env.AGENT_PROVIDER ?? 'deepseek',
    model: process.env.AGENT_MODEL ?? null,
    prompt: null,
    yolo: false,
    root: process.cwd(),
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--provider') options.provider = argv[++i]
    else if (arg === '--model') options.model = argv[++i]
    else if (arg === '--cwd') options.root = path.resolve(argv[++i])
    else if (arg === '-p' || arg === '--prompt') options.prompt = argv[++i]
    else if (arg === '--yolo') options.yolo = true
    else if (arg === '-h' || arg === '--help') options.help = true
  }
  return options
}

const SYSTEM_PROMPT = (root) => `You are a coding agent working in a terminal.

Workspace root: ${root}
Platform: ${process.platform}

You have tools for reading, searching, writing, and editing files, and for running
shell commands. Use them rather than guessing or asking the user to paste code.

Guidelines:
- Explore before you edit. Read a file before changing it; grep or glob to find
  things instead of assuming paths.
- Prefer edit_file over write_file when a file already exists, so you don't
  destroy content you haven't read.
- You may call several read-only tools in one step to gather context faster.
- After a change that should be verifiable, run the tests or build to check it.
- Be concise in prose. Show code, not descriptions of code.
- If a command fails, read the error and fix the cause; don't retry blindly.
- When the task is done, say so briefly. Don't pad with summaries of what the
  user can already see.`

// --- permissions ------------------------------------------------------------

function describeCall(name, args) {
  if (name === 'run_command') return args.command
  if (args?.path) return args.path
  if (args?.pattern) return args.pattern
  return Object.keys(args ?? {}).length ? JSON.stringify(args).slice(0, 120) : ''
}

async function confirm(rl, tool, args, session) {
  if (session.yolo || !tool.mutates || session.allowed.has(tool.name)) return true

  // No terminal to ask on (piped stdin, CI, `-p` in a script). Fail closed
  // rather than silently mutating the workspace nobody is watching.
  if (!process.stdin.isTTY) {
    console.log(
      `\n${c.yellow('!')} ${c.bold(tool.name)} ${c.dim(describeCall(tool.name, args))}` +
        c.red('  auto-denied (no terminal to confirm on; re-run with --yolo)'),
    )
    return false
  }

  console.log(`\n${c.yellow('!')} ${c.bold(tool.name)} ${c.dim(describeCall(tool.name, args))}`)
  if (tool.name === 'write_file' && args.content) {
    const preview = args.content.split('\n').slice(0, 15).join('\n')
    console.log(c.dim(preview + (args.content.split('\n').length > 15 ? '\n  ...' : '')))
  }

  let answer
  try {
    answer = await rl.question(c.dim('  allow? [y]es / [n]o / [a]lways: '))
  } catch {
    return false // stdin closed mid-prompt (Ctrl+D) — treat as "no".
  }

  answer = answer.trim().toLowerCase()
  if (answer === 'a' || answer === 'always') {
    session.allowed.add(tool.name)
    return true
  }
  return answer === 'y' || answer === 'yes'
}

// --- the agent loop ---------------------------------------------------------

async function runTurn(session, rl) {
  for (let step = 0; step < MAX_STEPS; step++) {
    const controller = new AbortController()
    const onInterrupt = () => controller.abort()
    process.on('SIGINT', onInterrupt)

    let reply
    let printed = false
    try {
      reply = await streamChat({
        provider: session.provider,
        model: session.model,
        messages: session.messages,
        tools: TOOL_SCHEMAS,
        signal: controller.signal,
        onText: (text) => {
          if (!printed) {
            process.stdout.write('\n')
            printed = true
          }
          process.stdout.write(text)
        },
      })
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log(c.dim('\n[interrupted]'))
        return
      }
      throw error
    } finally {
      process.off('SIGINT', onInterrupt)
    }

    if (printed) process.stdout.write('\n')
    if (reply.usage) {
      session.tokensIn += reply.usage.prompt_tokens ?? 0
      session.tokensOut += reply.usage.completion_tokens ?? 0
    }

    // The assistant message goes on the transcript exactly as returned; the API
    // requires every tool_call id to be answered by a matching tool message.
    session.messages.push({
      role: 'assistant',
      content: reply.content || null,
      ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}),
    })

    if (reply.toolCalls.length === 0) return // Model is done talking; back to the user.

    for (const call of reply.toolCalls) {
      const tool = TOOL_BY_NAME[call.function.name]
      let result

      if (!tool) {
        result = `Error: no such tool "${call.function.name}"`
      } else {
        let args = {}
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
        } catch {
          result = `Error: arguments were not valid JSON: ${call.function.arguments?.slice(0, 200)}`
        }

        if (result === undefined) {
          if (!(await confirm(rl, tool, args, session))) {
            result = 'Denied by the user. Stop and ask what they would like instead.'
            console.log(c.red('  denied'))
          } else {
            const label = describeCall(tool.name, args)
            process.stdout.write(c.dim(`  ${tool.name}${label ? ` ${label}` : ''} `))
            try {
              result = await tool.run(args, { root: session.root })
              console.log(c.green('ok'))
            } catch (error) {
              result = `Error: ${error.message}`
              console.log(c.red(`error: ${error.message}`))
            }
          }
        }
      }

      session.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: String(result),
      })
    }
  }

  console.log(c.yellow(`\n[stopped after ${MAX_STEPS} steps]`))
}

// --- repl -------------------------------------------------------------------

const HELP = `
  ${c.bold('Commands')}
    /help              this message
    /clear             wipe the conversation, keep the session
    /tools             list available tools
    /model <name>      switch model
    /cost              tokens used this session
    /exit              quit

  Ctrl+C interrupts the current response. Ctrl+D exits.
`

async function main() {
  loadEnv()
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(`
  node agent.mjs [options]

    --provider <name>   ${Object.keys(PROVIDERS).join(' | ')}   (default: deepseek)
    --model <name>      override the provider's default model
    --cwd <path>        workspace root (default: current directory)
    -p, --prompt <text> run one prompt and exit
    --yolo              skip permission prompts
`)
    return
  }

  let provider
  try {
    provider = resolveProvider(options.provider)
  } catch (error) {
    console.error(c.red(error.message))
    process.exit(1)
  }

  const session = {
    provider,
    model: options.model ?? provider.defaultModel,
    root: options.root,
    yolo: options.yolo,
    allowed: new Set(),
    tokensIn: 0,
    tokensOut: 0,
    messages: [{ role: 'system', content: SYSTEM_PROMPT(options.root) }],
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  // Headless mode: one prompt, no banner, no REPL.
  if (options.prompt) {
    session.messages.push({ role: 'user', content: options.prompt })
    await runTurn(session, rl)
    rl.close()
    return
  }

  console.log(`
  ${c.bold('howard-agent')} ${c.dim(`· ${provider.name} · ${session.model}`)}
  ${c.dim(session.root)}
  ${c.dim('/help for commands')}${session.yolo ? c.yellow('  · yolo mode') : ''}`)

  while (true) {
    let input
    try {
      input = (await rl.question(`\n${c.cyan('›')} `)).trim()
    } catch {
      break // Ctrl+D
    }

    if (input === '') continue

    if (input.startsWith('/')) {
      const [command, ...rest] = input.slice(1).split(/\s+/)

      if (command === 'exit' || command === 'quit') break
      if (command === 'help') {
        console.log(HELP)
      } else if (command === 'clear') {
        session.messages = [{ role: 'system', content: SYSTEM_PROMPT(session.root) }]
        console.log(c.dim('  conversation cleared'))
      } else if (command === 'tools') {
        for (const tool of TOOLS) {
          console.log(`  ${tool.mutates ? c.yellow('!') : ' '} ${c.bold(tool.name)}`)
        }
      } else if (command === 'model') {
        if (rest[0]) {
          session.model = rest[0]
          console.log(c.dim(`  model → ${session.model}`))
        } else {
          console.log(c.dim(`  ${session.model}  (available: ${provider.models.join(', ')})`))
        }
      } else if (command === 'cost') {
        console.log(c.dim(`  in ${session.tokensIn}  out ${session.tokensOut} tokens`))
      } else {
        console.log(c.dim(`  unknown command: /${command}`))
      }
      continue
    }

    session.messages.push({ role: 'user', content: input })
    try {
      await runTurn(session, rl)
    } catch (error) {
      console.error(c.red(`\n${error.message}`))
    }
  }

  rl.close()
  console.log(c.dim('\nbye'))
}

main().catch((error) => {
  console.error(c.red(error.stack ?? error.message))
  process.exit(1)
})
