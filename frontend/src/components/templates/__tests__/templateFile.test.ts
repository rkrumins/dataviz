/**
 * A layout template as a file: only the layout travels, and a file that isn't
 * one says why instead of half-importing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ViewLayerConfig } from '@/types/schema'

const { download } = vi.hoisted(() => ({ download: vi.fn() }))
vi.mock('@/services/importExportApiService', () => ({ triggerBrowserDownload: download }))

import { readTemplateFile, saveTemplateFile, templateFileName } from '../templateFile'

const LAYERS: ViewLayerConfig[] = [
    { id: 'src', name: 'Sources', color: '#3b82f6', entityTypes: ['Table'], order: 0, anchorUrn: 'urn:li:dataset:orders', templateLayerId: 'old' },
    { id: 'out', name: 'Outputs', entityTypes: [], order: 1, rules: [{ id: 'r', urnPattern: 'urn:li:dataset:one', priority: 1 }] },
]

function fileOf(content: unknown, name = 't.layout-template.json'): File {
    return new File([typeof content === 'string' ? content : JSON.stringify(content)], name, { type: 'application/json' })
}

function doc(template: Record<string, unknown>, over: Record<string, unknown> = {}) {
    return { format: 'layout-template', formatVersion: 1, exportedAt: '2026-10-18T00:00:00Z', template, ...over }
}

afterEach(() => vi.restoreAllMocks())

describe('templateFile', () => {
    it('names the file after the template', () => {
        expect(templateFileName('Finance — reporting flow!')).toBe('finance-reporting-flow.layout-template.json')
        expect(templateFileName('日本')).toBe('template.layout-template.json')
    })

    it('saves the layout and nothing that names an entity', async () => {
        let blob: Blob | undefined
        vi.spyOn(URL, 'createObjectURL').mockImplementation(b => { blob = b as Blob; return 'blob:x' })
        saveTemplateFile({ name: 'Finance flow', description: 'Where money moves', category: 'finance', layers: LAYERS })

        expect(download).toHaveBeenCalledWith('blob:x', 'finance-flow.layout-template.json')
        const saved = JSON.parse(await blob!.text())
        expect(saved).toMatchObject({
            format: 'layout-template', formatVersion: 1,
            template: { name: 'Finance flow', description: 'Where money moves', category: 'finance' },
        })
        expect(saved.template.layers[0]).not.toHaveProperty('anchorUrn')
        expect(saved.template.layers[0]).not.toHaveProperty('templateLayerId')
        expect(saved.template.layers[1].rules).toEqual([])
    })

    it('reads back what it saved', async () => {
        const read = await readTemplateFile(fileOf(doc({ name: ' Finance flow ', description: '', category: null, layers: LAYERS })))
        expect(read.name).toBe('Finance flow')
        expect(read.description).toBeNull()
        expect(read.layers.map(l => [l.id, l.name, l.entityTypes, l.order])).toEqual([
            ['src', 'Sources', ['Table'], 0],
            ['out', 'Outputs', [], 1],
        ])
        expect(read.layers[0]).not.toHaveProperty('anchorUrn')
    })

    it('gives a layer without an id, or with a taken one, a fresh id', async () => {
        const read = await readTemplateFile(fileOf(doc({
            name: 'Hand-written',
            layers: [{ name: 'One', id: 'a' }, { name: 'Two', id: 'a' }, { name: 'Three', entityTypes: ['Table', 7] }],
        })))
        const ids = read.layers.map(l => l.id)
        expect(ids[0]).toBe('a')
        expect(new Set(ids).size).toBe(3)
        expect(read.layers[2].entityTypes).toEqual(['Table'])
    })

    it.each([
        ['not JSON', '{nope', "This file isn't JSON."],
        ['another kind of file', { format: 'view-bundle', formatVersion: 1 }, "This isn't a layout template file"],
        ['a newer version', doc({ name: 'X', layers: LAYERS }, { formatVersion: 2 }), 'version 2; this app reads version 1'],
        ['no name', doc({ name: ' ', layers: LAYERS }), 'names no template'],
        ['no layers', doc({ name: 'X', layers: [] }), 'has no layers'],
        ['too many layers', doc({ name: 'X', layers: Array.from({ length: 31 }, (_, i) => ({ id: `l${i}`, name: `L${i}` })) }), 'at most 30 layers'],
        ['a nameless layer', doc({ name: 'X', layers: [{ id: 'a', name: '' }] }), 'Every layer in the file needs a name'],
    ])('refuses %s, saying why', async (_case, content, message) => {
        await expect(readTemplateFile(fileOf(content))).rejects.toThrow(message)
    })

    it('refuses a file too large to be a template', async () => {
        const big = fileOf(doc({ name: 'X', layers: LAYERS, padding: 'x'.repeat(300 * 1024) }))
        await expect(readTemplateFile(big)).rejects.toThrow('too large')
    })
})
