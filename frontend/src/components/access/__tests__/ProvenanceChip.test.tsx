/**
 * Every grant says how it came about — one label per origin, and the
 * sentence behind it naming who, when, the request, the identity
 * provider's groups, the team or the organization role. The hover names
 * the person who granted it, not their id.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

const { peopleById } = vi.hoisted(() => ({ peopleById: vi.fn() }))
vi.mock('@/services/userDirectoryService', () => ({ peopleById }))

import { ProvenanceChip } from '../ProvenanceChip'
import { provenanceSentence } from '../accessRequestCopy'
import type { AccessProvenance } from '@/services/workspaceMembersService'

function provenance(over: Partial<AccessProvenance>): AccessProvenance {
    return { origin: 'direct', source: null, by: null, at: null, requestId: null, idpGroups: [], idpProvider: null, ...over }
}

const names = (id: string) => ({ usr_bob: 'Bob', usr_wanda: 'Wanda' } as Record<string, string>)[id] ?? id

describe('ProvenanceChip', () => {
    it.each([
        ['direct', 'Added directly'],
        ['request', 'Approved request'],
        ['exception', 'Exception'],
        ['joined', 'Joined'],
        ['idp', 'Identity provider'],
        ['team', 'Team'],
        ['org_role', 'Organization-wide'],
    ] as const)('labels %s grants', (origin, label) => {
        render(<ProvenanceChip provenance={provenance({ origin })} />)
        expect(screen.getByText(label)).toBeInTheDocument()
    })

    it('renders nothing without a provenance', () => {
        const { container } = render(<ProvenanceChip provenance={null} />)
        expect(container).toBeEmptyDOMElement()
    })

    it('names who granted it on hover', async () => {
        peopleById.mockResolvedValue([{ id: 'usr_bob', displayName: 'Bob Steward', email: 'bob@x.io', deleted: false }])
        const user = userEvent.setup()
        render(
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                <ProvenanceChip provenance={provenance({ origin: 'request', by: 'usr_bob' })} />
            </QueryClientProvider>,
        )
        await user.hover(screen.getByText('Approved request'))
        expect(await screen.findByText('Approved by Bob Steward, answering their request.')).toBeInTheDocument()
        expect(peopleById).toHaveBeenCalledWith(['usr_bob'])
    })

    it('says how it came about in full', () => {
        expect(provenanceSentence(provenance({ origin: 'request', by: 'usr_bob' }), names))
            .toBe('Approved by Bob, answering their request.')
        expect(provenanceSentence(provenance({ origin: 'exception', by: 'usr_wanda' }), names))
            .toMatch(/^Granted here by Wanda as an exception/)
        expect(provenanceSentence(provenance({ origin: 'joined' }), names))
            .toBe('Joined — the workspace is open to everyone.')
        expect(provenanceSentence(provenance({ origin: 'idp', idpGroups: ['finance-analysts'], idpProvider: 'Entra ID' })))
            .toBe('Through “finance-analysts” in Entra ID — their identity provider adds and removes it.')
        expect(provenanceSentence(provenance({ origin: 'team', source: 'Close team', by: 'usr_wanda', requestId: 'ar_1' }), names))
            .toBe('A member of the team “Close team”, added by Wanda when their request was approved.')
        expect(provenanceSentence(provenance({ origin: 'org_role', source: 'org_admin' })))
            .toBe('Org Admin reaches every workspace.')
    })
})
