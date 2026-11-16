/**
 * Each versioned-graph setting as a destination of the app-wide palette: found by its label, its
 * key, its env var, the words people use for it and the problems it answers, and opened at its row
 * in Admin → Versioned graphs → Settings (`#reads-mode`).
 *
 * The registry's catalogue is large, so it is imported only once someone searches, as the docs
 * index is; the palette's own bundle stays as light as `pageIndex` keeps it. Each entry is gated
 * as the section is.
 */
import type { PageEntry } from './pageIndex'

export async function loadSettingEntries(): Promise<PageEntry[]> {
    const { default: catalogue } = await import('@/generated/versionedGraphSettings.json')
    return catalogue.settings.map((s) => ({
        id: `setting-${s.key}`,
        category: 'Setting',
        title: s.label,
        description: s.guidance.summary,
        keywords: [s.key, s.default.env ?? '', s.question, ...s.guidance.aliases, ...s.guidance.symptoms].filter(Boolean),
        path: `/admin/versioned-graphs?tab=settings#${s.key.replaceAll('.', '-').toLowerCase()}`,
        gate: { kind: 'admin', key: 'versioned-graphs' },
    }))
}
