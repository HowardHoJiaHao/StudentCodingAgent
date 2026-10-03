#!/usr/bin/env node
/**
 * Try the extension exactly as a student gets it.
 *
 * Packages extension/ into the .vsix you send to students, installs it into a
 * separate VS Code with its own settings and extensions folder, and opens that
 * window. Nothing from your own VS Code carries over — settings, other
 * extensions, the key you signed in with — so you see what a student sees on a
 * fresh machine.
 *
 *   node test-as-student.mjs             package, install, open an empty practice folder
 *   node test-as-student.mjs <folder>    ...and open your own folder instead
 *   node test-as-student.mjs --no-build  test the .vsix you already built
 *   node test-as-student.mjs --reset     start over as a new student (signed out)
 *
 * Options combine, e.g.  node test-as-student.mjs --reset "C:\my project"
 * --reset deletes the practice folder with the rest of the test profile, but
 * never touches a folder you name.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const EXT = path.join(ROOT, 'extension')
const { name, version } = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'))
const VSIX = path.join(EXT, `${name}-${version}.vsix`) // vsce's default output name

// Outside the repo, so the test profile can never be committed. It survives
// between runs, so you stay signed in until --reset.
const HOME = path.join(os.tmpdir(), 'howard-agent-student-test')
const PROFILE = ['--user-data-dir', path.join(HOME, 'data'), '--extensions-dir', path.join(HOME, 'ext')]
const PRACTICE = path.join(HOME, 'practice-project')

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('-')))
const folderArg = argv.find((a) => !a.startsWith('-'))

if (flags.has('--help') || flags.has('-h')) {
  const doc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].split('/**')[1]
  console.log(doc.replace(/^ \* ?/gm, ''))
  process.exit(0)
}

for (const flag of flags) {
  if (!['--reset', '--no-build'].includes(flag)) {
    console.error(`  Unknown option ${flag}. Run with --help to see the options.`)
    process.exit(1)
  }
}

// Check the folder before spending time on packaging, so a typo fails fast.
const FOLDER = folderArg ? path.resolve(folderArg) : PRACTICE
if (folderArg && !(fs.existsSync(FOLDER) && fs.statSync(FOLDER).isDirectory())) {
  console.error(`  No folder at ${FOLDER}`)
  process.exit(1)
}

/**
 * On Windows `code` and `npx` are .cmd shims, which Node only starts through a
 * shell, and a shell splits an unquoted path at its spaces. So build the whole
 * command line here, quoting anything with a space in it.
 */
function run(command, args, options = {}) {
  const line = [command, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ')
  const result = spawnSync(line, { stdio: 'inherit', shell: true, ...options })
  if (result.status !== 0) {
    console.error(`\n  "${command}" failed.`)
    if (command === 'code') {
      console.error('  Is the `code` command on your PATH? In VS Code: Ctrl+Shift+P →')
      console.error('  "Shell Command: Install \'code\' command in PATH" (macOS), or reinstall on Windows.')
    }
    process.exit(1)
  }
}

if (flags.has('--reset')) {
  fs.rmSync(HOME, { recursive: true, force: true })
  console.log('  Removed the old test profile. You will start signed out, like a new student.\n')
}

if (!flags.has('--no-build')) {
  console.log('  Packaging extension/ into the .vsix students get…\n')
  run('npx', ['--yes', '@vscode/vsce', 'package', '--allow-missing-repository'], { cwd: EXT })
}
if (!fs.existsSync(VSIX)) {
  console.error(`  No ${path.relative(ROOT, VSIX)} yet. Run without --no-build to package it.`)
  process.exit(1)
}

console.log(`\n  Installing ${path.basename(VSIX)} into a separate VS Code…`)
run('code', [...PROFILE, '--install-extension', VSIX, '--force'])

if (FOLDER === PRACTICE) fs.mkdirSync(PRACTICE, { recursive: true })
console.log(`
  A separate VS Code is opening on:
    ${FOLDER}${FOLDER === PRACTICE ? '\n    (the practice folder: --reset deletes it, so keep real work elsewhere)' : ''}

  It has no settings and no extensions except Howard Agent, like a student's
  fresh install. In that window:

    1. If it asks whether you trust the folder, choose "Yes, I trust the authors".
       The agent is switched off in Restricted Mode.
    2. Ctrl+Shift+P (Cmd+Shift+P on Mac) → "Howard Agent: Sign In" → paste a student key.
       Make one with:  ./students.sh new demo-student 1
    3. Click the < • > icon on the left and ask it to write some code.

  Test profile: ${HOME}
  Start over signed out with:  node test-as-student.mjs --reset
`)
run('code', [...PROFILE, '--new-window', FOLDER])
