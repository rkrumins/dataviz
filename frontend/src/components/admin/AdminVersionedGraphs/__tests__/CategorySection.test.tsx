/**
 * A category's "Set by your deployment": folded to one line that counts its read-only values in the
 * Business view, open in the Technical view; for a system admin, each fact with the value config
 * reads now, in its unit, and whether the deployment chose it or left the default; "—, couldn't be
 * read" with the server's reason when it couldn't be read; for anyone else (no value served), the
 * fact alone. Each category's list is a landmark named for the category. The header says how many
 * settings there are, are changed and aren't saved. Facts and labels come from the registry's
 * generated catalogue.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CATALOGUE, formatValue, type DeploymentFact, type Setting } from '@/components/settings'
import { CategorySection } from '../CategorySection'

const UPDATES = CATALOGUE.categories.find((c) => c.id === 'updates')!
const FACTS = CATALOGUE.deployment.filter((f) => f.category === 'updates')
const fact = (env: string) => FACTS.find((f) => f.env === env)!
const say = (f: DeploymentFact) => formatValue({ kind: f.kind, unit: f.unit } as Setting, f.value)

function renderFacts(deployment: DeploymentFact[], lens: 'business' | 'operator' = 'operator') {
    render(
        <CategorySection category={UPDATES} settings={[]} total={0} changed={0} staged={0} lens={lens} deployment={deployment}
            row={() => null} filtered={false} onShowAll={() => {}} />,
    )
    return within(screen.getByRole('region', { name: `${UPDATES.label}: set by your deployment` }))
}

describe('CategorySection: set by your deployment', () => {
    it('folds to one line in the Business view, counting its read-only values, and opens in the Technical view', () => {
        const folded = renderFacts(FACTS, 'business')
        const summary = folded.getByText('Set by your deployment').closest('summary')!
        expect(summary).toHaveTextContent(`Set by your deployment· ${FACTS.length} read-only values`)
        expect(summary.closest('details')).not.toHaveAttribute('open')
        expect(folded.getByText(FACTS[0].label, { selector: 'dt' })).not.toBeVisible()
        cleanup()
        const open = renderFacts(FACTS, 'operator')
        expect(open.getByText('Set by your deployment').closest('details')).toHaveAttribute('open')
        expect(open.getByText(FACTS[0].label, { selector: 'dt' })).toBeVisible()
    })

    it('shows a system admin each fact’s value with its unit, whether the deployment set it, or why it couldn’t be read', () => {
        const served: DeploymentFact[] = [
            { ...fact('GRAPHVER_PROJECTION_CONCURRENCY'), kind: 'count', unit: 'graphs', value: 4, set: true, problem: null },
            { ...fact('GRAPHVER_PROJECTION_POLL_SECS'), kind: 'seconds', unit: null, value: 5, set: false, problem: null },
            { ...fact('GRAPHVER_PROJECTION_BATCH_SIZE'), kind: 'count', unit: 'changes', value: null, set: null,
                problem: 'GRAPHVER_PROJECTION_BATCH_SIZE isn’t a whole number, so the worker uses its default.' },
        ]
        const facts = renderFacts(served)
        const item = (f: DeploymentFact) => within(facts.getByText(f.label, { selector: 'dt' }).parentElement!)

        expect(item(served[0]).getByText(say(served[0]))).toBeInTheDocument()
        expect(item(served[0]).getByText('set by your deployment')).toBeInTheDocument()
        // "Look for work every" reads to its end: the value says every how long.
        expect(item(served[1]).getByText(say(served[1]))).toBeInTheDocument()
        expect(item(served[1]).getByText('the default')).toBeInTheDocument()
        // Never a made-up value: "—" and why.
        const unread = item(served[2])
        expect(unread.getByText('Not known')).toBeInTheDocument()
        expect(unread.getByText(/couldn’t be read: GRAPHVER_PROJECTION_BATCH_SIZE isn’t a whole number/)).toBeInTheDocument()
        expect(facts.getByText('GRAPHVER_PROJECTION_POLL_SECS')).toBeInTheDocument()
    })

    it('shows anyone else the facts alone: no value is served to them', () => {
        const facts = renderFacts(FACTS)
        for (const f of FACTS) expect(facts.getByText(f.label, { selector: 'dt' })).toBeInTheDocument()
        expect(facts.queryByText('Not known')).not.toBeInTheDocument()
        expect(facts.queryByText(/couldn’t be read/)).not.toBeInTheDocument()
        expect(facts.queryByText('the default')).not.toBeInTheDocument()
    })
})

describe('CategorySection: its header', () => {
    it('counts the settings, those changed and those not saved, beside the posture the server writes', () => {
        const reads = CATALOGUE.categories.find((c) => c.id === 'reads')!
        render(
            <CategorySection category={reads} settings={[]} total={10} changed={2} staged={1} lens="business" deployment={[]}
                row={() => null} filtered={false} onShowAll={() => {}} />,
        )
        const header = screen.getByRole('heading', { level: 2, name: reads.label }).closest('header')!
        expect(header).toHaveTextContent(reads.posture)
        expect(within(header).getByText('10 settings')).toBeInTheDocument()
        expect(within(header).getByText('2 changed')).toBeInTheDocument()
        expect(within(header).getByText('1 not saved')).toBeInTheDocument()
    })
})
