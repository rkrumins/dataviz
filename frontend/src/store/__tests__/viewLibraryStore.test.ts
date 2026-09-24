/**
 * viewLibraryStore — the open view's library from the server: its rules
 * shown on the canvas, every change written through one rule at a time,
 * one write after another, and a refused write undone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
    getViewLibrary: vi.fn(),
    putViewRule: vi.fn(),
    deleteViewRule: vi.fn(),
    orderViewRules: vi.fn(),
    putViewQuery: vi.fn(),
    deleteViewQuery: vi.fn(),
}))
vi.mock('@/services/viewLibraryService', () => api)

import type { SavedViewQuery, ViewLibrary } from '@/services/viewLibraryService'
import type { DisplayRuleConfig } from '@/types/schema'

import { useReferenceModelStore } from '../referenceModelStore'
import { useViewLibraryStore } from '../viewLibraryStore'


const rule = (id: string, over: Partial<DisplayRuleConfig> = {}): DisplayRuleConfig => ({
    id, name: id.toUpperCase(), color: '#6366f1', predicate: { kind: 'hasProperty', key: id },
    enabled: true, createdAt: '2026-09-24T00:00:00Z', ...over,
})

const query = (id: string): SavedViewQuery => ({
    id, name: `Query ${id}`, predicate: { kind: 'hasProperty', key: id },
})

const library = (over: Partial<ViewLibrary> = {}): ViewLibrary => ({
    viewId: 'v1', branchId: null, displayRules: [rule('a')], savedQueries: [], canEdit: true, ...over,
})

const shown = () => useReferenceModelStore.getState().displayRules.map((r) => r.id)
const store = () => useViewLibraryStore.getState()

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

async function open(over: Partial<ViewLibrary> = {}, branchId: string | null = null) {
    api.getViewLibrary.mockResolvedValueOnce(library({ branchId, ...over }))
    await store().load(over.viewId ?? 'v1', branchId)
}


beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    useViewLibraryStore.setState({
        viewId: null, branchId: null, status: 'idle', error: null, canEdit: false, savedQueries: [],
    })
    useReferenceModelStore.setState({ displayRules: [] })
})


describe('loading a view\'s library', () => {
    it('shows its rules on the canvas, with its saved queries and whether they can be changed', async () => {
        await open({ savedQueries: [query('q1')] })
        expect(api.getViewLibrary).toHaveBeenCalledWith('v1', null)
        expect(shown()).toEqual(['a'])
        expect(store()).toMatchObject({ status: 'ready', canEdit: true, savedQueries: [query('q1')] })
    })

    it('never shows one view\'s rules on another while the other\'s load', async () => {
        await open()
        const next = deferred<ViewLibrary>()
        api.getViewLibrary.mockReturnValueOnce(next.promise)
        const loading = store().load('v2', null)
        expect(shown()).toEqual([])
        expect(store().status).toBe('loading')
        next.resolve(library({ viewId: 'v2', displayRules: [rule('b')] }))
        await loading
        expect(shown()).toEqual(['b'])
    })

    it('ignores an answer for a view it has moved on from', async () => {
        const first = deferred<ViewLibrary>()
        const second = deferred<ViewLibrary>()
        api.getViewLibrary.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
        const a = store().load('v1', null)
        const b = store().load('v2', null)
        second.resolve(library({ viewId: 'v2', displayRules: [rule('b')] }))
        first.resolve(library({ displayRules: [rule('a')] }))
        await Promise.all([a, b])
        expect(shown()).toEqual(['b'])
        expect(store().viewId).toBe('v2')
    })

    it('says why it couldn\'t', async () => {
        api.getViewLibrary.mockRejectedValueOnce(new Error('Service Unavailable'))
        await store().load('v1', null)
        expect(store()).toMatchObject({ status: 'error', error: 'Service Unavailable' })
    })
})


describe('changing the rules', () => {
    it('shows a new rule at once, then the view\'s rules as the server has them', async () => {
        await open()
        const answer = deferred<DisplayRuleConfig[]>()
        api.putViewRule.mockReturnValueOnce(answer.promise)
        const saving = store().saveRule(rule('n'))
        expect(shown()).toEqual(['a', 'n'])
        // Someone else added "z" meanwhile: the answer has it.
        answer.resolve([rule('a'), rule('z'), rule('n')])
        await saving
        expect(api.putViewRule).toHaveBeenCalledWith('v1', rule('n'), null)
        expect(shown()).toEqual(['a', 'z', 'n'])
    })

    it('replaces an edited rule where it stands', async () => {
        await open({ displayRules: [rule('a'), rule('b')] })
        const answer = deferred<DisplayRuleConfig[]>()
        api.putViewRule.mockReturnValueOnce(answer.promise)
        const saving = store().saveRule(rule('a', { name: 'Renamed' }))
        expect(useReferenceModelStore.getState().displayRules.map((r) => r.name)).toEqual(['Renamed', 'B'])
        answer.resolve([rule('a', { name: 'Renamed' }), rule('b')])
        await saving
    })

    it('sends one write at a time, so the last answer holds every change', async () => {
        await open()
        const first = deferred<DisplayRuleConfig[]>()
        const second = deferred<DisplayRuleConfig[]>()
        api.putViewRule.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
        const one = store().saveRule(rule('n'))
        const two = store().saveRule(rule('m'))
        await vi.waitFor(() => expect(api.putViewRule).toHaveBeenCalledTimes(1))
        expect(shown()).toEqual(['a', 'n', 'm'])

        first.resolve([rule('a'), rule('n')])
        await one
        // The first answer is already out of date: the second write is on its way.
        expect(shown()).toEqual(['a', 'n', 'm'])
        await vi.waitFor(() => expect(api.putViewRule).toHaveBeenCalledTimes(2))
        second.resolve([rule('a'), rule('n'), rule('m')])
        await two
        expect(shown()).toEqual(['a', 'n', 'm'])
    })

    it('undoes a refused write by reading the library again, and says why', async () => {
        await open()
        api.putViewRule.mockRejectedValueOnce(new Error('A rule named “A” already exists in this view.'))
        api.getViewLibrary.mockResolvedValueOnce(library())
        await expect(store().saveRule(rule('n', { name: 'A' }))).rejects.toThrow(/already exists/)
        await vi.waitFor(() => expect(api.getViewLibrary).toHaveBeenCalledTimes(2))
        await vi.waitFor(() => expect(shown()).toEqual(['a']))
    })

    it('refuses to write for someone who can\'t edit the view', async () => {
        await open({ canEdit: false })
        await expect(store().saveRule(rule('n'))).rejects.toThrow(/can't change this view's library/)
        expect(api.putViewRule).not.toHaveBeenCalled()
        expect(shown()).toEqual(['a'])
    })

    it('toggles, removes and reorders through the server', async () => {
        await open({ displayRules: [rule('a'), rule('b')] })
        api.putViewRule.mockResolvedValueOnce([rule('a', { enabled: false }), rule('b')])
        await store().toggleRule('a')
        expect(api.putViewRule).toHaveBeenCalledWith('v1', rule('a', { enabled: false }), null)

        const reordered = deferred<DisplayRuleConfig[]>()
        api.orderViewRules.mockReturnValueOnce(reordered.promise)
        const reordering = store().reorderRules(['b', 'a'])
        expect(shown()).toEqual(['b', 'a'])
        reordered.resolve([rule('b'), rule('a', { enabled: false })])
        await reordering
        expect(api.orderViewRules).toHaveBeenCalledWith('v1', ['b', 'a'], null)

        api.deleteViewRule.mockResolvedValueOnce([rule('b')])
        await store().removeRule('a')
        expect(api.deleteViewRule).toHaveBeenCalledWith('v1', 'a', null)
        expect(shown()).toEqual(['b'])
    })

    it('writes a draft\'s rules to its branch', async () => {
        await open({}, 'br1')
        api.putViewRule.mockResolvedValueOnce([rule('a'), rule('n')])
        await store().saveRule(rule('n'))
        expect(api.putViewRule).toHaveBeenCalledWith('v1', rule('n'), 'br1')
    })
})


describe('saved queries', () => {
    it('saves a query under a new id and lists it', async () => {
        await open()
        api.putViewQuery.mockImplementationOnce(async (_view: string, id: string, body: object) => ({ id, ...body }))
        const saved = await store().saveQuery({ name: 'Tables', predicate: { kind: 'hasProperty', key: 't' } })
        expect(api.putViewQuery).toHaveBeenCalledWith(
            'v1', expect.stringMatching(/^query/), { name: 'Tables', predicate: { kind: 'hasProperty', key: 't' } })
        expect(store().savedQueries).toEqual([saved])
    })

    it('removes one at once, and brings it back if the server refuses', async () => {
        await open({ savedQueries: [query('q1'), query('q2')] })
        api.deleteViewQuery.mockRejectedValueOnce(new Error('Service Unavailable'))
        api.getViewLibrary.mockResolvedValueOnce(library({ savedQueries: [query('q1'), query('q2')] }))
        const removing = store().removeQuery('q1')
        expect(store().savedQueries.map((q) => q.id)).toEqual(['q2'])
        await expect(removing).rejects.toThrow('Service Unavailable')
        await vi.waitFor(() => expect(store().savedQueries.map((q) => q.id)).toEqual(['q1', 'q2']))
    })
})
