/**
 * templateFile — a layout template as a file: saved from the library to hand
 * to another team or installation, read back to add it to a library.
 *
 * Only the layout travels: name, description, category and layers. Who could
 * use it, its shares, its versions and the views built from it stay behind,
 * and nothing that names an entity of some graph (`templateLayers`).
 */
import { generateId } from '@/lib/utils'
import { triggerBrowserDownload } from '@/services/importExportApiService'
import type { LayoutTemplate } from '@/services/layoutTemplateService'
import type { ViewLayerConfig } from '@/types/schema'
import { templateLayers } from './fromView'

export const TEMPLATE_FILE_FORMAT = 'layout-template'
const MAX_BYTES = 256 * 1024
const MAX_LAYERS = 30

export interface TemplateFileContent {
    name: string
    description: string | null
    category: string | null
    layers: ViewLayerConfig[]
}

export interface TemplateFile {
    format: typeof TEMPLATE_FILE_FORMAT
    formatVersion: 1
    exportedAt: string
    template: TemplateFileContent
}

/** "Finance flow" → "finance-flow.layout-template.json". */
export function templateFileName(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        .slice(0, 60).replace(/-+$/g, '')
    return `${slug || 'template'}.layout-template.json`
}

/** Hand the browser the template to save. */
export function saveTemplateFile(t: Pick<LayoutTemplate, 'name' | 'description' | 'category' | 'layers'>): void {
    const file: TemplateFile = {
        format: TEMPLATE_FILE_FORMAT,
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        template: {
            name: t.name, description: t.description ?? null, category: t.category ?? null,
            layers: templateLayers(t.layers),
        },
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }))
    triggerBrowserDownload(url, templateFileName(t.name))
    // Some browsers read the object URL after click() returns; release it once they're done.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** The template in `file`, ready to create — or an error that says why it isn't one. */
export async function readTemplateFile(file: File): Promise<TemplateFileContent> {
    if (file.size > MAX_BYTES) throw new Error('This file is too large to be a layout template.')
    const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(new Error("The file couldn't be read."))
        reader.readAsText(file)
    })
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        throw new Error("This file isn't JSON.")
    }
    const doc = parsed as Partial<TemplateFile> | null
    if (!doc || typeof doc !== 'object' || doc.format !== TEMPLATE_FILE_FORMAT) {
        throw new Error("This isn't a layout template file — export one from a template's menu in the library.")
    }
    if (doc.formatVersion !== 1) {
        throw new Error(`This template file is version ${String(doc.formatVersion)}; this app reads version 1.`)
    }
    const t = doc.template
    if (!t || typeof t.name !== 'string' || !t.name.trim()) throw new Error('The file names no template.')
    if (!Array.isArray(t.layers) || t.layers.length === 0) throw new Error('The template in this file has no layers.')
    if (t.layers.length > MAX_LAYERS) {
        throw new Error(`A template has at most ${MAX_LAYERS} layers; this one has ${t.layers.length}.`)
    }
    if (t.layers.some(l => !l || typeof l !== 'object' || typeof l.name !== 'string' || !l.name.trim())) {
        throw new Error('Every layer in the file needs a name.')
    }
    // A layer keeps the file's id unless it has none or another layer took it.
    const taken = new Set<string>()
    const layers = t.layers.map((l, i): ViewLayerConfig => {
        const id = typeof l.id === 'string' && l.id && !taken.has(l.id) ? l.id : generateId()
        taken.add(id)
        return {
            ...l,
            id,
            name: l.name.trim().slice(0, 80),
            entityTypes: Array.isArray(l.entityTypes) ? l.entityTypes.filter((e): e is string => typeof e === 'string') : [],
            order: i,
        }
    })
    return {
        name: t.name.trim().slice(0, 80),
        description: typeof t.description === 'string' && t.description.trim() ? t.description.trim().slice(0, 500) : null,
        category: typeof t.category === 'string' && t.category.trim() ? t.category.trim().slice(0, 40) : null,
        layers: templateLayers(layers),
    }
}
