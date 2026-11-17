/**
 * A setting row: named by its title (the question in the business lens, the label in the operator
 * lens); the control states the value, once, and a badge shows only a status that isn't "In effect";
 * in the business lens one line says where the value comes from (inherited, its own, locked, kept as
 * an exception, or what is in force now), in the operator lens the trail does; a staged row says the
 * server's answer under its control; going back to the default is one action, said to be the
 * recommended one, and what this platform's facts suggest is said in the open; the footer's actions
 * stage and never save; a why's fix calls back; a row the viewer may not change says who can; the
 * link copies; guidance opens on demand; a status and a defined word open what they mean on a tap;
 * and a change of status is announced. Words come from the registry's catalogue.
 */
import { render, screen, within } from '@testing-library/react'
import type { ResolvedSetting, ResolvedValues, Scope, SettingValue } from '../types'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SCHEMA, SETTINGS_BY_KEY as S } from '../__fixtures__/schema'
import { GRAPH_VALUES, PLATFORM_VALUES, WORKSPACE_VALUES } from '../__fixtures__/resolved'
import { formatValue } from '../format'
import { STATUS_META } from '../meta'
import { SettingRow, type SettingRowProps } from '../SettingRow'

const choice = (key: string, id: string) => S[key].choices.find((c) => c.id === id)!.title

function row(props: Partial<SettingRowProps> & Pick<SettingRowProps, 'setting' | 'resolved' | 'scope'>) {
    const onStage = vi.fn()
    const utils = render(<SettingRow onStage={onStage} dimensions={SCHEMA.dimensions} glossary={SCHEMA.glossary} {...props} />)
    return { onStage, ...utils }
}

describe('SettingRow', () => {
    it('business lens: titled by the question, with the label above it; an adjusted value says what is in force now, under its cards', () => {
        const s = S['reads.mode']
        row({ setting: s, resolved: GRAPH_VALUES['reads.mode'], scope: 'graph', lens: 'business' })
        const article = screen.getByRole('article', { name: s.question })
        expect(article).toHaveAttribute('id', 'reads-mode')
        expect(within(article).getByRole('heading', { level: 3 })).toHaveTextContent(s.question)
        expect(article).toHaveTextContent(`${s.label}${s.question}`)
        // No "In force" header: the cards state the value chosen, the line under them the value in force.
        expect(within(article).queryByText('In force')).not.toBeInTheDocument()
        const cards = within(article).getByRole('radiogroup', { name: s.question })
        const now = within(article).getByText(`In force now: ${choice('reads.mode', 'in_place')}`)
        expect(cards.compareDocumentPosition(now) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(within(article).getByText('Adjusted')).toBeInTheDocument()
        // The why says why; the trail is the Technical view's.
        expect(article).toHaveTextContent(GRAPH_VALUES['reads.mode'].why[0].text)
        expect(within(article).queryByRole('list', { name: `Where ${s.label} comes from` })).not.toBeInTheDocument()
    })

    it('states a value once: no "In force" header and no "In effect" badge, only the line that says where it comes from', () => {
        const s = S['drafts.keepClosedDays']
        row({ setting: s, resolved: PLATFORM_VALUES['drafts.keepClosedDays'], scope: 'platform', lens: 'business' })
        const article = screen.getByRole('article', { name: s.question })
        expect(article).not.toHaveTextContent('In force')
        expect(article).not.toHaveTextContent('In effect')
        const value = formatValue(s, PLATFORM_VALUES['drafts.keepClosedDays'].effective)
        expect(within(article).getByText(`The default: ${value}`)).toBeInTheDocument()
        expect(article.textContent!.split(value)).toHaveLength(2)
    })

    it('business lens: says where a value comes from in one line, a lock and an exception included', () => {
        const line = (key: string, values: ResolvedValues, scope: Scope, words: string) => {
            const { unmount } = row({ setting: S[key], resolved: values[key], scope, lens: 'business' })
            const article = screen.getByRole('article', { name: S[key].question })
            expect(within(article).getByText(words)).toBeInTheDocument()
            return { article, unmount }
        }
        // A switch or a choice states its value: the line says only whom it follows.
        line('drafts.selfApproval', GRAPH_VALUES, 'graph', 'Follows the workspace').unmount()
        line('residency.autoUnload', PLATFORM_VALUES, 'platform', 'Follows the default').unmount()
        // A number's own field shows it only faintly: the line states it.
        line('forks.maxPerGraph', PLATFORM_VALUES, 'platform', `The default: ${formatValue(S['forks.maxPerGraph'], 10)}`).unmount()
        line('imports.guardDeleteShare', GRAPH_VALUES, 'graph', 'Set for this graph').unmount()

        // Locked: said once, under the value, which says no more.
        const locked = line('imports.replaceGuard', GRAPH_VALUES, 'graph', 'Locked by the platform')
        expect(locked.article).not.toHaveTextContent('The platform locked this value.')
        expect(within(locked.article).queryByRole('switch')).not.toBeInTheDocument()
        expect(within(locked.article).getByText('Locked')).toBeInTheDocument()
        locked.unmount()

        // An exception, chosen here or above: always said.
        const own = line('drafts.keepClosedDays', WORKSPACE_VALUES, 'workspace', 'Set for this workspace')
        expect(within(own.article).getByText('Kept as an exception')).toBeInTheDocument()
        own.unmount()
        const above = line('forks.maxPerGraph', GRAPH_VALUES, 'graph', `From the workspace: ${formatValue(S['forks.maxPerGraph'], 50)}`)
        expect(within(above.article).getByText('Kept as an exception')).toBeInTheDocument()
    })

    it('operator lens: no provenance line; the trail says where the value comes from', () => {
        const s = S['imports.guardDeleteShare']
        row({ setting: s, resolved: GRAPH_VALUES['imports.guardDeleteShare'], scope: 'graph', lens: 'operator' })
        const article = screen.getByRole('article', { name: s.label })
        expect(within(article).getByRole('list', { name: `Where ${s.label} comes from` })).toBeInTheDocument()
        expect(within(article).queryByText('Set for this graph')).not.toBeInTheDocument()
        expect(article).not.toHaveTextContent('In effect')
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

    it('says a value comes from a level above, with the value', () => {
        const s = S['imports.maxRefusedRows']
        row({ setting: s, resolved: GRAPH_VALUES['imports.maxRefusedRows'], scope: 'graph' })
        expect(screen.getByRole('article', { name: s.question }))
            .toHaveTextContent(`From the workspace: ${formatValue(s, GRAPH_VALUES['imports.maxRefusedRows'].effective)}`)
    })

    it('offers one way back to the default when it is the recommended value; nothing is saved', async () => {
        const s = S['trash.restoreDays']
        const { onStage } = row({ setting: s, resolved: WORKSPACE_VALUES['trash.restoreDays'], scope: 'workspace' })
        const article = within(screen.getByRole('article', { name: s.question }))
        await userEvent.click(article.getByRole('button', { name: `Use the default · ${formatValue(s, s.default.code)} (recommended)` }))
        expect(article.queryByRole('button', { name: /^Use recommended/ })).not.toBeInTheDocument()
        expect(onStage).toHaveBeenCalledTimes(1)
        expect(onStage).toHaveBeenCalledWith(null)
    })

    it('says what this platform’s facts suggest in the open, while it isn’t the value in force', async () => {
        const s = S['builds.copyRoomPct']
        const suggested = s.guidance.recommended.forThisPlatform!
        const first = row({ setting: s, resolved: PLATFORM_VALUES['builds.copyRoomPct'], scope: 'platform' })
        const article = within(screen.getByRole('article', { name: s.question }))
        expect(article.getByText(`Suggested for your platform: ${formatValue(s, suggested.value)}`)).toBeInTheDocument()
        expect(article.getByText(suggested.why)).toBeInTheDocument()
        // It is the default here too: one action stages it, said to be the recommended one.
        await userEvent.click(article.getByRole('button', { name: `Use the default · ${formatValue(s, suggested.value)} (recommended)` }))
        expect(first.onStage).toHaveBeenCalledWith(null)
        first.unmount()

        // Where it isn't the default, the footer stages the suggestion itself.
        const max = S['builds.copyMaxBytes']
        const forMax = max.guidance.recommended.forThisPlatform!
        const second = row({ setting: max, resolved: PLATFORM_VALUES['builds.copyMaxBytes'], scope: 'platform' })
        const maxRow = within(screen.getByRole('article', { name: max.question }))
        expect(maxRow.getByText(`Suggested for your platform: ${formatValue(max, forMax.value)}`)).toBeInTheDocument()
        await userEvent.click(maxRow.getByRole('button', { name: `Use recommended · ${formatValue(max, forMax.value)}` }))
        expect(second.onStage).toHaveBeenCalledWith(forMax.value)
        second.unmount()

        // Once in force, there is nothing to suggest.
        row({ setting: S['residency.unloadStartPct'], resolved: PLATFORM_VALUES['residency.unloadStartPct'], scope: 'platform' })
        expect(screen.queryByText(/^Suggested for your platform/)).not.toBeInTheDocument()
    })

    it('says the server’s answer for a staged value under its control, never a guess', () => {
        const s = S['reads.mode']
        const r = GRAPH_VALUES['reads.mode']
        // The server's answer for `beside` staged at the graph: held to `in_place`.
        const answer = (staged: SettingValue): ResolvedSetting => ({
            ...r, effective: 'in_place', declared: staged, status: 'adjusted',
            trail: r.trail.map((t) => (t.scope === 'graph' ? { ...t, value: staged } : t)),
        })
        const article = () => within(screen.getByRole('article', { name: s.question }))
        const { rerender } = render(<SettingRow setting={s} resolved={r} scope="graph" staged="beside" checking onStage={() => {}} />)
        expect(article().getByText('Checking…')).toBeInTheDocument()
        expect(article().queryByText(/^Once saved/)).not.toBeInTheDocument()
        rerender(<SettingRow setting={s} resolved={r} scope="graph" staged="beside" preview={answer('beside')} onStage={() => {}} />)
        const saved = article().getByText(`Once saved: ${choice('reads.mode', 'in_place')}`)
        expect(article().getByText(`Chosen: ${choice('reads.mode', 'beside')}`)).toBeInTheDocument()
        expect(article().getByRole('radiogroup').compareDocumentPosition(saved) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        // An answer for an earlier staged value says nothing about this one.
        rerender(<SettingRow setting={s} resolved={r} scope="graph" staged="latest" preview={answer('beside')} onStage={() => {}} />)
        expect(article().queryByText(/^Once saved/)).not.toBeInTheDocument()
        // Nor while the staged value needs a fix.
        rerender(<SettingRow setting={s} resolved={r} scope="graph" staged="beside" preview={answer('beside')} checking error="Not allowed here." onStage={() => {}} />)
        expect(article().queryByText(/^(Once saved|Chosen):/)).not.toBeInTheDocument()
        expect(article().queryByText('Checking…')).not.toBeInTheDocument()
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

    it('underlines a defined term in the guidance, with its definition from the glossary on a tap', async () => {
        const user = userEvent.setup()
        row({ setting: S['reads.mode'], resolved: GRAPH_VALUES['reads.mode'], scope: 'graph' })
        await user.click(screen.getByRole('button', { name: 'How it works' }))
        const store = SCHEMA.glossary.find((t) => t.term === 'Graph store')!
        await user.click(screen.getAllByRole('button', { name: /^graph store$/i })[0])
        expect(screen.getByRole('dialog', { name: store.term })).toHaveTextContent(store.definition)
    })

    it('opens what a status means on a tap, and Esc hands focus back to the badge', async () => {
        const user = userEvent.setup()
        row({ setting: S['reads.mode'], resolved: GRAPH_VALUES['reads.mode'], scope: 'graph', lens: 'business' })
        const { label, hint } = STATUS_META[GRAPH_VALUES['reads.mode'].status]
        const badge = screen.getByRole('button', { name: label })
        await user.click(badge)
        expect(screen.getByRole('dialog', { name: label })).toHaveTextContent(hint)
        await user.keyboard('{Escape}')
        expect(screen.queryByRole('dialog', { name: label })).not.toBeInTheDocument()
        expect(badge).toHaveFocus()
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
