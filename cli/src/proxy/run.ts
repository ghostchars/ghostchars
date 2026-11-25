/**
 * `mcp-proxy`: run an MCP server as a child process and stand between it and
 * the host on stdio.
 *
 * WHAT FLOWS WHERE. The host's stdin goes to the child's stdin byte for byte:
 * a request is never rewritten. Each line is also read, only to remember which
 * method each request id asked for. The child's stdout comes back line by line,
 * and each message in it is cleaned by what it is:
 *
 *  - A response to a method in `SANITIZED_METHODS` is cleaned by that method.
 *    A response to any other method the host asked for loses run-scheme
 *    carriers in every string and key, and keeps its visible text.
 *  - A response whose id the host has no open request for (never asked, or
 *    already answered) has its whole result cleaned. A client should discard
 *    it, but one that does not would otherwise read it raw.
 *  - A request or notification in `SERVER_METHODS` has its params cleaned;
 *    any other one has carriers removed from its params.
 *  - The method name and any member JSON-RPC does not define lose carriers.
 *    The id and the version tag are never touched.
 *
 * WHAT MAKES A RESPONSE. A message is a response when it has a `result` or an
 * `error`, whatever else it has. A hostile server can add a `method` to a
 * response for a request the host is waiting on: a strict client rejects that
 * message, a lenient one takes it as the answer. So such a message is cleaned
 * as the response it may be, and also as the request it claims to be.
 *
 * A LINE THAT IS NOT A MESSAGE. On stdio, MCP is newline-delimited JSON-RPC
 * and the server must write nothing else to stdout. A line that is not a JSON
 * object or a batch of them is a protocol error a conforming client discards,
 * so dropping it loses nothing, while passing it on would hand a lenient
 * client, or a host log a person reads, text nothing here inspected. It is
 * dropped and named on stderr by size, never content. Under `--report-only`,
 * which changes nothing, it is passed on and still named. A blank line carries
 * nothing and is passed on.
 *
 * SERIALISED, NEVER RELAYED. Every message from the server goes on as
 * `JSON.stringify` of the value this proxy parsed and checked, even when the
 * check changed nothing, and never as the bytes that arrived. Relaying the
 * bytes would let any difference between this parser and the host's decide
 * what the host reads: with `{"text":"hidden","text":"clean"}`, JSON.parse
 * keeps the last member and checks "clean", while a parser that keeps the
 * first would read "hidden". The same holds for escapes, lone surrogates and
 * whitespace. The serialisation is one line: JSON.stringify escapes every
 * control character, LF included, and U+2028 and U+2029, which it writes
 * raw, are not LF, the only byte the stdio framing splits on. A lone
 * surrogate is written as an escape. Under `--report-only`, which promises to
 * change nothing, the bytes that arrived go on instead.
 *
 * WITHHELD, NOT DROPPED. A message that cannot go on (an id the host matches
 * holds a hidden character, an id or version tag JSON-RPC does not allow, two
 * member names the same once cleaned, nesting past `MAX_DEPTH`) is withheld.
 * When it answers a request the host has open, the host gets a JSON-RPC error
 * for that request in its place, so it is never left waiting. Depth is read
 * from the line before it is parsed: the parse that keeps number text
 * recurses, and a few thousand levels exhaust its stack.
 *
 * THE CHILD'S STDERR. Hosts show it in a log, and some keep it, so it is
 * cleaned line by line as prose and goes on with its line breaks.
 *
 * WHY THE PARSE KEEPS NUMBER TEXT. A changed message has to be serialised
 * again, and `JSON.parse` turns `12345678901234567890` into a double that
 * prints differently. Node 22 and newer expose each number's source text to a
 * reviver, and the parse below keeps any number that would not print back
 * identically as raw JSON, so ids and data survive a rewrite unchanged.
 *
 * BACKPRESSURE BOTH WAYS. When a writer reports a full buffer, the matching
 * reader pauses until it drains. Neither direction waits on the other, so a
 * large message in one cannot stall the other.
 *
 * EXIT. The proxy exits when the child does, with its exit code. A child killed
 * by a signal is reported by the proxy dying of the same signal. SIGINT,
 * SIGTERM and SIGHUP sent to the proxy are passed to the child, which decides
 * what they mean.
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync, writeSync } from 'node:fs'
import { constants } from 'node:os'

import type { CleanOptions } from '@ghostchars/engine'

import { UsageError } from '../exit.js'
import { errLine, errnoOf, fileErrorMessage, useStderrForOut } from '../io.js'
import * as strings from '../strings.js'

import { LineSplitter } from './lines.js'
import {
  isRecord,
  MAX_DEPTH,
  sanitizeEnvelope,
  sanitizeResponse,
  sanitizeServerMessage,
  sanitizeText,
  TooDeep,
} from './sanitize.js'
import type { FieldReport, SanitizeConfig, SanitizedMessage, Withheld } from './sanitize.js'

export interface ProxyOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly options: CleanOptions
  readonly reportOnly: boolean
  /** Append one JSON line per finding here. */
  readonly logPath?: string
}

const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

/** A request id, normalised so `1` and `1.0` from either side match. */
function idKey(id: unknown): string | null {
  if (typeof id === 'string') return `s:${id}`
  if (typeof id === 'number') return `n:${id}`
  if (isRawJsonNumber(id)) return `n:${Number(id.rawJSON)}`
  return null
}

function isRawJsonNumber(value: unknown): value is { rawJSON: string } {
  const check: unknown = Reflect.get(JSON, 'isRawJSON')
  return (
    typeof check === 'function' &&
    Reflect.apply(check, JSON, [value]) === true &&
    typeof value === 'object' &&
    value !== null &&
    'rawJSON' in value &&
    typeof value.rawJSON === 'string'
  )
}

const rawJson: unknown = Reflect.get(JSON, 'rawJSON')

/** The reviver that keeps a number's source text when it would not round-trip. */
function keepNumberText(_key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value !== 'number' || typeof rawJson !== 'function') return value
  const source = context?.source
  if (source === undefined || String(value) === source) return value
  return Reflect.apply(rawJson, JSON, [source])
}

function parseLine(text: string, lossless: boolean): unknown {
  try {
    const parsed: unknown = lossless ? JSON.parse(text, keepNumberText) : JSON.parse(text)
    return parsed
  } catch {
    return undefined
  }
}

/** The elements of a message or a batch. */
function membersOf(parsed: unknown): unknown[] {
  return Array.isArray(parsed) ? parsed : [parsed]
}

/**
 * How deeply a line's arrays and objects nest, read without parsing it, so a
 * line built to exhaust the parser's stack is caught before it is parsed.
 */
function nestingDepth(text: string): number {
  let depth = 0
  let deepest = 0
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i)
    if (inString) {
      if (ch === 0x5c) i += 1
      else if (ch === 0x22) inString = false
    } else if (ch === 0x22) inString = true
    else if (ch === 0x5b || ch === 0x7b) {
      depth += 1
      if (depth > deepest) deepest = depth
    } else if (ch === 0x5d || ch === 0x7d) depth -= 1
  }
  return deepest
}

/** A JSON-RPC object, or a non-empty batch of them. */
function isMessage(parsed: unknown): boolean {
  if (Array.isArray(parsed)) return parsed.length > 0 && parsed.every(isRecord)
  return isRecord(parsed)
}

/** The report label for a response that answers no open request. */
const UNMATCHED = 'response-to-unknown-id'

/** The report label for a method name or a member JSON-RPC does not define. */
const ENVELOPE = 'message'

/** The report label for a line of the server's stderr. */
const SERVER_STDERR = 'server-stderr'

/** Spaces, tabs and a CR only. */
function isBlank(line: Buffer): boolean {
  return line.every((byte) => byte === 0x20 || byte === 0x09 || byte === 0x0d)
}

/** One JSON line per finding, without the text it was found in. */
function logRecord(method: string, id: unknown, report: FieldReport): string {
  return JSON.stringify({
    time: new Date().toISOString(),
    tool: strings.TOOL,
    method,
    id: idKey(id) === null ? null : id,
    path: report.path,
    hidden: report.hidden,
    kinds: report.kinds,
    payloads: report.payloads,
    ...(report.policy === undefined ? {} : { policy: report.policy }),
    ...(report.unchanged === true ? { unchanged: true } : {}),
    ...(report.note === undefined ? {} : { note: report.note }),
  })
}

function openLog(path: string): number {
  try {
    return openSync(path, 'a', 0o600)
  } catch (error) {
    throw new UsageError(fileErrorMessage(path, error))
  }
}

async function started(child: ReturnType<typeof spawn>, command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => {
      resolve()
    })
    child.once('error', (error) => {
      reject(new UsageError(strings.errProxySpawn(command, strings.errnoMessage(errnoOf(error)))))
    })
  })
}

export async function runProxy(proxy: ProxyOptions): Promise<number> {
  // fd 1 belongs to the protocol from here on. Anything a shared module prints
  // through `src/io.ts` lands on stderr.
  useStderrForOut()
  const config: SanitizeConfig = { options: proxy.options, reportOnly: proxy.reportOnly }
  const logFd = proxy.logPath === undefined ? undefined : openLog(proxy.logPath)
  /** Each open request by id: its method, and the id as the host wrote it. */
  const pending = new Map<string, { readonly method: string; readonly id: unknown }>()

  const child = spawn(proxy.command, [...proxy.args], { stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => {
      resolve({ code, signal })
    })
  })
  try {
    await started(child, proxy.command)
  } catch (error) {
    if (logFd !== undefined) closeSync(logFd)
    throw error
  }
  const { stdin: childIn, stdout: childOut, stderr: childErr } = child
  if (childIn === null || childOut === null || childErr === null) throw new Error('the child has no stdio pipes')
  errLine(strings.proxyReady(proxy.command, proxy.reportOnly))

  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal)
  }
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward)

  // ------------------------------------------------------------ host to server

  const track = (line: Buffer): void => {
    if (line.length === 0) return
    for (const member of membersOf(parseLine(line.toString('utf8'), true))) {
      if (!isRecord(member)) continue
      const method = member['method']
      const id = member['id']
      const key = idKey(id)
      if (typeof method === 'string' && key !== null) pending.set(key, { method, id })
    }
  }
  const fromHost = new LineSplitter(track)

  // A child that exits early closes its stdin; a write after that is EPIPE,
  // and the exit itself is what the proxy reports.
  childIn.on('error', () => undefined)
  let hostPaused = false
  process.stdin.on('data', (chunk: Buffer) => {
    fromHost.push(chunk)
    if (!childIn.write(chunk) && !hostPaused) {
      hostPaused = true
      process.stdin.pause()
      childIn.once('drain', () => {
        hostPaused = false
        process.stdin.resume()
      })
    }
  })
  process.stdin.on('end', () => {
    const rest = fromHost.flush()
    if (rest !== null) track(rest)
    childIn.end()
  })

  // ------------------------------------------------------------ server to host

  const report = (method: string, id: unknown, reports: readonly FieldReport[]): void => {
    for (const found of reports) {
      const unchanged = proxy.reportOnly || found.unchanged === true
      errLine(strings.proxyFinding(method, found.path, found.hidden, found.payloads, unchanged, found.note, found.policy))
      if (logFd !== undefined) writeSync(logFd, `${logRecord(method, id, found)}\n`)
    }
  }

  /** What to do with one line from the server. */
  type Outcome = { readonly kind: 'forward' } | { readonly kind: 'drop' } | { readonly kind: 'rewrite'; readonly text: string }

  /** The open request a response answers, taken off the list, or undefined. */
  const answer = (member: Record<string, unknown>): { readonly method: string; readonly id: unknown } | undefined => {
    if (!('result' in member) && !('error' in member)) return undefined
    const key = idKey(member['id'])
    const asked = key === null ? undefined : pending.get(key)
    if (key !== null && asked !== undefined) pending.delete(key)
    return asked
  }

  /**
   * In place of a withheld response to an open request, an error the host can
   * act on, so it does not wait for an answer that will never come.
   */
  const refusal = (asked: { readonly id: unknown } | undefined, why: Withheld): unknown[] => {
    errLine(strings.proxyWithheld(why, proxy.reportOnly))
    if (asked === undefined) return []
    return [{ jsonrpc: '2.0', id: asked.id, error: { code: -32603, message: strings.proxyWithheldError(why) } }]
  }

  /**
   * Clean one message in place. Returns the messages that go on in its place:
   * itself, nothing, or an error for the open request it answered.
   */
  const clean = (member: Record<string, unknown>): unknown[] => {
    let withheld: Withheld | undefined
    const apply = (label: string, outcome: SanitizedMessage): void => {
      report(label, member['id'], outcome.reports)
      withheld ??= outcome.withheld
    }
    // Member names are cleaned first: everything below reads them by name.
    apply(ENVELOPE, sanitizeEnvelope(member, config))
    const asked = answer(member)
    try {
      if (withheld === undefined && ('result' in member || 'error' in member)) {
        apply(asked?.method ?? UNMATCHED, sanitizeResponse(member, asked?.method, config))
      }
      const method = member['method']
      if (withheld === undefined && typeof method === 'string') apply(method, sanitizeServerMessage(member, method, config))
    } catch (error) {
      if (!(error instanceof TooDeep)) throw error
      withheld = 'too-deep'
    }
    if (withheld === undefined) return [member]
    if (proxy.reportOnly) {
      errLine(strings.proxyWithheld(withheld, true))
      return [member]
    }
    return refusal(asked, withheld)
  }

  /** A line nested past what the walk will enter: refuse each open request it answers. */
  const tooDeep = (text: string): Outcome => {
    let parsed: unknown
    try {
      // The parse without a reviver does not recurse, so it reads any depth.
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (!isMessage(parsed)) {
      errLine(strings.proxyNotMessage(Buffer.byteLength(text), proxy.reportOnly))
      return proxy.reportOnly ? { kind: 'forward' } : { kind: 'drop' }
    }
    if (proxy.reportOnly) {
      errLine(strings.proxyWithheld('too-deep', true))
      return { kind: 'forward' }
    }
    const out = membersOf(parsed).flatMap((member) => (isRecord(member) ? refusal(answer(member), 'too-deep') : []))
    if (out.length === 0) return { kind: 'drop' }
    return { kind: 'rewrite', text: JSON.stringify(Array.isArray(parsed) ? out : out[0]) }
  }

  const transform = (line: Buffer): Outcome => {
    if (isBlank(line)) return { kind: 'forward' }
    const text = line.toString('utf8')
    if (nestingDepth(text) > MAX_DEPTH) return tooDeep(text)
    const parsed = parseLine(text, true)
    if (!isMessage(parsed)) {
      errLine(strings.proxyNotMessage(line.length, proxy.reportOnly))
      return proxy.reportOnly ? { kind: 'forward' } : { kind: 'drop' }
    }
    const out = membersOf(parsed).flatMap((member) => (isRecord(member) ? clean(member) : []))
    if (proxy.reportOnly) return { kind: 'forward' }
    if (out.length === 0) return { kind: 'drop' }
    // What goes on is always the serialisation of what was checked, changed or
    // not. See SERIALISED, NEVER RELAYED above.
    return { kind: 'rewrite', text: JSON.stringify(Array.isArray(parsed) ? out : out[0]) }
  }

  // One chunk can hold many lines, so the drain listener is armed once per
  // pause rather than once per line.
  let serverPaused = false
  const send = (bytes: Buffer | string): void => {
    if (!process.stdout.write(bytes) && !serverPaused) {
      serverPaused = true
      childOut.pause()
      process.stdout.once('drain', () => {
        serverPaused = false
        childOut.resume()
      })
    }
  }

  /** Send one line on, with `end` after it: a newline, or nothing for the last. */
  const relay = (line: Buffer, end: string): void => {
    const outcome = transform(line)
    if (outcome.kind === 'drop') return
    if (outcome.kind === 'rewrite') send(`${outcome.text}${end}`)
    else send(end === '' ? line : Buffer.concat([line, Buffer.from(end)]))
  }

  const toHost = new LineSplitter((line) => {
    relay(line, '\n')
  })
  childOut.on('data', (chunk: Buffer) => {
    toHost.push(chunk)
  })
  // The bytes after the last newline are judged like any line, so a message the
  // server ends without a newline is no way around the filter.
  childOut.on('end', () => {
    const rest = toHost.flush()
    if (rest !== null) relay(rest, '')
  })

  // ------------------------------------------------------------ server stderr

  // Hosts show the server's stderr in a log, and some keep it, so each line is
  // cleaned as prose and goes on with its line ending. A finding in it is
  // reported like any other.
  let errLines = 0
  const cleanErr = (line: Buffer, end: string): void => {
    errLines += 1
    const raw = line.toString('utf8')
    const cr = raw.endsWith('\r') ? '\r' : ''
    const body = cr === '' ? raw : raw.slice(0, -1)
    const { text, report: found } = sanitizeText(body, config, false)
    process.stderr.write(`${text}${cr}${end}`)
    if (found !== null) report(SERVER_STDERR, null, [{ path: `line ${String(errLines)}`, ...found }])
  }
  const serverErr = new LineSplitter((line) => {
    cleanErr(line, '\n')
  })
  childErr.on('data', (chunk: Buffer) => {
    serverErr.push(chunk)
  })
  childErr.on('end', () => {
    const rest = serverErr.flush()
    if (rest !== null) cleanErr(rest, '')
  })

  // ------------------------------------------------------------------- exit

  const { code, signal } = await closed
  for (const forwarded of FORWARDED_SIGNALS) process.off(forwarded, forward)
  process.stdin.removeAllListeners('data')
  process.stdin.destroy()
  if (logFd !== undefined) closeSync(logFd)
  // An empty write's callback runs once everything queued before it is out,
  // which matters most before the proxy kills itself below.
  for (const stream of [process.stdout, process.stderr]) {
    await new Promise<void>((resolve) => {
      stream.write('', () => {
        resolve()
      })
    })
  }
  if (signal !== null) {
    process.kill(process.pid, signal)
    return 128 + (constants.signals[signal] ?? 0)
  }
  return code ?? 0
}
