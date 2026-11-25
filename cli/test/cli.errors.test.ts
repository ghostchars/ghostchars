/**
 * The argument surface, which is frozen.
 *
 * Everything asserted here is behaviour no later builder may change: the exit
 * code for a usage error, the shape of the unknown-flag message, and above all
 * the promise `help --json` makes. That last one is a cross-check, not a
 * snapshot: it walks the parser's own flag tables and requires the JSON
 * document to advertise exactly those flags, so the machine-readable surface an
 * agent recovers with cannot drift away from the parser that has to honour it.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { COMMANDS, COMMAND_ARGUMENTS, FLAG_TABLES, GLOBAL_FLAGS } from '../src/args.js'
import type { CommandName } from '../src/args.js'
import { FLAG_SUMMARIES, COMMAND_SUMMARIES, VERSION } from '../src/strings.js'
import { runCli } from './helpers/run.js'

/**
 * The document is validated rather than asserted into shape: this package bans
 * `as`, and a schema is the honest way to turn JSON somebody else printed into
 * something typed.
 */
const HELP_FLAG = z.object({
  long: z.string(),
  short: z.string().nullable(),
  type: z.string(),
  summary: z.string(),
})

const HELP_DOCUMENT = z.object({
  tool: z.string(),
  version: z.string(),
  bars: z.record(z.string(), z.array(z.string())),
  gateBars: z.array(z.string()),
  exitCodes: z.array(z.object({ code: z.number(), meaning: z.string() })),
  globalFlags: z.array(HELP_FLAG),
  commands: z.array(
    z.object({
      name: z.string(),
      summary: z.string(),
      arguments: z.string(),
      exitCodes: z.array(z.number()),
      flags: z.array(HELP_FLAG),
      examples: z.array(z.string()),
    }),
  ),
})

type HelpDocument = z.infer<typeof HELP_DOCUMENT>

function helpJson(): HelpDocument {
  const result = runCli(['help', '--json'])
  expect(result.code).toBe(0)
  const parsed: unknown = JSON.parse(result.stdout)
  return HELP_DOCUMENT.parse(parsed)
}

describe('usage errors', () => {
  it('rejects an unknown command, lists the real ones, and exits 2', () => {
    const result = runCli(['clena'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain("unknown command 'clena'")
    for (const name of COMMANDS) expect(result.stderr).toContain(name)
  })

  it('rejects an unknown flag and names the nearest known one', () => {
    const result = runCli(['clean', '--punc'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unknown flag --punc')
    expect(result.stderr).toContain('Did you mean --punct?')
    expect(result.stderr).toContain('help --json')
  })

  it('does not invent a suggestion when nothing is close', () => {
    const result = runCli(['clean', '--zzzzzzzz'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unknown flag --zzzzzzzz')
    expect(result.stderr).not.toContain('Did you mean')
  })

  it('names the unknown SHORT flag rather than the whole group', () => {
    const result = runCli(['clean', '-sq'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unknown flag -q')
  })

  it('does not read a bare invocation on a pipe as a command', () => {
    const result = runCli([], { input: 'plain text' })
    expect(result.stderr).not.toContain('unknown command')
  })
})

describe('help and version', () => {
  it('prints help for --help, -h and the help command, all exit 0', () => {
    for (const args of [['--help'], ['-h'], ['help']]) {
      const result = runCli(args)
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('usage: ghostchars <command>')
      expect(result.stderr).toBe('')
    }
  })

  it('prints one command\'s flags for help <command> and for <command> --help', () => {
    for (const args of [
      ['help', 'clean'],
      ['clean', '--help'],
    ]) {
      const result = runCli(args)
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`usage: ghostchars clean ${COMMAND_ARGUMENTS.clean}`)
      expect(result.stdout).toContain('--punct')
      expect(result.stdout).toContain('--bar <bar>')
    }
  })

  it('offers --gutters to clean, inspect and check, and describes it in help --json', () => {
    const help = helpJson()
    for (const name of ['clean', 'inspect', 'check']) {
      const command = help.commands.find((candidate) => candidate.name === name)
      const flag = command?.flags.find((candidate) => candidate.long === '--gutters')
      expect(flag?.type, name).toBe('boolean')
      expect(flag?.summary, name).toContain('quote bar')
    }
    expect(help.bars['max']).toContain('gutters')
    expect(help.bars['text']).not.toContain('gutters')
  })

  it('refuses a help topic that is not a command', () => {
    const result = runCli(['help', 'nonsense'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("no help for 'nonsense'")
  })

  it('prints exactly the version for version and --version', () => {
    for (const args of [['version'], ['--version']]) {
      const result = runCli(args)
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${VERSION}\n`)
    }
  })

  it('reports the version and the running Node in version --json', () => {
    const result = runCli(['version', '--json'])
    expect(result.code).toBe(0)
    const parsed: unknown = JSON.parse(result.stdout)
    expect(parsed).toMatchObject({ tool: 'ghostchars', version: VERSION })
  })
})

describe('help --json', () => {
  it('names the bars, and the gate bars are exactly default and text', () => {
    const document = helpJson()
    expect(document.tool).toBe('ghostchars')
    expect(document.version).toBe(VERSION)
    expect(document.bars['default']).toEqual([])
    expect(document.bars['text']).toEqual(['punct', 'spaces'])
    expect(document.bars['max']).toContain('nfkc')
    expect(document.bars['max']).not.toContain('nfc')
    expect(document.gateBars).toEqual(['default', 'text'])
  })

  it('lists the four exit codes', () => {
    const document = helpJson()
    expect(document.exitCodes.map((entry) => entry.code)).toEqual([0, 1, 2, 3])
  })

  it('advertises exactly the flags the parser accepts, for every command', () => {
    const document = helpJson()
    expect(document.commands.map((command) => command.name)).toEqual([...COMMANDS])
    for (const command of document.commands) {
      const table = FLAG_TABLES[asCommandName(command.name)]
      expect(command.flags.map((flag) => flag.long)).toEqual(table.map((flag) => flag.long))
      expect(command.flags.map((flag) => flag.short)).toEqual(
        table.map((flag) => (flag.short === undefined ? null : `-${flag.short}`)),
      )
      expect(command.summary).toBe(COMMAND_SUMMARIES[command.name])
      expect(command.arguments).toBe(COMMAND_ARGUMENTS[asCommandName(command.name)])
    }
    expect(document.globalFlags.map((flag) => flag.long)).toEqual(
      GLOBAL_FLAGS.map((flag) => flag.long),
    )
  })

  it('gives every flag a summary, so no command can advertise a blank', () => {
    const document = helpJson()
    for (const command of [...document.commands, { flags: document.globalFlags }]) {
      for (const flag of command.flags) {
        expect(flag.summary, `${flag.long} has no summary`).not.toBe('')
        expect(FLAG_SUMMARIES[flag.long]).toBeDefined()
      }
    }
  })
})

describe('the frozen flag tables', () => {
  it('has a summary in strings.ts for every flag any command accepts', () => {
    for (const name of COMMANDS) {
      for (const flag of FLAG_TABLES[name]) {
        expect(FLAG_SUMMARIES[flag.long], `${name} ${flag.long}`).toBeDefined()
      }
    }
    for (const flag of GLOBAL_FLAGS) expect(FLAG_SUMMARIES[flag.long]).toBeDefined()
  })

  it('offers no max bar to the gate', () => {
    const check = FLAG_TABLES.check.find((flag) => flag.long === '--bar')
    expect(check?.choices).toEqual(['default', 'text'])
    expect(FLAG_TABLES.check.some((flag) => flag.long === '--max')).toBe(false)
  })

  it('accepts --help on every command', () => {
    for (const name of COMMANDS) {
      expect(FLAG_TABLES[name].some((flag) => flag.long === '--help')).toBe(true)
    }
  })
})

function asCommandName(value: string): CommandName {
  const match = COMMANDS.find((name) => name === value)
  if (match === undefined) throw new Error(`not a command: ${value}`)
  return match
}
