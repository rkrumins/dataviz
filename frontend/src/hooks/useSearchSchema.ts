/**
 * React Query hook for the SearchQuery JSON Schema served by the backend.
 *
 * The JSON DSL is the single source of truth for the Search API
 * (see ``docs/`` and the plan's W0). This hook fetches the schema once
 * per app session, caches it indefinitely (it's static within a release),
 * and asserts the served version matches the FE's compiled-against
 * version. A mismatch fails loud — every search-related surface that
 * reads from this hook should gate on ``isReady`` and surface the
 * banner when the version assertion fails.
 *
 * The schema is consumed by:
 *   - The JSON editor (Ajv validation, autocomplete suggestions).
 *   - Visual builder property/edge pickers (enumerations come from the
 *     schema's ``enum`` / ``oneOf`` fields).
 *   - The lossless round-trip codec (decode validates against the
 *     fetched schema before committing to the store).
 */
import { useQuery } from '@tanstack/react-query'

import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import {
    EXPECTED_SCHEMA_VERSION,
    type JsonSchemaDocument,
    readSchemaVersion,
} from '@/types/jsonSchema'


export const SEARCH_SCHEMA_QUERY_KEY = ['search', 'schema'] as const


export interface UseSearchSchemaResult {
    /** The schema document, or ``null`` while loading / on error. */
    schema: JsonSchemaDocument | null
    /** Version the server claims, parsed from ``properties.$schemaVersion``. */
    servedVersion: string | null
    /** Version the FE was compiled against (from ``@synodic/search-schema`` once
     *  polyrepo lands; from a worktree-local constant today). */
    expectedVersion: string
    /** True once we have a schema AND the version matches. The JSON editor,
     *  builder, and round-trip codec gate on this. */
    isReady: boolean
    /** Non-null when the served version doesn't match the expected one —
     *  the consumer surface should refuse to run queries and show a banner. */
    versionMismatch: { expected: string; served: string | null } | null
    /** Plain loading / error pass-through from React Query. */
    isLoading: boolean
    error: unknown
}


export function useSearchSchema(): UseSearchSchemaResult {
    const provider = useGraphProvider()
    // Search endpoints live on the concrete RemoteGraphProvider, not on
    // the GraphDataProvider interface (other graph backends — stub /
    // Neo4j / Spanner — don't speak the advanced-search contract).
    // Narrow to the concrete class; see also useAdvancedSearch.
    const remoteProvider = provider instanceof RemoteGraphProvider ? provider : null

    const query = useQuery({
        queryKey: SEARCH_SCHEMA_QUERY_KEY,
        queryFn: () => {
            if (!remoteProvider) {
                throw new Error(
                    'useSearchSchema requires a RemoteGraphProvider — advanced search ' +
                    'is only implemented against the FalkorDB-backed remote provider.',
                )
            }
            return remoteProvider.searchSchema()
        },
        enabled: remoteProvider !== null,
        // The schema is static within a release; never refetch on focus.
        // The backend serves Cache-Control + ETag headers so the browser
        // 304s most fetches anyway.
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
        retry: 2,
    })

    const schema = query.data ?? null
    const servedVersion = schema ? readSchemaVersion(schema) : null

    const versionMismatch =
        servedVersion !== null && servedVersion !== EXPECTED_SCHEMA_VERSION
            ? { expected: EXPECTED_SCHEMA_VERSION, served: servedVersion }
            : null

    const isReady = schema !== null && versionMismatch === null

    return {
        schema,
        servedVersion,
        expectedVersion: EXPECTED_SCHEMA_VERSION,
        isReady,
        versionMismatch,
        isLoading: query.isLoading,
        error: query.error,
    }
}
