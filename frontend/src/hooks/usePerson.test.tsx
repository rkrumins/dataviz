/**
 * usePerson — every row asking at once is one request, and an id that names
 * nobody stays an id.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { peopleById } = vi.hoisted(() => ({ peopleById: vi.fn() }))
vi.mock('@/services/userDirectoryService', () => ({ peopleById }))

import { usePerson } from './usePerson'

function Name({ id }: { id: string }) {
    const person = usePerson(id)
    return <li>{person === undefined ? 'loading' : person === null ? `nobody:${id}` : person.displayName}</li>
}

beforeEach(() => {
    peopleById.mockReset()
    peopleById.mockResolvedValue([
        { id: 'usr_a', displayName: 'Ana Okafor', email: 'ana@example.com', deleted: false },
        { id: 'usr_b', displayName: 'Ben Lindqvist', email: null, deleted: true },
    ])
})

describe('usePerson', () => {
    it('names a page of people with one request, repeats included', async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={client}>
                <ul>
                    <Name id="usr_a" />
                    <Name id="usr_b" />
                    <Name id="usr_a" />
                    <Name id="usr_gone" />
                </ul>
            </QueryClientProvider>,
        )
        await waitFor(() => expect(screen.getAllByText('Ana Okafor')).toHaveLength(2))
        expect(screen.getByText('Ben Lindqvist')).toBeInTheDocument()
        expect(screen.getByText('nobody:usr_gone')).toBeInTheDocument()
        expect(peopleById).toHaveBeenCalledTimes(1)
        expect([...peopleById.mock.calls[0][0]].sort()).toEqual(['usr_a', 'usr_b', 'usr_gone'])
    })
})
