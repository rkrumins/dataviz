import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { ClaimMappingEditor, type ClaimMapping } from './ClaimMappingEditor'

const { getDefaultMapping, testMapping } = vi.hoisted(() => ({
    getDefaultMapping: vi.fn(),
    testMapping: vi.fn(),
}))

vi.mock('@/services/ssoAdminService', async () => {
    const actual = await vi.importActual<typeof import('@/services/ssoAdminService')>(
        '@/services/ssoAdminService',
    )
    return {
        ...actual,
        ssoAdminService: { ...actual.ssoAdminService, getDefaultMapping, testMapping },
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

/** Wrapper that holds the mapping so edits round-trip like they do in
 *  the real form, and exposes the current JSON for assertions. */
function Harness({ onReadFromBrowser }: { onReadFromBrowser?: () => string | null }) {
    const [mapping, setMapping] = useState<ClaimMapping>({})
    return (
        <>
            <ClaimMappingEditor
                kind="custom_profile"
                providerId="idp_1"
                value={mapping}
                onChange={setMapping}
                onReadFromBrowser={onReadFromBrowser}
            />
            <pre data-testid="mapping">{JSON.stringify(mapping)}</pre>
        </>
    )
}

function currentMapping(): ClaimMapping {
    return JSON.parse(screen.getByTestId('mapping').textContent || '{}')
}

describe('ClaimMappingEditor', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        getDefaultMapping.mockResolvedValue(DEFAULTS)
    })

    it('seeds each field from the kind defaults', async () => {
        render(<Harness />)
        await waitFor(() => expect(getDefaultMapping).toHaveBeenCalledWith('custom_profile'))
        // Defaults render as chips but stay out of the override JSON —
        // an untouched field must fall through to the backend default.
        expect(await screen.findByText('emailAddress')).toBeInTheDocument()
        expect(currentMapping()).toEqual({})
        expect(screen.getAllByText('using default').length).toBeGreaterThan(0)
    })

    it('writes an ordered candidate list when a key is added', async () => {
        const user = userEvent.setup()
        render(<Harness />)
        await screen.findByText('emailAddress')

        const inputs = screen.getAllByPlaceholderText('add a key…')
        // Row order matches FIELDS: external_id first, then email.
        await user.type(inputs[1], 'mail{Enter}')

        await waitFor(() => {
            expect(currentMapping().email).toEqual(['email', 'emailAddress', 'mail'])
        })
    })

    it('lets a defaulted field be cleared, and says so', async () => {
        const user = userEvent.setup()
        render(<Harness />)
        await screen.findByText('fullName')

        await user.click(screen.getByLabelText('Remove fullName'))

        // Explicitly empty ≠ inherit: the default must not creep back.
        await waitFor(() => expect(currentMapping().display_name).toEqual([]))
        expect(screen.queryByText('fullName')).toBeNull()
        expect(screen.getByText('not mapped')).toBeInTheDocument()
    })

    it('reverts a single field back to inheriting the default', async () => {
        const user = userEvent.setup()
        render(<Harness />)
        await screen.findByText('fullName')

        await user.click(screen.getByLabelText('Remove fullName'))
        await waitFor(() => expect(currentMapping().display_name).toEqual([]))

        await user.click(screen.getAllByRole('button', { name: 'use default' })[0])

        await waitFor(() => expect('display_name' in currentMapping()).toBe(false))
        expect(await screen.findByText('fullName')).toBeInTheDocument()
    })

    it('lists the keys found in a pasted sample', async () => {
        const user = userEvent.setup()
        render(<Harness />)
        await screen.findByText('emailAddress')

        await user.click(screen.getByPlaceholderText(/or a JWT/))
        await user.paste('{"employeeId":"12345","user":{"emailAddress":"a@corp.example"}}')

        expect(await screen.findByRole('button', { name: 'employeeId' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'user' })).toBeInTheDocument()
    })

    it('pulls the real object from the browser when offered', async () => {
        const user = userEvent.setup()
        const read = vi.fn(() => '{"staffNumber":"999"}')
        render(<Harness onReadFromBrowser={read} />)
        await screen.findByText('emailAddress')

        await user.click(screen.getByRole('button', { name: /Read from my browser/ }))

        expect(read).toHaveBeenCalled()
        expect(await screen.findByRole('button', { name: 'staffNumber' })).toBeInTheDocument()
    })

    it('explains an empty storage key rather than failing silently', async () => {
        const user = userEvent.setup()
        render(<Harness onReadFromBrowser={() => null} />)
        await screen.findByText('emailAddress')

        await user.click(screen.getByRole('button', { name: /Read from my browser/ }))

        expect(await screen.findByText(/Nothing found under that key/)).toBeInTheDocument()
    })

    it('hides the browser-read button when the source cannot be read client-side', async () => {
        render(<Harness />)
        await screen.findByText('emailAddress')
        expect(screen.queryByRole('button', { name: /Read from my browser/ })).toBeNull()
    })

    it('resolves the sample through the mapping being edited', async () => {
        const user = userEvent.setup()
        testMapping.mockResolvedValue({
            providerId: 'idp_1',
            providerSlug: 'corp-portal',
            resolved: {
                external_id: 'u1', email: 'a@corp.example',
                first_name: 'Alice', last_name: 'Doe',
                groups: ['Eng'], auth_time: null,
                attributes: { department: 'Platform' },
            },
        })
        render(<Harness />)
        await screen.findByText('emailAddress')

        const textarea = screen.getByPlaceholderText(/or a JWT/)
        await user.click(textarea)
        await user.paste('{"sub":"u1","email":"a@corp.example"}')
        await user.click(screen.getByRole('button', { name: /Preview/ }))

        await waitFor(() => expect(testMapping).toHaveBeenCalledWith(
            'idp_1', { sub: 'u1', email: 'a@corp.example' }, {},
        ))
        expect(await screen.findByText('Resolved profile')).toBeInTheDocument()
        expect(screen.getByText('a@corp.example')).toBeInTheDocument()
        expect(screen.getByText(/"department":"Platform"/)).toBeInTheDocument()
    })

    it('surfaces the backend error when a required field will not resolve', async () => {
        const user = userEvent.setup()
        testMapping.mockRejectedValue(
            new Error("Claim mapping for provider 'corp-portal' could not resolve email"),
        )
        render(<Harness />)
        await screen.findByText('emailAddress')

        const textarea = screen.getByPlaceholderText(/or a JWT/)
        await user.click(textarea)
        await user.paste('{"sub":"u1"}')
        await user.click(screen.getByRole('button', { name: /Preview/ }))

        expect(await screen.findByText(/could not resolve email/)).toBeInTheDocument()
    })

    it('adds and names an extra attribute', async () => {
        const user = userEvent.setup()
        render(<Harness />)
        await screen.findByText('emailAddress')

        await user.type(screen.getByLabelText('New attribute name'), 'staff_id')
        // Exact name: /Add/ would also match "Remove emailAddress".
        await user.click(screen.getByRole('button', { name: 'Add' }))
        await waitFor(() => expect(currentMapping().extras).toEqual({ staff_id: [] }))

        const sourceInputs = screen.getAllByPlaceholderText('source key…')
        await user.type(sourceInputs[0], 'staffNumber{Enter}')

        await waitFor(() => {
            expect(currentMapping().extras).toEqual({ staff_id: ['staffNumber'] })
        })
    })

    it('resets every override back to the defaults', async () => {
        const user = userEvent.setup()
        render(<Harness />)
        await screen.findByText('emailAddress')

        await user.type(screen.getAllByPlaceholderText('add a key…')[1], 'mail{Enter}')
        await waitFor(() => expect(currentMapping().email).toBeDefined())

        await user.click(screen.getByRole('button', { name: /Reset to defaults/ }))
        expect(currentMapping()).toEqual({})
    })

    it('disables preview until the provider has been saved', async () => {
        render(
            <ClaimMappingEditor
                kind="custom_profile"
                value={{}}
                onChange={() => {}}
            />,
        )
        await screen.findByText('emailAddress')
        expect(screen.getByRole('button', { name: /Preview/ })).toBeDisabled()
    })
})
