/**
 * A person's name, for a record that holds only their id.
 *
 * Mounted only where there is an id to name, so the lookup (batched across
 * the page) never runs for a row that has nobody to show. While the name is
 * on its way, and when the id names nobody, the id itself is shown: a record
 * that says `usr_7f3a` is still true, a guessed name would not be.
 */
import { cn } from '@/lib/utils'
import { usePerson } from '@/hooks/usePerson'

export function PersonName({ id, className }: { id: string; className?: string }) {
    const person = usePerson(id)
    if (!person) {
        return <span className={cn('font-mono text-[0.95em]', className)} title={id}>{id}</span>
    }
    return (
        <span className={className} title={person.email ?? id}>
            {person.displayName}
            {person.deleted && <span className="text-ink-muted"> (deleted)</span>}
        </span>
    )
}
