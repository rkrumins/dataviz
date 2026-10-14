/**
 * Who made a view what it is: its creator, its last editor and whoever published
 * its latest data — each person once, in that order, as a row of avatars.
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
    // Side by side, not overlapping: a facepile parts its faces with a ring the
    // colour of the card, and a card tinted by hover or selection showed those
    // rings as white halos.
    <div className={cn('flex items-center gap-0.5', className)}>
      {people.map(p => {
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
                // A ring, not a lift: the face stays in line with its neighbours.
                // Flex, so the avatar isn't set on a line of text: an inline one
                // sat initials a few pixels lower than a picture.
                className="relative flex rounded-full outline-none hover:z-10 hover:ring-2 hover:ring-accent-lineage/50 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-accent-lineage"
              >
                {avatar}
              </button>
            ) : (
              <span
                tabIndex={0}
                aria-label={label}
                className="relative flex rounded-full outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-accent-lineage"
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
