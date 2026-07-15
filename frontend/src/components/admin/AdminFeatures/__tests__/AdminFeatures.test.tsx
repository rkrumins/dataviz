/**
 * Turning a feature OFF asks first. Turning it ON does not.
 *
 * That asymmetry is the redesign's central claim, and it is the kind that rots quietly: someone
 * simplifies the toggle handler, the confirmation stops appearing, and nothing fails — the page
 * just goes back to letting an admin remove a capability from every user of the deployment with
 * one unexamined click, which is exactly how it behaved before.
 *
 * So it is pinned here, from the outside, the way a user meets it.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminFeatures } from '../index'
import type { FeatureDefinition } from '@/services/featuresService'

// jsdom has no matchMedia, and the page's Toast/ResetConfirmModal ask it whether the user prefers
// reduced motion. A browser always answers; the test environment has to be told to.
beforeAll(() => {
    window.matchMedia = window.matchMedia ?? (((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia)
})

const handleChange = vi.fn()

/** Mutable so a test can put the page into "just saved" and reach for Undo. */
const hookState = { toastVisible: false, savingKey: null as string | null }

/** The impact probe is a network call; each test says what it should answer. */
const impact = vi.fn()
vi.mock('@/services/featuresService', async importOriginal => {
    const actual = await importOriginal<typeof import('@/services/featuresService')>()
    return {
        ...actual,
        featuresService: { ...actual.featuresService, impact: (k: string) => impact(k) },
    }
})

const TRACE: FeatureDefinition = {
    key: 'traceEnabled',
    name: 'Lineage trace',
    description: 'Follow a node’s lineage upstream and downstream.',
    category: 'lineage',
    type: 'boolean',
    default: true,
    enforcedServerSide: true,
    implemented: true,
    impactWhenOff: 'The Trace button disappears and the server refuses trace requests.',
    stillAllowed: ['Browsing the graph by hand'],
    serverGates: ['POST /graph/trace'],
    uiSurfaces: ['Trace button in the toolbars'],
}

const SIGNUP: FeatureDefinition = {
    key: 'signupEnabled',
    name: 'Self-registration',
    description: 'Let anyone create their own account.',
    category: 'auth',
    type: 'boolean',
    default: false,
    enforcedServerSide: true,
    implemented: true,
    posture: 'security',
    impactWhenOff: 'Strangers cannot create accounts.',
}

vi.mock('@/hooks/useAdminFeatures', () => ({
    SEARCH_MIN_FEATURES: 100, // keep the search box out of the way
    useAdminFeatures: () => ({
        data: {
            schema: [TRACE, SIGNUP],
            categories: [
                { id: 'lineage', label: 'Lineage', icon: 'GitBranch', color: 'amber', preview: false },
                { id: 'auth', label: 'Authentication', icon: 'UserPlus', color: 'emerald', preview: false },
            ],
            // traceEnabled ON, signupEnabled OFF.
            values: { traceEnabled: true, signupEnabled: false },
            version: 1,
            updatedAt: '2026-07-14T12:00:00Z',
        },
        isLoading: false,
        error: null,
        load: vi.fn(),
        handleChange,
        savingKey: hookState.savingKey,
        toastVisible: hookState.toastVisible,
        setToastVisible: vi.fn(),
        errorToastVisible: false,
        setErrorToastVisible: vi.fn(),
        errorToastMessage: '',
        resetConfirmOpen: false,
        setResetConfirmOpen: vi.fn(),
        handleReset: vi.fn(),
        resetLoading: false,
        defaultsHintDismissed: true,
        setDefaultsHintDismissed: vi.fn(),
        searchQuery: '',
        setSearchQuery: vi.fn(),
        resetModalRef: { current: null },
        cancelButtonRef: { current: null },
        updateNotice: vi.fn(),
    }),
}))

beforeEach(() => {
    handleChange.mockClear()
    hookState.toastVisible = false
    impact.mockReset()
    impact.mockResolvedValue({ known: false, facts: [] })
})

/** The selected feature has a switch in the index AND in the spec pane. Both are real ways to take
 *  a capability away from every user, so both have to ask — a confirmation on one route only is a
 *  confirmation you can walk around. `which` picks the route. */
const switchesFor = (name: RegExp) => screen.getAllByRole('switch', { name })

describe('AdminFeatures — turning things off', () => {
    it.each([
        ['from the index', 0],
        ['from the spec pane', 1],
    ])('does NOT turn a feature off on the first click %s — it shows the impact and waits', async (_label, which) => {
        const user = userEvent.setup()
        render(<AdminFeatures />)

        const controls = switchesFor(/Turn Lineage trace off/i)
        expect(controls.length).toBe(2)
        await user.click(controls[which as number])

        // Nothing saved yet. The admin has been shown what it costs and asked.
        expect(handleChange).not.toHaveBeenCalled()

        // Scoped to the dialog on purpose: the impact copy is ALSO on the spec pane behind it, and
        // an unscoped match would pass even if the dialog showed nothing at all.
        const dialog = await screen.findByRole('dialog')
        expect(within(dialog).getByText(/Turn off Lineage trace\?/i)).toBeInTheDocument()
        expect(within(dialog).getByText(/the server refuses trace requests/i)).toBeInTheDocument()
        // ...and what it does NOT cost, which is the half that lets people use the switch.
        expect(within(dialog).getByText(/Browsing the graph by hand/i)).toBeInTheDocument()
    })

    it('turns it off once confirmed', async () => {
        const user = userEvent.setup()
        render(<AdminFeatures />)

        await user.click(switchesFor(/Turn Lineage trace off/i)[0])
        await user.click(await screen.findByRole('button', { name: /Turn off for everyone/i }))

        await waitFor(() => expect(handleChange).toHaveBeenCalledWith('traceEnabled', false))
    })

    it('backing out changes nothing', async () => {
        const user = userEvent.setup()
        render(<AdminFeatures />)

        await user.click(switchesFor(/Turn Lineage trace off/i)[0])
        await user.click(await screen.findByRole('button', { name: /Keep it on/i }))

        expect(handleChange).not.toHaveBeenCalled()
        await waitFor(() =>
            expect(screen.queryByText(/Turn off Lineage trace\?/i)).not.toBeInTheDocument(),
        )
    })

    it('turning a feature ON is immediate — no ceremony for giving a capability back', async () => {
        const user = userEvent.setup()
        render(<AdminFeatures />)

        await user.click(switchesFor(/Turn Self-registration on/i)[0])

        expect(handleChange).toHaveBeenCalledWith('signupEnabled', true)
        expect(screen.queryByText(/Turn off/i)).not.toBeInTheDocument()
    })
})

describe('AdminFeatures — what the page says about itself', () => {
    it('names what your users cannot do, before showing a single switch', () => {
        render(<AdminFeatures />)
        expect(screen.getByText(/Your users cannot:/i)).toBeInTheDocument()
        expect(screen.getByText(/1 of 2/)).toBeInTheDocument()
    })

    it('the bar plots STATE, sized by how many features are in each — not one tick per feature', () => {
        // The first version drew twelve identical segments, one per feature, which you could not
        // identify without hovering. Here the bands ARE the states, and a state nobody is in gets
        // no band and no legend entry — 2 features, 1 on and 1 off, is exactly two bands.
        render(<AdminFeatures />)
        const bar = screen.getByRole('img', { name: /available/i })
        expect(bar).toHaveAccessibleName('1 available, 1 turned off')
        expect(bar.children).toHaveLength(2)
    })

    it('an off feature carries its consequence in the list, unasked', () => {
        render(<AdminFeatures />)
        // signupEnabled is off, so the row shows the CONSEQUENCE rather than the description —
        // that's the sentence that matters while you're scanning for what your users have lost.
        expect(screen.getByText(/Strangers cannot create accounts/i)).toBeInTheDocument()
    })
})

// ── The three things the dialog now says that nothing else on the page would ──────

describe('ConfirmTurnOff — the facts that decide the question', () => {
    it('COUNTS what it would touch in this estate, not just what the feature does', async () => {
        // The prose says "views become read-only" on an estate of four views and one of four
        // thousand. The number is the thing that actually decides it.
        impact.mockResolvedValue({
            known: true,
            facts: [
                {
                    count: 142,
                    label: 'views',
                    consequence: 'Become read-only.',
                    tone: 'neutral',
                    detail: ['120 × graph', '22 × hierarchy'],
                },
            ],
        })
        const user = userEvent.setup()
        render(<AdminFeatures />)
        await user.click(switchesFor(/Turn Lineage trace off/i)[0])

        const dialog = await screen.findByRole('dialog')
        expect(await within(dialog).findByText('142')).toBeInTheDocument()
        expect(within(dialog).getByText(/In your estate, right now/i)).toBeInTheDocument()
        expect(within(dialog).getByText(/120 × graph/)).toBeInTheDocument()
    })

    it('says WE DID NOT MEASURE rather than showing an empty space', async () => {
        // The sharpest rule in the design. An empty space on a confirmation screen is read as
        // reassurance, and an unmeasured flag has not earned it: "we didn't look" and "we looked
        // and found nothing" are different answers, and only one of them is comforting.
        impact.mockResolvedValue({ known: false, facts: [] })
        const user = userEvent.setup()
        render(<AdminFeatures />)
        await user.click(switchesFor(/Turn Lineage trace off/i)[0])

        const dialog = await screen.findByRole('dialog')
        expect(await within(dialog).findByText(/can't measure this one/i)).toBeInTheDocument()
        expect(
            within(dialog).getByText(/not as proof that nothing is affected/i),
        ).toBeInTheDocument()
    })

    it('an empty estate is a REASSURANCE, and reads differently from an unmeasured one', async () => {
        impact.mockResolvedValue({ known: true, facts: [] })
        const user = userEvent.setup()
        render(<AdminFeatures />)
        await user.click(switchesFor(/Turn Lineage trace off/i)[0])

        const dialog = await screen.findByRole('dialog')
        expect(await within(dialog).findByText(/Nothing in your estate uses this yet/i)).toBeInTheDocument()
        expect(within(dialog).queryByText(/can't measure/i)).not.toBeInTheDocument()
    })
})

describe('Undo', () => {
    it('offers to take the last change back, and puts it back exactly as it was', async () => {
        const user = userEvent.setup()
        const { rerender } = render(<AdminFeatures />)

        // Turn Self-registration ON (instant — no confirmation for giving a capability back).
        await user.click(switchesFor(/Turn Self-registration on/i)[0])
        expect(handleChange).toHaveBeenCalledWith('signupEnabled', true)

        // The hook reports "saved", so the toast appears — carrying the escape hatch.
        handleChange.mockClear()
        hookState.toastVisible = true
        rerender(<AdminFeatures />)

        await user.click(screen.getByRole('button', { name: /Undo/i }))

        // Back to FALSE — its value before the change, not its shipped default by luck.
        expect(handleChange).toHaveBeenCalledWith('signupEnabled', false)
    })
})
