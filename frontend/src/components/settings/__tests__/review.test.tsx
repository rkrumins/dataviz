/**
 * The save model's pieces: the save bar says what is staged and offers Review and Discard; the
 * review shows each change from → to and saves only with a reason and every warning acknowledged;
 * a conflict offers to re-apply; the lens opens on the app's business / technical view.
 */
import { act, render, renderHook, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { usePersonaStore } from '@/store/persona'
import { SCHEMA, SETTINGS_BY_KEY } from '../__fixtures__/schema'
import { GRAPH_VALUES } from '../__fixtures__/resolved'
import { ChangeReviewDialog } from '../ChangeReviewDialog'
import { useLens } from '../lens'
import { LensSwitch } from '../LensSwitch'
import { reviewItems } from '../review'
import { StickySaveBar } from '../StickySaveBar'
import { diffStaged } from '../useStagedChanges'

const ITEMS = reviewItems(
    diffStaged({ 'reads.mode': { value: null, version: 3 }, 'imports.guardDeleteShare': { value: 0.4, version: 3 } }, GRAPH_VALUES, 'graph'),
    SETTINGS_BY_KEY, GRAPH_VALUES, 'graph',
)

describe('StickySaveBar', () => {
    it('says how many changes are staged, politely, and offers Review and Discard', async () => {
        const onReview = vi.fn()
        const onDiscard = vi.fn()
        const { rerender } = render(<StickySaveBar count={0} onReview={onReview} onDiscard={onDiscard} />)
        expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toHaveClass('invisible')
        rerender(<StickySaveBar count={2} onReview={onReview} onDiscard={onDiscard} />)
        const bar = screen.getByRole('region', { name: 'Unsaved changes' })
        expect(bar).toHaveClass('visible')
        expect(bar).toHaveTextContent('2 changes not saved yet')
        expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('2 changes not saved yet.')
        await userEvent.click(within(bar).getByRole('button', { name: 'Review changes' }))
        await userEvent.click(within(bar).getByRole('button', { name: 'Discard' }))
        expect(onReview).toHaveBeenCalled()
        expect(onDiscard).toHaveBeenCalled()
    })

    it('holds Review while a staged value needs a fix', () => {
        render(<StickySaveBar count={1} problems={1} onReview={() => {}} onDiscard={() => {}} />)
        expect(screen.getByRole('button', { name: 'Review changes' })).toBeDisabled()
        expect(screen.getByRole('region', { name: 'Unsaved changes' })).toHaveTextContent('1 to fix')
    })
})

describe('ChangeReviewDialog', () => {
    it('lists each change from → to, and saves only with a reason and the warnings acknowledged', async () => {
        const user = userEvent.setup()
        const onSave = vi.fn()
        render(
            <ChangeReviewDialog open onOpenChange={() => {}} items={ITEMS} where="this graph" dimensions={SCHEMA.dimensions}
                impact={<p>3 graphs read from the database while they update.</p>}
                warnings={[{ id: 'db', text: 'Readers of 3 graphs will read from the database while they update.' }]}
                onSave={onSave} />,
        )
        const dialog = screen.getByRole('dialog', { name: 'Review 2 changes to this graph' })
        const changes = within(dialog).getAllByRole('listitem').filter((li) => li.parentElement?.tagName === 'OL')
        expect(changes[0]).toHaveTextContent('Read mode')
        expect(changes[0]).toHaveTextContent('From Keep serving, update in placeto Always the latest')
        expect(changes[0]).toHaveTextContent('Use the platform’s value')
        expect(changes[1]).toHaveTextContent('From 30%to 40%')
        expect(within(changes[1]).getByRole('list', { name: `What changing ${SETTINGS_BY_KEY['imports.guardDeleteShare'].label} does` })).toBeInTheDocument()
        expect(dialog).toHaveTextContent('3 graphs read from the database while they update.')

        const save = within(dialog).getByRole('button', { name: 'Save 2 changes' })
        expect(save).toBeDisabled()
        await user.type(within(dialog).getByRole('textbox', { name: /Why are you making this change/ }), 'Imports were slowing canvases')
        expect(save).toBeDisabled()
        expect(dialog).toHaveTextContent('Acknowledge the warning to save.')
        await user.click(within(dialog).getByRole('checkbox'))
        expect(save).toBeEnabled()
        await user.click(save)
        expect(onSave).toHaveBeenCalledWith('Imports were slowing canvases')
    })

    it('offers to reload and re-apply after a conflict', async () => {
        const onReapply = vi.fn()
        render(<ChangeReviewDialog open onOpenChange={() => {}} items={ITEMS} onSave={() => {}}
            error="Someone changed Read mode while you were editing." onReapply={onReapply} />)
        expect(screen.getByRole('alert')).toHaveTextContent('Someone changed Read mode while you were editing.')
        await userEvent.click(screen.getByRole('button', { name: 'Reload and re-apply my changes' }))
        expect(onReapply).toHaveBeenCalled()
    })
})

describe('LensSwitch', () => {
    it('opens on the persona’s view, and switching it changes only this page', async () => {
        act(() => usePersonaStore.setState({ mode: 'business' }))
        const { result } = renderHook(() => useLens())
        expect(result.current[0]).toBe('business')
        act(() => usePersonaStore.setState({ mode: 'technical' }))
        const { result: technical } = renderHook(() => useLens())
        expect(technical.current[0]).toBe('operator')

        const onChange = vi.fn()
        render(<LensSwitch value="operator" onChange={onChange} />)
        const group = screen.getByRole('radiogroup', { name: 'Show settings for' })
        expect(within(group).getByRole('radio', { name: 'Operator' })).toHaveAttribute('aria-checked', 'true')
        await userEvent.click(within(group).getByRole('radio', { name: 'Business' }))
        expect(onChange).toHaveBeenCalledWith('business')
        expect(usePersonaStore.getState().mode).toBe('technical')
    })
})
