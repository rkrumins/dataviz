/**
 * Workspace health, said as a sentence with a next step.
 *
 * `deriveWorkspaceHealth` answers "can I use this?" with one word (Ready,
 * Syncing, Needs attention…). A word with no reason sends the reader hunting
 * through tabs for which source and why, so the hero says it: what is going on,
 * in plain words, and — for someone who can act on it — the one place to go.
 */
import type { WorkspaceHealth } from './WorkspaceHealthBadge'
import type { DataSection } from './workspaceTabs'

export interface HealthSource {
    label: string
    aggregationStatus: string
    projectorCurrent?: boolean | null
}

export interface HealthStory {
    /** One sentence about the workspace's data. */
    detail: string
    /** Where to go about it — offered only to someone who can change it. */
    action?: { label: string; section: DataSection }
}

const quoted = (names: string[]) =>
    names.length === 1 ? `“${names[0]}”` : `${names.length} sources`

export function describeWorkspaceHealth(
    status: WorkspaceHealth,
    sources: HealthSource[],
    opts: { canManage: boolean },
): HealthStory {
    const act = (label: string, section: DataSection) => (opts.canManage ? { action: { label, section } } : {})
    const n = sources.length
    switch (status) {
        case 'critical': {
            const failed = sources.filter(s => s.aggregationStatus === 'failed').map(s => s.label)
            const behind = sources.filter(s => s.projectorCurrent === false).map(s => s.label)
            const detail = failed.length
                ? `${quoted(failed)} couldn’t finish refreshing, so some connections may be missing.`
                : `${quoted(behind)} ${behind.length === 1 ? 'is' : 'are'} behind ${behind.length === 1 ? 'its' : 'their'} latest published changes.`
            return { detail, ...act('Review', 'processing') }
        }
        case 'warning': {
            const busy = sources.filter(s => s.aggregationStatus === 'pending' || s.aggregationStatus === 'running')
            return {
                detail: `${quoted(busy.map(s => s.label))} ${busy.length === 1 ? 'is' : 'are'} refreshing. Views keep working meanwhile.`,
                ...act('See progress', 'processing'),
            }
        }
        case 'healthy':
            return { detail: n === 1 ? 'Its data source is up to date.' : `All ${n} data sources are up to date.` }
        case 'no-data':
            return {
                detail: 'Data is connected, but there’s nothing in it yet.',
                ...act('Open sources', 'sources'),
            }
        case 'empty':
            return {
                detail: 'No data is connected yet. Connect a source to start building views.',
                ...act('Connect data', 'sources'),
            }
        default:
            return { detail: 'Checking the data…' }
    }
}
