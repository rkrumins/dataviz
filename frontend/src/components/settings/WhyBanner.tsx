/**
 * WhyBanner — why the value in force differs from the one chosen, and the one click that fixes it
 * ("Turn on New-version builds"). The click calls back; what it does (a feature switch with its own
 * confirmation, or staging a setting) is the page's decision.
 *
 * A polite live region, so a why that appears after an edit is heard as well as seen.
 */
import { Info, Wand2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { describeFix } from './format'
import type { WhyFix, WhyItem } from './types'

export function WhyBanner({ why, onFix, fixLabel = (fix: WhyFix) => describeFix(fix), compact = false, className }: {
    why: WhyItem[]
    onFix?: (fix: WhyFix, item: WhyItem) => void
    /** The fix button's words; `describeFix` by default. */
    fixLabel?: (fix: WhyFix) => string
    /** One line per reason, for inside a setting row. */
    compact?: boolean
    className?: string
}) {
    return (
        <div role="status" aria-live="polite" className={cn(why.length === 0 && 'sr-only', className)}>
            {why.length > 0 && (
                <ul className={cn('grid', compact ? 'gap-1.5' : 'gap-2')}>
                    {why.map((w) => (
                        <li
                            key={w.code}
                            className={cn(
                                'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-amber-500/20 bg-amber-500/[0.06]',
                                compact ? 'px-3 py-2' : 'px-3.5 py-2.5',
                            )}
                        >
                            <Info className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                            <p className="min-w-0 flex-1 basis-56 text-xs leading-relaxed text-ink-secondary">{w.text}</p>
                            {w.fix && onFix && (
                                <Button size="sm" variant="secondary" leftIcon={Wand2} onClick={() => onFix(w.fix as WhyFix, w)}
                                    className="shrink-0">
                                    {fixLabel(w.fix)}
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}
