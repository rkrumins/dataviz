/**
 * useSchemaStatus — the database schema, read live by the server on each poll.
 *
 * A slower poll than the snapshot's: the schema changes when an upgrade runs, not second to second.
 */
import { useQuery } from '@tanstack/react-query'
import { systemStatusService, type SchemaStatus } from '@/services/systemStatusService'

export function useSchemaStatus() {
    return useQuery<SchemaStatus>({
        queryKey: ['admin', 'schema-status'],
        queryFn: systemStatusService.getSchema,
        refetchInterval: 60_000,
        staleTime: 30_000,
    })
}
