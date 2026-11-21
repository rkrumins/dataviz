/**
 * Questions and conversations, read and written through react-query (keys under
 * `['discussions', …]`), and only while the `conversationsEnabled` switch is on.
 *
 * How it stays current without costing much:
 *  - a subject's summary (counts, unread, `latest`, questions per node) is the one thing polled —
 *    ETag'd, so an unchanged one is a 304 — and its lists are read again only when `latest` moves;
 *  - an open thread asks only for what changed `since` its newest message, and merges it in;
 *  - every write seeds the cache with what the server answered, so a reply shows at once, and
 *    then refreshes the lists and counts it touched.
 */
import { useCallback, useEffect, useMemo } from 'react'
import {
    keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient,
    type InfiniteData, type QueryClient,
} from '@tanstack/react-query'
import { POLLING_INTERVALS, withJitter } from '@/config/polling'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { INBOX_QUERY_KEY } from '@/hooks/useInbox'
import { useFeature } from '@/store/features'
import type { MentionSource } from '@/features/reviews/comments/CommentComposer'
import type { MentionCandidate } from '@/features/reviews/comments/mentions'
import {
    acceptAnswer, askQuestion, closeThread, deleteMessage, deleteThread, editMessage,
    getMyDiscussionSummary, getSubjectPeople, getSubjectSummaries, getSubjectSummary, getThread, listMentionable,
    listMyDiscussions, listMyWatches, listSubjectThreads, markThreadRead, postReply, reopenThread,
    setThreadMe, unacceptAnswer, unwatchSubject, watchSubject,
    type AskInput, type DiscussionStatus, type MentionablePerson, type MessageResult, type MyBox,
    type SubjectCount, type SubjectKey, type SubjectSummary, type SubjectType, type ThreadDetail,
    type ThreadFilter, type ThreadList, type ThreadChange, type ThreadSummary,
} from '@/services/discussionsService'
import { useAnchorStore } from './anchorStore'

export const CONVERSATIONS_FEATURE = 'conversationsEnabled'

/** Whether questions and conversations are offered at all (the admin switch). */
export function useConversationsEnabled(): boolean {
    return useFeature(CONVERSATIONS_FEATURE)
}

const subjectKey = (s: SubjectKey) => ['discussions', 'subject', s.type, s.id] as const

export const DISCUSSION_KEYS = {
    all: ['discussions'] as const,
    subject: subjectKey,
    threads: (s: SubjectKey, filter: Required<ThreadFilter>) => [...subjectKey(s), 'threads', filter] as const,
    summary: (s: SubjectKey) => [...subjectKey(s), 'summary'] as const,
    /** Every list's card counts; one list's, by its sorted ids. */
    summaries: ['discussions', 'summaries'] as const,
    counts: (type: SubjectType, sortedIds: string[]) => ['discussions', 'summaries', type, sortedIds.join(',')] as const,
    people: (s: SubjectKey) => [...subjectKey(s), 'people'] as const,
    mentionable: (s: SubjectKey) => [...subjectKey(s), 'mentionable'] as const,
    thread: (id: string) => ['discussions', 'thread', id] as const,
    me: ['discussions', 'me'] as const,
    myList: (box: MyBox, status: DiscussionStatus | 'all') => ['discussions', 'me', 'list', box, status] as const,
    mySummary: ['discussions', 'me', 'summary'] as const,
    watches: ['discussions', 'me', 'watches'] as const,
}

export const THREAD_PAGE = 20

const pollEvery = (base: number) => () => withJitter(base)

// ── A subject's threads and counts ─────────────────────────────────

export function useSubjectThreads(subject: SubjectKey | null | undefined, filter: ThreadFilter = {}) {
    const on = useConversationsEnabled()
    const f: Required<ThreadFilter> = { status: filter.status ?? 'all', entityId: filter.entityId ?? null, mine: !!filter.mine }
    return useInfiniteQuery({
        queryKey: DISCUSSION_KEYS.threads(subject ?? { type: 'view', id: '' }, f),
        queryFn: ({ pageParam }) => listSubjectThreads(subject!, f, { cursor: pageParam, limit: THREAD_PAGE }),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.nextCursor ?? undefined,
        enabled: on && !!subject?.id,
        // Read again when the summary's `latest` moves (below), not on a clock of its own.
        staleTime: 5 * 60_000,
        refetchOnWindowFocus: false,
    })
}

/** The `latest` each subject's summary was last seen at, so the first reader to see it move
 *  refreshes the lists and the others don't do it again. */
const seenLatest = new Map<string, string | null>()

/**
 * A subject's counts — open, answered, unread, watching, questions per node — polled, ETag'd.
 * `live` polls at the open-drawer pace instead of the badge pace.
 */
export function useSubjectSummary(subject: SubjectKey | null | undefined, { live = false }: { live?: boolean } = {}) {
    const on = useConversationsEnabled()
    const qc = useQueryClient()
    const q = useQuery({
        queryKey: DISCUSSION_KEYS.summary(subject ?? { type: 'view', id: '' }),
        queryFn: () => getSubjectSummary(subject!),
        enabled: on && !!subject?.id,
        refetchInterval: pollEvery(live ? POLLING_INTERVALS.discussions : POLLING_INTERVALS.discussionSummary),
        refetchOnWindowFocus: true,
        staleTime: 15_000,
        retry: 1,
    })
    const latest = q.data?.latest
    const type = subject?.type
    const id = subject?.id
    useEffect(() => {
        if (latest === undefined || !type || !id) return
        const k = `${type}:${id}`
        const before = seenLatest.get(k)
        seenLatest.set(k, latest)
        if (before !== undefined && before !== latest) {
            void qc.invalidateQueries({ queryKey: [...subjectKey({ type, id }), 'threads'] })
        }
    }, [qc, type, id, latest])
    return q
}

/** Ids one card-counts request carries, at most (the server's cap). */
export const COUNTS_CHUNK = 100
const NO_COUNTS: Record<string, SubjectCount> = {}

/**
 * The question counts on a list of cards — views or data sources — by id: one request per hundred
 * for the whole list, never one per card; polled at the badge pace, ETag'd. A subject the reader
 * can't open, or with no question they can see, is absent. Empty while the switch is off.
 */
export function useSubjectCounts(type: SubjectType, ids: readonly string[]): Record<string, SubjectCount> {
    const on = useConversationsEnabled()
    const sorted = useMemo(() => [...new Set(ids)].sort(), [ids])
    const q = useQuery({
        queryKey: DISCUSSION_KEYS.counts(type, sorted),
        queryFn: async () => {
            const chunks: string[][] = []
            for (let i = 0; i < sorted.length; i += COUNTS_CHUNK) chunks.push(sorted.slice(i, i + COUNTS_CHUNK))
            const pages = await Promise.all(chunks.map((c) => getSubjectSummaries(type, c)))
            return Object.assign({}, ...pages.map((p) => p.summaries)) as Record<string, SubjectCount>
        },
        enabled: on && sorted.length > 0,
        refetchInterval: pollEvery(POLLING_INTERVALS.discussionSummary),
        refetchOnWindowFocus: true,
        // A new page of cards keeps the numbers already shown until its own arrive.
        placeholderData: keepPreviousData,
        staleTime: 15_000,
        retry: 1,
    })
    return (on && q.data) || NO_COUNTS
}

/** Keeps the canvas's question marks counting the questions on `viewId`, while it is open. */
export function useViewQuestionAnchors(viewId: string | null | undefined) {
    const summary = useSubjectSummary(viewId ? { type: 'view', id: viewId } : null).data
    const byEntity = summary?.byEntity
    useEffect(() => {
        if (!viewId || !byEntity) return
        useAnchorStore.getState().set(viewId, byEntity)
    }, [viewId, byEntity])
    useEffect(() => {
        if (!viewId) return
        return () => useAnchorStore.getState().clear(viewId)
    }, [viewId])
}

/** Who to ask about a subject: its owners and data contacts, with how each came to be one. */
export function useSubjectPeople(subject: SubjectKey | null | undefined) {
    const on = useConversationsEnabled()
    return useQuery({
        queryKey: DISCUSSION_KEYS.people(subject ?? { type: 'view', id: '' }),
        queryFn: () => getSubjectPeople(subject!),
        enabled: on && !!subject?.id,
        staleTime: 5 * 60_000,
    })
}

const toCandidate = (p: MentionablePerson): MentionCandidate => ({
    id: p.id, name: p.displayName || p.email || p.id, email: p.email, avatarId: p.avatarId, hasImage: p.hasImage, hint: p.hint,
})

/** People who can read the subject matching `q` — asked a pause after the typing stops. */
export function useMentionable(subject: SubjectKey | null | undefined, q: string, enabled = true) {
    const on = useConversationsEnabled()
    const query = useDebouncedValue(q.trim(), 200)
    return useQuery({
        queryKey: [...DISCUSSION_KEYS.mentionable(subject ?? { type: 'view', id: '' }), query],
        queryFn: async () => (await listMentionable(subject!, query)).people.map(toCandidate),
        enabled: on && enabled && !!subject?.id,
        staleTime: 60_000,
        placeholderData: (prev) => prev,
    })
}

/** The composer's `@` list for a subject: anyone who can read it, with their role there. */
export function useMentionSource(subject: SubjectKey): MentionSource {
    const { type, id } = subject
    return useMemo(() => ({
        queryKey: DISCUSSION_KEYS.mentionable({ type, id }),
        load: async (q: string) => (await listMentionable({ type, id }, q)).people.map(toCandidate),
    }), [type, id])
}

/** Whether the reader watches the subject (told of each new open question), and the switch. */
export function useWatch(subject: SubjectKey | null | undefined) {
    const qc = useQueryClient()
    const summary = useSubjectSummary(subject)
    const watching = summary.data?.watching ?? false
    const key = DISCUSSION_KEYS.summary(subject ?? { type: 'view', id: '' })
    const m = useMutation({
        mutationFn: (watch: boolean) => (watch ? watchSubject(subject!) : unwatchSubject(subject!)),
        onMutate: (watch) => {
            const before = qc.getQueryData<SubjectSummary>(key)
            if (before) qc.setQueryData<SubjectSummary>(key, { ...before, watching: watch })
            return { before }
        },
        onError: (_e, _w, ctx) => { if (ctx?.before) qc.setQueryData(key, ctx.before) },
        onSettled: () => {
            void qc.invalidateQueries({ queryKey: key })
            void qc.invalidateQueries({ queryKey: DISCUSSION_KEYS.watches })
        },
    })
    return { watching, ready: !!summary.data, toggle: () => m.mutate(!watching), isPending: m.isPending, error: m.error }
}

// ── One thread ─────────────────────────────────────────────────────

const stamp = (s: string | null | undefined) => (s ? Date.parse(s) : NaN)

/** The newest moment anything in the thread changed: where the next `since` poll starts. */
export function changedSince(thread: ThreadDetail): string {
    let best = thread.createdAt
    let bestAt = stamp(best)
    for (const m of thread.messages) {
        for (const at of [m.createdAt, m.editedAt, m.deletedAt]) {
            const t = stamp(at)
            if (t > bestAt) { best = at!; bestAt = t }
        }
    }
    return best
}

const byCreated = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
    stamp(a.createdAt) - stamp(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** What a `since` page changed, merged into the thread as it was: newer or changed messages
 *  replace theirs, the thread's own state is the page's, older pages stay. */
export function mergeThread(prev: ThreadDetail, page: ThreadDetail): ThreadDetail {
    const messages = new Map(prev.messages.map((m) => [m.id, m]))
    for (const m of page.messages) messages.set(m.id, m)
    return {
        ...page,
        messages: [...messages.values()].sort(byCreated),
        olderCursor: prev.olderCursor,
        people: { ...prev.people, ...page.people },
    }
}

/** A write's answer — one message and the thread's new state — folded into the thread. */
function applyMessage(prev: ThreadDetail, res: MessageResult): ThreadDetail {
    const messages = new Map(prev.messages.map((m) => [m.id, m]))
    messages.set(res.message.id, res.message)
    return {
        ...prev,
        ...res.thread,
        messages: [...messages.values()].sort(byCreated),
        people: { ...prev.people, ...res.people },
    }
}

/**
 * A thread, polled while it is on screen: the first read takes its newest page, each poll after
 * it only what changed since, merged in. `loadOlder` reads the page before the oldest shown;
 * `reload` reads it afresh (after "This changed").
 */
export function useThread(threadId: string | null | undefined, { poll = true }: { poll?: boolean } = {}) {
    const on = useConversationsEnabled()
    const qc = useQueryClient()
    const key = DISCUSSION_KEYS.thread(threadId ?? '')
    const q = useQuery({
        queryKey: key,
        queryFn: async () => {
            const prev = qc.getQueryData<ThreadDetail>(key)
            if (!prev) return getThread(threadId!)
            return mergeThread(prev, await getThread(threadId!, { since: changedSince(prev) }))
        },
        enabled: on && !!threadId,
        refetchInterval: poll ? pollEvery(POLLING_INTERVALS.discussions) : false,
        refetchOnWindowFocus: true,
        staleTime: 10_000,
    })
    const loadOlder = useCallback(async () => {
        if (!threadId) return
        const prev = qc.getQueryData<ThreadDetail>(DISCUSSION_KEYS.thread(threadId))
        if (!prev?.olderCursor) return
        const page = await getThread(threadId, { cursor: prev.olderCursor })
        qc.setQueryData<ThreadDetail>(DISCUSSION_KEYS.thread(threadId), (cur) => cur && {
            ...cur,
            messages: [...new Map([...page.messages, ...cur.messages].map((m) => [m.id, m])).values()].sort(byCreated),
            olderCursor: page.olderCursor,
            people: { ...page.people, ...cur.people },
        })
    }, [qc, threadId])
    const reload = useCallback(async () => {
        if (!threadId) return
        qc.setQueryData(DISCUSSION_KEYS.thread(threadId), await getThread(threadId))
    }, [qc, threadId])
    return { ...q, loadOlder, reload }
}

// ── Writes ─────────────────────────────────────────────────────────

type Rows = InfiniteData<ThreadList>

/** A change to one thread's row, wherever a list holds it — the unread dot clears at once. */
function patchRows(qc: QueryClient, id: string, patch: Partial<ThreadSummary>) {
    qc.setQueriesData<Rows>({
        queryKey: DISCUSSION_KEYS.all,
        predicate: (query) => query.queryKey.includes('threads') || (query.queryKey[1] === 'me' && query.queryKey[2] === 'list'),
    }, (data) => data?.pages ? {
        ...data,
        pages: data.pages.map((p) => ({ ...p, threads: p.threads.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
    } : data)
}

/** Every list and count a change to a thread about `subject` may have moved. */
function refreshAround(qc: QueryClient, subject: SubjectKey | null | undefined) {
    if (subject) {
        void qc.invalidateQueries({ queryKey: [...subjectKey(subject), 'threads'] })
        void qc.invalidateQueries({ queryKey: DISCUSSION_KEYS.summary(subject) })
    }
    void qc.invalidateQueries({ queryKey: DISCUSSION_KEYS.summaries })
    void qc.invalidateQueries({ queryKey: DISCUSSION_KEYS.me })
}

/**
 * Ask, reply, edit, delete, accept, close and reopen, mute and follow, mark read. Each folds the
 * server's answer into the thread at once (the composer shows a post while it is on its way, and
 * keeps it with Retry when it fails), then refreshes the lists and counts around it.
 */
export function useDiscussionActions() {
    const qc = useQueryClient()
    const threadOf = (id: string) => qc.getQueryData<ThreadDetail>(DISCUSSION_KEYS.thread(id))
    const putThread = (id: string, fn: (t: ThreadDetail) => ThreadDetail) =>
        qc.setQueryData<ThreadDetail>(DISCUSSION_KEYS.thread(id), (t) => (t ? fn(t) : t))
    const onMessage = (threadId: string) => (res: MessageResult) => {
        putThread(threadId, (t) => applyMessage(t, res))
        refreshAround(qc, res.thread.subject)
    }
    const onThread = (threadId: string) => (res: ThreadChange) => {
        putThread(threadId, (t) => ({ ...t, ...res.thread, people: { ...t.people, ...res.people } }))
        patchRows(qc, threadId, res.thread)
        refreshAround(qc, res.thread.subject)
    }

    const ask = useMutation({
        mutationFn: ({ subject, input }: { subject: SubjectKey; input: AskInput }) => askQuestion(subject, input),
        onSuccess: (res, { subject }) => {
            qc.setQueryData(DISCUSSION_KEYS.thread(res.thread.id), res.thread)
            refreshAround(qc, subject)
        },
    })
    const reply = useMutation({
        mutationFn: ({ threadId, ...input }: { threadId: string; body: string; mentions: string[]; clientKey: string }) =>
            postReply(threadId, input),
        onSuccess: (res, { threadId }) => onMessage(threadId)(res),
    })
    const edit = useMutation({
        mutationFn: ({ threadId, messageId, ...input }: { threadId: string; messageId: string; body: string; mentions: string[]; expectedVersion: number }) =>
            editMessage(threadId, messageId, input),
        onSuccess: (res, { threadId }) => onMessage(threadId)(res),
    })
    const remove = useMutation({
        mutationFn: ({ threadId, messageId }: { threadId: string; messageId: string }) => deleteMessage(threadId, messageId),
        onSuccess: (res, { threadId }) => onMessage(threadId)(res),
    })
    /** Accept `messageId` as the answer, or (null) take the accepted answer back. */
    const answer = useMutation({
        mutationFn: ({ threadId, messageId, expectedVersion }: { threadId: string; messageId: string | null; expectedVersion: number }) =>
            (messageId ? acceptAnswer(threadId, messageId, expectedVersion) : unacceptAnswer(threadId, expectedVersion)),
        onSuccess: (res, { threadId }) => onThread(threadId)(res),
    })
    const setStatus = useMutation({
        mutationFn: ({ threadId, close, expectedVersion }: { threadId: string; close: boolean; expectedVersion: number }) =>
            (close ? closeThread(threadId, expectedVersion) : reopenThread(threadId, expectedVersion)),
        onSuccess: (res, { threadId }) => onThread(threadId)(res),
    })
    const removeThread = useMutation({
        mutationFn: ({ threadId }: { threadId: string }) => deleteThread(threadId),
        onSuccess: (_res, { threadId }) => {
            const subject = threadOf(threadId)?.subject
            qc.removeQueries({ queryKey: DISCUSSION_KEYS.thread(threadId), exact: true })
            refreshAround(qc, subject)
        },
    })
    /** Mute (no more notifications) or follow (notifications without having taken part). */
    const setMine = useMutation({
        mutationFn: ({ threadId, ...state }: { threadId: string; muted?: boolean; following?: boolean }) => setThreadMe(threadId, state),
        onMutate: ({ threadId, ...state }) => {
            const before = threadOf(threadId)
            putThread(threadId, (t) => ({ ...t, ...state }))
            return { before }
        },
        onError: (_e, { threadId }, ctx) => { if (ctx?.before) qc.setQueryData(DISCUSSION_KEYS.thread(threadId), ctx.before) },
        onSuccess: (res, { threadId }) => {
            putThread(threadId, (t) => ({ ...t, ...res }))
            patchRows(qc, threadId, res)
        },
    })
    const markRead = useMutation({
        mutationFn: (threadId: string) => markThreadRead(threadId),
        onSuccess: (_res, threadId) => {
            putThread(threadId, (t) => ({ ...t, unread: false }))
            patchRows(qc, threadId, { unread: false })
            const subject = threadOf(threadId)?.subject
            if (subject) void qc.invalidateQueries({ queryKey: DISCUSSION_KEYS.summary(subject) })
            // The card's unread dot goes too.
            void qc.invalidateQueries({ queryKey: DISCUSSION_KEYS.summaries })
            void qc.invalidateQueries({ queryKey: DISCUSSION_KEYS.mySummary })
            // Reading the thread marks its Inbox messages read too.
            void qc.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
        },
    })
    return { ask, reply, edit, remove, answer, setStatus, removeThread, setMine, markRead }
}

// ── The reader's own ───────────────────────────────────────────────

/** The reader's conversations in one box — asked of them, their own, mentions, watched. */
export function useMyConversations(box: MyBox, status: DiscussionStatus | 'all' = 'all') {
    const on = useConversationsEnabled()
    return useInfiniteQuery({
        queryKey: DISCUSSION_KEYS.myList(box, status),
        queryFn: ({ pageParam }) => listMyDiscussions(box, status, { cursor: pageParam, limit: THREAD_PAGE }),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.nextCursor ?? undefined,
        enabled: on,
        staleTime: 30_000,
        refetchOnWindowFocus: true,
    })
}

/** The reader's unread counts per box, polled like the bell. */
export function useMySummary() {
    const on = useConversationsEnabled()
    return useQuery({
        queryKey: DISCUSSION_KEYS.mySummary,
        queryFn: getMyDiscussionSummary,
        enabled: on,
        refetchInterval: pollEvery(POLLING_INTERVALS.discussionSummary),
        refetchOnWindowFocus: true,
        staleTime: 15_000,
        retry: 1,
    })
}

/** What the reader watches. */
export function useMyWatches() {
    const on = useConversationsEnabled()
    return useInfiniteQuery({
        queryKey: DISCUSSION_KEYS.watches,
        queryFn: ({ pageParam }) => listMyWatches({ cursor: pageParam, limit: 50 }),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.nextCursor ?? undefined,
        enabled: on,
        staleTime: 60_000,
    })
}
