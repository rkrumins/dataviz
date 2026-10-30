/**
 * ContributorsStack — who saved into a draft (its `contributors`, most active first): a few faces,
 * then how many more; everyone named on hover.
 */
import { HoverTip } from '@/components/ui/HoverTip'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { ownerName } from '../model/branchVocab'

const SHOWN = 4

function listed(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function ContributorsStack({ contributors, userNames }: {
  contributors: string[]
  userNames?: Record<string, string>
}) {
  if (contributors.length === 0) return null
  const names = contributors.map((c) => ownerName(c, userNames))
  const label = `Saved into this draft by ${listed(names)}`
  return (
    <HoverTip className="inline-flex" label={label}>
      <span role="group" aria-label={label} className="inline-flex items-center -space-x-1.5">
        {contributors.slice(0, SHOWN).map((c, i) => (
          <UserAvatar key={c} userId={c} name={names[i]} shape="gradient"
            className="w-5 h-5 text-[8px] font-bold ring-2 ring-canvas-elevated" />
        ))}
        {contributors.length > SHOWN && (
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-canvas-overlay ring-2 ring-canvas-elevated text-[9px] font-semibold text-ink-muted">
            +{contributors.length - SHOWN}
          </span>
        )}
      </span>
    </HoverTip>
  )
}
