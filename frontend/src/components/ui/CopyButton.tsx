/**
 * CopyButton — copies one value, and says so.
 *
 * The check stays for a beat so the click is confirmed without a toast. A
 * denied or missing clipboard is a no-op, never an error: copying is a
 * convenience on a page that must keep working without it. Inside a clickable
 * row it does not also open the row.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { cn } from '@/lib/utils'

export function CopyButton({ value, label, className, iconClassName }: {
    value: string
    /** What is copied, for the accessible name: "Copy event id". */
    label: string
    className?: string
    iconClassName?: string
}) {
    const [copied, setCopied] = useState(false)
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
    useEffect(() => () => clearTimeout(timer.current), [])

    return (
        <button
            type="button"
            aria-label={copied ? `${label}: copied` : label}
            onClick={(e) => {
                e.stopPropagation()
                navigator.clipboard?.writeText(value).then(
                    () => {
                        setCopied(true)
                        clearTimeout(timer.current)
                        timer.current = setTimeout(() => setCopied(false), 1200)
                    },
                    () => {},
                )
            }}
            className={cn(
                'inline-flex shrink-0 items-center justify-center rounded-md p-1 text-ink-muted transition-colors',
                'hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.07]',
                'outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                className,
            )}
        >
            {copied
                ? <Check aria-hidden className={cn('h-3 w-3 text-emerald-500', iconClassName)} />
                : <Copy aria-hidden className={cn('h-3 w-3', iconClassName)} />}
        </button>
    )
}
