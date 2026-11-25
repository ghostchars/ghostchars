/**
 * The server: construction, the stdout guard, and the transport.
 *
 * THE STDOUT PROBLEM, AND THREE INDEPENDENT LAYERS AGAINST IT. Under stdio the
 * JSON-RPC stream owns fd 1, and exactly three kinds of write corrupt it: a
 * `console.log`, a direct `process.stdout.write`, and anything logged while the
 * process starts. The same bundle legitimately writes to stdout in CLI mode, so
 * "just do not print" is not a design, it is a hope. The three layers are:
 *
 *  1. ARCHITECTURE. Nothing in this package reaches a stream except through
 *     `src/io.ts`, and {@link serve} calls `useStderrForOut()` before anything
 *     can run, so a command module reused by a tool writes to stderr.
 *  2. THE GUARD. {@link installStdoutGuard} captures the real writer, hands it
 *     privately to the transport, and repoints the public
 *     `process.stdout.write` at stderr. After that, a stray `console.log`
 *     anywhere (in this package, in the SDK, in a preloaded module) lands on
 *     stderr where it is merely noise.
 *  3. LINT. `no-console: error` with no allow list. There is no legitimate
 *     `console.*` call in this package.
 *
 * `mcp.stdio.test.ts` poisons a running session on purpose, with all three
 * kinds of write, and asserts that every non-empty line on the real stdout
 * still parses as JSON-RPC.
 *
 * WHY THE READINESS LINE IS ON STDERR. Because fd 1 belongs to the protocol.
 * It exists so that a person debugging a host configuration can see the server
 * came up at all, which is the single most common thing to get wrong.
 *
 * NOTHING HERE HARDCODES A PROTOCOL VERSION. SDK 1.30 negotiates `2025-11-25`
 * and older; the current specification revision is newer. Advertising a version
 * we do not implement would be a lie the SDK would then have to unpick.
 */
import { Writable } from 'node:stream'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { EXIT_OK } from '../exit.js'
import { errLine, useStderrForOut } from '../io.js'
import * as strings from '../strings.js'

import { registerTools } from './tools.js'

/** Everything `ghostchars mcp` can be told from the command line. */
export interface ServeOptions {
  /** The server name reported to the host. Defaults to `ghostchars`. */
  readonly name: string
  /** Register `clean_files`, which writes to disk. Off unless asked for. */
  readonly allowWrite: boolean
  /** Prepended to every tool name, for a host that already has one of ours. */
  readonly toolPrefix: string
  /** The directory tool paths are resolved against, and confined to. */
  readonly root: string
}

/** What a caller has to pass; the rest is filled in here. */
export const DEFAULT_SERVE_OPTIONS: ServeOptions = {
  name: strings.TOOL,
  allowWrite: false,
  toolPrefix: '',
  root: '.',
}

/**
 * Build the server and register its tools, without connecting anything.
 *
 * Split out from {@link serve} so `mcp.inmemory.test.ts` can drive the same
 * server the binary runs over a linked pair of in-memory transports, which is
 * how every tool gets per-behaviour coverage without a subprocess.
 */
export function createServer(options: ServeOptions): { server: McpServer; tools: string[] } {
  const server = new McpServer(
    { name: options.name, version: strings.VERSION },
    { capabilities: { tools: {} }, instructions: strings.MCP_INSTRUCTIONS },
  )
  const tools = registerTools(server, options)
  return { server, tools }
}

/** What the transport writes through, and nobody else can reach. */
export interface StdoutGuard {
  readonly protocolOut: Writable
}

/**
 * Capture fd 1 for the protocol and point everything else at stderr.
 *
 * The order matters: the real writer is bound BEFORE the public one is
 * replaced, so `protocolOut` keeps writing to the actual stdout while every
 * later `process.stdout.write` (and therefore every `console.log`, which calls
 * it) goes to stderr.
 */
export function installStdoutGuard(): StdoutGuard {
  const realWrite = process.stdout.write.bind(process.stdout)

  const protocolOut = new Writable({
    write(
      chunk: Uint8Array | string,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): void {
      realWrite(chunk, () => {
        callback()
      })
    },
    final(callback: (error?: Error | null) => void): void {
      callback()
    },
  })

  // One implementation signature that satisfies BOTH of the stream's overloads,
  // `(chunk, cb?)` and `(chunk, encoding?, cb?)`, so it can be assigned without
  // a cast in a package that bans them.
  function redirected(
    chunk: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    if (typeof encodingOrCallback === 'function') {
      return process.stderr.write(chunk, encodingOrCallback)
    }
    if (encodingOrCallback === undefined) return process.stderr.write(chunk)
    return process.stderr.write(chunk, encodingOrCallback, callback)
  }

  process.stdout.write = redirected
  useStderrForOut()
  return { protocolOut }
}

/**
 * Run the server until the transport closes.
 *
 * `onclose` is set on the inner `Server` rather than on the transport, because
 * `connect()` takes ownership of the transport's own callbacks. The returned
 * promise is what keeps `ghostchars mcp` alive: the process stays up as long as
 * the host holds stdin open.
 */
export async function serve(options: ServeOptions): Promise<number> {
  const { server, tools } = createServer(options)
  const { protocolOut } = installStdoutGuard()

  const closed = new Promise<void>((resolveClosed) => {
    server.server.onclose = (): void => {
      resolveClosed()
    }
  })

  await server.connect(new StdioServerTransport(process.stdin, protocolOut))
  errLine(strings.mcpReady(options.name, tools.length))
  await closed
  return EXIT_OK
}
