/**
 * Tool definitions.
 *
 * Each tool is a JSON schema the model sees, plus a run() the agent executes
 * locally. `mutates` drives the permission prompt in agent.mjs: read-only tools
 * run silently, everything else asks first.
 *
 * To add a tool, append an entry here. Nothing else needs to change.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const MAX_OUTPUT = 30_000 // Cap tool results so one big file can't blow the context.
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__'])

function truncate(text) {
  if (text.length <= MAX_OUTPUT) return text
  return `${text.slice(0, MAX_OUTPUT)}\n\n[truncated ${text.length - MAX_OUTPUT} more characters]`
}

/** Keep the agent inside the workspace it was launched in. */
function safePath(root, target = '.') {
  const resolved = path.resolve(root, target)
  const relative = path.relative(root, resolved)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the workspace: ${target}`)
  }
  return resolved
}

function globToRegExp(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i++
        if (pattern[i + 1] === '/') i++ // `**/` should also match zero directories
      } else {
        out += '[^/\\\\]*'
      }
    } else if (char === '?') out += '.'
    else if ('\\^$+.()|{}[]'.includes(char)) out += `\\${char}`
    else out += char
  }
  return new RegExp(`^${out}$`, 'i')
}

async function* walk(dir, root) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      yield* walk(full, root)
    } else if (entry.isFile()) {
      yield path.relative(root, full).split(path.sep).join('/')
    }
  }
}

export const TOOLS = [
  {
    name: 'read_file',
    mutates: false,
    description:
      'Read a text file from the workspace. Returns numbered lines. Use offset/limit for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root' },
        offset: { type: 'integer', description: '1-based line to start at' },
        limit: { type: 'integer', description: 'Maximum lines to return (default 2000)' },
      },
      required: ['path'],
    },
    async run({ path: target, offset = 1, limit = 2000 }, { root }) {
      const content = await fs.readFile(safePath(root, target), 'utf8')
      if (content.includes('\0')) return '[binary file, not shown]'
      if (content === '') return '[empty file]'

      const lines = content.split('\n')
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const width = String(offset + slice.length - 1).length

      return truncate(
        slice.map((line, i) => `${String(offset + i).padStart(width)}\t${line}`).join('\n'),
      )
    },
  },

  {
    name: 'write_file',
    mutates: true,
    description: 'Create a file or overwrite an existing one. Creates parent directories as needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    async run({ path: target, content }, { root }) {
      const resolved = safePath(root, target)
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, content, 'utf8')
      return `Wrote ${content.split('\n').length} lines to ${target}`
    },
  },

  {
    name: 'edit_file',
    mutates: true,
    description:
      'Replace an exact string in a file. old_string must match the file byte-for-byte and must be ' +
      'unique unless replace_all is true. Prefer this over write_file for changes to existing files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to find' },
        new_string: { type: 'string', description: 'Text to replace it with' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async run({ path: target, old_string, new_string, replace_all = false }, { root }) {
      const resolved = safePath(root, target)
      const content = await fs.readFile(resolved, 'utf8')

      const occurrences = content.split(old_string).length - 1
      if (occurrences === 0) throw new Error(`old_string not found in ${target}`)
      if (occurrences > 1 && !replace_all) {
        throw new Error(
          `old_string appears ${occurrences} times in ${target}. ` +
            'Add more surrounding context to make it unique, or pass replace_all: true.',
        )
      }

      const updated = replace_all
        ? content.split(old_string).join(new_string)
        : content.replace(old_string, new_string)

      await fs.writeFile(resolved, updated, 'utf8')
      return `Replaced ${replace_all ? occurrences : 1} occurrence(s) in ${target}`
    },
  },

  {
    name: 'list_dir',
    mutates: false,
    description: 'List files and folders in a directory (non-recursive).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Defaults to workspace root' } },
    },
    async run({ path: target = '.' }, { root }) {
      const entries = await fs.readdir(safePath(root, target), { withFileTypes: true })
      if (entries.length === 0) return '[empty directory]'

      return truncate(
        entries
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .sort()
          .join('\n'),
      )
    },
  },

  {
    name: 'glob_files',
    mutates: false,
    description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/test_*.py".',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
    async run({ pattern }, { root }) {
      const regex = globToRegExp(pattern)
      const matches = []

      for await (const file of walk(root, root)) {
        if (regex.test(file)) matches.push(file)
        if (matches.length >= 500) break
      }

      return matches.length ? truncate(matches.join('\n')) : `No files match ${pattern}`
    },
  },

  {
    name: 'grep',
    mutates: false,
    description: 'Search file contents with a regular expression. Returns path:line: match.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        glob: { type: 'string', description: 'Optional file filter, e.g. "**/*.js"' },
      },
      required: ['pattern'],
    },
    async run({ pattern, glob }, { root }) {
      const regex = new RegExp(pattern)
      const filter = glob ? globToRegExp(glob) : null
      const hits = []

      for await (const file of walk(root, root)) {
        if (filter && !filter.test(file)) continue

        let content
        try {
          content = await fs.readFile(path.join(root, file), 'utf8')
        } catch {
          continue
        }
        if (content.includes('\0')) continue

        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) hits.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
          if (hits.length >= 200) break
        }
        if (hits.length >= 200) break
      }

      return hits.length ? truncate(hits.join('\n')) : `No matches for ${pattern}`
    },
  },

  {
    name: 'run_command',
    mutates: true,
    description:
      'Run a shell command in the workspace and return its output. Use for builds, tests, git, ' +
      'and package managers. Avoid long-running or interactive commands.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'integer', description: 'Default 120000, max 600000' },
      },
      required: ['command'],
    },
    run({ command, timeout_ms = 120_000 }, { root }) {
      const [shell, ...prefix] =
        process.platform === 'win32'
          ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command']
          : ['/bin/sh', '-c']

      return new Promise((resolve) => {
        const child = spawn(shell, [...prefix, command], { cwd: root })
        let output = ''

        const timer = setTimeout(() => {
          child.kill()
          output += `\n[timed out after ${timeout_ms}ms]`
        }, Math.min(timeout_ms, 600_000))

        child.stdout.on('data', (d) => (output += d))
        child.stderr.on('data', (d) => (output += d))
        child.on('error', (err) => {
          clearTimeout(timer)
          resolve(`Failed to start command: ${err.message}`)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          const status = code === 0 ? '' : `\n[exit code ${code}]`
          resolve(truncate(output.trim() === '' ? `[no output]${status}` : output + status))
        })
      })
    },
  },
]

/** The schema array sent to the model on every request. */
export const TOOL_SCHEMAS = TOOLS.map((tool) => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  },
}))

export const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool]))
