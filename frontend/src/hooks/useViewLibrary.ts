/**
 * useViewLibrary — loads the open view's library (its display rules and
 * saved queries, from the server) and keeps it loaded as the view, or the
 * draft open on it, changes. Mounted once per canvas, beside the rule
 * engine that reads the rules it loads.
 *
 * ``branchId`` is the draft open on the view, if any: a draft shows its own
 * rules once it has changed them, the published ones until then.
 */
import { useEffect } from 'react'

import { useViewLibraryStore } from '@/store/viewLibraryStore'


export function useViewLibrary(viewId: string | null | undefined, branchId: string | null | undefined): void {
    const load = useViewLibraryStore((s) => s.load)
    useEffect(() => {
        void load(viewId ?? null, branchId ?? null)
    }, [viewId, branchId, load])
}
