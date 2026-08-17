/**
 * The Automation modal — the three-stage pipeline (① Detect → ② Check → ③ Act)
 * that replaced the 448px cadence dialog, plus the vocabulary and contradiction
 * rules it speaks. The save tests came verbatim from CadenceControls' popover
 * block: it writes the same two records in the same order.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { automationWarnings } from './automationCopy'

const {
    getAggregationSettings, putAggregationCadence, listJobsGlobal, permissionFn,
    getReconciliation, putReconciliation, reconcileNow,
} = vi.hoisted(() => ({
    getAggregationSettings: vi.fn(),
    putAggregationCadence: vi.fn(),
    listJobsGlobal: vi.fn(),
    permissionFn: vi.fn(),
    getReconciliation: vi.fn(),
    putReconciliation: vi.fn(),
    reconcileNow: vi.fn(),
}))

/** The reconciliation policy shares the modal and the stored record with the
 *  rebuild cadence, so every cadence test needs it resolvable. */
const RECON_POLICY = {
    enabled: true, checkIntervalSecs: null, maxActionsPerRun: null,
    shrinkTolerancePct: null, detectors: null,
    envEnabled: true, envCheckIntervalSecs: 3600, envMaxActionsPerRun: 10,
    envShrinkTolerancePct: 10, envStatsMaxAgeSecs: 2700,
    allDetectors: ['overlay_missing', 'overlay_shrunk', 'never_aggregated', 'raw_drift'],
}

vi.mock('@/store/auth', () => ({
    usePermission: (perm: string, workspaceId?: string | null) => permissionFn(perm, workspaceId),
}))

vi.mock('@/services/freshnessService', async () => {
    const actual = await vi.importActual<typeof import('@/services/freshnessService')>('@/services/freshnessService')
    return {
        ...actual,
        freshnessService: {
            ...actual.freshnessService,
            getReconciliation, putReconciliation, reconcileNow,
        },
    }
})

vi.mock('@/services/aggregationService', async () => {
    const actual = await vi.importActual<typeof import('@/services/aggregationService')>('@/services/aggregationService')
    return {
        ...actual,
        aggregationService: { ...actual.aggregationService, getAggregationSettings, putAggregationCadence, listJobsGlobal },
    }
})

import { AutomationModal } from './AutomationModal'

function wrap(node: React.ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return {
        qc,
        ...render(
            <QueryClientProvider client={qc}>
                <MemoryRouter>{node}</MemoryRouter>
            </QueryClientProvider>,
        ),
    }
}

/** A deploy with everything on, so the tests below vary one thing at a time. */
const SETTINGS = {
    tuning: null, cadence: null,
    envRebuildMinIntervalSecs: 900, envDriftAutoRebuild: true,
    envProbeEnabled: true, envProbeIntervalSecs: 60,
}

/** Force the mounted reconciliation query to refetch — stands in for the 60s
 *  poll landing a payload another admin just wrote. */
async function repoll(qc: QueryClient) {
    await act(async () => {
        await qc.invalidateQueries({ queryKey: ['freshness', 'reconciliation'] })
    })
}

/**
 * The tuning knobs sit behind one `Advanced` disclosure per stage, closed by
 * default — the essentials are the pipeline itself. Only the ROUTE to those
 * controls moved; every assertion reached through here is the one it was.
 *
 * Two collapsed rows both reading "Advanced" would be indistinguishable to a
 * screen reader, so each carries its stage in its accessible name — which is
 * also what makes them addressable from here.
 */
async function openAdvanced(stage: 'Check' | 'Act') {
    await userEvent.click(
        await screen.findByRole('button', { name: new RegExp(`advanced ${stage}`, 'i') }),
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    permissionFn.mockReturnValue(true)
    getReconciliation.mockResolvedValue({ policy: RECON_POLICY, runs: [] })
    putReconciliation.mockResolvedValue(RECON_POLICY)
    // The impact line fires a debounced dry sweep; keep it resolvable so a
    // slow assertion cannot land on an unmocked promise.
    reconcileNow.mockResolvedValue({ run: null, findings: [], skipped: false })
})

describe('automationWarnings', () => {
    it('warns that checks are only as fresh as the slow refresh when detect is off', () => {
        const w = automationWarnings(
            { enabled: true, detectors: null },
            { probeEnabled: false },
        )
        expect(w.map(x => x.id)).toContain('detect-off')
        expect(w[0].text).toMatch(/only see data as fresh as/i)
    })

    it('warns when every detector is unchecked', () => {
        const w = automationWarnings(
            { enabled: true, detectors: [] },
            { probeEnabled: true },
        )
        expect(w.map(x => x.id)).toContain('no-detectors')
    })

    it('treats an unset detector list as all-on, not none', () => {
        // null = "all enabled"; [] = "act on nothing". Never truthiness.
        const w = automationWarnings(
            { enabled: true, detectors: null },
            { probeEnabled: true },
        )
        expect(w.map(x => x.id)).not.toContain('no-detectors')
    })

    it('warns when the action cap is zero', () => {
        const w = automationWarnings(
            { enabled: true, detectors: null, maxActionsPerRun: 0 },
            { probeEnabled: true },
        )
        expect(w.map(x => x.id)).toContain('cap-zero')
        // The three stage names are a fixed vocabulary. Spending one of them
        // on a plain verb here put a second "Detect" on the page meaning
        // something else, and made /Detect/ ambiguous for anyone querying it.
        expect(w.find(x => x.id === 'cap-zero')?.text).toBe(
            'Report only — no rebuilds will be queued.',
        )
    })

    it('is silent on a healthy policy', () => {
        expect(automationWarnings(
            { enabled: true, detectors: null, maxActionsPerRun: 10 },
            { probeEnabled: true },
        )).toEqual([])
    })
})

describe('AutomationModal', () => {
    it('renders read-only without system:admin', async () => {
        wrap(<AutomationModal open onClose={() => {}} isAdmin={false} summary={null} />)

        // The stage name is now in two places — the rail's diagram and the
        // section it points at — so this asks for the section, not for "the
        // only element saying Detect".
        expect(await screen.findByRole('heading', { name: 'Detect' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: '5m' })).toBeDisabled()
        // The cadence record is admin-only to READ, so a non-admin must not
        // fire a request that can only 403.
        expect(getAggregationSettings).not.toHaveBeenCalled()
    })

    it('offers nothing to save when the settings cannot be read', async () => {
        // Both queries stop loading on an error, so "not loading" is not
        // "ready". Rendering the form anyway would put a live Save over state
        // that still says `detectors: []` — one click, every detector off.
        getReconciliation.mockRejectedValue(new Error('nope'))
        getAggregationSettings.mockResolvedValue(SETTINGS)
        wrap(<AutomationModal open onClose={() => {}} isAdmin summary={null} />)

        // `useReconciliation` sets its own `retry: 1`, which the client-level
        // `retry: false` does not override, so the error state lands one
        // backoff later than a default-configured query would.
        expect(await screen.findByRole('alert', {}, { timeout: 4000 }))
            .toHaveTextContent(/could not read the automation settings/i)
        expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    })

    it('adopts a policy someone else changed while nothing is being edited', async () => {
        getAggregationSettings.mockResolvedValue(SETTINGS)
        const { qc } = wrap(<AutomationModal open onClose={() => {}} isAdmin summary={null} />)

        // The detectors decide what COUNTS as a finding, so they live under
        // ② Check now, not ③ Act.
        await openAdvanced('Check')
        // `detectors: null` seeds every box ticked.
        expect(await screen.findByLabelText(/Rollups went missing/)).toBeChecked()

        getReconciliation.mockResolvedValue({
            policy: { ...RECON_POLICY, detectors: ['raw_drift'] }, runs: [],
        })
        await repoll(qc)

        await waitFor(() => expect(screen.getByLabelText(/Rollups went missing/)).not.toBeChecked())
    })

    it('stops adopting once you edit, and says the settings moved under you', async () => {
        getAggregationSettings.mockResolvedValue(SETTINGS)
        const { qc } = wrap(<AutomationModal open onClose={() => {}} isAdmin summary={null} />)

        await openAdvanced('Act')
        const capBox = await screen.findByLabelText('At most, each check')
        await userEvent.type(capBox, '3')

        getReconciliation.mockResolvedValue({
            policy: { ...RECON_POLICY, detectors: ['raw_drift'] }, runs: [],
        })
        await repoll(qc)

        expect(capBox).toHaveValue(3)
        // The edit-in-progress survives — and the reader is told, rather than
        // discovering it by overwriting a colleague on Save.
        await openAdvanced('Check')
        expect(screen.getByLabelText(/Rollups went missing/)).toBeChecked()
        expect(await screen.findByRole('status'))
            .toHaveTextContent(/changed these settings while you were editing/i)
    })

    it('closed, it puts nothing on the page', () => {
        wrap(<AutomationModal open={false} onClose={() => {}} isAdmin summary={null} />)

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
        // The cadence record is admin-only and there is nothing to seed yet.
        expect(getAggregationSettings).not.toHaveBeenCalled()
    })

    it('keeps the form when a later poll fails, and says so without taking it away', async () => {
        // query-core marks a query `status: 'error'` when a BACKGROUND refetch
        // fails, even though the cached policy is still there. Reading that as
        // "cannot be read" pulled the whole form — including unsaved typing and
        // the Save button — behind an alert until the next successful poll.
        getAggregationSettings.mockResolvedValue(SETTINGS)
        const { qc } = wrap(<AutomationModal open onClose={() => {}} isAdmin summary={null} />)

        await openAdvanced('Act')
        const capBox = await screen.findByLabelText('At most, each check')
        await userEvent.type(capBox, '7')

        getReconciliation.mockRejectedValue(new Error('gone'))
        await repoll(qc)

        // `useReconciliation` sets its own `retry: 1`, so the error state lands
        // one backoff after the invalidation.
        expect(await screen.findByText(/could not be refreshed just now/i, {}, { timeout: 4000 }))
            .toBeInTheDocument()
        expect(capBox).toHaveValue(7)
        expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('the words beside a switch are a click target, not just decoration', async () => {
        getAggregationSettings.mockResolvedValue(SETTINGS)
        wrap(<AutomationModal open onClose={() => {}} isAdmin summary={null} />)

        const label = await screen.findByText('Watch for changes made outside this app')
        const toggle = screen.getByRole('switch', { name: /Watch for changes made outside this app/ })
        expect(toggle).toBeChecked()

        await userEvent.click(label)

        await waitFor(() => expect(toggle).not.toBeChecked())
    })

    it('Escape closes straight away while nothing has been typed', async () => {
        // Guarding an untouched form would be a dialog that exists to be
        // clicked through, which is how people learn to stop reading them.
        getAggregationSettings.mockResolvedValue(SETTINGS)
        const onClose = vi.fn()
        wrap(<AutomationModal open onClose={onClose} isAdmin summary={null} />)

        await screen.findByRole('button', { name: 'Save' })
        await userEvent.keyboard('{Escape}')

        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('Escape asks before it throws away an edit', async () => {
        // Hosting this in a modal handed it three ways to lose work — Escape,
        // the backdrop and the × — that the inline panel it replaced did not
        // have. All three go through the same guard.
        getAggregationSettings.mockResolvedValue(SETTINGS)
        const onClose = vi.fn()
        wrap(<AutomationModal open onClose={onClose} isAdmin summary={null} />)

        await openAdvanced('Act')
        await userEvent.type(await screen.findByLabelText('At most, each check'), '5')
        await userEvent.keyboard('{Escape}')

        expect(onClose).not.toHaveBeenCalled()
        expect(screen.getByRole('alertdialog')).toHaveTextContent(/unsaved changes will be lost/i)

        // Keep editing puts the form back exactly as it was, edit included —
        // and hands focus back to the panel. Left on <body>, useModalA11y's
        // trap never engages again (it only acts from the panel or an end
        // stop), so the next Tab walks into the page behind the modal.
        await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
        expect(document.activeElement).toBe(screen.getByRole('dialog'))
        expect(screen.getByLabelText('At most, each check')).toHaveValue(5)

        // And the × asks too — it is a dismissal gesture, not a decision.
        await userEvent.click(screen.getByRole('button', { name: /close automation settings/i }))
        expect(onClose).not.toHaveBeenCalled()

        await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('Escape backs out of the discard prompt it just raised', async () => {
        // The prompt is summoned BY Escape, so Escape is the key a reader will
        // reach for to leave it. The parent's document listener is still live
        // while the prompt is up, so that press routed to `requestClose` and
        // set `showCloseConfirm` to the value it already held — React bailed
        // out of the render and the guard answered the key that raised it with
        // silence.
        getAggregationSettings.mockResolvedValue(SETTINGS)
        const onClose = vi.fn()
        wrap(<AutomationModal open onClose={onClose} isAdmin summary={null} />)

        await openAdvanced('Act')
        await userEvent.type(await screen.findByLabelText('At most, each check'), '5')
        await userEvent.keyboard('{Escape}')
        expect(screen.getByRole('alertdialog')).toBeInTheDocument()

        await userEvent.keyboard('{Escape}')

        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
        // Backing out of the prompt is not closing the modal, and the edit the
        // whole exchange was about is still there.
        expect(onClose).not.toHaveBeenCalled()
        expect(screen.getByLabelText('At most, each check')).toHaveValue(5)
    })

    it('the discard prompt holds the keyboard, so the form behind it cannot be saved', async () => {
        // Borrowing ProviderOnboardingWizard's confirm shape was right, but that
        // wizard's parent has no focus trap; pairing it with useModalA11y made a
        // NEW interaction, where Shift+Tab reached Save and a keyboard user
        // could commit the very changes they were being asked about.
        getAggregationSettings.mockResolvedValue(SETTINGS)
        wrap(<AutomationModal open onClose={() => {}} isAdmin summary={null} />)

        await openAdvanced('Act')
        await userEvent.type(await screen.findByLabelText('At most, each check'), '5')
        await userEvent.keyboard('{Escape}')

        const keep = screen.getByRole('button', { name: 'Keep editing' })
        const discard = screen.getByRole('button', { name: 'Discard' })
        expect(document.activeElement).toBe(keep)

        await userEvent.tab({ shift: true })
        expect(document.activeElement).toBe(discard)

        await userEvent.tab()
        expect(document.activeElement).toBe(keep)
    })

    it('a detector explains itself to a screen reader, not only on screen', async () => {
        // The hint used to sit INSIDE the <label>, so it reached the accessible
        // name. Moving it out for a cleaner name silently left screen-reader
        // users with "Rollups shrank" and no explanation at all.
        getAggregationSettings.mockResolvedValue(SETTINGS)
        wrap(<AutomationModal open onClose={() => {}} isAdmin summary={null} />)

        await openAdvanced('Check')

        expect(await screen.findByLabelText('Rollups shrank'))
            .toHaveAccessibleDescription(/far fewer rollups than the last build produced/i)
    })

    it('never tells a reader who cannot see Detect that it is feeding Check', async () => {
        // `starvedIntoCheck` is false for a non-admin — correctly, since we must
        // not claim the probe is off. But that made the first seam read
        // `feeding` to exactly the reader the pill beside it reads `hidden` to.
        wrap(<AutomationModal open onClose={() => {}} isAdmin={false} summary={null} />)

        await screen.findByRole('heading', { name: 'Detect' })
        // The seam into Act is still knowable, so exactly one caption remains.
        expect(screen.getAllByText('feeding')).toHaveLength(1)
    })
})

/** Moved verbatim (assertions unchanged) from CadenceControls' `admin cadence
 *  popover` block when the dialog was deleted. The panel is the editor now, so
 *  only how the values are reached changed — a DurationField in seconds
 *  instead of a bare minutes box. */
describe('admin automation save', () => {
    it('seeds from the persisted cadence and Save fires the cadence PUT', async () => {
        getAggregationSettings.mockResolvedValue({
            tuning: null, cadence: { rebuildMinIntervalSecs: 600, driftAutoRebuild: false },
            envRebuildMinIntervalSecs: 900, envDriftAutoRebuild: true,
            envProbeEnabled: true, envProbeIntervalSecs: 60,
        })
        putAggregationCadence.mockResolvedValue({ tuning: null, cadence: { rebuildMinIntervalSecs: 120, driftAutoRebuild: false } })
        wrap(<AutomationModal open onClose={() => {}} isAdmin summary={null} />)

        const input = await screen.findByLabelText('Minimum time between rebuilds (custom, seconds)')
        // Seeded straight from the stored 600s — no minutes/seconds arithmetic
        // for the reader, which is the whole point of the shared control.
        await waitFor(() => expect(input).toHaveValue(600))

        await userEvent.clear(input)
        await userEvent.type(input, '120')
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        await waitFor(() => expect(putAggregationCadence).toHaveBeenCalledWith(
            {
                rebuildMinIntervalSecs: 120, driftAutoRebuild: false,
                probeEnabled: true, probeIntervalSecs: null,
            },
        ))
    })

    it('no persisted cadence: a plain Save round-trips the env defaults (no drift clobber)', async () => {
        // Deploy env has drift-auto and change-detection OFF, and no persisted
        // cadence. Both toggles must seed from their env default (false), so an
        // interval-only Save does NOT switch either on fleet-wide. Every toggle
        // added to this panel inherits the same hazard, hence both here.
        getAggregationSettings.mockResolvedValue({
            tuning: null, cadence: null,
            envRebuildMinIntervalSecs: 900, envDriftAutoRebuild: false,
            envProbeEnabled: false, envProbeIntervalSecs: 60,
        })
        putAggregationCadence.mockResolvedValue({ tuning: null, cadence: null })
        wrap(<AutomationModal open onClose={() => {}} isAdmin summary={null} />)

        const toggle = await screen.findByLabelText(/Automatically rebuild a source when drift is detected/i)
        await waitFor(() => expect(toggle).not.toBeChecked())

        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        await waitFor(() => expect(putAggregationCadence).toHaveBeenCalledWith(
            {
                rebuildMinIntervalSecs: null, driftAutoRebuild: false,
                probeEnabled: false, probeIntervalSecs: null,
            },
        ))
        // The other half of the same sequenced write. `detectors` is seeded
        // through `?? allDetectors`, so a Save from unseeded state would send
        // the initial `[]` — a real configuration meaning "act on nothing"
        // — and silently disarm every detector fleet-wide.
        expect(putReconciliation).toHaveBeenCalledWith(
            expect.objectContaining({ detectors: RECON_POLICY.allDetectors }),
        )
    })

    it('seeds the shrink allowance from the stored policy', async () => {
        // `shrinkTolerancePct` reached the API before it reached any UI, so it
        // arrived here untested across all four of its paths: seed, edit,
        // validate, write. These three cover them.
        getAggregationSettings.mockResolvedValue(SETTINGS)
        getReconciliation.mockResolvedValue({
            policy: { ...RECON_POLICY, shrinkTolerancePct: 25 }, runs: [],
        })
        wrap(<AutomationModal open onClose={() => {}} isAdmin summary={null} />)

        await openAdvanced('Check')
        expect(await screen.findByLabelText('Allow rollups to shrink by')).toHaveValue(25)
    })

    it('sends the shrink allowance in the policy write', async () => {
        getAggregationSettings.mockResolvedValue(SETTINGS)
        putAggregationCadence.mockResolvedValue({ tuning: null, cadence: null })
        wrap(<AutomationModal open onClose={() => {}} isAdmin summary={null} />)

        await openAdvanced('Check')
        await userEvent.type(await screen.findByLabelText('Allow rollups to shrink by'), '25')
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        await waitFor(() => expect(putReconciliation).toHaveBeenCalledWith(
            expect.objectContaining({ shrinkTolerancePct: 25 }),
        ))
    })

    it('a cadence failure after the policy landed says exactly which half saved', async () => {
        const onClose = vi.fn()
        getAggregationSettings.mockResolvedValue(SETTINGS)
        putAggregationCadence.mockRejectedValue(new Error('control plane unreachable'))
        wrap(<AutomationModal open onClose={onClose} isAdmin summary={null} />)

        await screen.findByRole('button', { name: 'Save' })
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        await waitFor(() => expect(putAggregationCadence).toHaveBeenCalled())
        // The policy PUT already committed fleet-wide; a generic "could not
        // save" would be a lie about half the form.
        const { useToastStore } = await import('@/components/ui/toast')
        await waitFor(() => expect(
            useToastStore.getState().toasts.some(t =>
                /watch policy saved, but/i.test(t.message)),
        ).toBe(true))
        // The modal stays open and dirty-guarded for the retry.
        expect(onClose).not.toHaveBeenCalled()
        expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('a policy failure saves nothing and the cadence PUT never fires', async () => {
        const onClose = vi.fn()
        getAggregationSettings.mockResolvedValue(SETTINGS)
        putReconciliation.mockRejectedValue(new Error('nope'))
        wrap(<AutomationModal open onClose={onClose} isAdmin summary={null} />)

        await screen.findByRole('button', { name: 'Save' })
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        await waitFor(() => expect(putReconciliation).toHaveBeenCalled())
        expect(putAggregationCadence).not.toHaveBeenCalled()
        expect(onClose).not.toHaveBeenCalled()
    })

    it('refuses a shrink allowance outside 0–100 rather than letting the server 422', async () => {
        getAggregationSettings.mockResolvedValue(SETTINGS)
        putAggregationCadence.mockResolvedValue({ tuning: null, cadence: null })
        wrap(<AutomationModal open onClose={() => {}} isAdmin summary={null} />)

        await openAdvanced('Check')
        const box = await screen.findByLabelText('Allow rollups to shrink by')
        await userEvent.type(box, '150')
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        expect(putReconciliation).not.toHaveBeenCalled()

        // The same Save goes through once the number is legal, so the refusal
        // was about the value and not a button that never worked.
        await userEvent.clear(box)
        await userEvent.type(box, '15')
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        await waitFor(() => expect(putReconciliation).toHaveBeenCalledWith(
            expect.objectContaining({ shrinkTolerancePct: 15 }),
        ))
    })

    it('says out loud that a check cannot outrun a detector that is off', async () => {
        // The dependency the modal hid: Detect feeds Check, so Detect off
        // makes the Check interval a promise nobody can keep.
        getAggregationSettings.mockResolvedValue({
            tuning: null, cadence: null,
            envRebuildMinIntervalSecs: 900, envDriftAutoRebuild: true,
            envProbeEnabled: false, envProbeIntervalSecs: 60,
        })
        wrap(<AutomationModal open onClose={() => {}} isAdmin summary={null} />)

        expect(await screen.findByText(/only see data as fresh as/i)).toBeInTheDocument()
        // And shows it: the connector into ② Check goes dashed, amber and
        // labelled. The word is the half of that state a screenshot-blind
        // reader still gets — colour is never the only carrier.
        expect(screen.getByText('starved')).toBeInTheDocument()
    })
})
