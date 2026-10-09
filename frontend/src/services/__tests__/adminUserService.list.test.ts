/**
 * adminUserService.listUsers — one page, and the total across all of them.
 *
 * The admin table used to call this with no arguments, get the endpoint's
 * default fifty rows back, and treat that as everyone. It now asks for an
 * explicit slice and reads how many accounts exist from ``X-Total-Count``.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchWithTimeoutMock } = vi.hoisted(() => ({ fetchWithTimeoutMock: vi.fn() }))
vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: fetchWithTimeoutMock }))

import { adminUserService } from '../adminUserService'

const requestedUrl = () => new URL(fetchWithTimeoutMock.mock.calls[0][0] as string, 'http://x')

describe('adminUserService.listUsers', () => {
    beforeEach(() => fetchWithTimeoutMock.mockReset())

    it('asks for exactly the slice, search and order it was given', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(new Response('[]', { status: 200 }))
        await adminUserService.listUsers({
            status: 'active', search: '  ada ', sort: 'name', order: 'asc',
            limit: 25, offset: 50,
        })
        const url = requestedUrl()
        expect(url.pathname).toBe('/api/v1/admin/users')
        expect(Object.fromEntries(url.searchParams)).toEqual({
            limit: '25', offset: '50', status: 'active', search: 'ada',
            sort: 'name', order: 'asc',
        })
    })

    it('leaves out filters it was not given, instead of sending them empty', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(new Response('[]', { status: 200 }))
        await adminUserService.listUsers({ search: '   ', limit: 25 })
        expect(Object.fromEntries(requestedUrl().searchParams)).toEqual({
            limit: '25', offset: '0',
        })
    })

    it('takes the total from X-Total-Count, not from the page length', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(new Response(
            JSON.stringify([{ id: 'usr_1' }, { id: 'usr_2' }]),
            { status: 200, headers: { 'X-Total-Count': '81' } },
        ))
        const page = await adminUserService.listUsers({ limit: 2 })
        expect(page.items.map(u => u.id)).toEqual(['usr_1', 'usr_2'])
        expect(page.total).toBe(81)
    })

    it('falls back to the page length when a server sends no total', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(new Response(
            JSON.stringify([{ id: 'usr_1' }]), { status: 200 },
        ))
        expect((await adminUserService.listUsers({ limit: 25 })).total).toBe(1)
    })

    it('reports a failure as its readable message, not the raw body', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(new Response(
            JSON.stringify({ detail: 'Admin access required' }), { status: 403 },
        ))
        await expect(adminUserService.listUsers({ limit: 25 }))
            .rejects.toThrow(/^Admin access required$/)
    })
})
