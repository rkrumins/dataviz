/**
 * ReadModePicker: the three read modes as cards that explain themselves — the promise, what readers
 * see before, while and after version 6 lands, a worked example, trade-offs and needs — chosen as a
 * radio group; for one graph, a first option that uses the platform's default, naming it; a mode
 * that can't be chosen says why.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ReadModePicker } from './ReadModePicker'

const radio = (name: string | RegExp) => screen.getByRole('radio', { name })

describe('ReadModePicker', () => {
    it('shows each mode with what readers see while version 6 lands, an example, and its trade-offs', () => {
        render(<ReadModePicker value="in_place" defaultMode="in_place" onChange={() => {}} />)
        const group = screen.getByRole('radiogroup', { name: 'What readers get while a new version lands' })
        expect(within(group).getAllByRole('radio').map(r => r.getAttribute('aria-label'))).toEqual([
            'Keep serving, update in place', 'Keep serving, switch when ready', 'Always the latest'])
        const inPlace = radio('Keep serving, update in place')
        expect(inPlace).toHaveAttribute('aria-checked', 'true')
        expect(inPlace).toHaveTextContent('Default')
        expect(inPlace).toHaveTextContent('v5 + parts of v6')
        expect(inPlace).toHaveTextContent(/Example\. An import changes 100,000 items in a graph of 10 million/)
        expect(radio('Keep serving, switch when ready')).toHaveTextContent('Preview')
        expect(radio('Keep serving, switch when ready')).toHaveTextContent('Exactly version 5; version 6 is built alongside')
        const latest = radio('Always the latest')
        expect(within(latest).getByRole('list', { name: 'What readers see' })).toHaveTextContent('database')
        expect(latest).toHaveTextContent('Lineage summaries are missing until the graph store catches up')
    })

    it('chooses a mode', async () => {
        const onChange = vi.fn()
        render(<ReadModePicker value="in_place" onChange={onChange} />)
        await userEvent.click(radio('Always the latest'))
        expect(onChange).toHaveBeenCalledWith('latest')
    })

    it("offers a graph the platform's default first, naming it, and chooses it as null", async () => {
        const onChange = vi.fn()
        render(<ReadModePicker value={null} inheritFrom="beside" onChange={onChange} />)
        const inherit = radio(/Use the platform default/)
        expect(inherit).toHaveAttribute('aria-checked', 'true')
        expect(inherit).toHaveTextContent('Currently Keep serving, switch when ready')
        await userEvent.click(radio('Keep serving, update in place'))
        expect(onChange).toHaveBeenLastCalledWith('in_place')
        await userEvent.click(inherit)
        expect(onChange).toHaveBeenLastCalledWith(null)
    })

    it("says why a mode can't be chosen, and shows a mode's note", () => {
        render(
            <ReadModePicker
                value="in_place"
                onChange={() => {}}
                unavailable={{ beside: 'Your own key is never copied.' }}
                notes={{ latest: <span>Needs room in the database.</span> }}
            />,
        )
        expect(radio('Keep serving, switch when ready')).toBeDisabled()
        expect(screen.getByText('Your own key is never copied.')).toBeInTheDocument()
        expect(screen.getByText('Needs room in the database.')).toBeInTheDocument()
    })
})
