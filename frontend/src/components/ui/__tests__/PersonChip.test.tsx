/**
 * A person as every record shows them: a face and a name, never an invented
 * one. Shimmers in its final shape while the name is on its way; keeps the id
 * when it names nobody — or when the directory cannot be reached; marks a
 * deleted account and still names it; and asks for no picture it was told
 * does not exist.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { peopleById } = vi.hoisted(() => ({ peopleById: vi.fn() }))
vi.mock('@/services/userDirectoryService', () => ({ peopleById }))

import { resetAvatarImageCacheForTests } from '@/lib/avatarImage'
import { PersonChip } from '../PersonChip'

function wrap(ui: ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

async function hover(el: Element) {
    let anchor: Element | null = el
    // The tip's anchor is the chip's outermost box.
    while (anchor && !(anchor.parentElement?.tagName === 'DIV')) anchor = anchor.parentElement
    fireEvent.mouseEnter(anchor!)
    await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
}

beforeEach(() => {
    vi.clearAllMocks()
    resetAvatarImageCacheForTests()
})

describe('PersonChip', () => {
    it('looks a person up once, and shows their face, name and a link to them', async () => {
        peopleById.mockResolvedValue([
            { id: 'usr_ana', displayName: 'Ana Okafor', email: 'ana@example.com', deleted: false, hasImage: true },
        ])
        const { container } = wrap(<><PersonChip id="usr_ana" /><PersonChip id="usr_ana" size="md" showEmail /></>)
        // The final shape while the name is on its way.
        expect(screen.getAllByText('Loading usr_ana')).toHaveLength(2)

        const links = await screen.findAllByRole('link', { name: 'Ana Okafor' })
        expect(links[0]).toHaveAttribute('href', '/admin/users?user=usr_ana')
        expect(screen.getByText('ana@example.com')).toBeInTheDocument()
        expect(peopleById).toHaveBeenCalledTimes(1)
        expect(container.querySelector('img')).toHaveAttribute('src', '/api/v1/users/usr_ana/avatar')

        await hover(links[0])
        const tip = screen.getByRole('tooltip')
        expect(tip).toHaveTextContent('usr_ana')
        expect(tip).toHaveTextContent('Opens their account in User Management.')
    })

    it('shows a service account as one: a bot for a face, no address, its own page', async () => {
        const { container } = wrap(
            <PersonChip
                id="svc_0123456789ab" size="md" showEmail
                person={{ name: 'Metadata sync', email: 'svc_0123456789ab@service-account.invalid', deleted: false }}
            />,
        )
        const link = screen.getByRole('link', { name: 'Metadata sync' })
        expect(link).toHaveAttribute('href', '/admin/service-accounts?account=svc_0123456789ab')
        expect(screen.queryByText(/service-account\.invalid/)).not.toBeInTheDocument()
        expect(container.querySelector('img')).toBeNull()

        await hover(link)
        const tip = screen.getByRole('tooltip')
        expect(tip).toHaveTextContent('Service account')
        expect(tip).toHaveTextContent('Opens it in Service accounts.')
        expect(peopleById).not.toHaveBeenCalled()
    })

    it('uses the person the record already names, and asks the directory nothing', () => {
        const { container } = wrap(
            <PersonChip id="usr_bo" person={{ name: 'Bo Lind', email: 'bo@example.com', deleted: false, hasImage: false }} />,
        )
        expect(screen.getByRole('link', { name: 'Bo Lind' })).toBeInTheDocument()
        expect(peopleById).not.toHaveBeenCalled()
        // Told there is no picture: no request for one.
        expect(container.querySelector('img')).toBeNull()
        expect(screen.getByText('BL')).toBeInTheDocument()
    })

    it('keeps an id that names nobody, verbatim, and says why on hover', async () => {
        peopleById.mockResolvedValue([])
        wrap(<PersonChip id="usr_gone" />)
        const id = await screen.findByText('usr_gone')
        expect(screen.queryByRole('link')).not.toBeInTheDocument()
        await hover(id)
        expect(screen.getByRole('tooltip')).toHaveTextContent('Not in the user directory')
    })

    it('shows the id, not a shimmer for ever, when the directory cannot be reached', async () => {
        peopleById.mockRejectedValue(new Error('503'))
        wrap(<PersonChip id="usr_ana" />)
        const id = await screen.findByText('usr_ana')
        await hover(id)
        expect(screen.getByRole('tooltip')).toHaveTextContent('Name not available')
    })

    it('still names a deleted account, and marks it', () => {
        wrap(<PersonChip id="usr_old" person={{ name: 'Grace Hopper', deleted: true }} />)
        expect(screen.getByText('Grace Hopper')).toBeInTheDocument()
        expect(screen.getByText('Deleted')).toBeInTheDocument()
    })

    it('leaves the link out where the row itself is the button', () => {
        wrap(<PersonChip id="usr_bo" person={{ name: 'Bo Lind' }} link={false} />)
        expect(screen.getByText('Bo Lind')).toBeInTheDocument()
        expect(screen.queryByRole('link')).not.toBeInTheDocument()
    })
})
