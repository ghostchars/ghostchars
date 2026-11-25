import { clean } from './clean'
import type { CleanOptionKey, CleanOptions } from './types'

/**
 * The rich-text flavour of a paste: clean a clipboard `text/html` fragment
 * without touching its markup, so a list stays a list, a quote stays a quote
 * and a heading stays a heading on the way back out.
 *
 * THIS IS THE ONE IMPLEMENTATION for every surface that handles a clipboard
 * fragment: the extension's clean-on-paste content script, the extension's
 * popup and the website's tool. It was written for clean-on-paste first, and
 * the popup and the site used to hand the browser a `<textarea>` and
 * `writeText`, which is a plain-text round trip: a paste with bullets came in
 * as lines and went out as lines, and the list was gone by the time it landed
 * in the document it was headed for.
 *
 * It takes a `Document` rather than reaching for the global one, so it stays
 * a pure function of its arguments like the rest of the engine, and so a test
 * can hand it a DOM of its own.
 *
 * WHY NOT RUN THE ENGINE OVER THE HTML STRING. Because an em dash in an
 * `href` or a curly quote in a `class` is markup, and `--punct` would rewrite
 * the quotes and dashes inside tags, producing HTML the user never had. Parsing first and cleaning
 * only the text nodes means the paste keeps its bold, its links and its lists,
 * and the cleaning applies to exactly the characters a reader can see, which
 * is what "preserve the other flavours" has to mean in practice.
 */

export interface CleanedFragment {
  /** The cleaned markup, sanitised: safe to hand to `insertHTML` or `ClipboardItem`. */
  readonly html: string
  /** The text nodes' cleaned contents, joined: what the fragment reads as. */
  readonly text: string
  readonly removed: number
  readonly replaced: number
  /** Whether any text node came out different. */
  readonly changed: boolean
  /**
   * Switches that were on and could NOT run on this fragment: see
   * {@link WHOLE_TEXT_ONLY}. The caller says so out loud; a cleanup the user
   * asked for and did not get is exactly the kind of silence this product
   * exists to remove.
   */
  readonly notApplied: readonly CleanOptionKey[]
}

/**
 * The pre-passes that read the text as ONE document and therefore cannot be run
 * over a fragment one text node at a time.
 *
 * `--trailing` is the one that corrupted pastes. `TRAILING_RE` is
 * `[ \t]+(?=\r?\n|$)`, and `$` is the end of whatever string it is handed, so
 * for the text node `'Hello '` in `<p>Hello <strong>world</strong></p>` the
 * space between the two words IS trailing whitespace, and the paste came back
 * as `Helloworld`.
 *
 * `--collapse` is the same shape without the damage: `COLLAPSE_RE` needs a
 * non-space on both sides, so a run split by a tag never matches and the switch
 * would silently under-apply while the toast claimed the cleanup happened.
 *
 * `--gutters` is `--trailing` at the other end of the line. `GUTTER_RE` starts
 * a line at the start of whatever string it is handed, so in
 * `<p><code>ls</code>\u2502 out</p>` the text node `'\u2502 out'` would read as
 * a quoted line and the bar in the middle of the sentence would go.
 *
 * `--nfc`/`--nfkc` stay ON per node, deliberately. Normalisation has no `^`/`$`
 * anchor and works one combining sequence at a time, so the worst a node
 * boundary can do is leave a mark that a tag separated from its base
 * decomposed: a miss, not a corruption. Running it over the joined text
 * instead would let canonical reordering MOVE a character across that tag,
 * which is strictly worse. `--punct` is the same trade: a dash flush against a
 * tag becomes `-` instead of ` - `, exactly as a line-initial dash already does
 * in the reference implementation.
 */
export const WHOLE_TEXT_ONLY = ['gutters', 'trailing', 'collapse'] as const satisfies readonly CleanOptionKey[]

/**
 * Clean the `text/html` flavour without touching its markup.
 *
 * Returns `null` when the fragment cannot be parsed, which sends the caller
 * back to the plain-text path.
 */
export function cleanFragment(
  html: string,
  options: CleanOptions,
  doc: Document,
): CleanedFragment | null {
  // An INERT document: one made by `createHTMLDocument` has no browsing
  // context, so parsing the fragment into it runs no script and loads no
  // resource of any kind. The clipboard's HTML is someone else's markup and is
  // treated that way: parsed to be walked, sanitised, and only then
  // re-inserted.
  let body: HTMLElement | null
  try {
    const parsed = doc.implementation.createHTMLDocument('')
    parsed.body.innerHTML = html
    body = parsed.body
  } catch {
    return null
  }
  if (body === null) return null

  sanitize(body)

  const notApplied = WHOLE_TEXT_ONLY.filter((key) => options[key])
  const perNode: CleanOptions = { ...options, gutters: false, trailing: false, collapse: false }

  let removed = 0
  let replaced = 0
  let changed = false
  const plain: string[] = []

  for (const node of textNodesOf(body)) {
    const original = node.nodeValue ?? ''
    if (original.length === 0) continue
    const result = clean(original, perNode)
    removed += result.summary.removed
    replaced += result.summary.replaced
    if (result.text !== original) {
      node.nodeValue = result.text
      changed = true
    }
    plain.push(result.text)
  }

  return { html: body.innerHTML, text: plain.join(''), removed, replaced, changed, notApplied }
}

/**
 * Does the rich flavour of a paste describe what is now in the box?
 *
 * A `<textarea>` receives only the `text/plain` flavour, and the `text/html`
 * flavour is worth keeping only while the two say the same thing: a paste into
 * a box that already held a sentence, or over a selection, produces a value
 * the fragment does not describe, and copying that fragment out later would
 * hand the visitor formatting for words they did not paste. So the html rides
 * along exactly when the box's value IS the pasted plain text.
 *
 * Line endings are the one licensed difference: a `<textarea>` normalises
 * `\r\n` to `\n` on insertion, and a Windows clipboard puts `\r\n` in the plain
 * flavour, so the comparison happens on `\n` for both sides.
 */
export function describesWholeText(plain: string, value: string): boolean {
  return plain.length > 0 && newlines(plain) === newlines(value)
}

function newlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * Elements that never come back out of a clipboard fragment.
 *
 * None of them carry prose a reader can see, and all of them are a way to run
 * something: `<script>`, `<iframe srcdoc>`, `<object>`/`<embed>` plugins,
 * `<link>`/`<meta>` (refresh, CSP relaxation), `<style>` (overlay the page),
 * `<base>` (rewrite every relative URL after it). `<template>` is here because
 * its contents live in a fragment this walk cannot reach, so they cannot be
 * checked.
 *
 * The four SVG animation elements are here for a subtler reason: they set
 * attributes DECLARATIVELY. `<set attributeName="onload" to="alert(1)">` inside
 * a pasted `<svg>` installs a handler after the attribute sweep below has
 * already run, so stripping `on*` from the markup would not be enough. They
 * carry no prose either way, so dropping them costs a paste nothing.
 */
const UNSAFE_ELEMENTS = new Set([
  'animate',
  'animatemotion',
  'animatetransform',
  'applet',
  'base',
  'embed',
  'frame',
  'frameset',
  'iframe',
  'link',
  'meta',
  'object',
  'script',
  'set',
  'style',
  'template',
])

/** Attributes whose value is a URL, and therefore a possible `javascript:` payload. */
const URL_ATTRIBUTES = new Set([
  'action',
  'background',
  'cite',
  'data',
  'formaction',
  'href',
  'longdesc',
  'poster',
  'src',
  'xlink:href',
])

/**
 * Strip everything executable out of the parsed clipboard fragment.
 *
 * WHY THIS EXISTS. The extension re-inserts the fragment with
 * `execCommand('insertHTML')`, and that command (unlike the browser's own
 * paste, which runs the clipboard through Blink's sanitiser first) inserts the
 * markup verbatim. Without this pass, taking the paste event would REMOVE a
 * security control the user had: a page that puts `<img src=x onerror=...>` on
 * the clipboard (plus one zero-width space, so the extension decides to act)
 * would get script execution in the origin the user opted in to. The popup and
 * the site write the fragment back to the clipboard instead, where the next
 * paste target sanitises it again; they get the same pass because a fragment
 * this module hands out must be safe wherever it lands. Cleaning text a user
 * can see must never cost them that, so the fragment leaves here with no event
 * handlers, no script-bearing elements and no `javascript:`/`data:` URLs.
 */
function sanitize(root: Element): void {
  for (const element of Array.from(root.querySelectorAll('*'))) {
    if (UNSAFE_ELEMENTS.has(element.tagName.toLowerCase())) {
      element.remove()
      continue
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      // `on*` covers every inline handler there is or will be; `srcdoc` is a
      // whole document smuggled into an attribute.
      if (name.startsWith('on') || name === 'srcdoc') {
        element.removeAttribute(attribute.name)
        continue
      }
      if (URL_ATTRIBUTES.has(name) && !isSafeUrl(attribute.value)) {
        element.removeAttribute(attribute.name)
      }
    }
  }
}

/**
 * Is this attribute value a URL that cannot run code?
 *
 * The scheme is read the way a browser reads it: whitespace and C0 controls are
 * ignored, so `java\nscript:` is not a way past this. `data:` is refused except
 * for the raster image types, which is how a pasted screenshot survives without
 * letting `data:text/html` (or `data:image/svg+xml`, which can script) through.
 */
function isSafeUrl(value: string): boolean {
  let stripped = ''
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) > 0x20) stripped += character
  }
  if (/^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif)[;,]/i.test(stripped)) return true
  return !/^(?:javascript|vbscript|data):/i.test(stripped)
}

/** Every text node under `root`, skipping the ones that are code rather than prose. */
function textNodesOf(root: Node): Text[] {
  const found: Text[] = []
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child instanceof Text) {
        found.push(child)
        continue
      }
      if (child instanceof Element) {
        const tag = child.tagName.toLowerCase()
        if (tag === 'script' || tag === 'style' || tag === 'template') continue
        walk(child)
      }
    }
  }
  walk(root)
  return found
}
