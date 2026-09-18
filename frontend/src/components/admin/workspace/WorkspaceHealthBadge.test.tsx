/**
 * Workspace health answers "can I use this workspace?".
 *
 * A source whose rolled-up connections are not being served is one an analyst
 * WILL open and find lineage missing from, so the workspace dot must not read
 * Ready. Aggregation status alone cannot see that: the source's last batch job
 * succeeded and its stored status is still `ready`.
 */
import { describe, expect, it } from 'vitest'
import { deriveWorkspaceHealth } from './WorkspaceHealthBadge'

describe('deriveWorkspaceHealth', () => {
    it('keeps its existing answers', () => {
        expect(deriveWorkspaceHealth([])).toBe('empty')
        expect(deriveWorkspaceHealth([{ aggregationStatus: 'failed' }])).toBe('critical')
        expect(deriveWorkspaceHealth([{ aggregationStatus: 'pending' }])).toBe('warning')
        expect(deriveWorkspaceHealth([{ aggregationStatus: 'ready' }])).toBe('unknown')
        expect(deriveWorkspaceHealth([{ aggregationStatus: 'ready' }], { nodeCount: 10 })).toBe('healthy')
        expect(deriveWorkspaceHealth([{ aggregationStatus: 'ready' }], { nodeCount: 0 })).toBe('no-data')
    })

    it('does not report a workspace as Ready while one of its sources is not serving its connections', () => {
        expect(deriveWorkspaceHealth(
            [
                { aggregationStatus: 'ready' },
                { aggregationStatus: 'ready', projectorCurrent: false },
            ],
            { nodeCount: 2_100_000 },
        )).toBe('critical')
    })

    it('never downgrades on an UNKNOWN reading — null is not a wedge', () => {
        // null/undefined means "not versioned, or the projection store could
        // not be read". Reporting that as a fault would put every external
        // source permanently in the red.
        expect(deriveWorkspaceHealth(
            [
                { aggregationStatus: 'ready', projectorCurrent: null },
                { aggregationStatus: 'ready' },
            ],
            { nodeCount: 5 },
        )).toBe('healthy')
    })
})
