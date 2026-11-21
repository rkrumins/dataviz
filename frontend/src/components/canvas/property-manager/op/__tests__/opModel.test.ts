/**
 * opModel — a bulk property change as the dialog builds it: each target is the search the server
 * walks (a container's children are one level down from it, everything inside is every level, a
 * layer is searched in the view), the operation is sent only once it is whole, and Review counts
 * what it will change, replace and leave alone. A clean-up of a property's values is previewed in
 * the browser as the server applies it, and its near-duplicates found as the server would merge them.
 */
import { describe, expect, it } from 'vitest'

import {
  impactOf, jobOp, needsTypedConfirm, opProblem, predicateOf, propertyJobLabel, reviewCounts, targetLabel, targetOf, type OpDraft,
} from '../opModel'
import { cleanValue, convertValue, mergeMap, normalizeText, replaceText, similarGroups } from '../cleanup'

const op = (patch: Partial<OpDraft>): OpDraft => ({ kind: 'set', key: 'owner', to: '', value: 'ana', onConflict: 'skip', ...patch })

describe('targets', () => {
  it('a container\'s children are one level down from it; several containers are any of them', () => {
    expect(predicateOf({ kind: 'children', urns: ['urn:a'], label: 'A' }))
      .toEqual({ kind: 'related', axis: 'parent', where: { kind: 'is', refs: [{ urn: 'urn:a' }] } })
    expect(predicateOf({ kind: 'children', urns: ['urn:a', 'urn:b'], label: '2' }))
      .toMatchObject({ kind: 'group', op: 'or', children: [{ axis: 'parent' }, { axis: 'parent' }] })
  })

  it('everything inside is every level down — the container itself only when asked', () => {
    expect(predicateOf({ kind: 'inside', urns: ['urn:a'], label: 'A', includeSelf: false }))
      .toEqual({ kind: 'related', axis: 'ancestor', where: { kind: 'is', refs: [{ urn: 'urn:a' }] } })
    expect(predicateOf({ kind: 'inside', urns: ['urn:a'], label: 'A', includeSelf: true }))
      .toEqual({ kind: 'descendantOf', urns: ['urn:a'] })
  })

  it('a layer is searched in the view, whatever scope was chosen', () => {
    expect(targetOf({ kind: 'layer', layerId: 'L1', name: 'Gold' }, 'v1', 'data_source'))
      .toEqual({ viewId: 'v1', predicate: { kind: 'layer', layerAssignment: 'L1' }, scopeMode: 'view' })
    expect(targetOf({ kind: 'view' }, 'v1', 'data_source')).toEqual({ viewId: 'v1', predicate: { kind: 'all' }, scopeMode: 'data_source' })
  })

  it('a selection is sent as its ids; criteria not finished are not sent at all', () => {
    expect(targetOf({ kind: 'selection', ids: ['a', 'b'] }, 'v1', 'view')).toEqual({ ids: ['a', 'b'] })
    expect(targetOf({ kind: 'custom', predicate: null }, 'v1', 'view')).toBeNull()
  })

  it('reads as a sentence', () => {
    expect(targetLabel({ kind: 'children', urns: ['urn:a'], label: 'Orders' })).toBe('the children of Orders')
    expect(targetLabel({ kind: 'selection', ids: ['a', 'b', 'c'] })).toBe('the 3 selected')
  })
})

describe('the operation', () => {
  it('is whole only with a usable name, a new name that differs, and a value where one is needed', () => {
    expect(opProblem(op({}))).toBeNull()
    expect(opProblem(op({ key: ' ' }))).toBe('Name the property')
    expect(opProblem(op({ key: 'urn' }))).toMatch(/kept by the platform/)
    expect(opProblem(op({ value: '' }))).toBe('Give it a value')
    expect(opProblem(op({ kind: 'rename', to: '' }))).toBe('Name the new property')
    expect(opProblem(op({ kind: 'rename', to: 'owner' }))).toMatch(/same as the old one/)
    expect(opProblem(op({ kind: 'remove', value: undefined }))).toBeNull()
  })

  it('is sent with only what its kind uses', () => {
    expect(jobOp(op({ key: ' owner ' }))).toEqual({ kind: 'set', key: 'owner', value: 'ana' })
    expect(jobOp(op({ kind: 'rename', to: 'steward', onConflict: 'overwrite' })))
      .toEqual({ kind: 'rename', key: 'owner', to: 'steward', onConflict: 'overwrite' })
    expect(jobOp(op({ kind: 'remove' }))).toEqual({ kind: 'remove', key: 'owner' })
  })
})

describe('review', () => {
  const target = { kind: 'all' } as never

  it('counts the target, those holding the property, and those holding the new name', () => {
    expect(reviewCounts(op({ kind: 'copy', to: 'lead' }), target).map((c) => c.id)).toEqual(['target', 'haveKey', 'haveTo'])
    expect(reviewCounts(op({}), target)[1]!.predicate)
      .toEqual({ kind: 'group', op: 'and', children: [target, { kind: 'hasProperty', key: 'owner', negate: false }] })
  })

  it('says what each operation changes, replaces and leaves alone', () => {
    const c = { target: 100, haveKey: 40, haveTo: 10 }
    expect(impactOf(op({ kind: 'set' }), c)).toEqual({ changes: 100, replaced: 40, untouched: 0 })
    expect(impactOf(op({ kind: 'fillEmpty' }), c)).toEqual({ changes: 60, replaced: 0, untouched: 40 })
    expect(impactOf(op({ kind: 'remove' }), c)).toEqual({ changes: 40, replaced: 0, untouched: 60 })
    expect(impactOf(op({ kind: 'rename', to: 'x' }), c)).toEqual({ changes: 30, replaced: 0, untouched: 70 })
    expect(impactOf(op({ kind: 'rename', to: 'x', onConflict: 'overwrite' }), c)).toEqual({ changes: 40, replaced: 10, untouched: 60 })
  })

  it('asks for the name to be typed for a large or source-wide removal, rename or overwrite', () => {
    expect(needsTypedConfirm(op({ kind: 'remove' }), { changes: 1000, replaced: 0 }, 'view')).toBe(true)
    expect(needsTypedConfirm(op({ kind: 'remove' }), { changes: 10, replaced: 0 }, 'data_source')).toBe(true)
    expect(needsTypedConfirm(op({ kind: 'remove' }), { changes: 10, replaced: 0 }, 'view')).toBe(false)
    expect(needsTypedConfirm(op({ kind: 'set' }), { changes: 5000, replaced: 0 }, 'view')).toBe(false)
    expect(needsTypedConfirm(op({ kind: 'set' }), { changes: 5000, replaced: 1200 }, 'view')).toBe(true)
    expect(needsTypedConfirm(op({ kind: 'fillEmpty' }), { changes: 5000, replaced: 0 }, 'data_source')).toBe(false)
  })
})

describe('a clean-up of the values a property holds', () => {
  const merge = [{ from: 'finance ', fromKind: 'String' as const, to: 'Finance', toKind: 'String' as const }]

  it('is whole once it knows what to do, and is sent with every choice it makes', () => {
    expect(opProblem(op({ kind: 'replace' }))).toBe('Say what to find')
    expect(opProblem(op({ kind: 'replace', find: 'x'.repeat(257) }))).toMatch(/at most 256/)
    expect(opProblem(op({ kind: 'normalize', trim: false }))).toBe('Choose what to tidy')
    expect(opProblem(op({ kind: 'normalize' }))).toBeNull()                       // trims unless told not to
    expect(opProblem(op({ kind: 'mapValues' }))).toBe('Choose the values to merge')
    expect(opProblem(op({ kind: 'convert' }))).toBe('Choose the kind to convert to')
    expect(jobOp(op({ kind: 'replace', find: 'Fin', value: 'ignored' }))).toEqual(
      { kind: 'replace', key: 'owner', find: 'Fin', replaceWith: '', matchCase: false, wholeValue: false })
    expect(jobOp(op({ kind: 'normalize', case: 'lower' }))).toEqual(
      { kind: 'normalize', key: 'owner', trim: true, collapseSpaces: false, case: 'lower', dedupeList: false })
    expect(jobOp(op({ kind: 'mapValues', map: merge }))).toEqual({ kind: 'mapValues', key: 'owner', map: merge, dedupeList: true })
    expect(jobOp(op({ kind: 'convert', toKind: 'Integer' }))).toEqual({ kind: 'convert', key: 'owner', toKind: 'Integer', onFail: 'skip' })
  })

  it('reads as its commits name it', () => {
    expect(propertyJobLabel({ kind: 'replace', key: 'dept', find: 'Fin', replaceWith: 'Finance' })).toBe('Replace “Fin” → “Finance” in dept')
    expect(propertyJobLabel({ kind: 'normalize', key: 'dept', trim: true, collapseSpaces: true, case: 'lower' }))
      .toBe('Normalize dept (trim, collapse spaces, lower case)')
    expect(propertyJobLabel({ kind: 'mapValues', key: 'dept', map: [...merge, ...merge, ...merge] })).toBe('Merge 3 values of dept')
    expect(propertyJobLabel({ kind: 'convert', key: 'tier', toKind: 'Float' })).toBe('Convert tier to Decimal')
  })

  it('counts at most the entities holding what it finds, or the values it merges', () => {
    const target = { kind: 'all' } as never
    const [, , match] = reviewCounts(op({ kind: 'replace', find: 'Fin', matchCase: true }), target)
    expect(match).toEqual({ id: 'match', predicate: { kind: 'group', op: 'and', children: [target,
      { kind: 'property', key: 'owner', op: 'contains', value: 'Fin', valueType: 'string', caseSensitive: true }] } })
    const merged = reviewCounts(op({ kind: 'mapValues', map: [...merge, { from: 1, fromKind: 'Float', to: 2 }] }), target)[2]!
    expect((merged.predicate as { children: unknown[] }).children[1]).toEqual({ kind: 'group', op: 'or', children: [
      { kind: 'property', key: 'owner', op: 'in', value: ['finance '], valueType: 'string', caseSensitive: true },
      { kind: 'property', key: 'owner', op: 'in', value: [1], valueType: 'number' }] })
    expect(reviewCounts(op({ kind: 'normalize' }), target).map((c) => c.id)).toEqual(['target', 'haveKey'])

    const c = { target: 100, haveKey: 40, match: 12 }
    expect(impactOf(op({ kind: 'replace', find: 'x' }), c)).toEqual({ changes: 12, replaced: 12, untouched: 88, upTo: true })
    expect(impactOf(op({ kind: 'normalize' }), c)).toEqual({ changes: 40, replaced: 40, untouched: 60, upTo: true })
    // A convert: those holding it as another kind, from the catalog.
    expect(impactOf(op({ kind: 'convert', toKind: 'Integer' }), c, { Integer: 35, String: 5 }).changes).toBe(5)
    // Named entities: exact, read from the draft.
    expect(impactOf(op({ kind: 'convert', toKind: 'Integer' }), { target: 3, haveKey: 3, wouldChange: 2 }))
      .toEqual({ changes: 2, replaced: 2, untouched: 1 })
    expect(needsTypedConfirm(op({ kind: 'mapValues' }), { changes: 1500, replaced: 1500 }, 'view')).toBe(true)
    expect(needsTypedConfirm(op({ kind: 'normalize' }), { changes: 10, replaced: 10 }, 'view')).toBe(false)
  })

  it('previews each value as the server rewrites it', () => {
    expect(replaceText(op({ find: 'fin', replaceWith: 'Finance' }), 'FIN ops, fin')).toBe('Finance ops, Finance')
    expect(replaceText(op({ find: 'fin', replaceWith: 'Finance', matchCase: true }), 'FIN ops, fin')).toBe('FIN ops, Finance')
    expect(replaceText(op({ find: 'fin', replaceWith: 'F', wholeValue: true }), 'Fin')).toBe('F')
    expect(replaceText(op({ find: 'fin', replaceWith: 'F', wholeValue: true }), 'Fin ops')).toBe('Fin ops')
    expect(normalizeText(op({ collapseSpaces: true, case: 'title' }), '  data   PLATFORM ')).toBe('Data Platform')
    expect(normalizeText(op({ trim: false, case: 'upper' }), ' a ')).toBe(' A ')
    expect(cleanValue(op({ kind: 'normalize' }), 'tidy', 'String').changed).toBe(false)
    expect(cleanValue(op({ kind: 'replace', find: '1', replaceWith: '2' }), 1, 'Integer').changed).toBe(false)  // text only
    expect(cleanValue(op({ kind: 'mapValues', map: [{ from: 1, fromKind: 'Float', to: 'one' }] }), 1, 'Integer').changed).toBe(false)
    expect(cleanValue(op({ kind: 'mapValues', map: [{ from: 1, fromKind: 'Float', to: 'one' }] }), 1, 'Float').value).toBe('one')
  })

  it('previews what converts, exactly, and what won’t', () => {
    expect(convertValue(' +42.0 ', 'String', 'Integer')).toEqual({ value: 42, fails: false })
    expect(convertValue('42.5', 'String', 'Integer').fails).toBe(true)
    expect(convertValue('9223372036854775808', 'String', 'Integer').fails).toBe(true)
    expect(convertValue('1e3', 'String', 'Float').fails).toBe(true)
    expect(convertValue(true, 'Boolean', 'Integer').fails).toBe(true)
    expect(convertValue(1, 'Float', 'String')).toEqual({ value: '1.0', fails: false })
    expect(convertValue(' TRUE ', 'String', 'Boolean')).toEqual({ value: true, fails: false })
    expect(convertValue('yes', 'String', 'Boolean').fails).toBe(true)
    const remove = cleanValue(op({ kind: 'convert', toKind: 'Integer', onFail: 'remove' }), 'n/a', 'String')
    expect(remove).toMatchObject({ value: undefined, changed: true, fails: true })
    expect(cleanValue(op({ kind: 'convert', toKind: 'Integer' }), 'n/a', 'String')).toMatchObject({ changed: false, fails: true })
  })

  it('finds values that differ only in case or spaces, and proposes the cleanest most held one', () => {
    const values = [
      { value: 'finance ', kind: 'String', count: 900 }, { value: 'Finance', kind: 'String', count: 500 },
      { value: 'FINANCE', kind: 'String', count: 20 }, { value: 'Ops', kind: 'String', count: 300 },
      { value: 1, kind: 'Integer', count: 4 }, { value: 'ops', kind: 'String', count: 2 },
    ]
    const groups = similarGroups(values)
    expect(groups.map((g) => [g.key, g.members.map((m) => m.value), g.canonical])).toEqual([
      ['finance', ['finance ', 'Finance', 'FINANCE'], 1], ['ops', ['Ops', 'ops'], 0]])
    expect(mergeMap(groups.slice(0, 1))).toEqual([
      { from: 'finance ', fromKind: 'String', to: 'Finance', toKind: 'String' },
      { from: 'FINANCE', fromKind: 'String', to: 'Finance', toKind: 'String' }])
  })
})
