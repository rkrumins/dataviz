/**
 * Decoding the failure code on the row that shows it.
 *
 * The load-bearing property is the fall-through: a code we have not
 * catalogued must still reach the reader. Swallowing an unknown reason to
 * keep the component tidy would remove the single most useful thing on the
 * row at the moment somebody needs it most.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReasonHint, codesIn, explainReason } from '../ReasonHint'

describe('pulling codes out of a summary', () => {
    it('reads the one after the colon', () => {
        expect(codesIn('[a1b2c3d4] Sign-in via entra failed: jit_disabled'))
            .toEqual(['jit_disabled'])
    })

    it('reads a comma-separated list of deny reasons', () => {
        expect(codesIn('Refused a@b from entra: email_unverified, strict_existing_sso'))
            .toEqual(['email_unverified', 'strict_existing_sso'])
    })

    it('keeps a prefixed reason whole', () => {
        expect(codesIn('Refused a@b from entra: existing_status:suspended'))
            .toEqual(['existing_status:suspended'])
    })

    it('finds nothing in a summary that carries no reason', () => {
        expect(codesIn("IdP provider 'entra' created")).toEqual([])
    })

    it('does not mistake prose after a colon for a code', () => {
        expect(codesIn('SSO / login config changed: two settings')).toEqual([])
    })
})

describe('explaining a code', () => {
    it('covers the plain ones', () => {
        expect(explainReason('jit_disabled')?.what).toMatch(/no account here/i)
        expect(explainReason('jit_disabled')?.next).toMatch(/invite|switch/i)
    })

    it('expands a prefixed policy reason to the policy it names', () => {
        expect(explainReason('policy:manual_only')?.what).toMatch(/by design/i)
        expect(explainReason('policy:disabled')?.what).toMatch(/switched off/i)
    })

    it('expands a status reason with the status in it', () => {
        expect(explainReason('existing_status:suspended')?.what)
            .toMatch(/is suspended/i)
        expect(explainReason('existing_status:pending')?.next)
            .toMatch(/approve it/i)
    })

    it('returns null for something it has never seen', () => {
        expect(explainReason('some_new_backend_code')).toBeNull()
    })
})

describe('the hint on a row', () => {
    it('explains a known code', () => {
        render(<ReasonHint summary="Sign-in via entra failed: jit_disabled" />)
        expect(screen.getByText(/no account here/i)).toBeInTheDocument()
    })

    it('explains every reason in a list', () => {
        render(<ReasonHint summary="Refused a@b from entra: email_unverified, strict_existing_sso" />)
        expect(screen.getByText(/did not say the address is verified/i)).toBeInTheDocument()
        expect(screen.getByText(/already has an SSO identity/i)).toBeInTheDocument()
    })

    it('renders nothing at all for a summary it cannot decode', () => {
        // Not an empty box, not a placeholder — the row is unchanged.
        const { container } = render(
            <ReasonHint summary="IdP provider 'entra' created" />,
        )
        expect(container).toBeEmptyDOMElement()
    })

    it('leaves an unknown code to the summary rather than swallowing it', () => {
        // The summary itself still carries it; the hint simply adds nothing.
        const { container } = render(
            <ReasonHint summary="Sign-in via entra failed: brand_new_code" />,
        )
        expect(container).toBeEmptyDOMElement()
    })
})
