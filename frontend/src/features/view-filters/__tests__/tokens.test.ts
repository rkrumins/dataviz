/**
 * Tokens are filters typed as text, so they must land on exactly the state the
 * menus would set — and anything that names nothing must stay text, not become a
 * filter that silently matches nothing.
 */
import { describe, expect, it } from 'vitest'
import {
  applyTokens, dateTokenRule, insertToken, matchOne, parseTokens, searchTextOf, tokenAtCaret, type TokenResolver,
} from '../tokens'
import { EMPTY_FILTERS, ME } from '../model'

const TODAY = '2026-10-12'
const PEOPLE = [
  { id: 'u_ada', name: 'Ada Lovelace', email: 'ada@example.com' },
  { id: 'u_alan', name: 'Alan Turing', email: 'alan@example.com' },
]
const resolver: TokenResolver = {
  person: q => matchOne(PEOPLE, q, p => p.name, p => p.email)?.id ?? null,
  viewType: q => (q.toLowerCase().startsWith('context') ? 'context' : null),
  tag: q => (['pii', 'finance'].includes(q.toLowerCase()) ? q.toLowerCase() : null),
  workspace: q => (q.toLowerCase() === 'finance' ? 'ws_fin' : null),
  dataSource: () => null,
}

describe('parseTokens', () => {
  it('pulls tokens out of free text, quoted values included', () => {
    const { tokens, text } = parseTokens('revenue by:"Ada Lovelace" is:versioned  board')
    expect(tokens.map(t => [t.key, t.value])).toEqual([['by', 'Ada Lovelace'], ['is', 'versioned']])
    expect(text).toBe('revenue board')
  })

  it('knows the aliases and ignores words that merely contain a colon', () => {
    const { tokens, text } = parseTokens('updated-by:alan workspace:finance http://x 10:30')
    expect(tokens.map(t => t.key)).toEqual(['edited-by', 'ws'])
    expect(text).toBe('http://x 10:30')
  })
})

describe('applyTokens', () => {
  it('sets the same state the menus would', () => {
    const { tokens } = parseTokens('edited-by:ada is:external updated:<30d tag:PII type:context ws:finance')
    const { state, unresolved } = applyTokens(EMPTY_FILTERS, tokens, resolver, TODAY)
    expect(unresolved).toEqual([])
    expect(state).toMatchObject({
      contributorIds: ['u_ada'], contributorRole: 'edited', sourceKind: 'external',
      updated: '30d', tags: ['pii'], viewTypes: ['context'], workspaceIds: ['ws_fin'],
    })
  })

  it('reads by:me as you', () => {
    const { state } = applyTokens(EMPTY_FILTERS, parseTokens('by:me').tokens, resolver, TODAY)
    expect(state.contributorIds).toEqual([ME])
    expect(state.contributorRole).toBeNull()
  })

  it('lets a role token set the role for everyone picked', () => {
    const start = { ...EMPTY_FILTERS, contributorIds: ['u_alan'], contributorRole: 'edited' as const }
    const { state } = applyTokens(start, parseTokens('created-by:ada').tokens, resolver, TODAY)
    expect(state.contributorIds).toEqual(['u_alan', 'u_ada'])
    expect(state.contributorRole).toBe('created')
  })

  it('leaves what it cannot resolve unapplied — an ambiguous name is not a guess', () => {
    const { state, unresolved } = applyTokens(EMPTY_FILTERS, parseTokens('by:a is:purple tag:nope').tokens, resolver, TODAY)
    expect(unresolved.map(t => t.raw)).toEqual(['by:a', 'is:purple', 'tag:nope'])
    expect(state).toEqual(EMPTY_FILTERS)
  })
})

describe('dateTokenRule', () => {
  it.each([
    ['<7d', '7d'],
    ['>30d', '..2026-09-12'],
    ['today', 'today'],
    ['2026-09', '2026-09'],
    ['2026-09-01..2026-09-15', '2026-09-01..2026-09-15'],
  ])('%s → %s', (value, rule) => {
    expect(dateTokenRule(value, TODAY)).toBe(rule)
  })

  it('rejects what no rule means', () => {
    expect(dateTokenRule('soon', TODAY)).toBeNull()
  })
})

describe('matchOne', () => {
  it('prefers an exact name or email, then a unique prefix, then a unique substring', () => {
    expect(matchOne(PEOPLE, 'alan@example.com', p => p.name, p => p.email)?.id).toBe('u_alan')
    expect(matchOne(PEOPLE, 'ada', p => p.name)?.id).toBe('u_ada')
    expect(matchOne(PEOPLE, 'turing', p => p.name)?.id).toBe('u_alan')
    expect(matchOne(PEOPLE, 'a', p => p.name)).toBeNull()
  })
})

describe('completion', () => {
  it('finds the token being typed at the caret', () => {
    const text = 'revenue by:al'
    expect(tokenAtCaret(text, text.length)).toEqual({ key: 'by', partial: 'al', start: 8, end: 13 })
    expect(tokenAtCaret('revenue', 7)).toBeNull()
    expect(tokenAtCaret('note: x', 5)).toBeNull()
  })

  it('reads the canonical key for an alias', () => {
    expect(tokenAtCaret('workspace:fin', 13)?.key).toBe('ws')
  })

  it('finishes a token, quoting a value with a space, and leaves the rest', () => {
    const text = 'by:al board'
    const at = tokenAtCaret(text, 5)!
    expect(insertToken(text, at, 'by', 'Alan Turing')).toBe('by:"Alan Turing" board')
  })
})

describe('searchTextOf', () => {
  it('searches only the words, never a token — finished, half-typed or bare', () => {
    expect(searchTextOf('revenue by:al')).toBe('revenue')
    expect(searchTextOf('revenue by: board')).toBe('revenue board')
    expect(searchTextOf('is:purple revenue')).toBe('revenue')
    expect(searchTextOf('note: http://x')).toBe('note: http://x')
  })
})
