/**
 * AvatarStack — a few faces, overlapping, and how many more: who is in a conversation, who a
 * question goes to. Each face is ringed in the surface colour so the overlap reads as a cut, and
 * the count of the rest is a face of its own. The names are spoken once, for a screen reader.
 */
import { cn } from '@/lib/utils'
import { UserAvatar } from './UserAvatar'

export interface StackPerson {
    id: string
    name: string
    avatarId?: string | null
    hasImage?: boolean
    deleted?: boolean
}

const SIZES = {
    xs: { face: 'w-5 h-5 text-[8px]', overlap: '-ml-1', more: 'text-[8.5px]' },
    sm: { face: 'w-6 h-6 text-[9px]', overlap: '-ml-1.5', more: 'text-[9.5px]' },
    md: { face: 'w-8 h-8 text-[11px]', overlap: '-ml-2', more: 'text-[11px]' },
} as const

export function AvatarStack({ people, total, max = 4, size = 'sm', ring = 'ring-canvas-elevated', label, className }: {
    people: readonly StackPerson[]
    /** Everyone there is, when more than `people` were sent; `people.length` otherwise. */
    total?: number
    /** Faces shown before the rest are counted. */
    max?: number
    size?: keyof typeof SIZES
    /** The ring between faces: the colour of the surface the stack sits on. */
    ring?: string
    /** What the stack is, for a screen reader ("Taking part"); the names follow it. */
    label?: string
    className?: string
}) {
    const s = SIZES[size]
    const count = Math.max(total ?? people.length, people.length)
    const shown = people.slice(0, count > max ? max - 1 : max)
    const rest = count - shown.length
    const names = people.map((p) => p.name).join(', ')
    if (count === 0) return null
    return (
        <span className={cn('inline-flex items-center', className)}
            role="img" aria-label={`${label ? `${label}: ` : ''}${names}${rest > 0 && count > people.length ? ` and ${count - people.length} more` : ''}`}>
            {shown.map((p, i) => (
                <UserAvatar key={p.id} userId={p.id} name={p.name} avatarId={p.avatarId} hasImage={p.hasImage}
                    className={cn(s.face, 'font-bold ring-2', ring, i > 0 && s.overlap, p.deleted && 'grayscale opacity-70')} />
            ))}
            {rest > 0 && (
                <span aria-hidden className={cn(s.face, s.overlap, s.more, 'ring-2', ring,
                    'inline-flex shrink-0 items-center justify-center rounded-full bg-black/[0.07] dark:bg-white/[0.10] font-bold tabular-nums text-ink-secondary')}>
                    +{rest > 99 ? 99 : rest}
                </span>
            )}
        </span>
    )
}
