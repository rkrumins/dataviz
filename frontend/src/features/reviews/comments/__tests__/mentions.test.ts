import { describe, expect, it } from 'vitest'
import { matchMentionCandidates, mentionAt, mentionsIn, splitLinks, splitMentions } from '../mentions'

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

  it('matches a person by a word of their name or their email', () => {
    const people = [{ id: 'u1', name: 'Ana Silva', email: 'asilva@x.io' }, { id: 'u2', name: 'Bo Chen', email: null }]
    expect(matchMentionCandidates(people, 'sil').map((p) => p.id)).toEqual(['u1'])
    expect(matchMentionCandidates(people, 'asil').map((p) => p.id)).toEqual(['u1'])
    expect(matchMentionCandidates(people, 'CH').map((p) => p.id)).toEqual(['u2'])
    expect(matchMentionCandidates(people, '')).toHaveLength(2)
  })
})

describe('splitLinks', () => {
  it('links http and https addresses, leaving the sentence around them as text', () => {
    expect(splitLinks('See https://wiki.example.com/gl?x=1. Thanks')).toEqual([
      { text: 'See ' }, { text: 'https://wiki.example.com/gl?x=1', href: 'https://wiki.example.com/gl?x=1' }, { text: '. Thanks' },
    ])
    expect(splitLinks('(docs: http://x.io/a_(b))')).toEqual([
      { text: '(docs: ' }, { text: 'http://x.io/a_(b)', href: 'http://x.io/a_(b)' }, { text: ')' },
    ])
  })

  it('never links another scheme or a bare domain', () => {
    expect(splitLinks('javascript:alert(1)')).toEqual([{ text: 'javascript:alert(1)' }])
    expect(splitLinks('click JAVASCRIPT://x.io/%0Aalert(1)')).toEqual([{ text: 'click JAVASCRIPT://x.io/%0Aalert(1)' }])
    expect(splitLinks('data:text/html,<b>hi</b> or example.com')).toEqual([{ text: 'data:text/html,<b>hi</b> or example.com' }])
    expect(splitLinks('ahttps://x.io')).toEqual([{ text: 'ahttps://x.io' }])
    expect(splitLinks('')).toEqual([{ text: '' }])
  })

  it('every href it gives is http or https', () => {
    const parts = splitLinks('a https://ok.io b http://fine.io/c javascript:https://bad d')
    for (const p of parts) if (p.href) expect(p.href).toMatch(/^https?:\/\//)
    expect(parts.filter((p) => p.href).map((p) => p.text)).toEqual(['https://ok.io', 'http://fine.io/c', 'https://bad'])
  })
})
