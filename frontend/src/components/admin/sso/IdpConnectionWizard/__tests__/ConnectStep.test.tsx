/**
 * The wizard has to be able to configure the kinds it offers.
 *
 * It could not. `IdpConnectionWizard` renders no settings editor at any
 * step; OIDC and SAML were carried by discovery writing into `settings`,
 * and every other kind reached Publish with `{}`. So the five-step flow
 * produced a connection that could not work, with nothing anywhere
 * saying the operator had to abandon it and reopen the row in the
 * drawer.
 *
 * Two properties, then. A kind with no discovery gets a form; a kind
 * with discovery keeps its Fetch box and does not grow a second way to
 * enter the same thing.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ConnectStep } from '../steps/ConnectStep'
import { presetById } from '../../vendorPresets'

function renderStep(presetId: string, over: Record<string, unknown> = {}) {
    const onSettings = vi.fn()
    render(
        <ConnectStep
            preset={presetById(presetId)!}
            displayName="Corporate Gateway"
            onDisplayName={vi.fn()}
            slug="corp-gateway"
            connectInput=""
            onConnectInput={vi.fn()}
            onDiscover={vi.fn()}
            discovering={false}
            discovery={null}
            settings={over}
            onSettings={onSettings}
        />,
    )
    return onSettings
}

describe('a kind with no discovery', () => {
    it('can be configured here rather than nowhere', () => {
        renderStep('backchannel')
        expect(screen.getByPlaceholderText(/sso-gateway\.corp\.internal\/token$/))
            .toBeInTheDocument()
    })

    it('reports what the operator types', async () => {
        const onSettings = renderStep('backchannel')
        await userEvent.type(
            screen.getByPlaceholderText(/sso-gateway\.corp\.internal\/token$/), 'h',
        )
        expect(onSettings).toHaveBeenCalled()
        expect(onSettings.mock.calls.at(-1)![0]).toHaveProperty('gateway_url')
    })

    it('gets the right form for its kind', () => {
        // Not a generic JSON box: the portal kind had this dead end too,
        // and fixing one without the other would have been arbitrary.
        renderStep('custom_profile')
        expect(screen.getByText(/Payload format/i)).toBeInTheDocument()
        expect(screen.queryByPlaceholderText(/sso-gateway\.corp\.internal\/token$/))
            .not.toBeInTheDocument()
    })

    it('offers no Fetch button, because there is nothing to fetch', () => {
        // POST /discover supports oidc and saml2 and 404s for anything
        // else, so a Fetch button here could only ever fail.
        renderStep('backchannel')
        expect(screen.queryByRole('button', { name: /fetch/i }))
            .not.toBeInTheDocument()
    })
})

describe('a kind with discovery', () => {
    it('keeps its Fetch box', () => {
        renderStep('oidc')
        expect(screen.getByRole('button', { name: /fetch/i })).toBeInTheDocument()
    })

    it('does not also grow a settings form', () => {
        // Discovery already fills these in. A second place to type the
        // same values is a way for the two to disagree.
        renderStep('oidc')
        expect(screen.queryByText(/Advanced/i)).not.toBeInTheDocument()
    })
})
