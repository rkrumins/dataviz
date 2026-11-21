/**
 * The clarification card: the readings as a radio group with their counts (arrow keys move the
 * choice), Remember for this data source, Continue once something is chosen, and "Something
 * else…" in the person's own words. Answered, it says what was chosen and asks no more.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Clarification } from '../api/types'
import { ClarificationCard } from '../components/blocks/ClarificationCard'

const PII: Clarification = {
    id: 'clr_1',
    question: 'There’s no property called “PII”. Which of these means PII here?',
    concept: 'PII',
    options: [
        { id: 'opt_1', label: 'Tag “pii”', description: 'on 312 columns', count: 312 },
        { id: 'opt_2', label: 'personal_data is true', description: 'property on 290 columns', count: 290 },
        { id: 'opt_3', label: 'Either of these', description: '340 columns', count: 340 },
    ],
    allowRemember: true,
    allowOther: true,
}

describe('ClarificationCard', () => {
    it('offers the readings as a radio group, with how many each finds', () => {
        render(<ClarificationCard data={PII} onAnswer={vi.fn()} onOther={vi.fn()} />)
        const group = screen.getByRole('radiogroup', { name: PII.question })
        const radios = screen.getAllByRole('radio')
        expect(group).toContainElement(radios[0])
        expect(radios).toHaveLength(3)
        expect(radios[0]).toHaveTextContent('Tag “pii”')
        expect(radios[0]).toHaveTextContent('312')
        expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false'])
        // Tab enters the group at its first reading.
        expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1])
        expect(screen.getByText('PII')).toBeInTheDocument()
    })

    it('continues only once a reading is chosen, with whether to remember it', () => {
        const onAnswer = vi.fn()
        render(<ClarificationCard data={PII} onAnswer={onAnswer} />)
        const go = screen.getByRole('button', { name: 'Continue' })
        expect(go).toBeDisabled()
        fireEvent.click(screen.getByRole('radio', { name: /personal_data is true/ }))
        expect(screen.getByRole('radio', { name: /personal_data is true/ })).toHaveAttribute('aria-checked', 'true')
        fireEvent.click(screen.getByRole('checkbox', { name: 'Remember for this data source' }))
        fireEvent.click(go)
        expect(onAnswer).toHaveBeenCalledWith({ optionId: 'opt_2', label: 'personal_data is true', remember: true })
    })

    it('moves the choice with the arrow keys, wrapping round', () => {
        render(<ClarificationCard data={PII} onAnswer={vi.fn()} />)
        const radios = screen.getAllByRole('radio')
        radios[0].focus()
        fireEvent.keyDown(radios[0], { key: 'ArrowDown' })
        expect(radios[1]).toHaveAttribute('aria-checked', 'true')
        expect(radios[1]).toHaveFocus()
        fireEvent.keyDown(radios[1], { key: 'ArrowUp' })
        fireEvent.keyDown(radios[0], { key: 'ArrowUp' })
        expect(radios[2]).toHaveAttribute('aria-checked', 'true')
    })

    it('sends "something else" in the person’s own words', () => {
        const onOther = vi.fn()
        render(<ClarificationCard data={PII} onAnswer={vi.fn()} onOther={onOther} />)
        fireEvent.click(screen.getByRole('button', { name: 'Something else…' }))
        const input = screen.getByRole('textbox', { name: 'What you meant, in your own words' })
        fireEvent.change(input, { target: { value: 'columns classified as sensitive' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        expect(onOther).toHaveBeenCalledWith('columns classified as sensitive')
    })

    it('offers neither remembering nor something else when the question doesn’t', () => {
        render(<ClarificationCard data={{ ...PII, allowRemember: false, allowOther: false }} onAnswer={vi.fn()} onOther={vi.fn()} />)
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Something else…' })).not.toBeInTheDocument()
    })

    it('once answered, says what was chosen and asks no more', () => {
        render(<ClarificationCard data={{ ...PII, answered: true, chosen: 'opt_1' }} onAnswer={vi.fn()} />)
        expect(screen.getByText('Tag “pii”')).toBeInTheDocument()
        expect(screen.queryByRole('radio')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()
    })
})
