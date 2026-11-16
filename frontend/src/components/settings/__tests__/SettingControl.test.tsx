/**
 * SettingControl draws the right input for each kind, offers only the choices allowed at the
 * scope, shows an inherited value as inherited, and reports values in the stored shape: words
 * ("unlimited", "forever") as words, identifiers and refusal budgets in their syntax. Labels come
 * from the registry's catalogue.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SETTINGS_BY_KEY as S } from '../__fixtures__/schema'
import { GRAPH_VALUES, PLATFORM_VALUES, WORKSPACE_VALUES } from '../__fixtures__/resolved'
import { SettingControl } from '../SettingControl'
import type { ResolvedValues, Scope, SettingValue } from '../types'

function setup(key: string, values: ResolvedValues, scope: Scope, value?: SettingValue | null) {
    const onChange = vi.fn()
    const r = values[key]
    const own = value !== undefined ? value : r.trail.find((t) => t.scope === scope)?.value ?? null
    render(<SettingControl setting={S[key]} value={own} onChange={onChange} resolved={r} scope={scope} />)
    return onChange
}

describe('SettingControl', () => {
    it('choice: one radio group of the allowed choices, inheriting first; a stale choice stays visible; arrows move the choice', async () => {
        const onChange = setup('reads.mode', GRAPH_VALUES, 'graph')
        const group = screen.getByRole('radiogroup', { name: S['reads.mode'].label })
        const radios = within(group).getAllByRole('radio')
        expect(radios).toHaveLength(4)
        expect(radios[0]).toHaveTextContent('Use the platform’s choiceCurrently Always the latest.')
        expect(radios.slice(1).map((r) => r.getAttribute('aria-label'))).toEqual(S['reads.mode'].choices.map((c) => c.title))
        const beside = screen.getByRole('radio', { name: 'Keep serving, switch when ready' })
        expect(beside).toHaveAttribute('aria-checked', 'true')
        expect(beside).toHaveTextContent('No longer offered here')
        expect(screen.getByRole('radio', { name: 'Keep serving, update in place' })).toHaveTextContent('In force now')
        beside.focus()
        fireEvent.keyDown(beside, { key: 'ArrowRight' })
        expect(onChange).toHaveBeenLastCalledWith(null)
        await userEvent.click(screen.getByRole('radio', { name: 'Always the latest' }))
        expect(onChange).toHaveBeenLastCalledWith('latest')
    })

    it('choice: names what the scope may not choose', () => {
        setup('reads.mode', WORKSPACE_VALUES, 'workspace')
        expect(screen.queryByRole('radio', { name: 'Keep serving, switch when ready' })).not.toBeInTheDocument()
        expect(screen.getByText('Not offered here: Keep serving, switch when ready.')).toBeInTheDocument()
    })

    it('bool: a switch that says On or Off', async () => {
        const onChange = setup('residency.autoUnload', PLATFORM_VALUES, 'platform', true)
        const sw = screen.getByRole('switch', { name: S['residency.autoUnload'].label })
        expect(sw).toHaveAttribute('aria-checked', 'true')
        expect(screen.getByText('On')).toBeInTheDocument()
        await userEvent.click(sw)
        expect(onChange).toHaveBeenCalledWith(false)
    })

    it('count: a number with its unit noun, showing the inherited value until one is typed', async () => {
        const onChange = setup('builds.aboveRows', PLATFORM_VALUES, 'platform')
        const spin = screen.getByRole('spinbutton', { name: S['builds.aboveRows'].label })
        expect(spin).toHaveValue('')
        expect(spin).toHaveAttribute('placeholder', '200,000')
        expect(screen.getByText(/The default:/)).toHaveTextContent('The default: 200,000 changes.')
        await userEvent.type(spin, '80,000')
        expect(onChange).toHaveBeenLastCalledWith(80000)
    })

    it('percent: a slider and a number together; the slider takes the arrow keys', () => {
        const onChange = setup('residency.unloadStartPct', PLATFORM_VALUES, 'platform', 85)
        const label = S['residency.unloadStartPct'].label
        const slider = screen.getByRole('slider', { name: label })
        expect(slider).toHaveAttribute('aria-valuetext', '85%')
        fireEvent.keyDown(slider, { key: 'ArrowRight' })
        expect(onChange).toHaveBeenLastCalledWith(86)
        fireEvent.keyDown(slider, { key: 'End' })
        expect(onChange).toHaveBeenLastCalledWith(95)
        expect(screen.getByRole('spinbutton', { name: `${label}, exact value` })).toHaveValue('85')
    })

    it('ratio as a share: shown in percent, stored as a fraction', () => {
        const onChange = setup('imports.guardDeleteShare', GRAPH_VALUES, 'graph')
        const slider = screen.getByRole('slider', { name: S['imports.guardDeleteShare'].label })
        expect(slider).toHaveAttribute('aria-valuetext', '30%')
        fireEvent.keyDown(slider, { key: 'ArrowLeft' })
        expect(onChange).toHaveBeenLastCalledWith(0.29)
    })

    it('ratio as a multiplier: shown in percent too, stored as the ratio', () => {
        const onChange = setup('updates.pacingRatio', PLATFORM_VALUES, 'platform', 0.5)
        const slider = screen.getByRole('slider', { name: S['updates.pacingRatio'].label })
        expect(slider).toHaveAttribute('aria-valuetext', '50%')
        fireEvent.keyDown(slider, { key: 'ArrowRight' })
        expect(onChange).toHaveBeenLastCalledWith(0.51)
    })

    it('seconds: a number in its largest round unit, with the unit spoken in full', () => {
        setup('residency.standardIdleSecs', PLATFORM_VALUES, 'platform')
        const label = S['residency.standardIdleSecs'].label
        expect(screen.getByRole('spinbutton', { name: label })).toHaveAttribute('aria-valuetext', '14 days')
        expect(screen.getByRole('combobox', { name: `${label}: unit` })).toHaveValue('d')
    })

    it('ms: milliseconds, or whole seconds in seconds; the value stays in ms', async () => {
        const user = userEvent.setup()
        const onChange = setup('database.readTimeoutMs', PLATFORM_VALUES, 'platform', 15000)
        const label = S['database.readTimeoutMs'].label
        const spin = screen.getByRole('spinbutton', { name: label })
        expect(spin).toHaveAttribute('aria-valuetext', '15 seconds')
        await user.selectOptions(screen.getByRole('combobox', { name: `${label}: unit` }), 'ms')
        expect(spin).toHaveValue('15,000')
        fireEvent.keyDown(spin, { key: 'ArrowUp' })
        expect(onChange).toHaveBeenLastCalledWith(15001)
    })

    it('days: a whole number of days', async () => {
        const onChange = setup('trash.restoreDays', WORKSPACE_VALUES, 'workspace')
        const spin = screen.getByRole('spinbutton', { name: S['trash.restoreDays'].label })
        expect(spin).toHaveAttribute('aria-valuetext', '14 days')
        await userEvent.type(spin, '0')
        expect(onChange).toHaveBeenLastCalledWith(140)
    })

    it('bytes: in bytes when that is the round unit', () => {
        setup('residency.bytesPerEntity', PLATFORM_VALUES, 'platform', 800)
        expect(screen.getByRole('spinbutton', { name: S['residency.bytesPerEntity'].label })).toHaveAttribute('aria-valuetext', '800 bytes')
    })

    it('days or forever: "forever" is a value of its own; a set time starts from the inherited number', async () => {
        const onChange = setup('drafts.keepClosedDays', WORKSPACE_VALUES, 'workspace')
        const group = screen.getByRole('radiogroup', { name: S['drafts.keepClosedDays'].label })
        expect(within(group).getByRole('radio', { name: 'Forever' })).toHaveAttribute('aria-checked', 'true')
        await userEvent.click(within(group).getByRole('radio', { name: 'For a set time' }))
        expect(onChange).toHaveBeenLastCalledWith(30)
    })

    it('count or unlimited: Unlimited is a word, not -1', async () => {
        const onChange = setup('reads.maxVersionsBehind', WORKSPACE_VALUES, 'workspace')
        expect(screen.getByRole('spinbutton', { name: `${S['reads.maxVersionsBehind'].label}, versions` })).toHaveValue('3')
        await userEvent.click(screen.getByRole('radio', { name: 'Unlimited' }))
        expect(onChange).toHaveBeenLastCalledWith('unlimited')
    })

    it('bytes or unlimited: a limit starts at this platform’s recommendation', async () => {
        const onChange = setup('builds.copyMaxBytes', PLATFORM_VALUES, 'platform')
        expect(screen.getByRole('radio', { name: 'Unlimited' })).toHaveAttribute('aria-checked', 'true')
        await userEvent.click(screen.getByRole('radio', { name: 'Up to a limit' }))
        expect(onChange).toHaveBeenLastCalledWith(S['builds.copyMaxBytes'].guidance.recommended.forThisPlatform?.value)
    })

    it('identifier: entity id, URN, or a named property, with the URN as a fallback', async () => {
        const user = userEvent.setup()
        const onChange = setup('imports.identifier', GRAPH_VALUES, 'graph')
        expect(screen.getByRole('radio', { name: 'A property' })).toHaveAttribute('aria-checked', 'true')
        const name = screen.getByRole('textbox', { name: 'Property name' })
        expect(name).toHaveValue('sku')
        await user.type(name, '2')
        expect(onChange).toHaveBeenLastCalledWith('prop.sku2')
        await user.click(screen.getByRole('checkbox', { name: 'Rows without it: find them by their URN' }))
        expect(onChange).toHaveBeenLastCalledWith('prop.sku,urn')
        await user.click(screen.getByRole('radio', { name: 'URN' }))
        expect(onChange).toHaveBeenLastCalledWith('urn')
    })

    it('refusal budget: none, a number of rows, a share, or unlimited, in its syntax', async () => {
        const user = userEvent.setup()
        const onChange = setup('imports.maxRefusedRows', WORKSPACE_VALUES, 'workspace')
        expect(screen.getByRole('radio', { name: 'A share' })).toHaveAttribute('aria-checked', 'true')
        expect(screen.getByRole('spinbutton', { name: `${S['imports.maxRefusedRows'].label}, share of rows` })).toHaveValue('0.5')
        await user.click(screen.getByRole('radio', { name: 'None' }))
        expect(onChange).toHaveBeenLastCalledWith('0')
        await user.click(screen.getByRole('radio', { name: 'A number' }))
        expect(onChange).toHaveBeenLastCalledWith('100')
        await user.click(screen.getByRole('radio', { name: 'Unlimited' }))
        expect(onChange).toHaveBeenLastCalledWith('unlimited')
    })
})
