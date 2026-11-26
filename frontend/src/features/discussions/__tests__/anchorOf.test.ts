/**
 * A question about an entity is anchored to its urn, its name as the reader reads it, its type and
 * the containers it sits in, top first: its loaded parents, and above them the containers its feed
 * named — or, for what the canvas hasn't loaded, the data source's answer, taken only while the
 * drawer is still on that entity.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { usePersonaStore } from '@/store/persona'
import { useSchemaStore } from '@/store/schema'
import type { GraphDataProvider, GraphNode } from '@/providers/GraphDataProvider'
import { anchorOf, completeAnchorPath, describeAnchor } from '../anchorOf'
import { useDiscussionsDrawer } from '../drawerStore'

const node = (id: string, label: string, extra: Record<string, unknown> = {}) =>
    ({ id, position: { x: 0, y: 0 }, data: { label, urn: id, type: 'column', ...extra } }) as unknown as LineageNode
const contains = (source: string, target: string) => ({ id: `${source}>${target}`, source, target, data: { edgeType: 'CONTAINS' } })

function canvas(nodes: LineageNode[], edges: Array<ReturnType<typeof contains>>) {
    useCanvasStore.setState({ nodes, edges } as never)
}

const provider = (answer: () => Promise<GraphNode[]>) => ({ getAncestors: vi.fn(answer) }) as unknown as GraphDataProvider & {
    getAncestors: ReturnType<typeof vi.fn>
}
const ancestor = (urn: string, displayName: string) => ({ urn, displayName, entityType: 'schema' }) as GraphNode

beforeEach(() => {
    usePersonaStore.setState({ mode: 'business' })
    useSchemaStore.setState({ schema: { containmentEdgeTypes: ['CONTAINS'], views: [] } } as never)
    useDiscussionsDrawer.setState({ target: null })
    canvas([], [])
})

describe('anchorOf', () => {
    it('names the entity and its loaded containers as the reader reads them, top first', () => {
        canvas([
            node('urn:db', 'fin_db', { businessLabel: 'Finance' }),
            node('urn:tbl', 'gl', { businessLabel: 'Ledger' }),
            node('urn:col', 'amt', { businessLabel: 'Amount' }),
        ], [contains('urn:db', 'urn:tbl'), contains('urn:tbl', 'urn:col')])
        expect(anchorOf('urn:col')).toEqual({ id: 'urn:col', label: 'Amount', path: ['Finance', 'Ledger'], type: 'column' })
        usePersonaStore.setState({ mode: 'technical' })
        expect(anchorOf('urn:col')).toMatchObject({ label: 'amt', path: ['fin_db', 'gl'] })
    })

    it('a top-level entity sits in nothing', () => {
        canvas([node('urn:db', 'Finance')], [])
        expect(anchorOf('urn:db')).toEqual({ id: 'urn:db', label: 'Finance', path: [], type: 'column' })
    })

    it('above its topmost loaded container, the containers its feed named', () => {
        canvas([
            node('urn:tbl', 'Ledger', { ancestorPath: [{ urn: 'urn:org', displayName: 'Acme' }, { urn: 'urn:db', displayName: 'Finance' }] }),
            node('urn:col', 'Amount'),
        ], [contains('urn:tbl', 'urn:col')])
        expect(anchorOf('urn:col').path).toEqual(['Acme', 'Finance', 'Ledger'])
    })

    it('finds a node the store does not hold — a trace card — through `resolve`', () => {
        const card = node('trace:col', 'Amount', { urn: 'urn:col' })
        expect(anchorOf('trace:col', { resolve: (id) => (id === 'trace:col' ? card : null) }))
            .toEqual({ id: 'urn:col', label: 'Amount', path: [], type: 'column' })
    })

    it('an entity the canvas does not hold is named by its row', () => {
        expect(anchorOf('urn:x', { label: ' Orders ' })).toEqual({ id: 'urn:x', label: 'Orders' })
        expect(anchorOf('urn:x')).toEqual({ id: 'urn:x', label: 'urn:x' })
    })

    it('stops at a containment loop, and keeps the nearest 32 containers', () => {
        const ids = Array.from({ length: 40 }, (_, i) => `urn:${i}`)
        canvas(ids.map((id) => node(id, id.slice(4))), ids.slice(1).map((id, i) => contains(ids[i], id)))
        const deep = anchorOf('urn:39').path!
        expect(deep).toHaveLength(32)
        expect(deep[31]).toBe('38')
        canvas([node('urn:a', 'A'), node('urn:b', 'B')], [contains('urn:a', 'urn:b'), contains('urn:b', 'urn:a')])
        expect(anchorOf('urn:b').path).toEqual(['A'])
    })
})

describe('completeAnchorPath', () => {
    const open = (entity: ReturnType<typeof anchorOf>) =>
        useDiscussionsDrawer.getState().open({ subject: { type: 'view', id: 'v1' }, entity })

    it('fills in the containers the canvas has not loaded, named as the canvas names those it has', async () => {
        canvas([node('urn:tbl', 'gl', { businessLabel: 'Ledger' }), node('urn:col', 'Amount')], [contains('urn:tbl', 'urn:col')])
        const entity = anchorOf('urn:col')
        open(entity)
        const p = provider(async () => [ancestor('urn:tbl', 'gl'), ancestor('urn:db', 'Finance')])
        completeAnchorPath(entity, p)
        await vi.waitFor(() => expect(useDiscussionsDrawer.getState().target?.entity?.path).toEqual(['Finance', 'Ledger']))
        expect(p.getAncestors).toHaveBeenCalledWith('urn:col')
        expect(useDiscussionsDrawer.getState().target?.entity).toMatchObject({ id: 'urn:col', label: 'Amount', type: 'column' })
    })

    it('is dropped once the drawer is on another entity, and the path kept when the source cannot say', async () => {
        canvas([node('urn:a', 'A'), node('urn:b', 'B')], [])
        let answer!: (nodes: GraphNode[]) => void
        const late = provider(() => new Promise((resolve) => { answer = resolve }))
        open(anchorOf('urn:a'))
        completeAnchorPath(anchorOf('urn:a'), late)
        open(anchorOf('urn:b'))
        answer([ancestor('urn:db', 'Finance')])
        await new Promise((r) => setTimeout(r, 0))
        expect(useDiscussionsDrawer.getState().target?.entity).toEqual({ id: 'urn:b', label: 'B', path: [], type: 'column' })

        completeAnchorPath(anchorOf('urn:b'), provider(async () => { throw new Error('offline') }))
        await new Promise((r) => setTimeout(r, 0))
        expect(useDiscussionsDrawer.getState().target?.entity?.path).toEqual([])
        completeAnchorPath(anchorOf('urn:b'), null)
    })
})

describe('describeAnchor', () => {
    it('spells out its name, its whole path and its ID — and an ID kept without a name, once', () => {
        expect(describeAnchor({ id: 'urn:col', label: 'Amount', path: ['Finance', 'Ledger'] }))
            .toBe('Amount, in Finance › Ledger, ID urn:col')
        expect(describeAnchor({ id: 'urn:col', label: 'urn:col' })).toBe('urn:col')
    })
})
