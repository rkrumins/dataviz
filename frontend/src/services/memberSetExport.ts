/**
 * memberSetExport — everything a membership spec reaches, worked out on the
 * server and written to a file.
 *
 * The server resolves a set a step at a time (``POST /member-sets``), each
 * request moving it on as far as its wait allows and keeping where it got to,
 * so a set of a million entities resolves as surely as one of ten — and a
 * restart of whichever server was working on it costs a step, not the set.
 * This follows a set to the end, reporting each answer as it lands. The answer
 * that completes it carries a download token: the files download from
 * ``RemoteGraphProvider.memberSetDownloadUrl``, for whoever asked.
 */
import type { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { MemberSetRequest, MemberSetStatus } from '@/types/memberSet'

/** How long each request lets the server work before answering. */
const WAIT_MS = 10_000

/** A backstop, not a budget: at ten seconds a request, about six hours. */
const MAX_REQUESTS = 2_000

/**
 * Follow the set of ``request`` (without its setId) to completion, calling
 * ``onUpdate`` with every answer. Rejects when aborted, when a request fails,
 * or when the set itself failed.
 */
export async function followMemberSet(
    provider: RemoteGraphProvider,
    viewId: string | null,
    request: Omit<MemberSetRequest, 'setId' | 'waitMs'>,
    opts: {
        signal?: AbortSignal
        onUpdate?: (answer: MemberSetStatus) => void
    } = {},
): Promise<MemberSetStatus> {
    let setId: string | undefined
    for (let n = 0; n < MAX_REQUESTS; n++) {
        const answer = await provider.memberSet(viewId, {
            ...request,
            waitMs: WAIT_MS,
            ...(setId ? { setId } : {}),
        }, { signal: opts.signal })
        opts.onUpdate?.(answer)
        if (answer.status === 'complete') return answer
        if (answer.status === 'failed') throw new Error('The server could not work this out.')
        // No longer kept (swept, or its data moved on): the same question afresh.
        setId = answer.status === 'expired' ? undefined : answer.setId
    }
    throw new Error(`still working after ${MAX_REQUESTS} requests`)
}
