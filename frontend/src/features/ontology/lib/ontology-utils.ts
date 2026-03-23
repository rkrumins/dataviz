/**
 * Shared utilities for ontology features.
 */
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { GraphSchemaStats } from '@/providers/GraphDataProvider'

/**
 * Fetch graph schema stats for an arbitrary workspace/data-source combination.
 * Creates an ad-hoc RemoteGraphProvider — no global context required.
 */
export async function fetchSchemaStats(
  workspaceId: string,
  dataSourceId?: string,
): Promise<GraphSchemaStats> {
  const provider = new RemoteGraphProvider({ workspaceId, dataSourceId })
  return provider.getSchemaStats()
}
