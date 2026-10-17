/**
 * Name one person by id — batched, so a page of rows asking at once costs one
 * request, not one each.
 *
 * Records hold ids (who triggered a run, who added a member) and the screens
 * that show them are lists. Each row asks for its own person; the asks made
 * in the same tick are gathered into one `directory/people` call, and every
 * answer is cached per person, so the next page asks only for the people it
 * has not seen yet.
 *
 * `undefined` while unknown, `null` when the id names nobody: show the id
 * then, never an invented name.
 */
import { useQuery } from '@tanstack/react-query'

import { peopleById, type DirectoryPerson } from '@/services/userDirectoryService'

type Waiter = { resolve: (person: DirectoryPerson | null) => void; reject: (err: unknown) => void }

let pending = new Map<string, Waiter[]>()
let scheduled = false

function flush() {
    const batch = pending
    pending = new Map()
    scheduled = false
    peopleById([...batch.keys()]).then(
        (people) => {
            const byId = new Map(people.map((p) => [p.id, p]))
            batch.forEach((waiters, id) => waiters.forEach((w) => w.resolve(byId.get(id) ?? null)))
        },
        (err) => batch.forEach((waiters) => waiters.forEach((w) => w.reject(err))),
    )
}

function loadPerson(id: string): Promise<DirectoryPerson | null> {
    return new Promise((resolve, reject) => {
        const waiters = pending.get(id)
        if (waiters) waiters.push({ resolve, reject })
        else pending.set(id, [{ resolve, reject }])
        if (!scheduled) {
            scheduled = true
            queueMicrotask(flush)
        }
    })
}

/** The lookup itself, failure included: a page that cannot reach the
 *  directory still shows ids — and must not shimmer for ever waiting. */
export function usePersonLookup(id: string | null | undefined) {
    return useQuery({
        queryKey: ['directory', 'person', id ?? ''],
        queryFn: () => loadPerson(id!),
        enabled: !!id,
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
        retry: false,
    })
}

export function usePerson(id: string | null | undefined): DirectoryPerson | null | undefined {
    return usePersonLookup(id).data
}
