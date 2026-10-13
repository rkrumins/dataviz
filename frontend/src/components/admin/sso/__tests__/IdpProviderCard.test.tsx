/**
 * What the card has to answer at a glance.
 *
 * An operator arrives at this page with two questions: can people use
 * this yet, and is it about to break? The table this replaces had a
 * column for neither. These tests pin the states that answer them.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { IdpProviderCard } from '../IdpProviderCard'
import type { IdpProvider, IdpHealth } from '@/services/ssoAdminService'

function provider(over: Partial<IdpProvider> = {}): IdpProvider {
    return {
        id: 'idp_1', slug: 'entra-staff', displayName: 'Corporate Entra',
        kind: 'oidc', enabled: true, priority: 100, settings: {},
        claimMapping: {}, linkingPolicy: 'strict',
        assurance: 'verified', assuranceReason: 'Signature checked',
        emailDomains: [], lifecycle: 'live',
        createdAt: '', updatedAt: '',
        ...over,
    } as IdpProvider
}

const noop = {
    onEdit: () => {}, onRehearse: () => {}, onPublish: () => {},
    onToggleEnabled: () => {}, onDelete: () => {},
}

describe('lifecycle', () => {
    it('says plainly that a draft is invisible', async () => {
        // The single most important thing on the card: the difference
        // between "still setting up" and "everyone sees this".
        render(<IdpProviderCard provider={provider({ lifecycle: 'draft' })} {...noop} />)
        expect(screen.getByText(/not visible to anyone/i)).toBeInTheDocument()
    })

    it('offers Publish only while it is a draft', () => {
        const { rerender } = render(
            <IdpProviderCard provider={provider({ lifecycle: 'draft' })} {...noop} />)
        expect(screen.getByRole('button', { name: /publish/i })).toBeInTheDocument()

        rerender(<IdpProviderCard provider={provider({ lifecycle: 'live' })} {...noop} />)
        expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument()
    })

    it('publishes when asked', async () => {
        const onPublish = vi.fn()
        const user = userEvent.setup()
        render(<IdpProviderCard provider={provider({ lifecycle: 'draft' })}
                                {...noop} onPublish={onPublish} />)
        await user.click(screen.getByRole('button', { name: /publish/i }))
        expect(onPublish).toHaveBeenCalled()
    })
})

describe('health', () => {
    function health(over: Partial<IdpHealth> = {}): IdpHealth {
        return {
            providerId: 'idp_1', slug: 'entra-staff', status: 'ok',
            checkedAt: '', ...over,
        } as IdpHealth
    }

    it('counts down a certificate before it expires', () => {
        render(<IdpProviderCard provider={provider()} {...noop}
                                health={health({ status: 'warning', certDaysRemaining: 12 })} />)
        expect(screen.getByText(/expires in 12 days/i)).toBeInTheDocument()
    })

    it('says so once it has expired', () => {
        render(<IdpProviderCard provider={provider()} {...noop}
                                health={health({ status: 'unavailable', certDaysRemaining: -3 })} />)
        expect(screen.getByText(/certificate expired/i)).toBeInTheDocument()
    })

    it('distinguishes "nothing to check" from "not checked"', () => {
        // A bare dash reads the same as a failed probe. A corporate portal
        // has no certificate to check and should say that.
        render(<IdpProviderCard provider={provider({ kind: 'custom_profile' })} {...noop}
                                health={health({ status: 'unknown' })} />)
        expect(screen.getByText(/no certificate to check/i)).toBeInTheDocument()
    })

    it('is muted rather than alarming before the first sweep', () => {
        render(<IdpProviderCard provider={provider()} {...noop} />)
        expect(screen.getByText(/not checked yet/i)).toBeInTheDocument()
    })
})

describe('assurance', () => {
    const UNSIGNED = 'Trust unsigned is on: the browser hands over the '
        + "gateway's answer and nothing checks a signature on it."

    it('interrupts for a live connection nothing has vouched for', () => {
        // Live AND unverified is the combination worth a warning: it is
        // serving real sign-ins on forgeable claims.
        render(<IdpProviderCard {...noop}
            provider={provider({
                lifecycle: 'live', assurance: 'unverified', assuranceReason: UNSIGNED,
            })} />)
        expect(screen.getByText(/live and unverified/i)).toBeInTheDocument()
    })

    it('says which setting is to blame, and opens it', async () => {
        // The server names this row's cause and its fix; the generic
        // "anyone can be anyone" left the operator guessing which switch.
        const onEdit = vi.fn()
        render(<IdpProviderCard {...noop} onEdit={onEdit}
            provider={provider({
                lifecycle: 'live', assurance: 'unverified', assuranceReason: UNSIGNED,
            })} />)
        expect(screen.getByText(/Trust unsigned is on/)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: /open its settings/i }))
        expect(onEdit).toHaveBeenCalledTimes(1)
    })

    it('folds away once read, remembered per connection and cause', async () => {
        // An admin who has read it can put it away; a different cause —
        // TLS switched off after Trust unsigned was accepted — opens it
        // again, because that is a different risk.
        window.localStorage.clear()
        const live = (assuranceReason: string) => provider({
            lifecycle: 'live', assurance: 'unverified', assuranceReason,
        })
        const first = render(<IdpProviderCard {...noop} provider={live(UNSIGNED)} />)
        await userEvent.click(screen.getByRole('button', { name: /^hide$/i }))
        expect(screen.queryByText(/Trust unsigned is on/)).not.toBeInTheDocument()
        expect(screen.getByText(/warning hidden/i)).toBeInTheDocument()
        first.unmount()

        const again = render(<IdpProviderCard {...noop} provider={live(UNSIGNED)} />)
        expect(screen.getByText(/warning hidden/i)).toBeInTheDocument()
        again.unmount()

        render(<IdpProviderCard {...noop}
            provider={live('TLS verification is off for this connection.')} />)
        expect(screen.getByText(/TLS verification is off/)).toBeInTheDocument()
    })

    it('opens again on request', async () => {
        window.localStorage.clear()
        render(<IdpProviderCard {...noop}
            provider={provider({
                lifecycle: 'live', assurance: 'unverified', assuranceReason: UNSIGNED,
            })} />)
        await userEvent.click(screen.getByRole('button', { name: /^hide$/i }))
        await userEvent.click(screen.getByRole('button', { name: /show the warning/i }))
        expect(screen.getByText(/Trust unsigned is on/)).toBeInTheDocument()
    })

    it('says when the connection links administrators too, and reopens for it', async () => {
        window.localStorage.clear()
        const live = (settings: Record<string, unknown>) => provider({
            lifecycle: 'live', assurance: 'unverified', assuranceReason: UNSIGNED, settings,
        })
        const before = render(<IdpProviderCard {...noop} provider={live({})} />)
        expect(screen.getByText(/link itself to a Super Admin's or break-glass account/i))
            .toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: /^hide$/i }))
        before.unmount()

        // Turning the opt-in on is a new risk: the folded warning opens again.
        render(<IdpProviderCard {...noop} provider={live({ link_admin_accounts: true })} />)
        expect(screen.getByText(/set to link Super Admin and break-glass accounts too/i))
            .toBeInTheDocument()
    })

    it('stays quiet about an unverified DRAFT', () => {
        // Still being set up, still invisible — nothing to warn about yet.
        render(<IdpProviderCard {...noop}
            provider={provider({
                lifecycle: 'draft', assurance: 'unverified', assuranceReason: UNSIGNED,
            })} />)
        expect(screen.queryByText(/live and unverified/i)).not.toBeInTheDocument()
    })
})

describe('actions', () => {
    it('labels every control for screen readers', () => {
        render(<IdpProviderCard provider={provider()} {...noop} />)
        for (const name of [/rehearse sign-in/i, /edit/i, /delete/i]) {
            expect(screen.getByRole('button', { name })).toBeInTheDocument()
        }
        // The enabled toggle is a real switch now, not a glyph whose two
        // states rendered identically.
        expect(screen.getByRole('switch', { name: /turn off/i }))
            .toBeInTheDocument()
    })

    it('shows where an email domain routes', () => {
        render(<IdpProviderCard {...noop}
            provider={provider({ emailDomains: ['corp.example', 'sub.corp.example'] })} />)
        expect(screen.getByText(/corp\.example, sub\.corp\.example/)).toBeInTheDocument()
    })

    it('marks the connection the sign-in page leads with, and only that one', () => {
        const { rerender } = render(
            <IdpProviderCard provider={provider()} primary {...noop} />)
        expect(screen.getByText('Primary')).toBeInTheDocument()

        rerender(<IdpProviderCard provider={provider()} {...noop} />)
        expect(screen.queryByText('Primary')).not.toBeInTheDocument()
    })
})

describe('the enabled state, said in words', () => {
    it('a switched-off connection says so instead of claiming Live', () => {
        // The old card showed a green "Live" chip at 60% opacity for a
        // connection the stat tiles excluded — the two surfaces
        // contradicted each other.
        render(<IdpProviderCard {...noop}
            provider={provider({ enabled: false })} />)
        expect(screen.getByText(/off — sign-ins refused/i)).toBeInTheDocument()
        expect(screen.queryByText(/^live$/i)).not.toBeInTheDocument()
        expect(screen.getByRole('switch', { name: /turn on/i }))
            .toHaveAttribute('aria-checked', 'false')
    })

    it('an enabled live connection reads Live with the switch on', () => {
        render(<IdpProviderCard provider={provider()} {...noop} />)
        expect(screen.getByText('Live')).toBeInTheDocument()
        expect(screen.getByRole('switch', { name: /turn off/i }))
            .toHaveAttribute('aria-checked', 'true')
    })

    it('the switch toggles when asked', async () => {
        const onToggleEnabled = vi.fn()
        const user = userEvent.setup()
        render(<IdpProviderCard provider={provider()} {...noop}
                                onToggleEnabled={onToggleEnabled} />)
        await user.click(screen.getByRole('switch', { name: /turn off/i }))
        expect(onToggleEnabled).toHaveBeenCalled()
    })
})

describe('readiness and history', () => {
    it('a rehearsed draft says so', () => {
        render(<IdpProviderCard {...noop}
            provider={provider({
                lifecycle: 'draft',
                lastAssertionAt: new Date().toISOString(),
            })} />)
        expect(screen.getByText(/rehearsed ✓/i)).toBeInTheDocument()
    })

    it('an unrehearsed draft shows no tick', () => {
        render(<IdpProviderCard {...noop}
            provider={provider({ lifecycle: 'draft' })} />)
        expect(screen.queryByText(/rehearsed ✓/i)).not.toBeInTheDocument()
    })

    it('a live connection shows its last sign-in', () => {
        render(<IdpProviderCard {...noop}
            provider={provider({
                lastAssertionAt: new Date().toISOString(),
            })} />)
        expect(screen.getByText(/last sign-in/i)).toBeInTheDocument()
    })
})

describe('health fetch failure', () => {
    it('is distinguished from "never probed"', () => {
        render(<IdpProviderCard provider={provider()} {...noop}
                                healthUnavailable />)
        expect(screen.getByText(/health unavailable right now/i))
            .toBeInTheDocument()
        expect(screen.queryByText(/not checked yet/i)).not.toBeInTheDocument()
    })
})
