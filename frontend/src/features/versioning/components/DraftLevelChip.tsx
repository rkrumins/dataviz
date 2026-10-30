/**
 * DraftLevelChip — a draft's level at a glance, wherever drafts are listed: a globe for a public
 * draft, a lock for a private one, saying who sees it on hover.
 */
import { Globe2, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import type { DraftLevel } from '@/services/versioningApiService'
import { DRAFT_LEVEL_WORDS } from '../model/draftLevels'

export function DraftLevelChip({ level, className }: { level?: DraftLevel | null; className?: string }) {
  if (!level) return null
  const Icon = level === 'public' ? Globe2 : Lock
  return (
    <HoverTip className="inline-flex shrink-0" label={`${DRAFT_LEVEL_WORDS[level].label} draft`} detail={DRAFT_LEVEL_WORDS[level].who}>
      <span
        role="img"
        aria-label={`${DRAFT_LEVEL_WORDS[level].label} draft`}
        className={cn('inline-flex items-center justify-center w-4 h-4 rounded-full',
          level === 'public' ? 'text-sky-500 bg-sky-500/10' : 'text-violet-500 bg-violet-500/10', className)}
      >
        <Icon className="w-2.5 h-2.5" />
      </span>
    </HoverTip>
  )
}
