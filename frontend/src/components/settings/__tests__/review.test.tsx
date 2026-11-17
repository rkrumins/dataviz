/**
 * The save model's pieces: the save bar says what is staged and offers Review and Discard; the
 * review shows each change from → to and saves only with a reason and every warning acknowledged;
 * a conflict offers to re-apply; the switch is the app's own Business / Technical view, and the
 * lens follows it wherever it is changed.
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
        const title = (id: string) => SETTINGS_BY_KEY['reads.mode'].choices.find((c) => c.id === id)!.title
        expect(changes[0]).toHaveTextContent(`From ${title('in_place')}to ${title('latest')}`)
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

    it('waits for what the change does before it saves, and saves without it only when told to', async () => {
        const user = userEvent.setup()
        const props = { open: true, onOpenChange: () => {}, items: ITEMS, onSave: vi.fn() }
        const { rerender } = render(<ChangeReviewDialog {...props} impactLoading />)
        const dialog = screen.getByRole('dialog', { name: 'Review 2 changes' })
        await user.type(within(dialog).getByRole('textbox', { name: /Why are you making this change/ }), 'Imports were slowing canvases')
        const save = within(dialog).getByRole('button', { name: 'Save 2 changes' })
        expect(save).toBeDisabled()
        expect(dialog).toHaveTextContent('Save waits for what this changes.')

        // It couldn't be worked out: its warnings aren't known, so saving without them is a choice.
        rerender(<ChangeReviewDialog {...props} impactFailed impact={<p>Couldn’t work out what this changes.</p>} />)
        expect(save).toBeDisabled()
        expect(dialog).toHaveTextContent('Acknowledge the warning to save.')
        const unseen = () => within(dialog).getByRole('checkbox', { name: /Save without seeing what this changes/ })
        await user.click(unseen())
        expect(save).toBeEnabled()

        // Trying again asks again.
        rerender(<ChangeReviewDialog {...props} impactLoading />)
        expect(save).toBeDisabled()
        rerender(<ChangeReviewDialog {...props} impactFailed impact={<p>Couldn’t work out what this changes.</p>} />)
        expect(unseen()).not.toBeChecked()
        expect(save).toBeDisabled()
        // Answered: nothing more to acknowledge.
        rerender(<ChangeReviewDialog {...props} impact={<p>Nothing else changes.</p>} />)
        expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument()
        expect(save).toBeEnabled()
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
    it('is the app’s own Business or Technical switch: choosing a view sets the persona', async () => {
        act(() => usePersonaStore.setState({ mode: 'business' }))
        const { container } = render(<LensSwitch />)
        const group = screen.getByRole('radiogroup', { name: 'Business or Technical view' })
        expect(within(group).getByRole('radio', { name: 'Business' })).toHaveAttribute('aria-checked', 'true')
        const says = container.querySelector('p')!
        const business = says.textContent
        expect(business).not.toBe('')

        await userEvent.click(within(group).getByRole('radio', { name: 'Technical' }))
        expect(usePersonaStore.getState().mode).toBe('technical')
        expect(within(group).getByRole('radio', { name: 'Technical' })).toHaveAttribute('aria-checked', 'true')
        // A line, on screen and not only in the hover tip, says what the view changes here.
        expect(says.textContent).not.toBe(business)
    })

    it('follows a persona change made elsewhere (the top bar, ⌘/), and its setter sets the persona', () => {
        act(() => usePersonaStore.setState({ mode: 'business' }))
        const { result } = renderHook(() => useLens())
        expect(result.current[0]).toBe('business')
        act(() => usePersonaStore.getState().toggleMode())
        expect(result.current[0]).toBe('operator')

        act(() => result.current[1]('business'))
        expect(usePersonaStore.getState().mode).toBe('business')
        act(() => result.current[1]('operator'))
        expect(usePersonaStore.getState().mode).toBe('technical')
    })
})
