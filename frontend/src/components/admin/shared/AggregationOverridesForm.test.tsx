/**
 * Rollup storage is the one control here whose absent state is NOT its
 * off state.
 *
 * `materializeFinePairs` has three meanings — `true`, `'auto'`, and absent —
 * and absent means INHERIT: the stored global default, then the env default,
 * which ships as full detail. Every test below exists because treating absent
 * as Auto put the form and the job it queued into disagreement.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import {
    AggregationOverridesForm,
    CONFIG_PRESETS,
    type AggregationOverridesValue,
} from './AggregationOverridesForm'

const BASE: AggregationOverridesValue = {
    batchSize: 5000,
    projectionMode: 'in_source',
    maxRetries: 3,
    timeoutMinutes: 180,
}

/** Presets and the tuning knobs share one disclosure. */
function disclosure() {
    return screen.getByRole('button', { name: /Fine-Tune Performance/ })
}

async function openAdvanced() {
    await userEvent.click(disclosure())
}

/** The active profile is named inside the disclosure's own label; when
 *  nothing matches, no name is shown at all. */
function activeProfile() {
    return (disclosure().textContent ?? '')
        .replace('Fine-Tune Performance', '')
        .replace('Optional', '')
}

function renderForm(
    value: Partial<AggregationOverridesValue>,
    defaultFinePairs?: 'auto' | 'true' | 'false',
) {
    const onChange = vi.fn()
    render(
        <AggregationOverridesForm
            value={{ ...BASE, ...value }}
            onChange={onChange}
            defaultFinePairs={defaultFinePairs}
        />,
    )
    return onChange
}

const selected = (name: RegExp) =>
    screen.getByRole('radio', { name }).getAttribute('aria-checked')

describe('rollup storage', () => {
    it('an absent key shows the default the job would actually run', async () => {
        // The defect this guards: with no tuning of its own the form used to
        // render "Auto" unconditionally, over a job the server resolves to
        // full detail. The control claimed one thing, the run did another.
        renderForm({ tuning: {} }, 'true')
        await openAdvanced()
        expect(selected(/^Always full detail/)).toBe('true')
        expect(selected(/^Auto/)).toBe('false')
    })

    it('an absent key follows the default the other way too', async () => {
        renderForm({ tuning: {} }, 'auto')
        await openAdvanced()
        expect(selected(/^Auto/)).toBe('true')
    })

    it('an explicit choice always beats the default', async () => {
        renderForm({ tuning: { materializeFinePairs: 'auto' } }, 'true')
        await openAdvanced()
        expect(selected(/^Auto/)).toBe('true')
    })

    it('picking Auto sends a value rather than dropping the key', async () => {
        // Dropping it means "inherit", and inheritance cannot walk back a
        // stored global of `true`: the server layers the request over the
        // stored defaults and drops undefined, so the global would win.
        const onChange = renderForm({ tuning: { materializeFinePairs: true } }, 'true')
        await openAdvanced()
        await userEvent.click(screen.getByRole('radio', { name: /^Auto/ }))

        const next = onChange.mock.calls.at(-1)![0]
        expect(next.tuning.materializeFinePairs).toBe('auto')
        expect('materializeFinePairs' in next.tuning).toBe(true)
    })

    it('picking full detail sends true', async () => {
        const onChange = renderForm({ tuning: { materializeFinePairs: 'auto' } }, 'auto')
        await openAdvanced()
        await userEvent.click(screen.getByRole('radio', { name: /^Always full detail/ }))
        expect(onChange.mock.calls.at(-1)![0].tuning.materializeFinePairs).toBe(true)
    })
})

describe('performance presets', () => {
    it('a preset keeps the rollup storage choice it does not own', async () => {
        // `applyPreset` replaces `tuning` wholesale and no preset carries a
        // storage choice, so without this, picking a profile would quietly
        // discard an explicit Auto and hand the job back to the fleet default.
        const onChange = renderForm({ tuning: { materializeFinePairs: 'auto', scanRangeWidth: 999_000 } })
        await openAdvanced()
        await userEvent.click(screen.getByRole('button', { name: /^Balanced/ }))

        const next = onChange.mock.calls.at(-1)![0]
        expect(next.tuning.materializeFinePairs).toBe('auto')
        // …while still applying everything the preset DOES own.
        expect(next.tuning.scanRangeWidth).toBe(200_000)
    })

    it('a profile still reads as active once a storage choice is present', () => {
        // Regression: `materializeFinePairs` used to sit in the preset-match
        // key list. Once Auto became a value rather than an omission, no form
        // could ever equal a preset that carries nothing, and the active-profile
        // name went permanently dark.
        const balanced = CONFIG_PRESETS.find(p => p.id === 'balanced')!
        renderForm({
            maxRetries: balanced.maxRetries,
            timeoutMinutes: balanced.timeoutMinutes,
            tuning: { ...balanced.tuning, materializeFinePairs: 'auto' },
        })
        expect(activeProfile()).toMatch(/Balanced/)
    })

    it('and a form that matches no profile still names none', () => {
        // The other half: the assertion above would pass on a component that
        // named a profile unconditionally.
        renderForm({ tuning: { scanRangeWidth: 999_000 } })
        expect(activeProfile()).not.toMatch(/Balanced|Conservative|Performance/)
    })
})
