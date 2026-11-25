/**
 * What `mcp-proxy` does to one message: find the strings a model will read,
 * clean them, and say what was removed.
 *
 * WHICH STRINGS. A server reaches the model through a handful of results:
 * the `instructions` in its initialize result, the tool, prompt and resource
 * listings, a tool call's content (directly or through a task), a resource
 * read, a prompt and completion values. Those are the methods in
 * {@link SANITIZED_METHODS}. It also reaches the model or the user through the
 * requests and notifications it sends on its own, {@link SERVER_METHODS}. In
 * each of these every string value is cleaned except the protocol fields a
 * client compares or decodes byte for byte ({@link PROTOCOL_KEYS}: URIs, ids,
 * cursors, MIME types, base64 data, schema keywords). Inside
 * `structuredContent` and a log message's `data`, which are the server's own
 * data, every string is cleaned. A resource `blob` whose media type is text is
 * decoded and cleaned like `text`.
 *
 * EXACT FIELDS STILL LOSE WHAT DRAWS NOTHING. Object keys, protocol fields and
 * the exact values of a JSON Schema (keywords, enum members, required names)
 * keep their visible text exactly but lose every invisible, bidi, format and
 * control character, except glue the classifier binds (the joiner in a
 * Persian word, the ZWJ and VS16 of an emoji) and only while the proxy policy
 * lets it stand; so do `_meta` and any message whose method this module has
 * no map of ({@link stripInvisible}). A scattered scheme in one is flattened
 * by its channel. A client compares these, so no clean that touches visible
 * text is safe. An id the host matches against its own copy, at the exact
 * places {@link RESPONSE_IDS} and {@link SERVER_IDS} name, cannot be changed
 * at all, so a message with any hidden character in one is withheld.
 *
 * WHAT CLEANING MEANS. The standard clean, at the option set the command line
 * chose, plus three things when the decoder finds a payload:
 *
 *  1. A run scheme (tag characters, variation selectors, a zero-width run) is
 *     deleted by its span, which also covers the case the default clean keeps,
 *     such as a long tag run dressed as a flag.
 *  2. A scattered scheme is a pattern in visible typography, so it is erased by
 *     turning on the one clean option that flattens that channel, for that
 *     string only: trailing whitespace, no-break spaces, doubled spaces, curly
 *     apostrophes, decomposed letters. Bidi marks need nothing extra: the
 *     default clean already removes the ones that carry bits.
 *  3. A visible notice is appended to a prose field naming each scheme and how
 *     many characters carried it. Never the decoded text: that is the attack.
 *
 * Look-alike letters are the exception. They are a fingerprint rather than a
 * message, and folding them rewrites letters, so they are removed only when the
 * proxy runs with `--max`, which turns on the confusables pass.
 *
 * STRICTER THAN THE DEFAULT CLEAN. On top of the clean, prose loses what the
 * proxy policy in `policy.ts` removes (tag sequences that are not a
 * recommended flag, variation selectors other than an emoji's, bidi marks,
 * trains of glue bound to letters), and controls and private-use characters,
 * by switching on the `controls` and `pua` options. Each of those removals is
 * named in the notice and on stderr.
 */
import { cleanText, decode, DEFAULT_OPTIONS, enabledFlags, resolveOptions, toFinding } from '@ghostchars/engine'
import type { CleanOptionKey, CleanOptions, PayloadConfidence, PayloadScheme } from '@ghostchars/engine'

import * as strings from '../strings.js'

import { analyse, exactDrops, hasHidden, policyDrops } from './policy.js'

/** The results whose strings reach the model, keyed by the request method. */
export const SANITIZED_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
  'completion/complete',
  'tasks/get',
  'tasks/list',
  'tasks/result',
  'tasks/cancel',
])

/**
 * Requests and notifications a server sends the host whose params carry text
 * a model or a person reads: a sampling request is a prompt, an elicitation is
 * a question put to the user, and log, progress, cancellation and task status
 * messages are shown in the host.
 */
export const SERVER_METHODS: ReadonlySet<string> = new Set([
  'sampling/createMessage',
  'elicitation/create',
  'notifications/message',
  'notifications/progress',
  'notifications/cancelled',
  'notifications/tasks/status',
])

/** Schemes whose carriers sit next to each other and can be deleted by span. */
const RUN_SCHEMES: ReadonlySet<PayloadScheme> = new Set([
  'tag-ascii',
  'variation-selector',
  'zero-width-binary',
  'canary',
])

/** The one clean option that flattens each scattered channel. */
const CHANNEL_OPTION: Readonly<Partial<Record<PayloadScheme, CleanOptionKey>>> = {
  'trailing-whitespace': 'trailing',
  'space-nbsp-binary': 'spaces',
  'double-space-binary': 'collapse',
  'apostrophe-binary': 'punct',
  'normalization-binary': 'nfc',
}

/**
 * String fields a client compares or decodes exactly: URIs, media types,
 * version tags, base64, schema keywords. The full clean would break the
 * protocol rather than protect the model, so they lose every invisible, bidi,
 * format and control character ({@link stripInvisible}), none of which a URI,
 * a token or base64 may hold, and keep every visible one. `data` and `blob`
 * get this only while they are base64; any other string under them is text
 * and gets the full clean. Only a string value is treated this way: an object
 * under one of these keys (a schema property named `type`, say) is still
 * walked.
 */
const PROTOCOL_KEYS: ReadonlySet<string> = new Set([
  'uri',
  'uriTemplate',
  'url',
  'mimeType',
  'blob',
  'data',
  'protocolVersion',
  'type',
  'format',
  'pattern',
  '$ref',
  '$id',
  '$schema',
  '$anchor',
])

/**
 * The names of the ids a host matches against a copy it holds. Only at the
 * exact places listed in {@link RESPONSE_IDS} and {@link SERVER_IDS} is such
 * an id left as the server sent it. Under these names anywhere else in a
 * schema it loses carriers like a keyword; anywhere else at all it is ordinary
 * text and gets the full clean.
 */
const CORRELATION_KEYS: ReadonlySet<string> = new Set([
  'progressToken',
  'requestId',
  'taskId',
  'elicitationId',
  'nextCursor',
])

const LIST_CURSOR = /^\/result\/nextCursor$/

/**
 * Where a response carries an id the host will send back or match: the next
 * page's cursor, and the task id of a task a tool call started or the task
 * methods describe. Keyed by the method of the request the response answers.
 */
const RESPONSE_IDS: Readonly<Record<string, RegExp>> = {
  'tools/list': LIST_CURSOR,
  'resources/list': LIST_CURSOR,
  'resources/templates/list': LIST_CURSOR,
  'prompts/list': LIST_CURSOR,
  'tasks/list': /^\/result\/(?:nextCursor|tasks\/\d+\/taskId)$/,
  'tools/call': /^\/result\/task\/taskId$/,
  'tasks/get': /^\/result\/taskId$/,
  'tasks/cancel': /^\/result\/taskId$/,
}

/**
 * Where a server's own request or notification names an id the host matches:
 * the progress token of the host's request, the id of a request being
 * cancelled, a task, an elicitation. Keyed by the message's method.
 */
const SERVER_IDS: Readonly<Record<string, RegExp>> = {
  'notifications/progress': /^\/params\/progressToken$/,
  'notifications/cancelled': /^\/params\/requestId$/,
  'notifications/tasks/status': /^\/params\/taskId$/,
  'elicitation/create': /^\/params\/elicitationId$/,
  'notifications/elicitation/complete': /^\/params\/elicitationId$/,
  'tasks/get': /^\/params\/taskId$/,
  'tasks/result': /^\/params\/taskId$/,
  'tasks/cancel': /^\/params\/taskId$/,
}

const NO_IDS = /$^/

/**
 * Inside a JSON Schema, the values a validator compares exactly: an enum
 * member, a constant, a required property name. They lose every invisible and
 * format character ({@link stripInvisible}) and keep every visible one, so a
 * value the model sends back still validates. A `default`, an example, a
 * `title` or a `description` is free text and gets the full clean.
 */
const SCHEMA_EXACT_KEYS: ReadonlySet<string> = new Set(['enum', 'const', 'required'])

/** Schema keywords whose value is an identifier, cleaned like {@link SCHEMA_EXACT_KEYS}. */
const SCHEMA_KEYWORD_KEYS: ReadonlySet<string> = new Set(['$dynamicRef', '$dynamicAnchor'])

/** The members whose object holds a JSON Schema. */
const SCHEMA_KEYS: ReadonlySet<string> = new Set(['inputSchema', 'outputSchema', 'requestedSchema'])

/** Prose fields: the ones that carry the visible notice when a payload goes. */
const NOTICE_KEYS: ReadonlySet<string> = new Set(['text', 'description', 'instructions', 'message', 'systemPrompt'])

/** What happened to one payload. */
export type PayloadAction = 'removed' | 'kept' | 'reported'

/** One payload, as the log records it. Never its decoded text. */
export interface PayloadNote {
  readonly scheme: PayloadScheme
  readonly confidence: PayloadConfidence
  /** How many characters carried it. */
  readonly characters: number
  readonly bits: number
  readonly action: PayloadAction
}

/** What one string held. */
export interface TextReport {
  /** Hidden characters removed or replaced, or that would be in report-only mode. */
  readonly hidden: number
  /** The same count, by the engine's finding kind. */
  readonly kinds: Readonly<Record<string, number>>
  readonly payloads: readonly PayloadNote[]
  /** Characters the proxy policy removed beyond the clean, by category. */
  readonly policy?: Readonly<Record<string, number>>
  /** Set when the text was deliberately left as it was, whatever the mode. */
  readonly unchanged?: true
  /** What happened, when it is not a count of characters. */
  readonly note?: ProxyNote
}

/** A finding that is not a count of characters. */
export type ProxyNote = 'undecodable-text-blob' | 'colliding-keys' | 'colliding-members'

export interface SanitizeConfig {
  /** The option set the command line chose. */
  readonly options: CleanOptions
  /** Pass everything through unchanged and only report. */
  readonly reportOnly: boolean
}

export interface SanitizedText {
  readonly text: string
  /** `null` when the string held nothing worth reporting. */
  readonly report: TextReport | null
}

/**
 * Printable ASCII and LF, with no doubled space and no whitespace at the end of
 * a line: no clean option changes such a string and no scheme can hide in it,
 * so the common case skips the engine entirely. A CR is left to the engine,
 * because the max bar rewrites line endings.
 */
const PLAIN = /^[\x20-\x7e\t\n]*$/
const SPACING_CARRIER = / {2}|[ \t](?:\n|$)/

/**
 * Every clean option off, which is what the default set is: the base for
 * flattening one scattered channel and nothing else.
 */
const NO_OPTIONS: CleanOptions = { ...DEFAULT_OPTIONS }

/**
 * The codepoints whose index `drop` does not hold, as a string. Built in
 * chunks: spreading millions of arguments into one call overflows the stack.
 */
function joinKept(cps: readonly number[], drop: { has(index: number): boolean }): string {
  const parts: string[] = []
  let chunk: number[] = []
  cps.forEach((cp, i) => {
    if (drop.has(i)) return
    chunk.push(cp)
    if (chunk.length === 8192) {
      parts.push(String.fromCodePoint(...chunk))
      chunk = []
    }
  })
  parts.push(String.fromCodePoint(...chunk))
  return parts.join('')
}

/** Add one to a count in a record. */
function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1
}

/** One decoded payload as the log records it. */
function payloadNote(payload: { scheme: PayloadScheme; confidence: PayloadConfidence; start: number; end: number; bits: number }, action: PayloadAction): PayloadNote {
  const characters = RUN_SCHEMES.has(payload.scheme) ? payload.end - payload.start : payload.bits
  return { scheme: payload.scheme, confidence: payload.confidence, characters, bits: payload.bits, action }
}

/**
 * Clean one string of prose. With `notice`, a removed payload or a policy
 * removal leaves a bracketed line at the end of the text naming what went and
 * how many characters carried it.
 */
export function sanitizeText(text: string, config: SanitizeConfig, notice: boolean): SanitizedText {
  if (PLAIN.test(text) && !SPACING_CARRIER.test(text)) return { text, report: null }
  const analysis = analyse(text)
  const payloads = decode(text)
  // The proxy's prose clean: the command line's option set, with controls and
  // private-use characters always on.
  const options: CleanOptions = { ...config.options, controls: true, pua: true }
  const spans = new Set<number>()
  const notes: PayloadNote[] = []

  for (const payload of payloads) {
    const run = RUN_SCHEMES.has(payload.scheme)
    let action: PayloadAction = config.reportOnly ? 'reported' : 'removed'
    if (run) for (let i = payload.start; i < payload.end; i += 1) spans.add(i)
    else if (payload.scheme === 'homoglyph') {
      if (!options.confusables) action = 'kept'
    } else {
      const key = CHANNEL_OPTION[payload.scheme]
      if (key !== undefined) options[key] = true
    }
    notes.push(payloadNote(payload, action))
  }

  const policy: Record<string, number> = {}
  for (const [index, category] of policyDrops(analysis)) {
    if (spans.has(index)) continue
    spans.add(index)
    bump(policy, category)
  }

  const kinds: Record<string, number> = {}
  const base = enabledFlags(resolveOptions(config.options))
  const enabled = enabledFlags(resolveOptions(options))
  let hidden = 0
  for (const hit of analysis.hits.values()) {
    const acted = (finding: { action: string }): boolean => finding.action === 'removed' || finding.action === 'replaced'
    const now = acted(toFinding(hit, enabled))
    if (!now && !spans.has(hit.index)) continue
    hidden += 1
    bump(kinds, hit.kind)
    // A control or private-use character the command line's options alone
    // would have kept goes because of the proxy policy: name it.
    if (now && !spans.has(hit.index) && !acted(toFinding(hit, base)) && (hit.kind === 'control' || hit.kind === 'private-use')) {
      bump(policy, hit.kind)
    }
  }

  const hasPolicy = Object.keys(policy).length > 0
  const report: TextReport | null =
    hidden === 0 && notes.length === 0 ? null : { hidden, kinds, payloads: notes, ...(hasPolicy ? { policy } : {}) }
  // Without a report the clean still runs: under `--max` the whole-text passes
  // (trailing whitespace, doubled spaces, NFKC) change text without a finding.
  if (config.reportOnly) return { text, report }

  const kept = spans.size === 0 ? text : joinKept(analysis.cps, spans)
  let cleaned = cleanText(kept, options)
  const removed: [string, number][] = notes
    .filter((note) => note.action === 'removed')
    .map((note) => [note.scheme, note.characters])
  for (const [category, count] of Object.entries(policy)) removed.push([category, count])
  if (notice && removed.length > 0) {
    const line = strings.proxyNotice(removed)
    cleaned = cleaned === '' || cleaned.endsWith('\n') ? `${cleaned}${line}` : `${cleaned}\n${line}`
  }
  return { text: cleaned, report }
}

/**
 * Clean an exact field: an object key, a protocol field, an enum member,
 * constant or required name, anything in `_meta`, and every string of a
 * message this module has no map of. It loses what {@link exactDrops} names
 * and the carriers of any run scheme the decoder reads, and keeps every other
 * character, so a key and the `required` entry naming it still match. A
 * scattered scheme found in it is flattened by its one channel, and nothing
 * else visible changes. Look-alike letters are reported and kept.
 */
export function stripInvisible(text: string, config: SanitizeConfig): SanitizedText {
  if (PLAIN.test(text) && !SPACING_CARRIER.test(text)) return { text, report: null }
  const analysis = analyse(text)
  const drops = exactDrops(analysis)
  const policy: Record<string, number> = {}
  for (const [index, category] of policyDrops(analysis, true)) if (drops.has(index)) bump(policy, category)
  const action: PayloadAction = config.reportOnly ? 'reported' : 'removed'
  const notes: PayloadNote[] = []
  let channel: CleanOptions | null = null
  for (const payload of decode(text)) {
    if (RUN_SCHEMES.has(payload.scheme)) {
      for (let i = payload.start; i < payload.end; i += 1) {
        if (!drops.has(i)) drops.set(i, analysis.hits.get(i)?.kind ?? 'invisible')
      }
      notes.push(payloadNote(payload, action))
    } else if (payload.scheme === 'homoglyph') {
      notes.push(payloadNote(payload, 'kept'))
    } else {
      const key = CHANNEL_OPTION[payload.scheme]
      if (key !== undefined) channel = { ...(channel ?? NO_OPTIONS), [key]: true }
      notes.push(payloadNote(payload, action))
    }
  }
  if (drops.size === 0 && notes.length === 0) return { text, report: null }
  const kinds: Record<string, number> = {}
  for (const kind of drops.values()) bump(kinds, kind)
  const hasPolicy = Object.keys(policy).length > 0
  const report: TextReport = { hidden: drops.size, kinds, payloads: notes, ...(hasPolicy ? { policy } : {}) }
  if (config.reportOnly) return { text, report }
  let kept = drops.size === 0 ? text : joinKept(analysis.cps, drops)
  if (channel !== null) kept = cleanText(kept, channel)
  return { text: kept, report }
}

/** Whether a string holds any character that draws nothing. */
function holdsHidden(text: string): boolean {
  return !PLAIN.test(text) && hasHidden(analyse(text))
}

/** A media type, parsed: its essence, lowercased, and its parameters in order. */
interface MediaType {
  readonly essence: string
  readonly parameters: readonly (readonly [name: string, value: string, quoted: boolean])[]
}

/**
 * Parse a media type by RFC 9110, section 8.3.1: `type "/" subtype`, then any
 * number of `OWS ";" OWS [ name "=" ( token / quoted-string ) ]`. Returns null
 * for anything that does not follow the grammar exactly, so the proxy never
 * reads a media type one way while a host reads it another.
 */
function parseMediaType(text: string): MediaType | null {
  const head = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\/([!#$%&'*+.^_`|~0-9A-Za-z-]+)/.exec(text)
  if (head === null) return null
  // Sticky patterns read from a position, so a long parameter list is one pass.
  const ows = /[ \t]*/y
  const token = /[!#$%&'*+.^_`|~0-9A-Za-z-]+/y
  const read = (pattern: RegExp, from: number): string => {
    pattern.lastIndex = from
    return pattern.exec(text)?.[0] ?? ''
  }
  const parameters: [string, string, boolean][] = []
  let at = head[0].length
  for (;;) {
    at += read(ows, at).length
    if (at === text.length) break
    if (text[at] !== ';') return null
    at += 1
    at += read(ows, at).length
    const name = read(token, at)
    if (name === '') continue
    at += name.length
    if (text[at] !== '=') return null
    at += 1
    if (text[at] === '"') {
      let value = ''
      let quotedPair = false
      at += 1
      for (;;) {
        const ch = text[at]
        if (ch === undefined) return null
        if (ch === '"') break
        if (ch === '\\') {
          const next = text[at + 1]
          if (next === undefined || !/^[\t\x20-\x7e\x80-\xff]$/.test(next)) return null
          value += next
          quotedPair = true
          at += 2
          continue
        }
        if (!/^[\t \x21\x23-\x5b\x5d-\x7e\x80-\xff]$/.test(ch)) return null
        value += ch
        at += 1
      }
      at += 1
      parameters.push([name.toLowerCase(), value, quotedPair])
    } else {
      const value = read(token, at)
      if (value === '') return null
      at += value.length
      parameters.push([name.toLowerCase(), value, false])
    }
  }
  return { essence: `${head[1] ?? ''}/${head[2] ?? ''}`.toLowerCase(), parameters }
}

/**
 * Media types whose bytes are known not to be text: images, sound, video,
 * fonts, and compressed or archive formats, except a type with a `+xml`,
 * `+json` or `+yaml` suffix. A blob of one of these passes as it is. Every other type, `application/octet-stream` included, may be text a
 * host decodes, so it is tried as text.
 */
function isBinaryMediaType(essence: string): boolean {
  // A structured-syntax suffix says the bytes are text, whatever the top-level
  // type: an SVG image is XML, and its title and text are read like any other.
  if (/\+(?:xml|json|yaml)$/.test(essence)) return false
  return (
    /^(?:image|audio|video|font)\//.test(essence) ||
    /^application\/(?:zip|gzip|x-gzip|x-tar|x-7z-compressed|x-bzip2|x-xz|zstd|vnd\.rar|x-rar-compressed|java-archive|wasm|pdf|vnd\.ms-fontobject|x-font-ttf|x-font-otf|font-woff|font-woff2)$/.test(
      essence,
    )
  )
}

const UTF8_CHARSETS: ReadonlySet<string> = new Set(['utf-8', 'utf8', 'us-ascii', 'ascii'])

/**
 * Whether the media type leaves no doubt that the bytes are UTF-8: no
 * `charset`, or exactly one, spelled as a plain token or a quoted string with
 * no escapes, naming UTF-8 or ASCII. Two charsets, an escape inside one, or
 * any other value is a doubt.
 */
function isUtf8(type: MediaType): boolean {
  const charsets = type.parameters.filter(([name]) => name === 'charset')
  if (charsets.length === 0) return true
  const [only] = charsets
  return charsets.length === 1 && only !== undefined && !only[2] && UTF8_CHARSETS.has(only[1].toLowerCase())
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Standard base64 or base64url, padded or not, whitespace allowed. */
const BASE64 = /^(?:[A-Za-z0-9+/]*|[A-Za-z0-9_-]*)={0,2}$/

/**
 * A base64 or base64url blob as UTF-8 text, or null when it is not strictly
 * both. Node's own base64 decoder skips what it does not understand, and so may
 * a host, so anything short of a clean decode is treated as text this proxy
 * could not read.
 */
function blobText(blob: string): string | null {
  const compact = blob.replace(/\s+/g, '')
  if (!BASE64.test(compact) || compact.replace(/=+$/, '').length % 4 === 1) return null
  try {
    return UTF8.decode(Buffer.from(compact.replaceAll('-', '+').replaceAll('_', '/'), 'base64'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// walking a result
// ---------------------------------------------------------------------------

/** One string that held something, located by a JSON pointer into the message. */
export interface FieldReport extends TextReport {
  readonly path: string
}

/**
 * A number the lossless parser kept as its source text. Frozen, so the walk
 * must never write into it, and it carries no string the model reads.
 */
function isRawJson(value: unknown): boolean {
  const check: unknown = Reflect.get(JSON, 'isRawJSON')
  return typeof check === 'function' && Reflect.apply(check, JSON, [value]) === true
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isRawJson(value)
}

/** RFC 6901: `~` and `/` inside a key are escaped. */
function pointer(path: string, key: string | number): string {
  return `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`
}

interface Walk {
  readonly config: SanitizeConfig
  readonly reports: FieldReport[]
  /** The pointers of the ids in this message the host matches, from {@link RESPONSE_IDS} or {@link SERVER_IDS}. */
  readonly ids: RegExp
  changed: boolean
  /** Why the message must not go on, once a part of it says so. */
  withheld?: Withheld
  /** How many arrays and objects the walk is inside. */
  depth?: number
}

/**
 * Why a message is withheld rather than cleaned: an id the host matches holds
 * a hidden character, an id or a version tag is not what JSON-RPC allows, or
 * two member names are the same once cleaned.
 */
export type Withheld = 'hidden-id' | 'invalid-id' | 'invalid-version' | 'colliding-members' | 'too-deep'

/**
 * How deep the walk goes into a message. A real MCP message is a few dozen
 * levels at most; a hostile one can nest thousands deep to exhaust the stack.
 * The line reader checks the depth before parsing, and the walk checks again.
 */
export const MAX_DEPTH = 512

/** Thrown by the walk past {@link MAX_DEPTH}. */
export class TooDeep extends Error {
  constructor() {
    super('message nested too deeply to check')
  }
}

/**
 * How strings are treated where the walk stands.
 *
 * - `protocol`: a result's own fields. {@link PROTOCOL_KEYS} strings lose every
 *   invisible character ({@link stripInvisible}), every other string gets
 *   {@link sanitizeText}.
 * - `free`: data that is the server's own (`structuredContent`, a log
 *   message's `data`). Every string and every key gets {@link sanitizeText}.
 * - `schema`: inside `inputSchema`, `outputSchema` or `requestedSchema`. As
 *   `protocol`, and {@link SCHEMA_EXACT_KEYS} strings (and a value under a
 *   name in {@link CORRELATION_KEYS}) are exact too; free text such as a
 *   `description`, `title`, `default` or example gets {@link sanitizeText}.
 * - `meta`: inside `_meta`, and the whole of a message whose method this
 *   proxy has no map of. Every string and every key loses carriers only.
 * - `log`: the params of a log message, which are `protocol` except for `data`,
 *   which is `free`.
 * - `error`: an error object, which is `protocol` except for `data`, which is
 *   `free`.
 *
 * Everywhere, the one exception is an id the host matches, at the exact
 * pointer {@link Walk.ids} names: it is reported and left as it is.
 *
 * Outside `free`, an object key loses every invisible character and keeps its
 * visible text: a key is an identifier a client matches, and a schema's
 * property names have to keep matching its `required` list, which gets the
 * same clean.
 */
type Mode = 'protocol' | 'free' | 'schema' | 'meta' | 'log' | 'error'

function childMode(mode: Mode, key: string): Mode {
  if (key === '_meta') return 'meta'
  if (mode === 'log' || mode === 'error') return key === 'data' ? 'free' : 'protocol'
  if (mode === 'protocol' && key === 'structuredContent') return 'free'
  if (mode === 'protocol' && SCHEMA_KEYS.has(key)) return 'schema'
  return mode
}

function record(walk: Walk, path: string, value: string, outcome: SanitizedText): string {
  if (outcome.report !== null) walk.reports.push({ path, ...outcome.report })
  if (outcome.text !== value) walk.changed = true
  return outcome.text
}

function visitString(walk: Walk, value: string, key: string | undefined, path: string): string {
  const notice = key !== undefined && NOTICE_KEYS.has(key)
  return record(walk, path, value, sanitizeText(value, walk.config, notice))
}

function visitValue(walk: Walk, value: string, key: string | undefined, path: string, mode: Mode): string {
  if (walk.ids.test(path)) {
    // An id the host matches can be neither cleaned nor trusted: a message
    // with a hidden character in one is withheld whole.
    if (holdsHidden(value)) {
      walk.withheld ??= 'hidden-id'
      const found = stripInvisible(value, { ...walk.config, reportOnly: true })
      if (found.report !== null) walk.reports.push({ path, ...found.report, unchanged: true })
    }
    return value
  }
  if (mode === 'meta') return record(walk, path, value, stripInvisible(value, walk.config))
  if (mode === 'free' || key === undefined) return visitString(walk, value, key, path)
  const schemaExact = mode === 'schema' && (SCHEMA_EXACT_KEYS.has(key) || SCHEMA_KEYWORD_KEYS.has(key) || CORRELATION_KEYS.has(key))
  const base64 = (key === 'data' || key === 'blob') && BASE64.test(value.replace(/\s+/g, ''))
  const exact = PROTOCOL_KEYS.has(key) && (base64 || (key !== 'data' && key !== 'blob'))
  if (schemaExact || exact) return record(walk, path, value, stripInvisible(value, walk.config))
  return visitString(walk, value, key, path)
}

interface Key {
  /** The key as it leaves the proxy. */
  readonly out: string
  /**
   * The key with the clean applied even in report-only mode. Pointers and the
   * choice of mode use it, so neither stderr nor the log repeats a hidden
   * character, and a key leaves the proxy treated as what it now says.
   */
  readonly name: string
}

function visitKey(walk: Walk, key: string, path: string, mode: Mode): Key {
  const clean = (config: SanitizeConfig): SanitizedText => {
    if (mode === 'free') return sanitizeText(key, config, false)
    return stripInvisible(key, config)
  }
  const outcome = clean(walk.config)
  const name = walk.config.reportOnly ? clean({ ...walk.config, reportOnly: false }).text : outcome.text
  if (outcome.report !== null) walk.reports.push({ path: `${pointer(path, name)} (key)`, ...outcome.report })
  return { out: outcome.text, name }
}

/**
 * A resource's base64 `blob` that is text a host may decode and hand the model
 * is decoded, cleaned like `text` and encoded again.
 *
 * - A blob whose media type parses as a known binary type
 *   ({@link isBinaryMediaType}) passes as it is.
 * - Any other blob, typed or not, is decoded strictly (base64 or base64url,
 *   then UTF-8) when nothing casts doubt on UTF-8, and cleaned as text.
 * - A blob that does not decode strictly, has a doubtful charset or a media
 *   type that does not parse is text this proxy cannot read but a lenient
 *   host might, so its content is replaced with a notice.
 */
function visitBlob(walk: Walk, node: Record<string, unknown>, path: string, byName: ReadonlyMap<string, string>): void {
  const blobKey = byName.get('blob')
  const mimeKey = byName.get('mimeType')
  if (blobKey === undefined) return
  const blob = node[blobKey]
  if (typeof blob !== 'string') return
  const mimeType = mimeKey === undefined ? undefined : node[mimeKey]
  const type = typeof mimeType === 'string' ? parseMediaType(mimeType) : undefined
  if (type !== undefined && type !== null && isBinaryMediaType(type.essence)) return
  const text = type === undefined || (type !== null && isUtf8(type)) ? blobText(blob) : null
  const notice = type?.essence.startsWith('text/') === true
  if (text === null) {
    walk.reports.push({ path: pointer(path, 'blob'), hidden: 0, kinds: {}, payloads: [], note: 'undecodable-text-blob' })
    if (!walk.config.reportOnly) {
      node[blobKey] = Buffer.from(strings.PROXY_BLOB_NOTICE, 'utf8').toString('base64')
      walk.changed = true
    }
    return
  }
  const outcome = sanitizeText(text, walk.config, notice)
  if (outcome.report !== null) walk.reports.push({ path: pointer(path, 'blob'), ...outcome.report })
  if (outcome.text !== text) {
    node[blobKey] = Buffer.from(outcome.text, 'utf8').toString('base64')
    walk.changed = true
  }
}

/** Walk `node` in place, or return its replacement when a key had to change. */
function visit(walk: Walk, node: unknown, key: string | undefined, path: string, mode: Mode): unknown {
  if (typeof node === 'string') return visitValue(walk, node, key, path, mode)
  if (typeof node !== 'object' || node === null) return node
  const depth = (walk.depth ?? 0) + 1
  if (depth > MAX_DEPTH) throw new TooDeep()
  walk.depth = depth
  try {
    return visitNode(walk, node, key, path, mode)
  } finally {
    walk.depth = depth - 1
  }
}

function visitNode(walk: Walk, node: object, key: string | undefined, path: string, mode: Mode): unknown {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      node[i] = visit(walk, node[i], key, pointer(path, i), mode)
    }
    return node
  }
  if (!isRecord(node)) return node
  // Every key is cleaned before anything is looked up by name, so a field is
  // judged by the name the client will read once the key leaves the proxy.
  const entries = Object.keys(node).map((key) => ({ key, ...visitKey(walk, key, path, mode) }))
  const byName = new Map<string, string>()
  for (const { key, name } of entries) {
    if (!byName.has(name)) {
      byName.set(name, key)
      continue
    }
    // Two keys that clean to the same name: whichever one a client keeps, the
    // other was read by nobody here. The object is hostile, and none of it goes on.
    walk.reports.push({ path, hidden: 0, kinds: {}, payloads: [], note: 'colliding-keys' })
    if (walk.config.reportOnly) break
    walk.changed = true
    return strings.PROXY_COLLISION_NOTICE
  }
  if (mode !== 'free') visitBlob(walk, node, path, byName)
  for (const { key, name } of entries) {
    node[key] = visit(walk, node[key], name, pointer(path, name), childMode(mode, name))
  }
  if (entries.every(({ key, out }) => key === out)) return node
  // A key changed: rebuild in the original order. defineProperty keeps a key
  // that cleans to `__proto__` an ordinary member, as JSON.parse made it.
  walk.changed = true
  const rebuilt: Record<string, unknown> = {}
  for (const { key, out } of entries) {
    Object.defineProperty(rebuilt, out, { value: node[key], enumerable: true, writable: true, configurable: true })
  }
  return rebuilt
}

export interface SanitizedMessage {
  readonly changed: boolean
  readonly reports: readonly FieldReport[]
  /** Set when the message must not go on to the host. */
  readonly withheld?: Withheld
}

function outcomeOf(walk: Walk): SanitizedMessage {
  return { changed: walk.changed, reports: walk.reports, ...(walk.withheld === undefined ? {} : { withheld: walk.withheld }) }
}

/** The members of a JSON-RPC message this module cleans by meaning. */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['jsonrpc', 'id', 'method', 'params', 'result', 'error'])

/** Whether a value is an id JSON-RPC allows: a string, a number or null. */
function isValidId(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'number') return true
  const check: unknown = Reflect.get(JSON, 'isRawJSON')
  return typeof check === 'function' && Reflect.apply(check, JSON, [value]) === true
}

/**
 * Clean a message's own members, in place, before anything reads one by name.
 *
 * Every member name loses every invisible character, so `result`, `method`
 * and the rest are found by the name a client will read. Two names that clean
 * to the same one withhold the message, and nothing else is done to it. The
 * method name loses every invisible character too, so a dressed-up method is
 * judged, and dispatched, as what it becomes. A member JSON-RPC does not
 * define gets the exact clean in every string.
 *
 * The id and the version tag are never changed, because a client matches the
 * one and checks the other, so they are checked instead: the message is
 * withheld when `jsonrpc` is not exactly "2.0", when the id is not a string,
 * a number or null, or when a string id holds a hidden character. Run this
 * before {@link sanitizeResponse} and {@link sanitizeServerMessage}.
 */
export function sanitizeEnvelope(message: Record<string, unknown>, config: SanitizeConfig): SanitizedMessage {
  const walk: Walk = { config, reports: [], ids: NO_IDS, changed: false }
  const entries = Object.keys(message).map((key) => ({ key, ...visitKey(walk, key, '', 'protocol') }))
  if (new Set(entries.map(({ name }) => name)).size !== entries.length) {
    walk.reports.push({ path: '', hidden: 0, kinds: {}, payloads: [], note: 'colliding-members' })
    walk.withheld = 'colliding-members'
    return outcomeOf(walk)
  }
  // No two names collide, so a renamed member can never land on another.
  for (const { key, out } of entries) {
    if (out === key) continue
    const value = message[key]
    Reflect.deleteProperty(message, key)
    Object.defineProperty(message, out, { value, enumerable: true, writable: true, configurable: true })
    walk.changed = true
  }
  if (message['jsonrpc'] !== '2.0') walk.withheld = 'invalid-version'
  if ('id' in message) {
    const id = message['id']
    if (!isValidId(id)) walk.withheld ??= 'invalid-id'
    else if (typeof id === 'string' && holdsHidden(id)) walk.withheld ??= 'hidden-id'
  }
  for (const { out, name } of entries) {
    const value = message[out]
    if (name === 'method' && typeof value === 'string') {
      message[out] = record(walk, '/method', value, stripInvisible(value, config))
    } else if (!ENVELOPE_KEYS.has(name)) {
      message[out] = visit(walk, value, name, pointer('', name), 'meta')
    }
  }
  return outcomeOf(walk)
}

/**
 * Clean one response, in place, given the method of the request it answers.
 * `method` undefined means the response answers no request the host has open.
 *
 * A response to a method in {@link SANITIZED_METHODS}, or to no open request,
 * has its whole result walked as `protocol`. A response to any other method
 * has a result this module has no map of, so every string and key in it gets
 * the exact clean. An error is walked as `error` either way. A
 * result or error of the wrong shape is walked whole: a client that rejects it
 * may still print it in the error it raises. The id and the version tag stay
 * exactly as the server sent them. It reads `result` and `error` by name, so
 * {@link sanitizeEnvelope} must have cleaned the member names first.
 */
export function sanitizeResponse(
  message: Record<string, unknown>,
  method: string | undefined,
  config: SanitizeConfig,
): SanitizedMessage {
  const ids = method === undefined ? NO_IDS : (RESPONSE_IDS[method] ?? NO_IDS)
  const walk: Walk = { config, reports: [], ids, changed: false }
  const mapped = method === undefined || SANITIZED_METHODS.has(method)
  if ('result' in message) message['result'] = visit(walk, message['result'], undefined, '/result', mapped ? 'protocol' : 'meta')
  if ('error' in message) message['error'] = visit(walk, message['error'], undefined, '/error', 'error')
  return outcomeOf(walk)
}

/**
 * Clean the params of a request or notification the server sends the host, in
 * place. The methods in {@link SERVER_METHODS} carry text for a model or a
 * person and are walked as `protocol`; a log message's `data` is the server's
 * own data, so every string in it gets the full clean. Any other method's
 * params get the exact clean in every string and key. It reads `params` by name, so
 * {@link sanitizeEnvelope} must have cleaned the member names first.
 */
export function sanitizeServerMessage(
  message: Record<string, unknown>,
  method: string,
  config: SanitizeConfig,
): SanitizedMessage {
  const walk: Walk = { config, reports: [], ids: SERVER_IDS[method] ?? NO_IDS, changed: false }
  if ('params' in message) {
    const mode: Mode = method === 'notifications/message' ? 'log' : SERVER_METHODS.has(method) ? 'protocol' : 'meta'
    message['params'] = visit(walk, message['params'], undefined, '/params', mode)
  }
  return outcomeOf(walk)
}
