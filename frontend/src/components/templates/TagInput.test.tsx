import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TagInput } from './TagInput'

function setup(initial: string[] = []) {
    const onChange = vi.fn()
    const utils = render(<TagInput value={initial} onChange={onChange} />)
    const input = utils.container.querySelector('input') as HTMLInputElement
    return { ...utils, onChange, input }
}

describe('TagInput', () => {
    it('adds a tag on Enter', async () => {
        const { onChange, input } = setup()
        await userEvent.type(input, 'etl{Enter}')
        expect(onChange).toHaveBeenCalledWith(['etl'])
    })

    it('adds a tag on comma', async () => {
        const { onChange, input } = setup()
        await userEvent.type(input, 'lineage,')
        expect(onChange).toHaveBeenCalledWith(['lineage'])
    })

    it('rejects duplicate tags', async () => {
        const { onChange, input } = setup(['etl'])
        await userEvent.type(input, 'etl{Enter}')
        expect(onChange).not.toHaveBeenCalled()
    })

    it('removes the last tag on Backspace when input is empty', async () => {
        const { onChange, input } = setup(['etl', 'lineage'])
        input.focus()
        await userEvent.keyboard('{Backspace}')
        expect(onChange).toHaveBeenCalledWith(['etl'])
    })

    it('removes a tag when its × button is clicked', async () => {
        const { onChange } = setup(['etl', 'lineage'])
        const removeButtons = screen.getAllByRole('button', { name: /remove/i })
        await userEvent.click(removeButtons[0])
        expect(onChange).toHaveBeenCalledWith(['lineage'])
    })

    it('lowercases the committed tag', async () => {
        const { onChange, input } = setup()
        await userEvent.type(input, 'WAREHOUSE{Enter}')
        expect(onChange).toHaveBeenCalledWith(['warehouse'])
    })
})
