/**
 * Options → Live counts: this browser's setting, on until turned off, and
 * no request option — Reset defaults and the header's badge leave it be.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useSearchStore } from '@/store/searchStore'

import { LIVE_COUNTS_KEY } from '../counts/liveCounts'
import { OptionsPanel } from '../OptionsPanel'


describe('OptionsPanel — Live counts', () => {
    beforeEach(() => {
        localStorage.clear()
        useSearchStore.getState().clear()
    })

    it('is on until turned off, remembered, and no request option', () => {
        render(<OptionsPanel knownEntityTypes={[]} knownPropertyKeys={[]} />)
        const live = screen.getByRole('checkbox', { name: /^Live counts/ })
        expect(live).toBeChecked()

        fireEvent.click(live)
        expect(live).not.toBeChecked()
        expect(localStorage.getItem(LIVE_COUNTS_KEY)).toBe('off')
        expect(useSearchStore.getState().draftOptions).toBeNull()
        expect(screen.queryByRole('button', { name: 'Reset defaults' })).not.toBeInTheDocument()

        fireEvent.click(live)
        expect(localStorage.getItem(LIVE_COUNTS_KEY)).toBeNull()
    })
})
