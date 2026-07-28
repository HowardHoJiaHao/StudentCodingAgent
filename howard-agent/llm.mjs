/**
 * Provider layer.
 *
 * Every provider here speaks the OpenAI chat-completions wire format, which is
 * why one client covers all of them. DeepSeek, Groq, OpenRouter and Ollama all
 * implement that same shape, so switching providers is a base URL + a model id.
 *
 * Zero dependencies: Node 18+ ships global fetch, and SSE is simple enough to
 * parse by hand (see readStream below).
 */

export const PROVIDERS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    envKey: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini'],
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile'],
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    defaultModel: 'deepseek/deepseek-chat',
    models: ['deepseek/deepseek-chat'],
  },
  // Local models. No key needed; run `ollama serve` first.
  // 127.0.0.1 rather than localhost: on Windows the latter can resolve to ::1
  // first and fail before it ever tries IPv4.
  ollama: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    envKey: 'OLLAMA_API_KEY',
    defaultModel: 'qwen2.5-coder:7b',
    models: ['qwen2.5-coder:7b'],
    keyOptional: true,
  },
}

export function resolveProvider(name) {
  const provider = PROVIDERS[name]
  if (!provider) {
    throw new Error(
      `Unknown provider "${name}". Available: ${Object.keys(PROVIDERS).join(', ')}`,
    )
  }

  const apiKey = process.env[provider.envKey] ?? (provider.keyOptional ? 'unused' : null)
  if (!apiKey) {
    throw new Error(
      `Missing ${provider.envKey}.\n` +
        `  PowerShell:  $env:${provider.envKey} = "sk-your-key"\n` +
        `  bash:        export ${provider.envKey}=sk-your-key\n` +
        `  or put it in a .env file next to agent.mjs`,
    )
  }

  // Spread first so the explicit fields below actually win.
  return {
    ...provider,
    name,
    apiKey,
    baseUrl: (process.env.AGENT_BASE_URL ?? provider.baseUrl).replace(/\/+$/, ''),
  }
}

/**
 * One assistant turn, streamed.
 *
 * Returns the fully-assembled assistant message once the stream closes, so the
 * caller can append it to the transcript and act on any tool calls. onText is
 * invoked with each token so the UI can print as it arrives.
 */
export async function streamChat({ provider, model, messages, tools, signal, onText }) {
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`${provider.name} returned ${response.status}: ${body.slice(0, 500)}`)
  }

  return readStream(response, onText)
}

async function readStream(response, onText) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  let content = ''
  let reasoning = ''
  // Keyed by the `index` field, because tool calls stream in as fragments that
  // have to be concatenated per slot — name in one chunk, arguments across many.
  const toolCalls = []
  let usage = null
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    // SSE events are separated by a blank line. Keep the trailing partial event
    // in the buffer until the rest of it arrives.
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''

    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue

        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue

        let chunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue // Ignore keepalives and anything malformed.
        }

        if (chunk.usage) usage = chunk.usage

        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue

        // deepseek-reasoner exposes its chain of thought separately.
        if (delta.reasoning_content) reasoning += delta.reasoning_content

        if (delta.content) {
          content += delta.content
          onText?.(delta.content)
        }

        for (const fragment of delta.tool_calls ?? []) {
          const slot = fragment.index ?? 0
          toolCalls[slot] ??= { id: '', type: 'function', function: { name: '', arguments: '' } }

          if (fragment.id) toolCalls[slot].id = fragment.id
          if (fragment.function?.name) toolCalls[slot].function.name += fragment.function.name
          if (fragment.function?.arguments) {
            toolCalls[slot].function.arguments += fragment.function.arguments
          }
        }
      }
    }
  }

  return {
    content,
    reasoning,
    toolCalls: toolCalls.filter(Boolean),
    usage,
  }
}
