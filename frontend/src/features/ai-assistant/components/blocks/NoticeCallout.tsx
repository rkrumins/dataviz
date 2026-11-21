import { AlertTriangle, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { NoticeData } from '../../api/types'

/** NoticeCallout — something the person should know about the answer, said beside it. */
export function NoticeCallout({ data }: { data: NoticeData }) {
    const warning = data.tone === 'warning'
    const Glyph = warning ? AlertTriangle : Info
    return (
        <div role="note" className={cn('flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm leading-relaxed',
            warning ? 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200'
                : 'border-sky-500/25 bg-sky-500/5 text-ink-secondary')}>
            <Glyph className={cn('mt-0.5 h-4 w-4 shrink-0', warning ? 'text-amber-500' : 'text-sky-500')} aria-hidden />
            <span>{data.text}</span>
        </div>
    )
}
