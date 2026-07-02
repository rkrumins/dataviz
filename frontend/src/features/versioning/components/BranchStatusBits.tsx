/**
 * Small presentational atoms shared by the branch switcher and the Branch Manager so status and
 * ownership read identically everywhere: a tone-coded status pill and a deterministic owner avatar.
 */
import { cn } from '@/lib/utils'
import { ownerInitials, ownerName, type DraftStatus, type StatusTone } from '../model/branchVocab'

const PILL_TONE: Record<StatusTone, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10',
  attention: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
  neutral: 'text-ink-muted bg-canvas-overlay',
}
const DOT_TONE: Record<StatusTone, string> = {
  ok: 'bg-emerald-500',
  attention: 'bg-amber-500',
  neutral: 'bg-ink-muted/50',
}

export function DraftStatusPill({ status, className }: { status: DraftStatus; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap',
        PILL_TONE[status.tone],
        className,
      )}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full', DOT_TONE[status.tone])} />
      {status.label}
    </span>
  )
}

// Deterministic premium gradient per owner — stable across renders, varied across people.
const AVATAR_TONES = [
  'bg-gradient-to-br from-indigo-500 to-violet-600',
  'bg-gradient-to-br from-emerald-500 to-teal-600',
  'bg-gradient-to-br from-amber-500 to-orange-600',
  'bg-gradient-to-br from-rose-500 to-pink-600',
  'bg-gradient-to-br from-sky-500 to-blue-600',
  'bg-gradient-to-br from-fuchsia-500 to-purple-600',
]
function avatarTone(owner?: string | null): string {
  if (!owner) return AVATAR_TONES[0]
  let h = 0
  for (let i = 0; i < owner.length; i++) h = (h * 31 + owner.charCodeAt(i)) >>> 0
  return AVATAR_TONES[h % AVATAR_TONES.length]
}

const AVATAR_SIZE = {
  xs: 'w-5 h-5 text-[9px]',
  sm: 'w-6 h-6 text-[10px]',
  md: 'w-8 h-8 text-[12px]',
} as const

export function OwnerAvatar({
  owner,
  userNames,
  size = 'sm',
  className,
}: {
  owner?: string | null
  userNames?: Record<string, string>
  size?: keyof typeof AVATAR_SIZE
  className?: string
}) {
  return (
    <span
      title={ownerName(owner, userNames)}
      className={cn(
        'inline-flex items-center justify-center rounded-full font-semibold text-white shrink-0 shadow-sm ring-1 ring-white/15',
        AVATAR_SIZE[size],
        avatarTone(owner),
        className,
      )}
    >
      {ownerInitials(owner, userNames)}
    </span>
  )
}
