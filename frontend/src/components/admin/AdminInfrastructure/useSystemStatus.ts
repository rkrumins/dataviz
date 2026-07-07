/**
 * useSystemStatus — react-query poll of the infrastructure snapshot plus a
 * page-lifetime sparkline history (per the "live history only" decision:
 * points accumulate while the page is open, nothing is stored server-side).
 *
 * refetchIntervalInBackground stays at its default (false) so polling
 * pauses when the tab is hidden — the backend's ~10s snapshot cache makes
 * each poll cheap, and a hidden tab costs nothing at all.
 */
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { systemStatusService, type SystemStatusSnapshot } from '@/services/systemStatusService'

const POLL_MS = 10_000
const MAX_POINTS = 60

export function useSystemStatus() {
    const query = useQuery<SystemStatusSnapshot>({
        queryKey: ['admin', 'system-status'],
        queryFn: systemStatusService.get,
        refetchInterval: POLL_MS,
        staleTime: 5_000,
        refetchOnWindowFocus: true,
        retry: 1,
    })

    const historyRef = useRef<Map<string, number[]>>(new Map())
    const [historyVersion, setHistoryVersion] = useState(0)
    const lastStampRef = useRef(0)

    useEffect(() => {
        const snap = query.data
        if (!snap || query.dataUpdatedAt === lastStampRef.current) return
        lastStampRef.current = query.dataUpdatedAt

        const push = (key: string, value: number | null | undefined) => {
            if (value == null) return
            const arr = historyRef.current.get(key) ?? []
            arr.push(value)
            if (arr.length > MAX_POINTS) arr.shift()
            historyRef.current.set(key, arr)
        }

        for (const svc of snap.services) push(`latency:${svc.key}`, svc.latencyMs)
        const agg = snap.streams?.aggregation.jobs
        push('stream:aggregation.jobs', agg?.groupLag ?? agg?.len)
        for (const [name, depth] of Object.entries(snap.streams?.insights.streams ?? {})) {
            push(`stream:${name}`, depth.groupLag ?? depth.len)
        }
        push('projection:lagging', snap.projection?.lagging)
        setHistoryVersion(v => v + 1)
    }, [query.data, query.dataUpdatedAt])

    return { ...query, history: historyRef.current, historyVersion }
}
