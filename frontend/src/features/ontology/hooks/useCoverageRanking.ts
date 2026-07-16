/**
 * useCoverageRanking — analyze how well one ontology covers every data source
 * across all workspaces (the "reverse suggest" flow). Fetches each source's
 * schema stats + coverage with bounded concurrency so large fleets rank fast
 * without overwhelming the backend.
 */
import { useEffect, useRef, useState } from 'react'
import { ontologyDefinitionService } from '@/services/ontologyDefinitionService'
import type { WorkspaceResponse } from '@/services/workspaceService'
import { fetchSchemaStats } from '../lib/ontology-utils'

export interface RankedDataSource {
  workspaceId: string
  workspaceName: string
  dataSourceId: string
  dataSourceLabel: string
  coveragePercent: number | null
  status: 'loading' | 'done' | 'error'
  currentOntologyId: string | null
}

const CONCURRENCY = 4

export function useCoverageRanking(ontologyId: string, workspaces: WorkspaceResponse[]) {
  const [results, setResults] = useState<RankedDataSource[]>([])
  const [isAnalyzing, setIsAnalyzing] = useState(true)
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false
    const allDs: RankedDataSource[] = []
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        allDs.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          dataSourceId: ds.id,
          dataSourceLabel: ds.label || ds.id,
          coveragePercent: null,
          status: 'loading',
          currentOntologyId: ds.ontologyId ?? null,
        })
      }
    }
    setResults(allDs)
    setIsAnalyzing(allDs.length > 0)

    ;(async () => {
      let next = 0
      async function worker() {
        while (!cancelledRef.current) {
          const i = next++
          if (i >= allDs.length) return
          const entry = allDs[i]
          try {
            const stats = await fetchSchemaStats(entry.workspaceId, entry.dataSourceId)
            if (cancelledRef.current) return
            const coverage = await ontologyDefinitionService.coverage(
              ontologyId, stats as unknown as Record<string, unknown>,
            )
            if (cancelledRef.current) return
            setResults(prev => prev.map((r, idx) =>
              idx === i ? { ...r, coveragePercent: coverage.coveragePercent, status: 'done' as const } : r
            ))
          } catch {
            if (cancelledRef.current) return
            setResults(prev => prev.map((r, idx) =>
              idx === i ? { ...r, status: 'error' as const } : r
            ))
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, allDs.length) }, () => worker()))
      if (!cancelledRef.current) setIsAnalyzing(false)
    })()

    return () => { cancelledRef.current = true }
  // Workspaces identity churns on refetch; key the analysis on the ontology.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ontologyId])

  const doneCount = results.filter(r => r.status === 'done').length
  return { results, isAnalyzing, doneCount }
}
