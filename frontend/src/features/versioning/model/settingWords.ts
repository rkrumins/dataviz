/**
 * A graph's settings as its data source shows them: the few an owner looks at first, and where a
 * value came from, said from the graph's side.
 */
import type { TrailScope } from '@/components/settings/types'

/** The settings an owner looks at first, in the order the data source's summary shows them. */
export const SUMMARY_KEYS = ['reads.mode', 'residency.class', 'imports.identifier', 'imports.replaceGuard', 'drafts.levels'] as const

/** Where a value came from: this graph, this workspace, the platform, the deployment's environment, or the default. */
export const SOURCE_WORDS: Record<TrailScope | 'env', string> = {
    graph: 'This graph', workspace: 'This workspace', platform: 'The platform', env: 'Your deployment', default: 'The default',
}
