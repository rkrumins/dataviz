/**
 * useNativeQueryEngine — the engine the open view's native queries run on,
 * or null when Edit and run isn't this person's to use here: the switch is
 * off, the view's access says they may not query its source, or the source
 * takes no native queries. The server decides all three; this only reads
 * what it said.
 */
import { useViewExecutionContext } from '@/providers/ViewExecutionContext'
import { useFeature } from '@/store/features'


export function useNativeQueryEngine(): 'falkordb' | 'neo4j' | null {
    const enabled = useFeature('nativeQueryEnabled')
    const access = useViewExecutionContext()?.access
    return enabled && access?.canQueryDataSource ? access.nativeQueryEngine ?? null : null
}
