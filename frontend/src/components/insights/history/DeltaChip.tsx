/**
 * DeltaChip — the signed-change pill used across the history surface.
 *
 * Its own file because `shared.ts` is functions and constants; a module
 * that exports both a component and helpers breaks Fast Refresh for every
 * consumer of the helpers.
 */
import { cn } from '@/lib/utils'

import { deltaTone, signedNum } from './shared'


/** Small pill used for deltas across the page. */
export function DeltaChip({ value, suffix, className }: {
    value: number | null | undefined
    suffix?: string
    className?: string
}) {
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full',
                'text-[11px] font-bold tabular-nums',
                deltaTone(value),
                className,
            )}
        >
            {signedNum(value)}{suffix ? <span className="font-semibold opacity-70">{suffix}</span> : null}
        </span>
    )
}
