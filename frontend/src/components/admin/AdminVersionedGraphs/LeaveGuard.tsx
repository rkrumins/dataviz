/**
 * LeaveGuard — asks before leaving drops what is staged on a settings page: another page of the
 * app (the router's blocker, as `components/canvas/UnsavedWorkGuard.tsx` holds a canvas's staged
 * edits), or a reload, a closed tab or another site (the browser's own prompt). A change of tab or
 * of the query on the same page isn't leaving. Esc, like Stay, keeps the page.
 *
 * The app's router is a data router, which can hold a navigation; a plain one (a test's, the
 * harness's) can't, and gets the browser's prompt alone. A router consults one blocker at a time,
 * so a page has one guard, counting what its drawer has staged too.
 */
import { useContext } from 'react'
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { useUnsavedChangesWarning } from '@/hooks/useUnsavedChangesWarning'

function RouteGuard({ count, what, onDiscard }: { count: number; what: string; onDiscard: () => void }) {
    const blocker = useBlocker(({ currentLocation, nextLocation }) => count > 0 && currentLocation.pathname !== nextLocation.pathname)
    return (
        <ConfirmDialog
            open={blocker.state === 'blocked'}
            onOpenChange={(open) => { if (!open && blocker.state === 'blocked') blocker.reset() }}
            title={`Leave without saving ${count} ${count === 1 ? 'change' : 'changes'}?`}
            confirmLabel="Discard and leave"
            cancelLabel="Stay"
            tone="danger"
            onConfirm={() => { if (blocker.state !== 'blocked') return; onDiscard(); blocker.proceed() }}
        >
            Your changes to {what} are staged, not saved. Leaving discards them.
        </ConfirmDialog>
    )
}

export function LeaveGuard({ count, what, onDiscard }: {
    /** How many changes are staged. */
    count: number
    /** Whose changes: "the platform’s settings", "this workspace’s defaults". */
    what: string
    /** Drops them, before the page is left. */
    onDiscard: () => void
}) {
    useUnsavedChangesWarning(count > 0)
    const dataRouter = useContext(UNSAFE_DataRouterContext)
    return dataRouter ? <RouteGuard count={count} what={what} onDiscard={onDiscard} /> : null
}
