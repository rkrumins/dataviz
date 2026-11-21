/**
 * MessageBody — what someone wrote, as plain text: the people it mentions drawn as chips (their
 * card on hover, their profile on click) and http(s) addresses as links that open apart from the
 * app. Nothing else is interpreted — no HTML, no other scheme — so a message can never run code.
 */
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { PersonHoverCard } from '@/components/explorer/PersonHoverCard'
import { splitLinks, splitMentions } from '@/features/reviews/comments/mentions'
import type { PeopleMap } from '@/services/discussionsService'
import { nameOf } from './discussionText'

/** A person a message mentions: their card on hover, their profile on click. */
export function MentionChip({ id, text, people }: { id: string; text: string; people: PeopleMap | undefined }) {
    const p = people?.[id]
    return (
        <PersonHoverCard userId={id} displayName={nameOf(id, people)} email={p?.email} avatarId={p?.avatarId} roles={['Mentioned']}>
            <Link to={`/people/${encodeURIComponent(id)}`}
                className="px-1 -mx-0.5 rounded-md font-semibold text-accent-lineage bg-accent-lineage/10 hover:bg-accent-lineage/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                {text}
            </Link>
        </PersonHoverCard>
    )
}

export function MessageBody({ body, mentions, people, className }: {
    body: string
    mentions: readonly string[]
    people: PeopleMap | undefined
    className?: string
}) {
    // Matched by the name as it was written, which a since-deleted account still has.
    const names = Object.fromEntries(mentions.map((id) => [id, people?.[id]?.displayName || people?.[id]?.email || id]))
    return (
        <p className={cn('whitespace-pre-wrap break-words text-ink', className)}>
            {splitMentions(body, mentions, names).map((part, i) => part.mention
                ? <MentionChip key={i} id={part.mention} text={part.text} people={people} />
                : splitLinks(part.text).map((bit, j) => bit.href ? (
                    <a key={`${i}.${j}`} href={bit.href} target="_blank" rel="noopener noreferrer nofollow"
                        className="font-medium text-accent-lineage underline decoration-accent-lineage/30 underline-offset-2 hover:decoration-accent-lineage break-all">
                        {bit.text}
                    </a>
                ) : <span key={`${i}.${j}`}>{bit.text}</span>))}
        </p>
    )
}
