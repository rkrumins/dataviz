/**
 * ConditionRow — a row naming edge types it hasn't picked yet is held back
 * from a run, as any row with a value still to fill in: the server takes no
 * empty list of edge types.
 */
import { describe, expect, it } from 'vitest'

import type { Predicate } from '@/types/search'

import { isRowIncomplete } from '../ConditionRow'


describe('ConditionRow — edge types to pick', () => {
    it.each<[Predicate, boolean]>([
        [{ kind: 'related', axis: 'neighbor', edgeTypes: [] }, true],
        [{ kind: 'related', axis: 'neighbor', edgeTypes: ['PRODUCES'] }, false],
        [{ kind: 'related', axis: 'neighbor', edgeClass: 'links' }, false],
        [{ kind: 'related', axis: 'descendant', where: { kind: 'related', axis: 'downstream', edgeTypes: [] } }, true],
        [{ kind: 'isRoot', edgeTypes: [] }, true],
        [{ kind: 'isRoot', edgeClass: 'any' }, false],
        [{ kind: 'degree', direction: 'in', op: 'gt', value: 2, edgeTypes: [] }, true],
        [{ kind: 'degree', direction: 'in', op: 'gt', value: 2, edgeTypes: ['DEFINED_BY'] }, false],
    ])('%j is incomplete: %s', (p, incomplete) => {
        expect(isRowIncomplete(p)).toBe(incomplete)
    })
})
