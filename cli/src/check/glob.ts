/**
 * The small glob subset a `ghostchars.json` surface speaks, matched in linear
 * time.
 *
 * WHY A SUBSET AND NOT A DEPENDENCY. This package declares zero runtime
 * dependencies, and the patterns a hygiene surface needs are three: `**` for a
 * run of directories, `*` for a run inside one segment, and `?` for a single
 * character. Braces and character classes buy nothing here and every one of
 * them is a way for two implementations of the same config to disagree.
 *
 * WHY THIS IS NOT A RegExp ANY MORE, AND MUST NOT BECOME ONE AGAIN. The obvious
 * implementation translates the pattern to a regular expression: one `[^/]*` per
 * `*`, concatenated with the literals around it. That is the textbook
 * catastrophic-backtracking shape, and JavaScript has no atomic group to stop
 * it. MEASURED on the shipped binary before this rewrite, with the pattern
 * `a*` repeated 30 times followed by `b` and a non-matching filename: 35
 * characters took 19 ms, 36 took 91 ms, 37 took 403 ms, 38 took 1,593 ms, 39
 * took 6,944 ms, roughly 4.3x per added character. End to end, one
 * `ghostchars.json` carrying that pattern and one 41-character filename hung
 * `ghostchars check` past a 20 second kill. The same code path is behind the MCP
 * `check_paths` tool, whose `config` field a caller supplies, so the pattern
 * does not even have to come from the repository owner.
 *
 * The matcher below is the classic two-pointer wildcard algorithm with one
 * remembered star, run twice: once over the path's SEGMENTS with `**` as the
 * star, and once inside a segment with `*` as the star. It backtracks to the
 * last star and never further, so a pattern of length m against a path of length
 * n costs O(n*m) in the worst case and O(n) in every realistic one. No input can
 * make it exponential, which is the property that matters when the pattern comes
 * out of a file.
 *
 * WHY `docs/ ** / *.md` MATCHES `docs/a.md`. `**` stands for ZERO or more path
 * segments, which is what Python's `pathlib.Path.glob` does and therefore what
 * anyone porting a pin list from the repository's own gate will expect. A `**`
 * that matched one-or-more would quietly drop the top level of every tree it
 * was pointed at, and the file that got dropped is exactly the one somebody
 * meant to gate.
 *
 * Patterns are matched against the root-relative POSIX path, always with `/` as
 * the separator, so a config written on one platform means the same thing on
 * another.
 */

/** The token a `**` segment compiles to. Anything else is a literal segment. */
const ANY_SEGMENTS = Symbol('**')

type Segment = string | typeof ANY_SEGMENTS

/**
 * Split a pattern into segments, with a whole-segment `**` marked.
 *
 * A `**` that shares its segment with anything else, such as `a**b`, is NOT a
 * segment crosser: it is an ordinary within-segment run, exactly as the previous
 * regular expression treated it. That falls out of the test below being for a
 * segment equal to `**`, not for a segment containing it.
 */
function compile(pattern: string): Segment[] {
  return pattern.split('/').map((segment) => (/^\*\*+$/.test(segment) ? ANY_SEGMENTS : segment))
}

/**
 * One segment against one path segment. `*` is any run, `?` is one character.
 *
 * Two pointers and one remembered star. On a mismatch the walk returns to the
 * character after the last star and lets that star eat one more character, so
 * the work is bounded by (stars seen) times (segment length) rather than by
 * every way of splitting the segment between the stars.
 */
function matchSegment(pattern: string, text: string): boolean {
  let p = 0
  let t = 0
  let starAt = -1
  let starText = 0
  while (t < text.length) {
    const character = pattern[p]
    if (p < pattern.length && (character === '?' || character === text[t])) {
      p += 1
      t += 1
      continue
    }
    if (p < pattern.length && character === '*') {
      // A run of stars inside a segment is one star: `a**b` means `a*b`.
      while (pattern[p] === '*') p += 1
      starAt = p
      starText = t
      continue
    }
    if (starAt < 0) return false
    starText += 1
    p = starAt
    t = starText
  }
  while (pattern[p] === '*') p += 1
  return p === pattern.length
}

/**
 * The segment lists, with `**` as the star. Same algorithm one level up.
 *
 * A trailing `**` therefore covers the directory itself as well as everything
 * under it: `vendor/**` is `[vendor, **]`, and against the path `vendor` the
 * star matches zero segments. That is the behaviour the previous compiler went
 * out of its way to produce by taking back the slash it had already emitted, and
 * it is the behaviour the config in the README relies on.
 */
function matchSegments(pattern: readonly Segment[], path: readonly string[]): boolean {
  let p = 0
  let t = 0
  let starAt = -1
  let starPath = 0
  while (t < path.length) {
    const segment = pattern[p]
    if (p < pattern.length && segment !== ANY_SEGMENTS && matchSegment(segment ?? '', path[t] ?? '')) {
      p += 1
      t += 1
      continue
    }
    if (p < pattern.length && segment === ANY_SEGMENTS) {
      while (pattern[p] === ANY_SEGMENTS) p += 1
      starAt = p
      starPath = t
      continue
    }
    if (starAt < 0) return false
    starPath += 1
    p = starAt
    t = starPath
  }
  while (pattern[p] === ANY_SEGMENTS) p += 1
  return p === pattern.length
}

/** Compile one glob into a predicate over a root-relative POSIX path. */
export function globMatcher(pattern: string): (path: string) => boolean {
  const segments = compile(pattern)
  return (path: string): boolean => matchSegments(segments, path.split('/'))
}

/**
 * One predicate for a list of patterns. An empty list matches nothing, which is
 * the right default for `exclude` and is why a surface must state its
 * `include` rather than inheriting one.
 */
export function compileGlobs(patterns: readonly string[]): (path: string) => boolean {
  const matchers = patterns.map(globMatcher)
  return (path: string): boolean => matchers.some((matches) => matches(path))
}
