/**
 * Streaming client. Same protocol as the CLI agent, CommonJS for the extension
 * host. Points at your LiteLLM proxy, never at DeepSeek directly — the student
 * holds a virtual key, not your real one.
 */

'use strict'

async function streamChat({ endpoint, apiKey, model, messages, tools, signal, onText }) {
  let response
  try {
    response = await fetch(`${endpoint.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
      }),
    })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new Error(`Can't reach ${endpoint}. Check the endpoint setting and your connection.`)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(explainStatus(response.status, body))
  }

  return readStream(response, onText)
}

/** Turn proxy errors into something a student can act on. */
function explainStatus(status, body) {
  const detail = body.slice(0, 300)
  if (status === 401) return 'Key rejected. Run "Howard Agent: Sign In" and paste it again.'
  if (status === 429) return 'Rate limited — too many requests at once. Wait a moment and retry.'
  if (status === 400 && /budget/i.test(body)) {
    return 'Your budget for this period is used up. Ask Howard to top it up.'
  }
  if (status === 402) return 'Budget exhausted. Ask Howard to top up your key.'
  return `Proxy returned ${status}: ${detail}`
}

async function readStream(response, onText) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  let content = ''
  const toolCalls = []
  let usage = null
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() || ''

    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue

        let chunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }

        if (chunk.usage) usage = chunk.usage
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta
        if (!delta) continue

        if (delta.content) {
          content += delta.content
          if (onText) onText(delta.content)
        }

        // Tool calls stream in as fragments that must be joined per index.
        for (const fragment of delta.tool_calls || []) {
          const slot = fragment.index || 0
          if (!toolCalls[slot]) {
            toolCalls[slot] = { id: '', type: 'function', function: { name: '', arguments: '' } }
          }
          if (fragment.id) toolCalls[slot].id = fragment.id
          if (fragment.function && fragment.function.name) {
            toolCalls[slot].function.name += fragment.function.name
          }
          if (fragment.function && fragment.function.arguments) {
            toolCalls[slot].function.arguments += fragment.function.arguments
          }
        }
      }
    }
  }

  return { content, toolCalls: toolCalls.filter(Boolean), usage }
}

module.exports = { streamChat }
