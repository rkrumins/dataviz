/**
 * Each versioned-graph setting in the palette opens its own row: the link's anchor is the one the
 * settings page gives the row, and the entry is gated as the section is.
 */
import { describe, expect, it } from 'vitest'
import { settingAnchor } from '@/components/settings/format'
import catalogue from '@/generated/versionedGraphSettings.json'
import { loadSettingEntries } from '../settingsPaletteIndex'

describe('loadSettingEntries', () => {
    it('offers every setting, opening Settings at its row, behind the section’s gate', async () => {
        const entries = await loadSettingEntries()
        expect(entries.map((e) => e.title)).toEqual(catalogue.settings.map((s) => s.label))
        catalogue.settings.forEach((s, i) => {
            expect(entries[i].path).toBe(`/admin/versioned-graphs?tab=settings#${settingAnchor(s.key)}`)
            expect(entries[i].gate).toEqual({ kind: 'admin', key: 'versioned-graphs' })
        })
    })

    it('finds a setting by its key, its env var and the problems it answers', async () => {
        const s = catalogue.settings.find((x) => x.key === 'reads.mode')!
        const entry = (await loadSettingEntries()).find((e) => e.id === 'setting-reads.mode')!
        expect(entry.keywords).toEqual(expect.arrayContaining([s.key, s.default.env, ...s.guidance.symptoms]))
    })
})
