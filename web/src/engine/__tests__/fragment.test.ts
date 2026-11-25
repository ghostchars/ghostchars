import { describe, expect, it } from 'vitest'

import { describesWholeText, WHOLE_TEXT_ONLY } from '@/engine/fragment'

/**
 * The pure half of the fragment module. `cleanFragment` itself needs a DOM and
 * is exercised by the callers that have one, through the same source file;
 * what lives here is the decision the website's box and the
 * popup both make before they keep a paste's `text/html` flavour at all.
 */
describe('describesWholeText', () => {
  it('accepts a box that holds exactly the pasted plain text', () => {
    expect(describesWholeText('one\ntwo', 'one\ntwo')).toBe(true)
  })

  it('normalises Windows line endings, which a textarea rewrites on insertion', () => {
    expect(describesWholeText('one\r\ntwo\r\n', 'one\ntwo\n')).toBe(true)
    expect(describesWholeText('one\rtwo', 'one\ntwo')).toBe(true)
  })

  it('refuses a box that already held something, or a paste over a selection', () => {
    expect(describesWholeText('two', 'one two')).toBe(false)
    expect(describesWholeText('two', 'one\ntwo')).toBe(false)
  })

  it('refuses an empty plain flavour, which describes nothing', () => {
    expect(describesWholeText('', '')).toBe(false)
  })
})

describe('the whole-text switches', () => {
  it('are exactly the three pre-passes that read the text as one document', () => {
    expect([...WHOLE_TEXT_ONLY]).toEqual(['gutters', 'trailing', 'collapse'])
  })
})
