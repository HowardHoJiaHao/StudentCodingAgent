/**
 * Exercises the tool layer without touching the network, so you can verify the
 * local half of the agent works before spending a single API token.
 *
 *   node selftest.mjs
 */

import assert from 'node:assert'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { TOOL_BY_NAME, TOOL_SCHEMAS } from './tools.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'howard-agent-test-'))
const ctx = { root }
const call = (name, args) => TOOL_BY_NAME[name].run(args, ctx)

let passed = 0
async function check(label, fn) {
  try {
    await fn()
    console.log(`  \x1b[32mok\x1b[0m   ${label}`)
    passed++
  } catch (error) {
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}\n       ${error.message}`)
    process.exitCode = 1
  }
}

console.log(`\n  tool self-test  \x1b[2m${root}\x1b[0m\n`)

await check('write_file creates nested paths', async () => {
  const out = await call('write_file', { path: 'src/greet.js', content: 'export const hi = 1\n' })
  assert.match(out, /Wrote/)
  assert.equal(await fs.readFile(path.join(root, 'src/greet.js'), 'utf8'), 'export const hi = 1\n')
})

await check('read_file returns numbered lines', async () => {
  const out = await call('read_file', { path: 'src/greet.js' })
  assert.match(out, /1\texport const hi = 1/)
})

await check('read_file honours offset and limit', async () => {
  await call('write_file', { path: 'many.txt', content: 'a\nb\nc\nd\ne\n' })
  const out = await call('read_file', { path: 'many.txt', offset: 2, limit: 2 })
  assert.match(out, /2\tb/)
  assert.match(out, /3\tc/)
  assert.doesNotMatch(out, /4\td/)
})

await check('edit_file replaces an exact string', async () => {
  await call('edit_file', { path: 'src/greet.js', old_string: 'hi = 1', new_string: 'hi = 42' })
  assert.match(await fs.readFile(path.join(root, 'src/greet.js'), 'utf8'), /hi = 42/)
})

await check('edit_file rejects a missing string', async () => {
  await assert.rejects(
    () => call('edit_file', { path: 'src/greet.js', old_string: 'nope', new_string: 'x' }),
    /not found/,
  )
})

await check('edit_file rejects an ambiguous string', async () => {
  await call('write_file', { path: 'dup.txt', content: 'x\nx\n' })
  await assert.rejects(
    () => call('edit_file', { path: 'dup.txt', old_string: 'x', new_string: 'y' }),
    /appears 2 times/,
  )
})

await check('edit_file replace_all works', async () => {
  const out = await call('edit_file', {
    path: 'dup.txt',
    old_string: 'x',
    new_string: 'y',
    replace_all: true,
  })
  assert.match(out, /Replaced 2/)
})

await check('list_dir lists entries', async () => {
  const out = await call('list_dir', { path: '.' })
  assert.match(out, /src\//)
  assert.match(out, /many\.txt/)
})

await check('glob_files matches recursively', async () => {
  const out = await call('glob_files', { pattern: '**/*.js' })
  assert.match(out, /src\/greet\.js/)
})

await check('glob_files matches a flat pattern', async () => {
  const out = await call('glob_files', { pattern: '*.txt' })
  assert.match(out, /many\.txt/)
  assert.doesNotMatch(out, /greet\.js/)
})

await check('grep finds matches with line numbers', async () => {
  const out = await call('grep', { pattern: 'hi = \\d+', glob: '**/*.js' })
  assert.match(out, /src\/greet\.js:1:/)
})

await check('grep reports no matches cleanly', async () => {
  const out = await call('grep', { pattern: 'zzzznotfound' })
  assert.match(out, /No matches/)
})

await check('paths cannot escape the workspace', async () => {
  await assert.rejects(() => call('read_file', { path: '../../../etc/passwd' }), /escapes/)
  await assert.rejects(() => call('write_file', { path: '../evil.txt', content: 'x' }), /escapes/)
})

await check('run_command captures output', async () => {
  const out = await call('run_command', { command: 'echo hello-from-shell' })
  assert.match(out, /hello-from-shell/)
})

await check('run_command reports a non-zero exit', async () => {
  const command = process.platform === 'win32' ? 'exit 3' : 'exit 3'
  const out = await call('run_command', { command })
  assert.match(out, /exit code 3/)
})

await check('every tool exposes a valid schema', () => {
  assert.equal(TOOL_SCHEMAS.length, Object.keys(TOOL_BY_NAME).length)
  for (const schema of TOOL_SCHEMAS) {
    assert.equal(schema.type, 'function')
    assert.ok(schema.function.name, 'tool needs a name')
    assert.ok(schema.function.description, `${schema.function.name} needs a description`)
    assert.equal(schema.function.parameters.type, 'object')
  }
})

await fs.rm(root, { recursive: true, force: true })
console.log(`\n  ${passed} passed${process.exitCode ? ', some failed' : ''}\n`)
