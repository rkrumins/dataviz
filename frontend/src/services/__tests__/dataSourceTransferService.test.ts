/**
 * dataSourceTransferService — the URLs, bodies and headers behind moving a
 * data source between workspaces.
 *
 * Pinned here: every call reaches the route the backend mounts; the reason a
 * person gives rides in X-Activity-Reason (never on a read); a decline's note
 * is both the note the proposer reads and the reason the log keeps; and a
 * refusal keeps its HTTP status, because the wizard tells "something changed"
 * (409) apart from "you may not" (403) by it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchWithTimeoutMock } = vi.hoisted(() => ({ fetchWithTimeoutMock: vi.fn() }))
vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: fetchWithTimeoutMock }))

import { dataSourceTransferService as svc } from '../dataSourceTransferService'
import { httpStatusOf } from '../graphRequestFailure'

const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 })

function lastCall() {
    const [url, init] = fetchWithTimeoutMock.mock.calls.at(-1) as [string, RequestInit | undefined]
    const headers = new Headers(init?.headers)
    return {
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
        reason: headers.get('X-Activity-Reason'),
    }
}

beforeEach(() => {
    fetchWithTimeoutMock.mockReset()
    // A fresh Response each time: a body can be read once.
    fetchWithTimeoutMock.mockImplementation(() => Promise.resolve(ok([])))
})

describe('dataSourceTransferService', () => {
    it('reads destinations, a preview and the history from the source’s own routes', async () => {
        await svc.destinations('ws a', 'ds/1')
        expect(lastCall().url).toBe('/api/v1/admin/workspaces/ws%20a/data-sources/ds%2F1/move-destinations')

        await svc.preview('ws1', 'ds1', 'ws 2')
        expect(lastCall()).toMatchObject({
            url: '/api/v1/admin/workspaces/ws1/data-sources/ds1/move-preview?to=ws%202',
            method: 'GET',
            reason: null,
        })

        await svc.history('ws1', 'ds1')
        expect(lastCall().url).toBe('/api/v1/admin/workspaces/ws1/data-sources/ds1/transfers')
    })

    it('moves with the preview token and the reason', async () => {
        await svc.move('ws1', 'ds1', {
            targetWorkspaceId: 'ws2',
            previewToken: 'tok',
        }, 'Team reorganisation')
        expect(lastCall()).toEqual({
            url: '/api/v1/admin/workspaces/ws1/data-sources/ds1/move',
            method: 'POST',
            body: { targetWorkspaceId: 'ws2', previewToken: 'tok' },
            reason: encodeURIComponent('Team reorganisation'),
        })
    })

    it('sends a request to the transfer-requests route, with no reason header when none was given', async () => {
        await svc.propose('ws1', 'ds1', { targetWorkspaceId: 'ws2', previewToken: 'tok' })
        expect(lastCall()).toMatchObject({
            url: '/api/v1/admin/workspaces/ws1/data-sources/ds1/transfer-requests',
            method: 'POST',
            body: { targetWorkspaceId: 'ws2', previewToken: 'tok' },
            reason: null,
        })
    })

    it('lists the requests to answer and a workspace’s own, open by default', async () => {
        await svc.listIncoming()
        expect(lastCall().url).toBe('/api/v1/admin/data-source-transfers?status=open')
        await svc.listIncoming('all')
        expect(lastCall().url).toBe('/api/v1/admin/data-source-transfers?status=all')
        await svc.listForWorkspace('ws1')
        expect(lastCall().url).toBe('/api/v1/admin/workspaces/ws1/data-source-transfers?status=open')
    })

    it('answers a request: accept pins the preview, decline’s note is also the logged reason', async () => {
        await svc.get('xfer_1')
        expect(lastCall().url).toBe('/api/v1/admin/data-source-transfers/xfer_1')

        await svc.accept('xfer_1', 'tok', 'Our team now owns it')
        expect(lastCall()).toEqual({
            url: '/api/v1/admin/data-source-transfers/xfer_1/accept',
            method: 'POST',
            body: { previewToken: 'tok' },
            reason: encodeURIComponent('Our team now owns it'),
        })

        await svc.decline('xfer_1', 'Not ours')
        expect(lastCall()).toEqual({
            url: '/api/v1/admin/data-source-transfers/xfer_1/decline',
            method: 'POST',
            body: { note: 'Not ours' },
            reason: encodeURIComponent('Not ours'),
        })

        await svc.cancel('xfer_1')
        expect(lastCall()).toMatchObject({ url: '/api/v1/admin/data-source-transfers/xfer_1/cancel', body: { note: null } })

        await svc.undo('xfer_1', 'Moved by mistake')
        expect(lastCall()).toMatchObject({
            url: '/api/v1/admin/data-source-transfers/xfer_1/undo',
            method: 'POST',
            reason: encodeURIComponent('Moved by mistake'),
        })
    })

    it('keeps the status and the readable message on a refusal', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(new Response(
            JSON.stringify({ detail: { error: 'preview_stale', message: 'Two new views were built on it since.' } }),
            { status: 409 },
        ))
        const err = await svc.move('ws1', 'ds1', { targetWorkspaceId: 'ws2' }).catch((e: unknown) => e)
        expect(httpStatusOf(err)).toBe(409)
        expect((err as Error).message).toBe('Two new views were built on it since.')
    })
})
