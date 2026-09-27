/**
 * Skeleton — the shape of content that is on its way, instead of a spinner in an empty box.
 * Hidden from assistive tech (the surrounding region says it is loading); still under
 * reduced motion.
 */
import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn('rounded-md bg-black/[0.06] dark:bg-white/[0.07] animate-pulse motion-reduce:animate-none', className)}
      {...rest}
    />
  )
}

/** A paragraph's worth of lines — the last one shorter, as text is. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3', i === lines - 1 && lines > 1 ? 'w-3/5' : 'w-full')} />
      ))}
    </div>
  )
}
