/**
 * PullLatestButton — conflicts are resolved from the draft's values the pull hands back for just
 * those entities. It used to download the draft's whole diff to seed them: for a draft of 100k
 * changes, 80 MB to resolve a handful of fields.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PullLatestButton } from '../PullLatestButton'

let resolverProps: Record<string, unknown> | null
const diffVsMain = vi.fn()

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('@/features/reviews/components/ConflictResolver', () => ({
    ConflictResolver: (props: Record<string, unknown>) => {
        resolverProps = props
        return <div>resolving</div>
    },
}))
vi.mock('../IncomingChangesSheet', () => ({ IncomingChangesSheet: () => null }))
vi.mock('../../hooks/useVersioning', () => ({
    useDiffVsMain: (...args: unknown[]) => diffVsMain(...args),
    usePullLatestDraft: () => ({
        isPending: false,
        mutate: (_vars: unknown, { onSuccess }: { onSuccess: (res: unknown) => void }) => onSuccess({
            clean: false,
            conflicts: [{ entity_id: 'A', path: ['f'], base: 1, ours: 99, theirs: 2 }],
            seeds: { A: { displayName: 'A', entityType: 'Dataset', f: 99 } },
        }),
    }),
}))

beforeEach(() => {
    resolverProps = null
    diffVsMain.mockReset()
})

describe('PullLatestButton', () => {
    it('resolves conflicts from the draft values the pull hands back', () => {
        render(<PullLatestButton wsId="ws1" graphId="g1" branchId="br_1" behind variant="bar" />)
        fireEvent.click(screen.getByText('Get latest updates'))
        expect(screen.getByText('resolving')).toBeInTheDocument()
        expect(resolverProps?.seeds).toEqual({ A: { displayName: 'A', entityType: 'Dataset', f: 99 } })
        expect(diffVsMain).not.toHaveBeenCalled()
    })
})
