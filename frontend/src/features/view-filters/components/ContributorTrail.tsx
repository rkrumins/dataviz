/**
 * Who made a view what it is: its creator, its last editor and whoever published
 * its latest data — each person once, in that order, as overlapping avatars.
 *
 * The card used to show the creator's initials alone, which answers "whose is
 * this?" but not "who touched it last?", and that is usually the person to ask.
 * Hovering an avatar says what they did and when; clicking adds them to the People
 * filter, so "what else has this person been changing" is one click from any card.
 */
import { cn } from '@/lib/utils'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { PersonHoverCard } from '@/components/explorer/PersonHoverCard'
import type { View } from '@/services/viewApiService'
import { contributorsOf } from '../contributors'

export function ContributorTrail({ view, onPick, className, avatarClassName = 'h-5 w-5 text-[8px]' }: {
  view: View
  /** Add this person to the People filter. Without it the avatars only inform. */
  onPick?: (userId: string) => void
  className?: string
  avatarClassName?: string
}) {
  const people = contributorsOf(view)
  if (people.length === 0) return null
  return (
    <div className={cn('flex items-center -space-x-1.5', className)}>
      {people.map((p, i) => {
        const label = `${p.name}: ${p.roles.join(', ')}`
        const avatar = (
          <UserAvatar
            userId={p.userId}
            name={p.name}
            avatarId={p.avatarId}
            shape="palette"
            className={cn(avatarClassName, 'font-bold')}
          />
        )
        return (
          <PersonHoverCard
            key={p.userId}
            userId={p.userId}
            displayName={p.name}
            email={p.email}
            avatarId={p.avatarId}
            roles={p.roles}
          >
            {onPick ? (
              <button
                type="button"
                aria-label={`${label}. Show their views`}
                // The card opens its preview on click and Enter; this one
                // filters instead, so neither may reach it.
                onClick={e => { e.stopPropagation(); onPick(p.userId) }}
                onKeyDown={e => e.stopPropagation()}
                style={{ zIndex: people.length - i }}
                className="relative rounded-full ring-2 ring-canvas-elevated outline-none transition-transform duration-150 hover:-translate-y-0.5 focus-visible:ring-accent-lineage"
              >
                {avatar}
              </button>
            ) : (
              <span
                tabIndex={0}
                aria-label={label}
                style={{ zIndex: people.length - i }}
                className="relative rounded-full ring-2 ring-canvas-elevated outline-none focus-visible:ring-accent-lineage"
              >
                {avatar}
              </span>
            )}
          </PersonHoverCard>
        )
      })}
    </div>
  )
}
