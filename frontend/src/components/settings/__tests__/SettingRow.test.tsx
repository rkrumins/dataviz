/**
 * A setting row: named by its title (the question in the business lens, the label in the operator
 * lens); "Use recommended" and the inherit action stage and never save; a why's fix calls back; a
 * row the viewer may not change says who can; the link copies; guidance opens on demand; and a
 * change of status is announced. Words come from the registry's catalogue.
 */
import { render, screen, within } from '@testing-library/react'
import type { ResolvedSetting, SettingValue } from '../types'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SCHEMA, SETTINGS_BY_KEY as S } from '../__fixtures__/schema'
import { GRAPH_VALUES, PLATFORM_VALUES } from '../__fixtures__/resolved'
import { SettingRow, type SettingRowProps } from '../SettingRow'

function row(props: Partial<SettingRowProps> & Pick<SettingRowProps, 'setting' | 'resolved' | 'scope'>) {
    const onStage = vi.fn()
    const utils = render(<SettingRow onStage={onStage} dimensions={SCHEMA.dimensions} glossary={SCHEMA.glossary} {...props} />)
    return { onStage, ...utils }
}

describe('SettingRow', () => {
    it('business lens: titled by the question, with the label above it and the value in force', () => {
        const s = S['reads.mode']
        row({ setting: s, resolved: GRAPH_VALUES['reads.mode'], scope: 'graph', lens: 'business' })
        const article = screen.getByRole('article', { name: s.question })
        expect(article).toHaveAttribute('id', 'reads-mode')
        expect(within(article).getByRole('heading', { level: 3 })).toHaveTextContent(s.question)
        expect(article).toHaveTextContent(`${s.label}${s.question}`)
        expect(article).toHaveTextContent('In forceKeep serving, update in place')
        expect(within(article).getByText('Adjusted')).toBeInTheDocument()
        expect(within(article).getByRole('radiogroup', { name: s.question })).toBeInTheDocument()
    })

    it('business lens: a setting for the platform team is titled by its question too', () => {
        const s = S['updates.pacingRatio']
        expect(s.audience).toBe('operator')
        row({ setting: s, resolved: PLATFORM_VALUES['updates.pacingRatio'], scope: 'platform', lens: 'business' })
        const article = screen.getByRole('article', { name: s.question })
        expect(within(article).getByRole('heading', { level: 3 })).toHaveTextContent(s.question)
        expect(article).toHaveTextContent(s.label)
    })

    it('operator lens: titled by the label, with the env var, when a change takes effect, its cap, and the evidence on demand', async () => {
        const s = S['builds.perWorker']
        row({ setting: s, resolved: PLATFORM_VALUES['builds.perWorker'], scope: 'platform', lens: 'operator' })
        const article = screen.getByRole('article', { name: s.label })
        expect(article).toHaveTextContent(s.default.env as string)
        expect(article).toHaveTextContent(s.takesEffect.text)
        expect(article).toHaveTextContent('Capped by GRAPHVER_PROJECTION_CONCURRENCY')
        // The evidence is a real button: its tip on focus, and a press opens the guidance where it is kept.
        const evidence = within(article).getByRole('button', { name: 'Evidence' })
        evidence.focus()
        expect(await screen.findByRole('tooltip')).toHaveTextContent(s.guidance.evidence.slice(0, 40))
        await userEvent.click(evidence)
        expect(within(article).getByRole('button', { name: 'Less' })).toHaveAttribute('aria-expanded', 'true')
    })

    it('operator lens: a cap with the value a system admin is served, and an env var that wraps', () => {
        const s = S['builds.perWorker']
        const capped = { ...s, caps: s.caps.map((c) => ({ ...c, value: 4 })) }
        row({ setting: capped, resolved: PLATFORM_VALUES['builds.perWorker'], scope: 'platform', lens: 'operator' })
        const article = screen.getByRole('article', { name: s.label })
        expect(article).toHaveTextContent('Capped at 4 builds by GRAPHVER_PROJECTION_CONCURRENCY')
        expect(within(article).getByText(s.default.env as string)).toHaveClass('[overflow-wrap:anywhere]')
    })

    it('says a cap whose value couldn’t be read, and why', () => {
        const s = S['builds.perWorker']
        const unread = { ...s, caps: s.caps.map((c) => ({ ...c, value: null, problem: 'It couldn’t be read just now.' })) }
        row({ setting: unread, resolved: PLATFORM_VALUES['builds.perWorker'], scope: 'platform', lens: 'operator' })
        expect(screen.getByRole('article', { name: s.label }))
            .toHaveTextContent('Capped by GRAPHVER_PROJECTION_CONCURRENCY: its value couldn’t be read. It couldn’t be read just now.')
    })

    it('says which level the value in force comes from', () => {
        row({ setting: S['imports.guardDeleteShare'], resolved: GRAPH_VALUES['imports.guardDeleteShare'], scope: 'graph' })
        expect(screen.getByRole('article', { name: S['imports.guardDeleteShare'].question })).toHaveTextContent('Set at Graph')
    })

    it('says a value comes from a level above', () => {
        row({ setting: S['imports.maxRefusedRows'], resolved: GRAPH_VALUES['imports.maxRefusedRows'], scope: 'graph' })
        expect(screen.getByRole('article', { name: S['imports.maxRefusedRows'].question })).toHaveTextContent('From Workspace')
    })

    it('"Use recommended" stages the recommendation for this platform; nothing is saved', async () => {
        const { onStage } = row({ setting: S['builds.copyRoomPct'], resolved: PLATFORM_VALUES['builds.copyRoomPct'], scope: 'platform' })
        await userEvent.click(screen.getByRole('button', { name: 'Use recommended · 220%' }))
        expect(onStage).toHaveBeenCalledTimes(1)
        expect(onStage).toHaveBeenCalledWith(220)
    })

    it('heads a staged row with the server’s answer for it, never a guess', () => {
        const s = S['reads.mode']
        const r = GRAPH_VALUES['reads.mode']
        // The server's answer for "switch when ready" staged at the graph: held to update in place.
        const answer = (staged: SettingValue): ResolvedSetting => ({
            ...r, effective: 'in_place', declared: staged, status: 'adjusted',
            trail: r.trail.map((t) => (t.scope === 'graph' ? { ...t, value: staged } : t)),
        })
        // The row's own head, before its trail (whose last step may say "In force" too).
        const head = () => within(screen.getByRole('article', { name: s.question })).getAllByText('In force')[0].parentElement as HTMLElement
        const { rerender } = render(<SettingRow setting={s} resolved={r} scope="graph" staged="beside" checking onStage={() => {}} />)
        expect(head()).toHaveTextContent('Checking…')
        expect(head()).not.toHaveTextContent('Once saved')
        rerender(<SettingRow setting={s} resolved={r} scope="graph" staged="beside" preview={answer('beside')} onStage={() => {}} />)
        expect(head()).toHaveTextContent(`Once saved: ${s.choices.find((c) => c.id === 'in_place')!.title}`)
        expect(head()).toHaveTextContent(`Chosen: ${s.choices.find((c) => c.id === 'beside')!.title}`)
        // An answer for an earlier staged value says nothing about this one.
        rerender(<SettingRow setting={s} resolved={r} scope="graph" staged="latest" preview={answer('beside')} onStage={() => {}} />)
        expect(head()).not.toHaveTextContent('Once saved')
        // Nor while the staged value needs a fix.
        rerender(<SettingRow setting={s} resolved={r} scope="graph" staged="beside" preview={answer('beside')} checking error="Not allowed here." onStage={() => {}} />)
        expect(head()).not.toHaveTextContent(/Once saved|Chosen|Checking/)
    })

    it('offers to inherit again, and to revert a staged change', async () => {
        const onUnstage = vi.fn()
        const { onStage } = row({
            setting: S['imports.guardDeleteShare'], resolved: GRAPH_VALUES['imports.guardDeleteShare'], scope: 'graph', lens: 'operator',
            staged: 0.4, onUnstage,
        })
        expect(screen.getByRole('article', { name: S['imports.guardDeleteShare'].label })).not.toHaveTextContent('Once saved')
        await userEvent.click(screen.getByRole('button', { name: 'Use the workspace’s value · 25%' }))
        expect(onStage).toHaveBeenLastCalledWith(null)
        await userEvent.click(screen.getByRole('button', { name: 'Revert' }))
        expect(onUnstage).toHaveBeenCalled()
    })

    it('a why’s fix calls back with the fix', async () => {
        const onFix = vi.fn()
        row({ setting: S['reads.mode'], resolved: GRAPH_VALUES['reads.mode'], scope: 'graph', onFix })
        await userEvent.click(screen.getByRole('button', { name: 'Turn on New-version builds' }))
        expect(onFix).toHaveBeenCalledWith({ feature: 'candidateKeysEnabled', to: true }, expect.objectContaining({ code: 'builds_off' }))
    })

    it('a value the viewer may not change is shown with who can change it', () => {
        row({ setting: S['residency.class'], resolved: GRAPH_VALUES['residency.class'], scope: 'graph', lens: 'operator' })
        const article = screen.getByRole('article', { name: S['residency.class'].label })
        expect(within(article).queryByRole('radiogroup')).not.toBeInTheDocument()
        expect(article).toHaveTextContent('Only a system admin can change it here.')
        expect(within(article).queryByRole('button', { name: /Use recommended/ })).not.toBeInTheDocument()
    })

    it('a locked value says the platform locked it', () => {
        row({ setting: S['imports.replaceGuard'], resolved: GRAPH_VALUES['imports.replaceGuard'], scope: 'graph', lens: 'operator' })
        expect(screen.getByRole('article', { name: S['imports.replaceGuard'].label })).toHaveTextContent('The platform locked this value.')
        expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    })

    it('copies a link to the row’s anchor', async () => {
        const user = userEvent.setup()
        row({ setting: S['reads.mode'], resolved: GRAPH_VALUES['reads.mode'], scope: 'graph' })
        await user.click(screen.getByRole('button', { name: 'Copy a link to Read mode' }))
        expect(await navigator.clipboard.readText()).toMatch(/#reads-mode$/)
        expect(await screen.findByRole('button', { name: 'Link to Read mode copied' })).toBeInTheDocument()
    })

    it('opens the guidance on demand: its meaning, its effects, and the technical details open for an operator', async () => {
        const user = userEvent.setup()
        const s = S['updates.pacingRatio']
        const { onStage } = row({ setting: s, resolved: PLATFORM_VALUES['updates.pacingRatio'], scope: 'platform', lens: 'operator' })
        const toggle = screen.getByRole('button', { name: 'How it works' })
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        await user.click(toggle)
        expect(screen.getByRole('button', { name: 'Less' })).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByRole('heading', { name: 'What it means' })).toBeInTheDocument()
        expect(screen.getByRole('table', { name: `What raising and lowering ${s.label} does` })).toBeInTheDocument()
        expect(screen.getByText('Technical details').closest('details')).toHaveAttribute('open')
        expect(screen.getByRole('link', { name: 'Read the guide' })).toHaveAttribute('href', `/guide/versioned-graph-settings#${'updates-pacingratio'}`)
        expect(screen.getByRole('button', { name: 'Use recommended' })).toBeDisabled()
        expect(onStage).not.toHaveBeenCalled()
    })

    it('underlines a defined term in the guidance, with its definition from the glossary on focus', async () => {
        const user = userEvent.setup()
        row({ setting: S['reads.mode'], resolved: GRAPH_VALUES['reads.mode'], scope: 'graph' })
        await user.click(screen.getByRole('button', { name: 'How it works' }))
        const term = screen.getAllByText('graph store').find((el) => el.getAttribute('tabindex') === '0') as HTMLElement
        term.focus()
        const definition = SCHEMA.glossary.find((t) => t.term === 'Graph store')!.definition
        expect(await screen.findByRole('tooltip')).toHaveTextContent(definition)
    })

    it('announces a change of status, not the status it opens with', () => {
        const s = S['builds.copyRoomPct']
        const { rerender, container } = row({ setting: s, resolved: PLATFORM_VALUES['builds.copyRoomPct'], scope: 'platform' })
        const live = [...container.querySelectorAll('[aria-live="polite"]')].at(-1) as HTMLElement
        expect(live).toBeEmptyDOMElement()
        rerender(<SettingRow setting={s} resolved={{ ...PLATFORM_VALUES['builds.copyRoomPct'], status: 'in_effect', why: [] }} scope="platform" onStage={() => {}} />)
        expect(live).toHaveTextContent(`${s.label}: In effect. The value chosen is the value in force.`)
    })
})
