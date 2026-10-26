/**
 * A query on its own as a file: written as a library pack of one (name and
 * description kept), read back from that, from a search's own JSON
 * (``*.search.json``) or from a bare condition; a library of several is
 * handed on whole, to import.
 */
import { describe, expect, it } from 'vitest'

import { queryPack, readQueryFile } from '../libraryFile'

const file = (name: string, contents: unknown) =>
    new File([typeof contents === 'string' ? contents : JSON.stringify(contents)], name)
const OWNED = { kind: 'hasProperty', key: 'owner' }

describe('libraryFile — one query', () => {
    it('writes a pack of one, from the view it was saved on', () => {
        const pack = queryPack({ name: 'Owned', description: 'has an owner', predicate: OWNED as never },
            { viewId: 'v1', viewName: 'Ops' })
        expect(pack).toMatchObject({
            format: 'synodic.view-library', version: 1, source: { viewId: 'v1', viewName: 'Ops' },
            displayRules: [], savedQueries: [{ name: 'Owned', description: 'has an owner', predicate: OWNED }],
        })
    })

    it('reads one back from a pack of one, a search, or a bare condition', async () => {
        const pack = queryPack({ name: 'Owned', predicate: OWNED as never }, { viewId: 'v1' })
        expect(await readQueryFile(file('x.library.json', pack))).toEqual(
            { kind: 'query', query: { name: 'Owned', description: null, predicate: OWNED } })
        expect(await readQueryFile(file('Owners.search.json', { predicate: OWNED, scope: {} }))).toEqual(
            { kind: 'query', query: { name: 'Owners', predicate: OWNED } })
        expect(await readQueryFile(file('cond.json', OWNED))).toEqual(
            { kind: 'query', query: { name: 'cond', predicate: OWNED } })
    })

    it('hands on a library of several, or with rules, whole', async () => {
        const several = { format: 'synodic.view-library', version: 1, displayRules: [],
                          savedQueries: [{ name: 'A', predicate: OWNED }, { name: 'B', predicate: OWNED }] }
        expect(await readQueryFile(file('lib.json', several))).toMatchObject({ kind: 'pack', pack: several })
    })

    it('says why a file holds no query', async () => {
        await expect(readQueryFile(file('a.json', 'not json'))).rejects.toThrow("isn't JSON")
        await expect(readQueryFile(file('a.json', { hello: 1 }))).rejects.toThrow('holds no query')
        await expect(readQueryFile(file('a.json', { format: 'synodic.view-library', version: 2 })))
            .rejects.toThrow('version 2')
    })
})
