/**
 * workspaceService.request() error handling.
 *
 * Every other surface in the admin notification sweep reaches the backend
 * through ``authFetch`` (apiClient), which runs the body past
 * ``extractErrorMessageFromText`` so a structured permission envelope arrives
 * as its ``message``. This file's own helper did not: it threw
 * ``Workspace API 403: {"detail":{...}}`` with the RAW body, so the crafted
 * plain-language fallbacks on WorkspacesPage / WorkspaceDetailPage — all of
 * them guarded with ``err.message ? err.message : …`` — could never be
 * reached, and the notification card showed the admin the JSON instead.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

const { fetchWithTimeoutMock } = vi.hoisted(() => ({ fetchWithTimeoutMock: vi.fn() }))
vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: fetchWithTimeoutMock }))

import { workspaceService } from '../workspaceService'

async function setDefaultError(): Promise<Error> {
    return workspaceService.setDefault('w1').then(
        () => { throw new Error('expected setDefault() to reject') },
        (e: unknown) => e as Error,
    )
}

describe('workspaceService — what a failed write says', () => {
    beforeEach(() => fetchWithTimeoutMock.mockReset())

    it('unwraps the structured permission envelope instead of leaking it', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(new Response(
            JSON.stringify({
                detail: {
                    error: 'forbidden',
                    permission: 'workspace:manage',
                    scope: 'workspace:abc-123',
                    message: 'Only an org admin can set the default workspace',
                },
            }),
            { status: 403 },
        ))

        const err = await setDefaultError()
        expect(err.message).toBe('Only an org admin can set the default workspace')
        expect(err.message).not.toContain('Workspace API')
        expect(err.message).not.toContain('{')
    })

    it('unwraps a plain string detail', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(new Response(
            JSON.stringify({ detail: 'That workspace is already the default' }),
            { status: 409 },
        ))

        const err = await setDefaultError()
        expect(err.message).toBe('That workspace is already the default')
    })

    it('leaves the message empty when the server sends nothing readable, so the caller can name the action', async () => {
        // A 502 over HTTP/2 carries no statusText and no body. The page-level
        // guards (`err.message ? err.message : "Could not make X the default…"`)
        // only work if there is genuinely nothing to prefer over them.
        fetchWithTimeoutMock.mockResolvedValueOnce(
            new Response('', { status: 502, statusText: '' }),
        )

        const err = await setDefaultError()
        expect(err.message).toBe('')
    })

    it('keeps a non-JSON body as-is', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(
            new Response('<html>504 Gateway Timeout</html>', { status: 504 }),
        )

        const err = await setDefaultError()
        expect(err.message).toBe('<html>504 Gateway Timeout</html>')
    })
})
