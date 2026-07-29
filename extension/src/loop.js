/**
 * The agent loop, with the UI factored out behind callbacks so the same code
 * could drive a webview, a terminal, or a test.
 *
 * Send the transcript plus tool schemas → run whatever tools come back → append
 * results → repeat until the model stops asking for tools.
 */

'use strict'

const { streamChat } = require('./llm')
const { TOOL_BY_NAME, TOOL_SCHEMAS } = require('./tools')

const MAX_STEPS = 60 // Ceiling per user turn, so a confused model can't spin forever.

const SYSTEM_PROMPT = (root) => `You are Howard Agent, a coding assistant working inside VS Code.

You are running on DeepSeek's models, reached through a proxy. You were not made
by Anthropic, OpenAI, or Google. If you are asked which model or company you are,
say you are Howard Agent running on DeepSeek. Never claim to be Claude, ChatGPT,
Gemini, or any other assistant. A model has no direct knowledge of its own
weights, so answer from this instruction rather than from guesswork.

Workspace root: ${root}
Platform: ${process.platform}

You have tools to read, search, write and edit files, and to run shell commands.
Use them instead of guessing or asking the user to paste code.

Guidelines:
- Explore before you edit. Read a file before you change it.
- Prefer edit_file over write_file on files that already exist.
- After a change that can be checked, run the tests or build.
- Be concise. Show code, not prose about code.
- If a command fails, read the error and fix the cause rather than retrying.
- Say when you're done, briefly.`

// Rough proxy for tokens. Four characters per token is close enough for deciding
// when to trim, and costs nothing compared to a real tokenizer.
const CHARS_PER_TOKEN = 4
const CONTEXT_LIMIT_CHARS = 220000 // ~55k tokens, well inside DeepSeek's window
const STUB = '[earlier tool output trimmed to keep the conversation within context]'

const sizeOf = (messages) =>
  messages.reduce((total, m) => total + (m.content ? String(m.content).length : 0), 0)

/**
 * Keep a long conversation alive instead of letting it hard-error.
 *
 * Tool results — file contents, grep dumps — dominate the transcript, and the
 * oldest ones are the least relevant. Trimming those in place preserves every
 * tool_call_id, which the API requires to stay paired with its call; dropping
 * messages outright would break that. The system prompt and the most recent
 * exchanges are never touched.
 */
function compact(messages, ui) {
  if (sizeOf(messages) <= CONTEXT_LIMIT_CHARS) return false

  let trimmed = 0
  const protectedTail = Math.max(1, messages.length - 8)

  for (let i = 0; i < protectedTail; i++) {
    if (sizeOf(messages) <= CONTEXT_LIMIT_CHARS) break
    const message = messages[i]
    if (message.role !== 'tool') continue
    if (message.content === STUB) continue
    if (String(message.content).length < 400) continue
    message.content = STUB
    trimmed++
  }

  if (trimmed && ui.onCompact) {
    ui.onCompact(trimmed, Math.round(sizeOf(messages) / CHARS_PER_TOKEN))
  }
  return trimmed > 0
}

async function runTurn({ endpoint, apiKey, model, messages, root, signal, ui, approve }) {
  for (let step = 0; step < MAX_STEPS; step++) {
    compact(messages, ui)

    const reply = await streamChat({
      endpoint,
      apiKey,
      model,
      messages,
      tools: TOOL_SCHEMAS,
      signal,
      onText: ui.onText,
      onRetry: ui.onRetry,
    })

    if (reply.usage) ui.onUsage(reply.usage)

    // Push exactly what came back: the API requires every tool_call id to be
    // answered by a matching tool message on the next request.
    messages.push({
      role: 'assistant',
      content: reply.content || null,
      ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}),
    })

    if (!reply.toolCalls.length) return

    for (const call of reply.toolCalls) {
      const tool = TOOL_BY_NAME[call.function.name]
      let result

      if (!tool) {
        result = `Error: no such tool "${call.function.name}"`
      } else {
        let args = {}
        let parseFailed = false
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
        } catch {
          parseFailed = true
          result = `Error: arguments were not valid JSON: ${String(
            call.function.arguments,
          ).slice(0, 200)}`
        }

        if (!parseFailed) {
          const id = ui.onToolStart(tool.name, args)
          if (!(await approve(tool, args))) {
            result = 'Denied by the user. Stop and ask what they would prefer.'
            ui.onToolEnd(id, 'denied', result)
          } else {
            try {
              // File tools return { text, stats } so the UI can show a +/- summary;
              // everything else returns a plain string. Only the text goes to the
              // model — stats are for the human.
              const raw = await tool.run(args, { root })
              const isDetailed = raw && typeof raw === 'object'
              result = isDetailed ? raw.text : raw
              ui.onToolEnd(id, 'ok', result, isDetailed ? raw.stats : null)
            } catch (err) {
              result = `Error: ${err.message}`
              ui.onToolEnd(id, 'error', result)
            }
          }
        }
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) })
    }
  }

  ui.onText(`\n\n[stopped after ${MAX_STEPS} steps]`)
}

module.exports = { runTurn, SYSTEM_PROMPT }
