/**
 * Source escape decoding, per surface, off by default.
 *
 * WHY THIS EXISTS. A dash typed into a TypeScript file as a backslash-u escape
 * ships as a dash. The bytes on disk are plain ASCII, so a gate that reads
 * bytes sees nothing, and that is exactly how a batch of machine-writing
 * typography can sit in a message catalogue for releases at a time. A gate that
 * ALWAYS decoded would be worse in the other direction: a table of codepoints
 * whose subject IS the escape would fail on its own subject matter. So it is a
 * per-surface switch, the direct port of the reads-bytes-versus-decodes split
 * in this repository's own hygiene gate.
 *
 * THE ODD-BACKSLASH-RUN RULE. The run of backslashes in front of the `u` is
 * captured so an escaped backslash can be told from an escape. An EVEN run is
 * escaped backslashes, after which the `u` is just a letter and nothing is
 * rendered; an ODD run is a real escape, and the resolved character replaces
 * the last backslash and the `u...` after it while the earlier pairs stay.
 *
 * TWO KINDS OF ESCAPE ARE LEFT ALONE, BOTH ON PURPOSE.
 *
 * A LONE SURROGATE cannot be handed to the cleaner as text, and nothing writes
 * an astral character that way when the braced form decodes it in one piece.
 *
 * A LINE TERMINATOR (U+000A, U+000D) is refused because resolving one would
 * insert a real newline, and every line number this gate reports is an index
 * into the text it cleaned. One decoded newline silently renumbers every
 * finding below it.
 *
 * Neither is typography, and typography is the whole reason a surface asks for
 * decoding.
 */

/**
 * A unicode escape in source. TypeScript writes both the bare four-digit form
 * and the braced one; Swift writes the braced form only. Character for
 * character the same expression the repository gate uses, so a count measured
 * by one tool means the same thing in the other.
 */
const ESCAPE_RE = /(\\+)u(?:\{([0-9A-Fa-f]{1,6})\}|([0-9A-Fa-f]{4}))/g

const MAX_CODEPOINT = 0x10ffff
const SURROGATE_FIRST = 0xd800
const SURROGATE_LAST = 0xdfff

function resolve(whole: string, slashes: string, digits: string | undefined): string {
  if (slashes.length % 2 === 0) return whole
  if (digits === undefined) return whole
  const codepoint = Number.parseInt(digits, 16)
  if (Number.isNaN(codepoint)) return whole
  if (codepoint > MAX_CODEPOINT) return whole
  if (codepoint >= SURROGATE_FIRST && codepoint <= SURROGATE_LAST) return whole
  const character = String.fromCodePoint(codepoint)
  if (character === '\n' || character === '\r') return whole
  return slashes.slice(0, -1) + character
}

/**
 * Resolve every escape the rules above accept.
 *
 * Written as a scan rather than a `replace` callback so no value in this
 * package ever crosses the `any`-typed replacer signature; the lint config
 * bans the casts that would otherwise be needed to get back to a string.
 */
export function decodeEscapes(text: string): string {
  let out = ''
  let last = 0
  ESCAPE_RE.lastIndex = 0
  for (;;) {
    const match = ESCAPE_RE.exec(text)
    if (match === null) break
    const whole = match[0]
    out += text.slice(last, match.index)
    out += resolve(whole, match[1] ?? '', match[2] ?? match[3])
    last = match.index + whole.length
  }
  return last === 0 ? text : out + text.slice(last)
}
