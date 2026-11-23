/**
 * Bring your own data, before anything is sent: CSV read the way spreadsheets write it (quoted
 * values with commas, quotes and line breaks in them, a semicolon file, a byte-order mark), its
 * columns matched to what a thing and a connection need, the rest kept as properties, JSON read in
 * the shape the server takes, and every row the server would refuse named first — with the same
 * limits. The templates the dialog offers are the files under docs/examples/playground.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    EXAMPLE, TEMPLATE_FILES, connectionsFromCsv, guessConnectionColumns, guessThingColumns, looksLikeConnections,
    parseCsv, parseOwnDataJson, propertyColumns, summarize, thingsFromCsv, toCsv, validateOwnData,
} from '../ownData'

describe('parseCsv', () => {
    it('reads quoted values with commas, doubled quotes and line breaks in them', () => {
        const t = parseCsv('key,name,description\r\na,"Loyalty report, monthly","The ""official"" figures"\nb,Two,"first line\nsecond line"\n')
        expect(t.headers).toEqual(['key', 'name', 'description'])
        expect(t.rows.map(r => r.cells)).toEqual([
            ['a', 'Loyalty report, monthly', 'The "official" figures'],
            ['b', 'Two', 'first line\nsecond line'],
        ])
        // Where each row starts in the file, for messages a person can find.
        expect(t.rows.map(r => r.line)).toEqual([2, 3])
    })

    it('drops a byte-order mark, skips blank lines and trims header names', () => {
        const t = parseCsv('\uFEFF key , type \n\na,Table\n,\n')
        expect(t.headers).toEqual(['key', 'type'])
        expect(t.rows.map(r => r.cells)).toEqual([['a', 'Table']])
    })

    it('reads a semicolon- or tab-separated file as such', () => {
        expect(parseCsv('key;name\na;"b;c"').rows[0].cells).toEqual(['a', 'b;c'])
        expect(parseCsv('key\tname\na\tb').rows[0].cells).toEqual(['a', 'b'])
    })

    it('says which line a quote is left open on', () => {
        expect(() => parseCsv('key,name\na,"never closed\nb,c')).toThrow(/line 2/)
    })
})

describe('matching columns', () => {
    it('guesses what each column of things is, whatever its case, and keeps the rest as properties', () => {
        const headers = ['ID', 'Kind', 'Label', 'Description', 'Tags', 'owner', 'system']
        const cols = guessThingColumns(headers)
        expect(cols).toEqual({ key: 'ID', type: 'Kind', name: 'Label', description: 'Description', tags: 'Tags' })
        expect(propertyColumns(headers, cols)).toEqual(['owner', 'system'])
    })

    it('never makes where a thing sat into a property, however its columns are written', () => {
        // A trace's, a member set's or a search's file, brought back: its parent and path say
        // where each row came from, and nothing of the thing.
        const headers = ['urn', 'name', 'type', 'layer', 'parentUrn', 'parentName', 'parentType', 'path', 'pathUrns',
            'parent_urn', 'Parent Name', 'PATH']
        expect(propertyColumns(headers, guessThingColumns(headers))).toEqual(['layer'])
        const t = parseCsv('urn,type,name,parentUrn,path,pathUrns,owner\nurn:a,Table,A,urn:db,Warehouse / gold,urn:db; urn:gold,Ops\n')
        expect(thingsFromCsv(t, guessThingColumns(t.headers))).toEqual([
            { key: 'urn:a', type: 'Table', name: 'A', properties: { owner: 'Ops' } }])
    })

    it("keeps someone's own path column: only a file an export wrote has its ancestry skipped", () => {
        // No parentUrn or pathUrns: this is a person's own file, and its `path` is their data.
        const headers = ['key', 'type', 'name', 'path', 'parentName']
        expect(propertyColumns(headers, guessThingColumns(headers))).toEqual(['path', 'parentName'])
    })

    it('tells a file of connections from a file of things', () => {
        expect(looksLikeConnections(['from', 'type', 'to'])).toBe(true)
        expect(looksLikeConnections(['Source', 'Relationship', 'Target'])).toBe(true)
        expect(looksLikeConnections(['key', 'type', 'name'])).toBe(false)
        expect(guessConnectionColumns(['Source', 'Relationship', 'Target'])).toEqual({ from: 'Source', type: 'Relationship', to: 'Target' })
    })

    it('makes things: the name falls back to the key, tags split, numbers and true/false read as such', () => {
        const t = parseCsv('key,type,name,tags,rows,live,owner\na,Table,,"pii; finance",120,true,\nb,Table,Bee,,0012,no,Ops')
        const things = thingsFromCsv(t, guessThingColumns(t.headers))
        expect(things[0]).toEqual({ key: 'a', type: 'Table', name: 'a', tags: ['pii', 'finance'], properties: { rows: 120, live: true } })
        // A leading zero is an identifier, not a number; an empty cell is no property at all.
        expect(things[1]).toEqual({ key: 'b', type: 'Table', name: 'Bee', properties: { rows: '0012', live: 'no', owner: 'Ops' } })
    })

    it('leaves out a column matched to nothing, and ignores a column the person unmatched', () => {
        const t = parseCsv('key,type,name,description\na,Table,A,Some words')
        const things = thingsFromCsv(t, { ...guessThingColumns(t.headers), description: null })
        // Unmatched from Description, it is a property like any other column.
        expect(things[0]).toEqual({ key: 'a', type: 'Table', name: 'A', properties: { description: 'Some words' } })
    })

    it('makes connections from their three columns', () => {
        const t = parseCsv('from,type,to\na,FEEDS,b')
        expect(connectionsFromCsv(t, guessConnectionColumns(t.headers))).toEqual([{ from: 'a', type: 'FEEDS', to: 'b' }])
    })
})

describe('parseOwnDataJson', () => {
    it('reads the shape the server takes, name and description included', () => {
        const data = parseOwnDataJson(JSON.stringify(EXAMPLE))
        expect(data.name).toBe(EXAMPLE.name)
        expect(data.things).toHaveLength(EXAMPLE.things.length)
        expect(data.connections).toHaveLength(EXAMPLE.connections.length)
    })

    it('takes a file without connections, and says what is wrong with one it can’t read', () => {
        expect(parseOwnDataJson('{"things":[{"key":"a","type":"T","name":"A"}]}').connections).toEqual([])
        expect(() => parseOwnDataJson('not json')).toThrow(/isn’t JSON/)
        expect(() => parseOwnDataJson('[1,2]')).toThrow(/"things"/)
    })
})

describe('validateOwnData', () => {
    it('names each row the server would refuse, by section, row and field', () => {
        const { rows, issues } = validateOwnData(
            [
                { key: 'a', type: 'Table', name: 'A' },
                { key: 'a', type: 'Table', name: 'Again' },
                { key: '', type: '', name: 'Nameless' },
                { key: 'c', type: 'Table', name: 'C', properties: { nested: { no: 1 } as never } },
            ],
            [{ from: 'a', type: 'FEEDS', to: 'zz' }, { from: 'a', type: '', to: 'a' }],
        )
        expect(issues).toEqual([])
        expect(rows).toEqual([
            { section: 'things', index: 1, field: 'key', message: 'Another thing already has the key “a”' },
            { section: 'things', index: 2, field: 'key', message: 'Needs a key' },
            { section: 'things', index: 2, field: 'type', message: 'Needs a type' },
            { section: 'things', index: 3, field: 'properties', message: '“nested” must be text, a number, true or false' },
            { section: 'connections', index: 0, field: 'to', message: 'No thing has the key “zz”' },
            { section: 'connections', index: 1, field: 'type', message: 'Needs a type' },
        ])
    })

    it('holds the server’s limits: at least one thing, and no more than 50 kinds of thing', () => {
        expect(validateOwnData([], []).issues).toEqual(['Add at least one thing.'])
        const many = Array.from({ length: 51 }, (_, i) => ({ key: `k${i}`, type: `Type ${i}`, name: `N${i}` }))
        expect(validateOwnData(many, []).issues).toEqual(['51 kinds of thing — the Playground takes up to 50.'])
        const long = validateOwnData([{ key: 'k'.repeat(201), type: 't'.repeat(61), name: 'n'.repeat(201) }], []).rows
        expect(long.map(e => e.field)).toEqual(['key', 'type', 'name'])
    })
})

describe('summarize', () => {
    it('counts things and connections by type, most first', () => {
        const s = summarize(
            [{ key: 'a', type: 'Table', name: 'A' }, { key: 'b', type: 'Table', name: 'B' }, { key: 'c', type: 'Report', name: 'C' }],
            [{ from: 'a', type: 'FEEDS', to: 'c' }],
        )
        expect(s.thingTypes).toEqual([['Table', 2], ['Report', 1]])
        expect(s.connectionTypes).toEqual([['FEEDS', 1]])
    })
})

describe('the templates', () => {
    it('quote what needs quoting when written out', () => {
        expect(toCsv([['a', 'b, c', 'say "hi"', 'two\nlines']])).toBe('a,"b, c","say ""hi""","two\nlines"\n')
    })

    it('read back as the example, with nothing to fix', () => {
        const things = parseCsv(TEMPLATE_FILES['things.csv'])
        const connections = parseCsv(TEMPLATE_FILES['connections.csv'])
        const t = thingsFromCsv(things, guessThingColumns(things.headers))
        const c = connectionsFromCsv(connections, guessConnectionColumns(connections.headers))
        expect(t).toEqual(EXAMPLE.things)
        expect(c).toEqual(EXAMPLE.connections)
        expect(validateOwnData(t, c)).toEqual({ rows: [], issues: [] })
        expect(parseOwnDataJson(TEMPLATE_FILES['example.json'])).toEqual(EXAMPLE)
    })

    it('are the files under docs/examples/playground, byte for byte', () => {
        const dir = join(__dirname, '..', '..', '..', '..', '..', 'docs', 'examples', 'playground')
        for (const [name, body] of Object.entries(TEMPLATE_FILES)) {
            expect(readFileSync(join(dir, name), 'utf8'), name).toBe(body)
        }
    })
})
