import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildExtensions, editorToMd } from './markdownBridge'

/** Parse markdown into a headless editor, then serialize back to markdown. */
function roundTrip(md: string): string {
  const editor = new Editor({ extensions: buildExtensions(), content: md })
  const out = editorToMd(editor).trim()
  editor.destroy()
  return out
}

describe('markdownBridge round-trip (Markdown in → Markdown out)', () => {
  const cases: Array<[string, string]> = [
    ['bold', 'this is **abc**'],
    ['italic', 'this is *abc*'],
    ['strike', 'this is ~~abc~~'],
    ['inline code', 'run `npm test` now'],
    ['heading', '# Title'],
    ['h2', '## Subtitle'],
    ['bullet list', '- one\n- two'],
    ['ordered list', '1. one\n2. two'],
    ['blockquote', '> quoted'],
    ['link', '[label](https://example.com)'],
  ]

  it.each(cases)('preserves %s', (_name, md) => {
    expect(roundTrip(md)).toBe(md)
  })

  it('keeps a task list as markdown checkboxes', () => {
    const out = roundTrip('- [ ] todo\n- [x] done')
    expect(out).toContain('[ ] todo')
    expect(out).toContain('[x] done')
  })

  it('never emits HTML tags', () => {
    expect(roundTrip('this is **abc**')).not.toMatch(/<[a-z]/i)
  })
})
