/**
 * The profile picker: the profiles offered at this level as one radio group, each told as an
 * outcome; a preview of what the chosen one would change here; Apply stages only what this person
 * may set, one value at a time, and never saves; then a summary of what was staged and what was
 * left out, and why. The Business view lists the business profiles first. Words come from the
 * catalogue and `skipWords`, not copied here.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CATALOGUE } from '../catalogue'
import { GRAPH_VALUES, PLATFORM_VALUES } from '../__fixtures__/resolved'
import { SETTINGS_BY_KEY as S } from '../__fixtures__/schema'
import { ProfilePicker } from '../ProfilePicker'
import { skipWords } from '../profiles'

const P = Object.fromEntries(CATALOGUE.profiles.map((p) => [p.id, p]))

function renderPicker(props: Partial<Parameters<typeof ProfilePicker>[0]> = {}) {
    const onStage = vi.fn()
    const onClose = vi.fn()
    render(<ProfilePicker profiles={CATALOGUE.profiles} scope="graph" editor="workspace_admin" resolved={GRAPH_VALUES}
        onStage={onStage} onClose={onClose} {...props} />)
    return { onStage, onClose, user: userEvent.setup() }
}

describe('ProfilePicker', () => {
    it('offers the profiles that apply at this level, each with its promise, when, caution and audience', () => {
        renderPicker()
        const group = screen.getByRole('radiogroup', { name: 'Profiles' })
        const radios = within(group).getAllByRole('radio')
        const offered = CATALOGUE.profiles.filter((p) => p.scopes.includes('graph'))
        expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(offered.map((p) => p.title))
        expect(radios[0]).toHaveAttribute('aria-checked', 'true')
        const fastest = within(group).getByRole('radio', { name: P['fastest-reads'].title })
        expect(fastest).toHaveAccessibleDescription(`${P['fastest-reads'].promise} What you give up: ${P['fastest-reads'].caution}`)
        for (const w of P['fastest-reads'].when) expect(fastest).toHaveTextContent(w)
        // Whom each is for, in the app's own views' words.
        expect(fastest).toHaveTextContent('Business')
        expect(within(group).getByRole('radio', { name: P['least-memory'].title })).toHaveTextContent('Technical')
        expect(group).not.toHaveTextContent('Operator')
        // Not offered here, and said so: Big import tonight is the platform's.
        expect(screen.getByText(new RegExp(`Not offered for this graph: ${P['big-import-tonight'].title}`))).toBeInTheDocument()
    })

    it('lists the business profiles first in the Business view, and keeps the order it is given in the Technical one', () => {
        // Given the technical profiles first, so the Business view has something to reorder.
        const given = [...CATALOGUE.profiles].sort((a, b) => Number(a.audience === 'business') - Number(b.audience === 'business'))
        const shown = () => within(screen.getByRole('radiogroup', { name: 'Profiles' })).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))
        const { unmount } = render(<ProfilePicker profiles={given} scope="platform" editor="system_admin" resolved={PLATFORM_VALUES}
            onStage={() => {}} onClose={() => {}} lens="business" />)
        const business = given.filter((p) => p.audience === 'business')
        expect(business.length).toBeGreaterThan(0)
        expect(shown()).toEqual([...business, ...given.filter((p) => p.audience !== 'business')].map((p) => p.title))
        // The first offered is the one chosen: a business profile.
        expect(screen.getByRole('radio', { name: business[0].title })).toHaveAttribute('aria-checked', 'true')
        unmount()

        render(<ProfilePicker profiles={given} scope="platform" editor="system_admin" resolved={PLATFORM_VALUES}
            onStage={() => {}} onClose={() => {}} lens="operator" />)
        expect(shown()).toEqual(given.map((p) => p.title))
    })

    it('previews what the chosen profile would change here, and what it leaves out and why', async () => {
        const { user } = renderPicker()
        await user.click(screen.getByRole('radio', { name: P['fastest-reads'].title }))
        const preview = screen.getByRole('region', { name: `What ${P['fastest-reads'].title} would change for this graph` })
        expect(within(preview).getByRole('figure', { name: `What ${P['fastest-reads'].title} trades here` })).toBeInTheDocument()
        expect(preview).toHaveTextContent('Will be staged · 2')
        // From the graph's own choice (in force as update in place while builds are off) to the profile's.
        const mode = S['reads.mode']
        const title = (id: string) => mode.choices.find((c) => c.id === id)!.title
        expect(within(preview).getByText(mode.label).closest('li')).toHaveTextContent(`${title('beside')} to ${title('in_place')}`)
        expect(preview).toHaveTextContent(
            `${skipWords('not_here', 'graph')}: ${S['updates.statementTargetMs'].label}, ${S['updates.pacingRatio'].label}`)
    })

    it('stages only what this person may set here, one value at a time, then says what it did', async () => {
        const { user, onStage, onClose } = renderPicker()
        await user.click(screen.getByRole('radio', { name: P['fastest-reads'].title }))
        await user.click(screen.getByRole('button', { name: `Apply ${P['fastest-reads'].title}` }))
        expect(onStage.mock.calls).toEqual([['reads.mode', 'in_place'], ['reads.maxVersionsBehind', 'unlimited']])
        const summary = screen.getByRole('heading', { name: `${P['fastest-reads'].title}: 2 changes staged for this graph` })
        expect(summary).toHaveFocus()
        const region = screen.getByRole('region', { name: summary.textContent! })
        expect(region).toHaveTextContent('Staged · 2')
        expect(region).toHaveTextContent('Left out · 2')
        expect(region).toHaveTextContent(skipWords('not_here', 'graph'))
        expect(onClose).not.toHaveBeenCalled()
        await user.click(screen.getByRole('button', { name: 'Done' }))
        expect(onClose).toHaveBeenCalledOnce()
    })

    it('says who may set what it can’t stage, and offers no Apply when nothing would change', async () => {
        const { user, onStage } = renderPicker()
        await user.click(screen.getByRole('radio', { name: P['balanced'].title }))
        expect(screen.getByText(`${skipWords('system_admin_only', 'graph')}:`).closest('li')).toHaveTextContent(S['residency.class'].label)
        // This graph is already Coldline, and nothing else of Least memory is set on a graph.
        await user.click(screen.getByRole('radio', { name: P['least-memory'].title }))
        expect(screen.getByText(/Already like this · 1/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: `Apply ${P['least-memory'].title}` })).toBeDisabled()
        expect(screen.getByText('Nothing to stage here.')).toBeInTheDocument()
        expect(onStage).not.toHaveBeenCalled()
    })

    it('moves the choice with the arrow keys, and Cancel hands back without staging', async () => {
        const { user, onStage, onClose } = renderPicker({ scope: 'platform', editor: 'system_admin', resolved: PLATFORM_VALUES })
        const radios = screen.getAllByRole('radio')
        expect(radios).toHaveLength(CATALOGUE.profiles.length)
        radios[0].focus()
        await user.keyboard('{ArrowDown}')
        expect(radios[1]).toHaveFocus()
        expect(radios[1]).toHaveAttribute('aria-checked', 'true')
        await user.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(onClose).toHaveBeenCalledOnce()
        expect(onStage).not.toHaveBeenCalled()
    })
})
