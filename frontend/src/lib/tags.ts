/**
 * Free-form tags: the same tag in other letters is the same tag, and the ones in use are
 * offered most used first.
 */

/** A tag as compared: "Finance" and "finance" are one tag. */
export const foldTag = (t: string) => t.trim().toLocaleLowerCase()

/** Every tag across these lists with how often it is used, most used first (ties
 *  alphabetically), each once in the spelling it first had. */
export function countTags(lists: ReadonlyArray<readonly string[] | null | undefined>): { tag: string; count: number }[] {
    const seen = new Map<string, { tag: string; count: number }>()
    for (const list of lists) {
        for (const raw of list ?? []) {
            const tag = raw.trim()
            if (!tag) continue
            const hit = seen.get(foldTag(tag))
            if (hit) hit.count += 1
            else seen.set(foldTag(tag), { tag, count: 1 })
        }
    }
    return [...seen.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/** The tags in use, most used first — what a tag box suggests. */
export const rankTags = (lists: ReadonlyArray<readonly string[] | null | undefined>): string[] =>
    countTags(lists).map(x => x.tag)
