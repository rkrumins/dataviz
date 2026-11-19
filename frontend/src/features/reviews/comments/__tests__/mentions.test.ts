import { describe, expect, it } from 'vitest'
import { mentionAt, mentionsIn, splitMentions } from '../mentions'

describe('mentions', () => {
  it('finds the @query being typed at the caret, not an address or a finished one', () => {
    expect(mentionAt('Hi @an', 6)).toEqual({ start: 3, query: 'an' })
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionAt('mail ana@x.io', 13)).toBeNull()
    expect(mentionAt('Hi @ana and', 11)).toBeNull()
  })

  it('keeps only the people whose @name is still in the text', () => {
    const picked = new Map([['u1', 'Ana Silva'], ['u2', 'Bo Chen']])
    expect(mentionsIn('Thanks @Ana Silva!', picked)).toEqual(['u1'])
  })

  it('splits a body at each person it mentions, longest name first', () => {
    const parts = splitMentions('@Ana Silva and @Ana, see this', ['u2', 'u1'], { u1: 'Ana Silva', u2: 'Ana' })
    expect(parts).toEqual([
      { text: '@Ana Silva', mention: 'u1' }, { text: ' and ' }, { text: '@Ana', mention: 'u2' }, { text: ', see this' },
    ])
    expect(splitMentions('plain', [], {})).toEqual([{ text: 'plain' }])
  })
})
