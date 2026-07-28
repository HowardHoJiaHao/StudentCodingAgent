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

const SYSTEM_PROMPT = (root) => `You are a coding assistant working inside VS Code.

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

async function runTurn({ endpoint, apiKey, model, messages, root, signal, ui, approve }) {
  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await streamChat({
      endpoint,
      apiKey,
      model,
      messages,
      tools: TOOL_SCHEMAS,
      signal,
      onText: ui.onText,
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
              result = await tool.run(args, { root })
              ui.onToolEnd(id, 'ok', result)
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
