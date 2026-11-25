/**
 * The shipped binary, over real stdio, including the stdout guard.
 *
 * WHAT ONLY THIS SUITE CAN PROVE. `mcp.inmemory.test.ts` drives the same server
 * object in process, which is fast and proves every tool's behaviour. It cannot
 * prove any of the things that only exist once there is a process: that
 * `dist/mcp.js` was built and is loadable, that the launcher reaches it, that
 * the newline framing survives a pipe, and above all that fd 1 stays clean when
 * something writes to it.
 *
 * THE POISON TEST, AND WHY IT IS SHAPED THIS WAY. The three writes that corrupt
 * a JSON-RPC stream are a `console.log`, a direct `process.stdout.write`, and
 * anything logged at startup. The shipped code contains none of them, so the
 * test injects all three from outside with a preloaded module. It arms itself
 * on the server's own readiness line, which is the first thing written AFTER
 * the guard is installed, and then writes continuously: once immediately, which
 * is the startup case, and on an interval, which covers the handler case. The
 * assertions are that the client still gets its result, that every non-empty
 * line on the real stdout parses as JSON-RPC, and that the poison actually
 * happened, which the last one proves by finding it on stderr. Without that
 * third assertion the test could pass by never firing.
 *
 * THE CLIENT ENVIRONMENT IS PASSED EXPLICITLY. `StdioClientTransport` otherwise
 * substitutes a filtered `DEFAULT_INHERITED_ENV_VARS` set, and a test that
 * silently loses PATH fails in a way that looks like a server bug.
 */
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { CLI_PATH, MAIN_PATH, requireBuild } from './helpers/run.js'

/** U+200B ZERO WIDTH SPACE, written as an escape so this file stays ASCII. */
const ZWSP = '\u200B'

const TEXT_BLOCK = z.object({ type: z.literal('text'), text: z.string() })

const TOOL_RESULT = z.object({
  content: z.array(z.unknown()),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
})

function structured(result: unknown): Record<string, unknown> {
  const value = TOOL_RESULT.parse(result).structuredContent
  if (value === undefined) throw new Error('the tool returned no structuredContent')
  return value
}

function blockText(result: unknown, index: number): string {
  return TEXT_BLOCK.parse(TOOL_RESULT.parse(result).content[index]).text
}

/** Only PATH, deliberately: see the module header. */
function childEnvironment(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '', ...extra }
}

beforeAll(() => {
  requireBuild()
})

// ---------------------------------------------------------------------------
// the lazy split
// ---------------------------------------------------------------------------

describe('the bundle split', () => {
  it('keeps the SDK out of the bundle every other command loads', () => {
    const main = readFileSync(MAIN_PATH, 'utf8')
    expect(main).not.toContain('modelcontextprotocol')
    expect(main).not.toContain('McpServer')
  })

  it('ships dist/mcp.js as a separate, self-contained file', () => {
    const mcp = readFileSync(join(MAIN_PATH, '..', 'mcp.js'), 'utf8')
    expect(mcp).toContain('modelcontextprotocol')
    expect(mcp.length).toBeGreaterThan(main().length)
  })

  function main(): string {
    return readFileSync(MAIN_PATH, 'utf8')
  }
})

// ---------------------------------------------------------------------------
// a real session, driven by the official client
// ---------------------------------------------------------------------------

describe('a real stdio session', () => {
  let root = ''
  let client: Client | undefined
  let transport: StdioClientTransport | undefined

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ghostchars-stdio-'))
    writeFileSync(join(root, 'clean.md'), 'plain ascii prose\n', 'utf8')
    writeFileSync(join(root, 'dirty.md'), `A${ZWSP}B\n`, 'utf8')
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, 'mcp', '--allow-write', '--root', root],
      env: childEnvironment(),
      stderr: 'pipe',
    })
    client = new Client({ name: 'ghostchars-tests', version: '1.0.0' })
    await client.connect(transport)
    await client.listTools()
  })

  afterAll(async () => {
    await client?.close()
    rmSync(root, { recursive: true, force: true })
  })

  function connected(): Client {
    if (client === undefined) throw new Error('the client did not connect')
    return client
  }

  it('advertises the five tools, in order, over the wire', async () => {
    const listed = await connected().listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'clean_text',
      'inspect_text',
      'style_report',
      'check_paths',
      'clean_files',
    ])
  })

  it('reports the server instructions, which say which bar to reach for', () => {
    const instructions = connected().getInstructions() ?? ''
    expect(instructions).toContain('Ghostchars')
    expect(instructions).toContain('bar "text"')
  })

  it('round-trips clean_text, and the client validates the structured output', async () => {
    const result = await connected().callTool({
      name: 'clean_text',
      arguments: { text: `A${ZWSP}B` },
    })
    expect(structured(result)['cleaned']).toBe('AB')
    expect(blockText(result, 1)).toBe('AB')
  })

  it('round-trips inspect_text', async () => {
    const result = await connected().callTool({
      name: 'inspect_text',
      arguments: { text: `A${ZWSP}B` },
    })
    expect(structured(result)['total']).toBe(1)
    expect(blockText(result, 0)).toContain('U+200B')
  })

  it('round-trips style_report', async () => {
    const result = await connected().callTool({
      name: 'style_report',
      arguments: { text: 'Aa bb. Cc dd. Ee ff.' },
    })
    expect(structured(result)['words']).toBe(6)
    expect(blockText(result, 0)).toContain('6 words, 3 sentences, 1 paragraphs')
  })

  it('round-trips check_paths against the --root it was given', async () => {
    const result = await connected().callTool({
      name: 'check_paths',
      arguments: { paths: ['.'] },
    })
    const payload = structured(result)
    expect(payload['ok']).toBe(false)
    expect(payload['files_failing']).toBe(1)
    expect(payload['root']).toContain('ghostchars-stdio-')
  })

  it('round-trips clean_files, and actually writes the file', async () => {
    const result = await connected().callTool({
      name: 'clean_files',
      arguments: { paths: ['dirty.md'] },
    })
    expect(structured(result)['unchanged']).toEqual([])
    expect(readFileSync(join(root, 'dirty.md'), 'utf8')).toBe('AB\n')
  })
})

describe('a session without --allow-write', () => {
  it('offers four tools and no writer', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, 'mcp'],
      env: childEnvironment(),
      stderr: 'pipe',
    })
    const client = new Client({ name: 'ghostchars-tests', version: '1.0.0' })
    try {
      await client.connect(transport)
      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        'clean_text',
        'inspect_text',
        'style_report',
        'check_paths',
      ])
    } finally {
      await client.close()
    }
  })
})

// ---------------------------------------------------------------------------
// the poison test
// ---------------------------------------------------------------------------

/**
 * A preloaded module that writes to stdout three ways, starting the moment the
 * server says it is ready. It arms on the readiness line because that is the
 * first thing written AFTER the guard is installed; anything earlier would be
 * writing to an fd nothing is protecting yet, which is not what is under test.
 */
const POISON_SOURCE = `
var realStderr = process.stderr.write.bind(process.stderr)
var armed = false

function poison() {
  console.log('POISON via console.log')
  process.stdout.write('POISON via process.stdout.write\\n')
}

process.stderr.write = function (chunk, encodingOrCallback, callback) {
  var text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  if (!armed && text.indexOf('MCP server') !== -1) {
    armed = true
    poison()
    setInterval(poison, 3).unref()
  }
  if (typeof encodingOrCallback === 'function') return realStderr(chunk, encodingOrCallback)
  if (encodingOrCallback === undefined) return realStderr(chunk)
  return realStderr(chunk, encodingOrCallback, callback)
}
`

interface RawSession {
  readonly child: ChildProcessWithoutNullStreams
  readonly stdout: () => string
  readonly stderr: () => string
  readonly send: (message: unknown) => void
  readonly waitFor: (id: number) => Promise<Record<string, unknown>>
}

function startRaw(args: readonly string[], env: Record<string, string>): RawSession {
  const child = spawn(process.execPath, [CLI_PATH, ...args], { env, stdio: 'pipe' })
  let outText = ''
  let errText = ''
  const pending = new Map<number, (value: Record<string, unknown>) => void>()
  let consumed = 0

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    errText += chunk
  })
  child.stdout.on('data', (chunk: string) => {
    outText += chunk
    // Deliver whole lines to whoever is waiting, without consuming the raw
    // transcript: the whole point of this session is to assert on it later.
    const boundary = outText.lastIndexOf('\n')
    if (boundary < consumed) return
    for (const line of outText.slice(consumed, boundary).split('\n')) {
      if (line.trim() === '') continue
      const parsed: unknown = safeParse(line)
      if (parsed === undefined) continue
      const id = idOf(parsed)
      if (id === undefined) continue
      const resolve = pending.get(id)
      if (resolve !== undefined && isRecord(parsed)) {
        pending.delete(id)
        resolve(parsed)
      }
    }
    consumed = boundary + 1
  })

  return {
    child,
    stdout: () => outText,
    stderr: () => errText,
    send: (message: unknown) => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    },
    waitFor: async (id: number) =>
      await new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, resolve)
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`no JSON-RPC reply to id ${id}`))
        }, 15_000).unref()
      }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeParse(line: string): unknown {
  try {
    const value: unknown = JSON.parse(line)
    return value
  } catch {
    return undefined
  }
}

function idOf(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const id = value['id']
  return typeof id === 'number' ? id : undefined
}

describe('the stdout guard', () => {
  it('survives a console.log, a direct write and a startup log, all at once', async () => {
    const poisonDirectory = mkdtempSync(join(tmpdir(), 'ghostchars-poison-'))
    const poisonFile = join(poisonDirectory, 'poison.mjs')
    writeFileSync(poisonFile, POISON_SOURCE, 'utf8')
    const session = startRaw(['mcp'], {
      ...childEnvironment(),
      NODE_OPTIONS: `--import ${pathToFileURL(poisonFile).href}`,
    })

    try {
      session.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'ghostchars-tests', version: '1.0.0' },
        },
      })
      await session.waitFor(1)
      session.send({ jsonrpc: '2.0', method: 'notifications/initialized' })

      // Two calls, spread over time, so the interval fires during a handler.
      session.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'clean_text', arguments: { text: `A${ZWSP}B` } },
      })
      const first = await session.waitFor(2)
      await new Promise((resolve) => setTimeout(resolve, 120))
      session.send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
      const second = await session.waitFor(3)

      // 1. The client got its results.
      expect(structured(first['result'])['cleaned']).toBe('AB')
      expect(isRecord(second['result'])).toBe(true)

      // 2. Every non-empty line on the REAL stdout is a JSON-RPC message.
      const lines = session.stdout().split('\n').filter((line) => line.trim() !== '')
      expect(lines.length).toBeGreaterThanOrEqual(3)
      for (const line of lines) {
        const parsed: unknown = safeParse(line)
        expect(isRecord(parsed), `not JSON-RPC: ${line.slice(0, 120)}`).toBe(true)
        if (isRecord(parsed)) expect(parsed['jsonrpc']).toBe('2.0')
      }

      // 3. The poison really did run, and landed on stderr where it is noise.
      expect(session.stderr()).toContain('POISON via console.log')
      expect(session.stderr()).toContain('POISON via process.stdout.write')
      expect(session.stderr()).toContain('MCP server')
    } finally {
      session.child.kill()
      rmSync(poisonDirectory, { recursive: true, force: true })
    }
  })
})
