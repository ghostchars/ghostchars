#!/usr/bin/env node
// Claude Code PostToolUse hook: after Write, Edit or MultiEdit, hold the file
// to the text bar and hand any finding back to the agent.
//
// It never rewrites the file. A finding is returned as feedback (exit 2, text
// on stderr), which Claude Code shows to the model, and the skill says what to
// do with each kind: drop the invisible character, rewrite the sentence that
// needed the dash. Cleaning silently would flatten an em dash into a hyphen in
// prose the model is about to ship, which is the one outcome the skill exists
// to prevent.
//
// Input, on stdin, is the hook JSON Claude Code sends. Only `tool_input.file_path`
// is read. Anything else, including a missing path, exits 0 without a word.
import { spawnSync } from 'node:child_process'

const BAR = process.env.GHOSTCHARS_HOOK_BAR ?? 'text'

let raw = ''
try {
  raw = (await import('node:fs')).readFileSync(0, 'utf8')
} catch {
  process.exit(0)
}

let filePath
try {
  const payload = JSON.parse(raw)
  filePath = payload?.tool_input?.file_path
} catch {
  process.exit(0)
}
if (typeof filePath !== 'string' || filePath.length === 0) process.exit(0)

const result = spawnSync('npx', ['-y', 'ghostchars', 'check', '--bar', BAR, '--', filePath], {
  encoding: 'utf8',
  cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
})

if (result.status === 1) {
  process.stderr.write(
    `ghostchars found characters in ${filePath} that fail the ${BAR} bar. ` +
      'Remove invisible characters; rewrite any sentence that needed a dash.\n' +
      result.stdout,
  )
  process.exit(2)
}
// 0 is clean. 2 is a usage or read error and 3 a bug: neither is the agent's
// fault, so say so once and do not block.
if (result.status !== 0 && result.stderr) process.stderr.write(result.stderr)
process.exit(0)
