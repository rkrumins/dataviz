/**
 * Staging one value redraws that setting's row, not the page's 48: rows are memoised on what they
 * show, and the callbacks they get keep their identity. Counted at the kit's SettingRow.
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CATALOGUE, type SettingRowProps } from '@/components/settings'
import { AdminVersionedGraphs } from '..'
import { mockApi, renderWithApi } from './helpers'

const renders = vi.hoisted(() => new Map<string, number>())

vi.mock('@/components/settings/SettingRow', async () => {
    const actual = await vi.importActual<typeof import('@/components/settings/SettingRow')>('@/components/settings/SettingRow')
    return {
        ...actual,
        SettingRow: (props: SettingRowProps) => {
            renders.set(props.setting.key, (renders.get(props.setting.key) ?? 0) + 1)
            return actual.SettingRow(props)
        },
    }
})

const S = Object.fromEntries(CATALOGUE.settings.map((s) => [s.key, s]))

describe('Settings rows', () => {
    it('redraw only the row whose value is staged', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: '/admin/versioned-graphs?tab=settings' })
        const reads = within(await screen.findByRole('article', { name: S['reads.mode'].label }))
        expect(renders.size).toBe(CATALOGUE.settings.length)

        const before = new Map(renders)
        await userEvent.click(reads.getByRole('radio', { name: S['reads.mode'].choices.find((c) => c.id === 'in_place')!.title }))
        // Wait for the server's quick answer too: it reaches only the staged row.
        await reads.findByText(/^Once saved:/)

        const redrawn = [...renders].filter(([key, n]) => n !== before.get(key)).map(([key]) => key)
        expect(redrawn).toEqual(['reads.mode'])
    })
})
