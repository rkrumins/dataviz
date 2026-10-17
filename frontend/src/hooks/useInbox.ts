/**
 * useInbox — the bell's data.
 *
 * There is no interval. A notification exists because somebody else did
 * something — it is an event, and the change feed delivers it as one, so
 * this refetches when the caller's notification topic moves rather than
 * once a minute forever on the chance that it did.
 *
 * ``refetchOnWindowFocus`` stays: it is what makes the badge correct the
 * moment someone looks at the tab, and it covers the window where the
 * feed's transport is reconnecting. ``staleTime`` has to be set
 * explicitly for it to mean anything — the app-wide default is five
 * minutes, which would make the focus refetch a no-op for most returns.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
    listInbox,
    markInboxRead,
    type InboxItem,
    type InboxList,
} from '@/services/inboxService'
import { useUserChangeTopic } from '@/store/changeFeed'

export const INBOX_QUERY_KEY = ['me', 'notifications'] as const

const EMPTY: InboxItem[] = []

export interface UseInboxResult {
    items: InboxItem[]
    unread: number
    isLoading: boolean
    /** Mark every message read (the backend's "omit ids" case). */
    markAllRead: () => void
    markRead: (id: string) => void
}

export function useInbox(): UseInboxResult {
    const queryClient = useQueryClient()

    const query = useQuery<InboxList>({
        queryKey: INBOX_QUERY_KEY,
        queryFn: () => listInbox(),
        // No ``refetchInterval``: the change feed wakes this when the
        // caller's notification topic moves. A notification is written
        // by someone else's action, so there is a real event to hang
        // the refresh on — polling for one was asking a question whose
        // answer was almost always no, once a minute, per tab.
        refetchOnWindowFocus: true,
        staleTime: 15_000,
        // A bell is never worth a retry storm; one attempt, then wait for
        // the next signal.
        retry: 1,
    })

    // "notifications", not "inbox": the topic names the backend resource,
    // which main deliberately kept (see inboxService.ts — "the backend
    // route keeps its name"). Renaming it here would subscribe to a topic
    // the server never bumps, and the bell would simply stop updating
    // with nothing failing to say so.
    useUserChangeTopic('notifications', () =>
        queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY }),
    )

    const markRead = useMutation<InboxList, Error, string[] | undefined>({
        mutationFn: (ids) => markInboxRead(ids),
        onSuccess: (data) => {
            // The POST answers with the post-mutation list AND the new
            // unread count, so the badge is correct before any refetch
            // lands — seeding the cache is what makes the click feel
            // instant rather than waiting a round trip to un-bold.
            queryClient.setQueryData(INBOX_QUERY_KEY, data)
            void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
        },
    })

    return {
        items: query.data?.items ?? EMPTY,
        unread: query.data?.unread ?? 0,
        isLoading: query.isLoading,
        markAllRead: () => markRead.mutate(undefined),
        markRead: (id: string) => markRead.mutate([id]),
    }
}
