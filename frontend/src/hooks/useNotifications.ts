/**
 * useNotifications — the bell's data.
 *
 * Poll posture matches the app's other always-mounted idle polls
 * (announcements, ``/me/permissions``): the interval baseline comes from
 * ``config/polling.ts``, and ``refetchIntervalInBackground`` is left at
 * its default of false so a hidden tab costs nothing. The interval is the
 * floor, not the mechanism people notice — ``refetchOnWindowFocus`` is
 * what makes the badge correct the moment someone looks at the tab.
 *
 * ``staleTime`` has to be set explicitly: the app-wide default is five
 * minutes, which would make the focus refetch a no-op for most returns.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
    listNotifications,
    markNotificationsRead,
    type Notification,
    type NotificationList,
} from '@/services/notificationsService'
import { POLLING_INTERVALS } from '@/config/polling'

export const NOTIFICATIONS_QUERY_KEY = ['me', 'notifications'] as const

const EMPTY: Notification[] = []

export interface UseNotificationsResult {
    items: Notification[]
    unread: number
    isLoading: boolean
    /** Mark every notification read (the backend's "omit ids" case). */
    markAllRead: () => void
    markRead: (id: string) => void
}

export function useNotifications(): UseNotificationsResult {
    const queryClient = useQueryClient()

    const query = useQuery<NotificationList>({
        queryKey: NOTIFICATIONS_QUERY_KEY,
        queryFn: () => listNotifications(),
        refetchInterval: POLLING_INTERVALS.notifications,
        refetchOnWindowFocus: true,
        staleTime: 15_000,
        // A bell is never worth a retry storm; one attempt, then wait for
        // the next poll.
        retry: 1,
    })

    const markRead = useMutation<NotificationList, Error, string[] | undefined>({
        mutationFn: (ids) => markNotificationsRead(ids),
        onSuccess: (data) => {
            // The POST answers with the post-mutation list AND the new
            // unread count, so the badge is correct before any refetch
            // lands — seeding the cache is what makes the click feel
            // instant rather than waiting a round trip to un-bold.
            queryClient.setQueryData(NOTIFICATIONS_QUERY_KEY, data)
            void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY })
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
