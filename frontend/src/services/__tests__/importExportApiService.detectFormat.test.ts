/**
 * detectFormat — the import dialog's format guess.
 *
 * It used to JSON.parse the first line of an 8 KiB read, so a JSON-array
 * export (one line) came back as ndjson when small and as csv when larger,
 * and the import then failed or found 0 rows. An unambiguous extension now
 * wins; otherwise the first non-whitespace character decides.
 */
import { describe, expect, it } from 'vitest'
import { detectFormat } from '../importExportApiService'

const upload = (body: BlobPart, name = 'upload') => new File([body], name)

const rows = Array.from({ length: 100 }, (_, i) => ({
    kind: 'node', urn: `urn:table:${i}`, displayName: `Table ${i}`, description: 'x'.repeat(40),
}))
const ndjson = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

describe('detectFormat', () => {
    it('classifies a single-line JSON array over 8 KiB as json', async () => {
        const body = JSON.stringify(rows)
        expect(body.length).toBeGreaterThan(8192)
        expect(body).not.toContain('\n')
        expect(await detectFormat(upload(body))).toBe('json')
    })

    it('classifies a small JSON array as json, also after a BOM and blank lines', async () => {
        expect(await detectFormat(upload(JSON.stringify(rows.slice(0, 2))))).toBe('json')
        expect(await detectFormat(upload('\uFEFF\r\n  [{"kind": "node"}]'))).toBe('json')
    })

    it('classifies NDJSON whose first line is over 8 KiB as ndjson', async () => {
        const first = JSON.stringify({ kind: 'node', description: 'd'.repeat(10_000) })
        expect(await detectFormat(upload(`${first}\n${ndjson}`))).toBe('ndjson')
    })

    it('classifies comma- and tab-delimited text as csv and tsv', async () => {
        expect(await detectFormat(upload('entity_id,urn,prop.owner\nent_1,urn:x,alice\n'))).toBe('csv')
        expect(await detectFormat(upload('entity_id\turn\tprop.owner\nent_1\turn:x\talice\n'))).toBe('tsv')
    })

    it('recognises an xlsx workbook by its PK zip signature', async () => {
        const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00])
        expect(await detectFormat(upload(zip))).toBe('xlsx')
    })

    it('trusts an unambiguous extension over the content', async () => {
        const array = JSON.stringify(rows)
        expect(await detectFormat(upload(ndjson, 'export.json'))).toBe('json')
        expect(await detectFormat(upload(array, 'export.ndjson'))).toBe('ndjson')
        expect(await detectFormat(upload(array, 'export.jsonl'))).toBe('ndjson')
        expect(await detectFormat(upload(array, 'Export.CSV'))).toBe('csv')
        expect(await detectFormat(upload('a,b\n1,2\n', 'rows.tsv'))).toBe('tsv')
        expect(await detectFormat(upload('a,b\n1,2\n', 'rows.tab'))).toBe('tsv')
        expect(await detectFormat(upload('a,b\n1,2\n', 'book.xlsx'))).toBe('xlsx')
    })
})
