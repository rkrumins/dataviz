/**
 * The mapping studio.
 *
 * Two jobs for this file. The first block re-asserts every behaviour the
 * old `ClaimMappingEditor` tests pinned, because a rewrite is exactly where
 * a three-state default semantics quietly becomes two. The second covers
 * what is new: the preview runs without a saved provider, it runs without
 * being asked, and a key can be assigned by clicking it.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { ClaimMappingStudio, type ClaimMapping } from '../ClaimMappingStudio'

const { getDefaultMapping, testMapping, previewMapping, lastAssertion } =
    vi.hoisted(() => ({
        getDefaultMapping: vi.fn(),
        testMapping: vi.fn(),
        previewMapping: vi.fn(),
        lastAssertion: vi.fn(),
    }))

vi.mock('@/services/ssoAdminService', async () => {
    const actual = await vi.importActual<typeof import('@/services/ssoAdminService')>(
        '@/services/ssoAdminService',
    )
    return {
        ...actual,
        ssoAdminService: {
            ...actual.ssoAdminService,
            getDefaultMapping, testMapping, previewMapping, lastAssertion,
        },
    }
})

const DEFAULTS = {
    external_id: ['sub'],
    email: ['email', 'emailAddress'],
    first_name: ['firstName'],
    last_name: ['lastName'],
    display_name: ['fullName'],
    groups: ['groups'],
    auth_time: ['iat'],
    email_verified: ['email_verified'],
    extras: {},
}

function resolved(over: Record<string, unknown> = {}) {
    return {
        providerSlug: 'corp-portal',
        resolved: {
            external_id: 'u1', email: 'a@corp.example',
            first_name: 'Alice', last_name: 'Doe',
            groups: ['Eng'], auth_time: null, attributes: {},
        },
        resolvedFrom: { external_id: 'sub', email: 'email' },
        ...over,
    }
}

function Harness({
    providerId, onReadFromBrowser, initialSample,
}: {
    providerId?: string
    onReadFromBrowser?: () => string | null
    initialSample?: string
} = {}) {
    const [mapping, setMapping] = useState<ClaimMapping>({})
    return (
        <>
            <ClaimMappingStudio
                kind="custom_profile"
                providerId={providerId}
                value={mapping}
                onChange={setMapping}
                onReadFromBrowser={onReadFromBrowser}
                initialSample={initialSample}
            />
            <pre data-testid="mapping">{JSON.stringify(mapping)}</pre>
        </>
    )
}

function currentMapping(): ClaimMapping {
    return JSON.parse(screen.getByTestId('mapping').textContent || '{}')
}

/** The raw textarea is folded away by default now — pasting is no longer
 *  the primary interaction, so it has to be opened first. */
async function openRaw(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: /edit raw payload/i }))
    return screen.getByPlaceholderText(/or a JWT/)
}

beforeEach(() => {
    vi.clearAllMocks()
    getDefaultMapping.mockResolvedValue(DEFAULTS)
    previewMapping.mockResolvedValue(resolved())
    testMapping.mockResolvedValue(resolved({ providerId: 'idp_1' }))
})

// ── Parity with the editor this replaces ─────────────────────────────

describe('mapping semantics', () => {
    it('seeds each field from the kind defaults without writing an override', async () => {
        render(<Harness />)
        await waitFor(() =>
            expect(getDefaultMapping).toHaveBeenCalledWith('custom_profile'))
        expect(await screen.findByText('emailAddress')).toBeInTheDocument()
        // An untouched field must fall through to the backend default.
        expect(currentMapping()).toEqual({})
        expect(screen.getAllByText('default').length).toBeGreaterThan(0)
    })

    it('writes an ordered candidate list when a key is added', async () => {
        const user = userEvent.setup()
        render(<Harness />)
        await screen.findByText('emailAddress')

        const inputs = screen.getAllByLabelText('Add a source key')
        // Row order matches FIELDS: external_id first, then email.
        await user.type(inputs[1], 'mail{Enter}')

        await waitFor(() =>
            expect(currentMapping().email).toEqual(['email', 'emailAddress', 'mail']))
    })

    it('lets a defaulted field be cleared, and keeps it cleared', async () => {
        const user = userEvent.setup()
        render(<Harness />)
        await screen.findByText('fullName')

        await user.click(screen.getByLabelText('Remove fullName'))

        // Explicitly empty is not the same as inherit: the default must
        // not creep back on the next render.
        await waitFor(() => expect(currentMapping().display_name).toEqual([]))
        expect(screen.queryByText('fullName')).toBeNull()
    })

    it('reverts a single field back to inheriting the default', async () => {
        const user = userEvent.setup()
        render(<Harness />)
        await screen.findByText('fullName')

        await user.click(screen.getByLabelText('Remove fullName'))
        await waitFor(() => expect(currentMapping().display_name).toEqual([]))

        await user.click(screen.getAllByRole('button', { name: /use default/i })[0])

        await waitFor(() => expect('display_name' in currentMapping()).toBe(false))
        expect(await screen.findByText('fullName')).toBeInTheDocument()
    })

    it('resets every override back to the defaults', async () => {
        const user = userEvent.setup()
        render(<Harness />)
        await screen.findByText('emailAddress')

        await user.type(screen.getAllByLabelText('Add a source key')[1], 'mail{Enter}')
        await waitFor(() => expect(currentMapping().email).toBeDefined())

        await user.click(screen.getByRole('button', { name: /reset to defaults/i }))
        expect(currentMapping()).toEqual({})
    })

    it('adds and names an extra attribute', async () => {
        const user = userEvent.setup()
        render(<Harness />)
        await screen.findByText('emailAddress')

        await user.type(screen.getByLabelText('New attribute name'), 'staff_id')
        await user.click(screen.getByRole('button', { name: 'Add' }))
        await waitFor(() => expect(currentMapping().extras).toEqual({ staff_id: [] }))

        await user.type(screen.getAllByPlaceholderText('source key…')[0],
                        'staffNumber{Enter}')
        await waitFor(() =>
            expect(currentMapping().extras).toEqual({ staff_id: ['staffNumber'] }))
    })
})

describe('sample sources', () => {
    it('lists the keys found in a pasted sample', async () => {
        const user = userEvent.setup()
        render(<Harness />)
        await screen.findByText('emailAddress')

        const raw = await openRaw(user)
        await user.click(raw)
        await user.paste('{"employeeId":"12345","user":{"emailAddress":"a@corp.example"}}')

        expect(await screen.findByText('employeeId')).toBeInTheDocument()
        expect(screen.getByText('user')).toBeInTheDocument()
    })

    it('pulls the real object from the browser when offered', async () => {
        const user = userEvent.setup()
        const read = vi.fn(() => '{"staffNumber":"999"}')
        render(<Harness onReadFromBrowser={read} />)
        await screen.findByText('emailAddress')

        await user.click(screen.getByRole('button', { name: /read from my browser/i }))

        expect(read).toHaveBeenCalled()
        expect(await screen.findByText('staffNumber')).toBeInTheDocument()
    })

    it('explains an empty storage key rather than failing silently', async () => {
        const user = userEvent.setup()
        render(<Harness onReadFromBrowser={() => null} />)
        await screen.findByText('emailAddress')

        await user.click(screen.getByRole('button', { name: /read from my browser/i }))

        expect(await screen.findByText(/nothing found under that key/i))
            .toBeInTheDocument()
    })

    it('hides the browser-read button when the source cannot be read client-side', async () => {
        render(<Harness />)
        await screen.findByText('emailAddress')
        expect(screen.queryByRole('button', { name: /read from my browser/i })).toBeNull()
    })

    it('warns that an example payload is not from your IdP', async () => {
        // A mapping validated against a vendor example can be confidently
        // wrong about the tenant in front of you. Nothing used to say so.
        render(<Harness initialSample='{"sub":"u1","email":"a@corp.example"}' />)
        expect(await screen.findByText(/not from your idp/i)).toBeInTheDocument()
    })

    it('offers a real assertion as an upgrade over the example', async () => {
        const user = userEvent.setup()
        lastAssertion.mockResolvedValue({
            claims: { sub: 'real-1', email: 'real@corp.example' },
            capturedAt: new Date().toISOString(),
        })
        render(<Harness providerId="idp_1"
                        initialSample='{"sub":"u1","email":"a@corp.example"}' />)
        await screen.findByText(/example payload/i)

        await user.click(screen.getByRole('button', { name: /use last real assertion/i }))

        expect(await screen.findByText(/real assertion/i)).toBeInTheDocument()
        // …and having got one, it stops offering the weaker source.
        expect(screen.queryByRole('button', { name: /use last real assertion/i }))
            .toBeNull()
    })
})

// ── What is new ──────────────────────────────────────────────────────

describe('live preview', () => {
    it('resolves with no provider saved — the reason this exists', async () => {
        // The wizard's step 3. The old editor disabled preview outright
        // here, so the guidance promised a preview that could never run.
        render(<Harness initialSample='{"sub":"u1","email":"a@corp.example"}' />)

        await waitFor(() => expect(previewMapping).toHaveBeenCalled())
        expect(testMapping).not.toHaveBeenCalled()
        // Once in the payload pane, once as the value it resolved to —
        // the two panes referring to each other is the whole design.
        expect(await screen.findAllByText('a@corp.example')).toHaveLength(2)
    })

    it('resolves without anyone pressing a button', async () => {
        const user = userEvent.setup()
        render(<Harness />)
        await screen.findByText('emailAddress')
        expect(screen.queryByRole('button', { name: /^preview$/i })).toBeNull()

        const raw = await openRaw(user)
        await user.click(raw)
        await user.paste('{"sub":"u1","email":"a@corp.example"}')

        await waitFor(() => expect(previewMapping).toHaveBeenCalled())
    })

    it('previews against the saved row when there is one', async () => {
        render(<Harness providerId="idp_1"
                        initialSample='{"sub":"u1","email":"a@corp.example"}' />)
        await waitFor(() => expect(testMapping).toHaveBeenCalled())
        expect(previewMapping).not.toHaveBeenCalled()
    })

    it('does not fire a request for a sample that is not JSON yet', async () => {
        const user = userEvent.setup()
        render(<Harness />)
        await screen.findByText('emailAddress')

        const raw = await openRaw(user)
        await user.click(raw)
        await user.paste('{"sub": ')

        await new Promise(r => setTimeout(r, 500))
        expect(previewMapping).not.toHaveBeenCalled()
        expect(await screen.findByText(/not json or a jwt yet/i)).toBeInTheDocument()
    })

    it('says which candidate key actually won', async () => {
        previewMapping.mockResolvedValue(resolved({
            resolvedFrom: { external_id: 'sub', email: 'emailAddress' },
        }))
        render(<Harness initialSample='{"sub":"u1","emailAddress":"a@corp.example"}' />)

        expect(await screen.findByText('emailAddress', { selector: 'code' }))
            .toBeInTheDocument()
    })

    it('marks a required field that resolves nothing as a failing sign-in', async () => {
        previewMapping.mockResolvedValue(resolved({
            resolvedFrom: { external_id: 'sub', email: null },
        }))
        render(<Harness initialSample='{"sub":"u1"}' />)

        expect(await screen.findByText(/sign-in would fail/i)).toBeInTheDocument()
    })

    it('surfaces the backend error rather than throwing it away', async () => {
        previewMapping.mockRejectedValue(
            new Error("Claim mapping for provider 'corp-portal' could not resolve email"),
        )
        render(<Harness initialSample='{"sub":"u1"}' />)

        expect(await screen.findByText(/could not resolve email/i)).toBeInTheDocument()
    })
})

describe('IdP-managed fields', () => {
    // Mapping a name is no longer only "fill this field": main's
    // identity_provenance hands the field to the IdP and refuses the
    // person's own edits with 409. The operator taking that decision
    // could not see it from either screen.
    it('marks the two fields that become read-only on the profile', async () => {
        previewMapping.mockResolvedValue(resolved({
            resolvedFrom: {
                external_id: 'sub', email: 'email',
                first_name: 'firstName', last_name: 'lastName',
            },
        }))
        render(<Harness initialSample={JSON.stringify({
            sub: 'u1', email: 'a@x.com', firstName: 'Alice', lastName: 'Doe',
        })} />)

        expect(await screen.findAllByText('IdP-managed')).toHaveLength(2)
        expect(await screen.findAllByText(/no longer\s+theirs to edit/i))
            .toHaveLength(2)
    })

    it('leaves display name and email unmarked, which is the whole point', async () => {
        // display_name is the one a person can always set for themselves —
        // the reason locking the other two is tolerable. Marking all four
        // would be wrong and entirely plausible-looking.
        previewMapping.mockResolvedValue(resolved({
            resolvedFrom: {
                external_id: 'sub', email: 'email', display_name: 'fullName',
                first_name: null, last_name: null,
            },
        }))
        render(<Harness initialSample={JSON.stringify({
            sub: 'u1', email: 'a@x.com', fullName: 'Alice Doe',
        })} />)

        // display_name has no resolved value of its own — the mapper folds it
        // into first/last — so wait on a field that does render one.
        await screen.findByText('email', { selector: 'code' })
        expect(screen.queryByText('IdP-managed')).toBeNull()
    })

    it('does not claim a field whose mapping resolves nothing', async () => {
        // asserted_fields gates on the value, not on a candidate being
        // listed. A mapping that resolves nothing takes nothing.
        previewMapping.mockResolvedValue(resolved({
            resolvedFrom: {
                external_id: 'sub', email: 'email',
                first_name: null, last_name: null,
            },
        }))
        render(<Harness initialSample='{"sub":"u1","email":"a@x.com"}' />)

        await screen.findByText('email', { selector: 'code' })
        expect(screen.queryByText('IdP-managed')).toBeNull()
    })
})

describe('a full name split into halves', () => {
    // An IdP that releases only `name` still populates both name fields —
    // the mapper splits the full name. But none of *their* candidates
    // fired, so resolvedFrom is null for each, and this pane read that as
    // "Nothing resolved" beside two values the login would go on to write.
    const SPLIT = {
        resolvedFrom: {
            external_id: 'sub', email: 'email',
            display_name: 'fullName', first_name: null, last_name: null,
        },
        namesDerivedFrom: 'fullName',
    }
    const SAMPLE = JSON.stringify({
        sub: 'u1', email: 'a@x.com', fullName: 'Alice Doe',
    })

    /** One field's row, so a claim about First name is not answered by
     *  Groups — several rows legitimately resolve nothing here. */
    function row(label: string) {
        return within(screen.getByText(label).closest('li')!)
    }

    it('shows the value it resolved to, not "nothing resolved"', async () => {
        previewMapping.mockResolvedValue(resolved(SPLIT))
        render(<Harness initialSample={SAMPLE} />)

        expect(await screen.findAllByText(/split from/i)).toHaveLength(2)
        expect(row('First name').getByText('Alice')).toBeInTheDocument()
        expect(row('Last name').getByText('Doe')).toBeInTheDocument()
        expect(row('First name').queryByText(/nothing resolved/i)).toBeNull()
    })

    it("shows the full name's own resolved value on its row", async () => {
        // This row used to read "Paste a sample to see this resolve"
        // while its winning chip sat highlighted green — the one screen
        // an operator debugs a full-name-only IdP on, lying about the
        // field doing all the work.
        previewMapping.mockResolvedValue(resolved({
            ...SPLIT,
            resolved: {
                external_id: 'u1', email: 'a@x.com',
                first_name: 'Alice', last_name: 'Doe',
                groups: [], auth_time: null, attributes: {},
                display_name: 'Alice Doe',
            },
        }))
        render(<Harness initialSample={SAMPLE} />)

        await screen.findAllByText(/split from/i)
        // The label also appears as a mapped-badge in the payload pane;
        // the profile row is the one inside a list item.
        const rowEl = screen.getAllByText('Full / display name')
            .map((el) => el.closest('li'))
            .find((el): el is HTMLLIElement => el !== null)!
        expect(within(rowEl).getByText('Alice Doe')).toBeInTheDocument()
        expect(within(rowEl).queryByText(/paste a sample/i)).toBeNull()
    })

    it('names the claim it was split out of', async () => {
        previewMapping.mockResolvedValue(resolved(SPLIT))
        render(<Harness initialSample={SAMPLE} />)

        // Twice for the two name rows, once more as display_name's own
        // winning candidate chip.
        expect(await screen.findAllByText('fullName', { selector: 'code' }))
            .not.toHaveLength(0)
    })

    it('does not hand the field to the connection', async () => {
        // The substantive half: ownership costs the person the ability to
        // correct the field and re-applies our answer every login. We are
        // not claiming that on the strength of a guess.
        previewMapping.mockResolvedValue(resolved(SPLIT))
        render(<Harness initialSample={SAMPLE} />)

        await screen.findAllByText(/split from/i)
        expect(screen.queryByText('IdP-managed')).toBeNull()
        expect(screen.getAllByText(/stays editable/i)).toHaveLength(2)
    })

    it('still hands it over when the IdP names the halves itself', async () => {
        // The asymmetry is the assertion worth having — it would be easy
        // to fix the lock by never locking anything.
        previewMapping.mockResolvedValue(resolved({
            resolvedFrom: {
                external_id: 'sub', email: 'email',
                first_name: 'firstName', last_name: 'lastName',
            },
            namesDerivedFrom: null,
        }))
        render(<Harness initialSample={JSON.stringify({
            sub: 'u1', email: 'a@x.com', firstName: 'Alice', lastName: 'Doe',
        })} />)

        expect(await screen.findAllByText('IdP-managed')).toHaveLength(2)
        expect(screen.queryByText(/split from/i)).toBeNull()
    })
})

describe('click to assign', () => {
    it('assigns a payload key to a field from its menu', async () => {
        const user = userEvent.setup()
        render(<Harness initialSample='{"sub":"u1","email":"a@x.com","staffNo":"99"}' />)
        await screen.findByText('staffNo')

        await user.click(screen.getByRole('button', { name: /staffNo/ }))
        await user.click(within(screen.getByRole('menu'))
            .getByRole('menuitem', { name: /external id/i }))

        await waitFor(() =>
            expect(currentMapping().external_id).toEqual(['sub', 'staffNo']))
    })

    it('appends rather than replaces — the list is a fallback chain', async () => {
        const user = userEvent.setup()
        render(<Harness initialSample='{"sub":"u1","email":"a@x.com","mail":"b@x.com"}' />)
        await screen.findByText('mail')

        await user.click(screen.getByRole('button', { name: /^mail/ }))
        await user.click(within(screen.getByRole('menu'))
            .getByRole('menuitem', { name: /^email$/i }))

        await waitFor(() =>
            expect(currentMapping().email).toEqual(['email', 'emailAddress', 'mail']))
    })

    it('keeps a key as an extra attribute', async () => {
        const user = userEvent.setup()
        render(<Harness initialSample='{"sub":"u1","email":"a@x.com","staffNo":"99"}' />)
        await screen.findByText('staffNo')

        await user.click(screen.getByRole('button', { name: /staffNo/ }))
        await user.click(within(screen.getByRole('menu'))
            .getByRole('menuitem', { name: /extra attribute/i }))

        await waitFor(() =>
            expect(currentMapping().extras).toEqual({ staffNo: ['staffNo'] }))
    })

    it('shows a candidate that can never fire as shadowed', async () => {
        // `email` wins, so `emailAddress` below it is dead weight the
        // operator is maintaining for nothing.
        previewMapping.mockResolvedValue(resolved({
            resolvedFrom: { external_id: 'sub', email: 'email' },
        }))
        render(<Harness
            initialSample='{"sub":"u1","email":"a@x.com","emailAddress":"b@x.com"}' />)

        expect(await screen.findByText('shadowed')).toBeInTheDocument()
    })
})
