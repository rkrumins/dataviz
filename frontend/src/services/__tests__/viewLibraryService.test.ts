/**
 * viewLibraryService — each call's path, method and query: a draft's
 * branch rides as ``branchId``, a rule's id is encoded into its path, and
 * an import says how it lands and whether it only previews.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authFetch = vi.hoisted(() => vi.fn(async (_url: string, _init?: RequestInit) => undefined))
vi.mock('../apiClient', () => ({ authFetch }))

import type { DisplayRuleConfig } from '@/types/schema'

import {
    LIBRARY_PACK_FORMAT, deleteViewQuery, getViewLibrary, importViewLibrary, orderViewRules, putViewRule,
    type LibraryPack,
} from '../viewLibraryService'


const rule: DisplayRuleConfig = {
    id: 'rule/1', name: 'PII', color: '#6366f1', predicate: { kind: 'hasProperty', key: 'pii' },
    enabled: true, createdAt: '2026-09-24T00:00:00Z',
}

beforeEach(() => authFetch.mockClear())


describe('viewLibraryService', () => {
    it('reads the published library, or a draft\'s', async () => {
        await getViewLibrary('v1')
        await getViewLibrary('v1', 'br 1')
        expect(authFetch.mock.calls.map((c) => c[0])).toEqual([
            '/api/v1/views/v1/library',
            '/api/v1/views/v1/library?branchId=br+1',
        ])
    })

    it('writes one rule under its own (encoded) id', async () => {
        await putViewRule('v1', rule, 'br1')
        expect(authFetch).toHaveBeenCalledWith(
            '/api/v1/views/v1/library/rules/rule%2F1?branchId=br1',
            { method: 'PUT', body: JSON.stringify(rule) },
        )
    })

    it('reorders rules and removes queries', async () => {
        await orderViewRules('v1', ['b', 'a'])
        await deleteViewQuery('v1', 'q1')
        expect(authFetch.mock.calls).toEqual([
            ['/api/v1/views/v1/library/rules', { method: 'PUT', body: '{"ids":["b","a"]}' }],
            ['/api/v1/views/v1/library/queries/q1', { method: 'DELETE' }],
        ])
    })

    it('imports a pack — previewing, or for real — the way it is told to', async () => {
        const pack: LibraryPack = { format: LIBRARY_PACK_FORMAT, version: 1, displayRules: [], savedQueries: [] }
        await importViewLibrary('v1', pack, { strategy: 'copy', dryRun: true })
        await importViewLibrary('v1', pack, { strategy: 'replace', dryRun: false, branchId: 'br1' })
        expect(authFetch.mock.calls.map((c) => c[0])).toEqual([
            '/api/v1/views/v1/library/import?strategy=copy&dryRun=true',
            '/api/v1/views/v1/library/import?strategy=replace&dryRun=false&branchId=br1',
        ])
        expect(authFetch.mock.calls[0][1]).toEqual({ method: 'POST', body: JSON.stringify(pack) })
    })
})
