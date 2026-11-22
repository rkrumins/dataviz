/**
 * Admin → Versioned graphs → Settings in the Business view: every setting is asked as a plain
 * question, the platform team's tuning among them, so each row is named by its question. The
 * questions come from the registry's generated catalogue.
 */
import { screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CATALOGUE } from '@/components/settings'
import { usePersonaStore } from '@/store/persona'
import { AdminVersionedGraphs } from '..'
import { mockApi, renderWithApi } from './helpers'

const SETTINGS = '/admin/versioned-graphs?tab=settings'

beforeEach(() => usePersonaStore.setState({ mode: 'business' }))
afterEach(() => usePersonaStore.setState({ mode: 'technical' }))

describe('Settings in the Business view', () => {
    it('names every setting’s row by its question', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await screen.findByRole('article', { name: CATALOGUE.settings[0].question })
        for (const s of CATALOGUE.settings) {
            expect(screen.getByRole('article', { name: s.question })).toBeInTheDocument()
        }
    })
})
