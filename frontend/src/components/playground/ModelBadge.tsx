/**
 * Where a data model on offer in the Playground comes from, as a small label beside its name:
 * approved for everyone, shared by another member, the reader's own, a starter, or a sample's.
 */
import { cn } from '@/lib/utils'
import type { PlaygroundModelKind } from '@/services/playgroundService'

export const MODEL_KIND_LABEL: Record<PlaygroundModelKind, string> = {
    approved: 'Approved', shared: 'Shared', yours: 'Yours', starter: 'Starter', sample: 'Sample',
}

const TONE: Record<PlaygroundModelKind, string> = {
    approved: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20',
    shared: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/20',
    yours: 'bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/20',
    starter: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20',
    sample: 'bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/20',
}

export function ModelBadge({ kind }: { kind: PlaygroundModelKind }) {
    return (
        <span className={cn('shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider', TONE[kind])}>
            {MODEL_KIND_LABEL[kind]}
        </span>
    )
}
