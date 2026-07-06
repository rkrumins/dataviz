import { describe, expect, it } from 'vitest'
import { deriveEntityScope, normalizeReferenceLayout, scopeForPersist } from '../referenceLayout'
import type { LayerAssignmentEntry, ViewContentConfig } from '@/types/schema'

describe('normalizeReferenceLayout', () => {
    it('returns empty layers/assignments for null, undefined, and malformed input', () => {
        expect(normalizeReferenceLayout(null)).toEqual({ layers: [], assignments: {} })
        expect(normalizeReferenceLayout(undefined)).toEqual({ layers: [], assignments: {} })
        expect(normalizeReferenceLayout('not an object')).toEqual({ layers: [], assignments: {} })
        expect(normalizeReferenceLayout(42)).toEqual({ layers: [], assignments: {} })
    })

    it('passes canonical input through, stripping entityAssignments from layers', () => {
        const raw = {
            layers: [{
                id: 'l1',
                name: 'Layer 1',
                entityTypes: [],
                order: 0,
            }],
            assignments: {
                'urn:canonical': { layerId: 'l1', inheritsChildren: true, assignedBy: 'user' },
            },
        }
        const result = normalizeReferenceLayout(raw)
        expect(result.assignments).toEqual({
            'urn:canonical': { layerId: 'l1', inheritsChildren: true, assignedBy: 'user' },
        })
        expect(result.layers).toHaveLength(1)
        expect(result.layers[0]).not.toHaveProperty('entityAssignments')
        expect(result.layers[0].id).toBe('l1')
    })

    it('up-converts legacy entityAssignments keyed by urn, dropping priority', () => {
        const raw = {
            layers: [{
                id: 'l1',
                name: 'L',
                entityTypes: [],
                order: 0,
                entityAssignments: [
                    { urn: 'urn:x', layerId: 'l1', inheritsChildren: false, priority: 999, assignedBy: 'user', assignedAt: '2026-01-01' },
                ],
            }],
        }
        const result = normalizeReferenceLayout(raw)
        expect(result.assignments['urn:x']).toEqual({
            layerId: 'l1',
            logicalNodeId: undefined,
            inheritsChildren: false,
            assignedBy: 'user',
            assignedAt: '2026-01-01',
        })
        expect(result.assignments['urn:x']).not.toHaveProperty('priority')
        expect(result.layers[0]).not.toHaveProperty('entityAssignments')
    })

    it('up-converts legacy entityAssignments keyed by entityId when urn is absent', () => {
        const raw = {
            layers: [{
                id: 'l1',
                name: 'L',
                entityTypes: [],
                order: 0,
                entityAssignments: [
                    { entityId: 'urn:by-entity-id', layerId: 'l1', priority: 500 },
                ],
            }],
        }
        const result = normalizeReferenceLayout(raw)
        expect(result.assignments['urn:by-entity-id']).toEqual({
            layerId: 'l1',
            logicalNodeId: undefined,
            inheritsChildren: true, // defaulted
            assignedBy: undefined,
            assignedAt: undefined,
        })
    })

    it('converts exact-urn (non-glob) layer rules into assignments', () => {
        const raw = {
            layers: [{
                id: 'l1', name: 'L', entityTypes: [], order: 0,
                rules: [{ id: 'r1', urnPattern: 'urn:exact:1', priority: 100 }],
            }],
        }
        const result = normalizeReferenceLayout(raw)
        expect(result.assignments['urn:exact:1']).toEqual({
            layerId: 'l1', inheritsChildren: true, assignedBy: 'rule',
        })
        // glob-free rule stays untouched on the layer itself
        expect(result.layers[0].rules).toHaveLength(1)
    })

    it('converts exact-urn logicalNode rules, tagging logicalNodeId', () => {
        const raw = {
            layers: [{
                id: 'l1', name: 'L', entityTypes: [], order: 0,
                logicalNodes: [{
                    id: 'ln1', name: 'LN', type: 'container',
                    rules: [{ id: 'r1', urnPattern: 'urn:exact:2' }],
                }],
            }],
        }
        const result = normalizeReferenceLayout(raw)
        expect(result.assignments['urn:exact:2']).toEqual({
            layerId: 'l1', logicalNodeId: 'ln1', inheritsChildren: true, assignedBy: 'rule',
        })
    })

    it('converts an exact-urn rule on a nested child logicalNode (depth >= 2)', () => {
        const raw = {
            layers: [{
                id: 'l1', name: 'L', entityTypes: [], order: 0,
                logicalNodes: [{
                    id: 'ln1', name: 'LN', type: 'container',
                    children: [{
                        id: 'ln1a', name: 'Child', type: 'container',
                        children: [{
                            id: 'ln1a-i', name: 'Grandchild', type: 'group',
                            rules: [{ id: 'r1', urnPattern: 'urn:nested:1' }],
                        }],
                    }],
                }],
            }],
        }
        const result = normalizeReferenceLayout(raw)
        expect(result.assignments['urn:nested:1']).toEqual({
            layerId: 'l1', logicalNodeId: 'ln1a-i', inheritsChildren: true, assignedBy: 'rule',
        })
    })

    it('does NOT convert a glob rule on a nested child logicalNode', () => {
        const raw = {
            layers: [{
                id: 'l1', name: 'L', entityTypes: [], order: 0,
                logicalNodes: [{
                    id: 'ln1', name: 'LN', type: 'container',
                    children: [{
                        id: 'ln1a', name: 'Child', type: 'container',
                        rules: [{ id: 'r1', urnPattern: 'urn:nested:*' }],
                    }],
                }],
            }],
        }
        const result = normalizeReferenceLayout(raw)
        expect(result.assignments).toEqual({})
    })

    it('collision between a parent rule and a nested child rule: parent (first-traversed) wins', () => {
        const raw = {
            layers: [{
                id: 'l1', name: 'L', entityTypes: [], order: 0,
                logicalNodes: [{
                    id: 'ln-parent', name: 'Parent', type: 'container',
                    rules: [{ id: 'r1', urnPattern: 'urn:shared' }],
                    children: [{
                        id: 'ln-child', name: 'Child', type: 'container',
                        rules: [{ id: 'r2', urnPattern: 'urn:shared' }],
                    }],
                }],
            }],
        }
        const result = normalizeReferenceLayout(raw)
        expect(result.assignments['urn:shared'].logicalNodeId).toBe('ln-parent')
    })

    it('does NOT convert glob rules (leaves them in place untouched)', () => {
        const raw = {
            layers: [{
                id: 'l1', name: 'L', entityTypes: [], order: 0,
                rules: [
                    { id: 'r1', urnPattern: 'urn:*:sales' },
                    { id: 'r2', urnPattern: 'urn:x?y' },
                ],
            }],
        }
        const result = normalizeReferenceLayout(raw)
        expect(result.assignments).toEqual({})
        expect(result.layers[0].rules).toHaveLength(2)
        expect(result.layers[0].rules?.[0].urnPattern).toBe('urn:*:sales')
    })

    it('collision precedence: top-level assignments beat entityAssignments beat rules', () => {
        const raw = {
            layers: [{
                id: 'l1', name: 'L', entityTypes: [], order: 0,
                entityAssignments: [{ urn: 'urn:same', layerId: 'l1', inheritsChildren: true, priority: 1000 }],
                rules: [{ id: 'r1', urnPattern: 'urn:same' }],
            }],
            assignments: {
                'urn:same': { layerId: 'TOP', inheritsChildren: true, assignedBy: 'user' } as LayerAssignmentEntry,
            },
        }
        const result = normalizeReferenceLayout(raw)
        expect(result.assignments['urn:same'].layerId).toBe('TOP')
    })

    it('collision precedence: entityAssignments beat rules when no top-level assignments exist', () => {
        // Both sources resolve to the same containing layer's id ('l1'), so the
        // discriminator is assignedBy — entityAssignments carries its own value
        // through ('user'), whereas a rule-derived entry always gets 'rule'.
        const raw = {
            layers: [{
                id: 'l1', name: 'L', entityTypes: [], order: 0,
                entityAssignments: [{ urn: 'urn:same2', layerId: 'l1', inheritsChildren: true, priority: 1000, assignedBy: 'user' }],
                rules: [{ id: 'r1', urnPattern: 'urn:same2' }],
            }],
        }
        const result = normalizeReferenceLayout(raw)
        expect(result.assignments['urn:same2'].assignedBy).toBe('user')
    })

    it('never mutates the input', () => {
        const raw = {
            layers: [{ id: 'l1', name: 'L', entityTypes: [], order: 0, entityAssignments: [{ entityId: 'urn:a', layerId: 'l1', inheritsChildren: true, priority: 1 }] }],
        }
        const snapshot = JSON.parse(JSON.stringify(raw))
        normalizeReferenceLayout(raw)
        expect(raw).toEqual(snapshot)
    })
})

describe('deriveEntityScope', () => {
    const emptyLayout = { layers: [], assignments: {} }
    const curatedLayout = { layers: [], assignments: { 'urn:a': { layerId: 'l1', inheritsChildren: true } as LayerAssignmentEntry } }

    it('explicit content.entityScope wins over derivation', () => {
        const content = { entityScope: 'all' } as ViewContentConfig
        expect(deriveEntityScope(content, curatedLayout)).toBe('all')
    })

    it('derives curated when assignments are non-empty and no explicit scope is set', () => {
        expect(deriveEntityScope(undefined, curatedLayout)).toBe('curated')
    })

    it('derives all when assignments are empty and no explicit scope is set', () => {
        expect(deriveEntityScope(undefined, emptyLayout)).toBe('all')
    })

    it('falls through to derivation when entityScope is a garbage value', () => {
        const content = { entityScope: 'bogus' } as unknown as ViewContentConfig
        expect(deriveEntityScope(content, curatedLayout)).toBe('curated')
        expect(deriveEntityScope(content, emptyLayout)).toBe('all')
    })
})

describe('scopeForPersist — a canvas gesture never flips scope implicitly', () => {
    it('(a) open view (no explicit scope, no pre-gesture assignments) pins "all"', () => {
        expect(scopeForPersist(undefined, { layers: [], assignments: {} })).toBe('all')
    })

    it('(b) view with existing pre-gesture assignments pins "curated" (canonical OR legacy shape)', () => {
        expect(scopeForPersist(undefined, { layers: [], assignments: { 'urn:a': { layerId: 'l1', inheritsChildren: true } } })).toBe('curated')
        // legacy per-layer entityAssignments are up-converted by normalizeReferenceLayout, so a
        // pre-canonical curated view still pins 'curated'.
        expect(scopeForPersist(undefined, { layers: [{ id: 'l1', name: 'L1', order: 0, entityTypes: [], entityAssignments: [{ entityId: 'urn:a', layerId: 'l1', inheritsChildren: true, priority: 1 }] }] })).toBe('curated')
    })

    it('(c) explicit content.entityScope passes through unchanged regardless of the pre-gesture layout', () => {
        const openContent = { entityScope: 'all' } as ViewContentConfig
        const curatedContent = { entityScope: 'curated' } as ViewContentConfig
        // explicit 'all' even though pre-gesture assignments exist
        expect(scopeForPersist(openContent, { layers: [], assignments: { 'urn:a': { layerId: 'l1', inheritsChildren: true } } })).toBe('all')
        // explicit 'curated' even though there are no pre-gesture assignments
        expect(scopeForPersist(curatedContent, { layers: [], assignments: {} })).toBe('curated')
    })

    it('tolerates a missing/undefined pre-gesture layout (new view) → "all"', () => {
        expect(scopeForPersist(undefined, undefined)).toBe('all')
    })
})
