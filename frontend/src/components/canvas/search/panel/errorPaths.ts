/**
 * errorPaths — where in the query a server message points, in the panel's
 * words. The server names a position by its JSON path
 * (``$.children[1].where``); people read "filter 2 › its condition".
 */

const SEGMENT = /\.([A-Za-z]+)(?:\[(\d+)\])?/g
/** A path standing as a word of its own: ``$``, then any segments. */
const PATH = /(^|[\s(])\$((?:\.[A-Za-z]+(?:\[\d+\])?)*)(?=[\s:,.;)]|$)/g

const WORDS: Record<string, string> = {
    where: 'its condition',
    sourceWhere: 'where it starts',
    targetWhere: 'where it ends',
    edge: 'its edge filter',
    edgePredicate: 'its edge filter',
}


/** One path, read as a position: "filter 2 › its condition". */
export function describeQueryPath(path: string): string {
    const parts: string[] = []
    for (const [, name, index] of path.matchAll(SEGMENT)) {
        const n = index === undefined ? null : Number(index) + 1
        if (name === 'predicate') continue
        if (name === 'children') parts.push(`${parts.length ? 'condition' : 'filter'} ${n}`)
        else if (name === 'items') parts.push(`rule ${n}`)
        else if (name === 'refs') parts.push(`name ${n}`)
        else if (name === 'sourceRefs') parts.push('where it starts', `name ${n}`)
        else if (name === 'targetRefs') parts.push('where it ends', `name ${n}`)
        else parts.push(WORDS[name] ?? (n === null ? name : `${name} ${n}`))
    }
    return parts.length ? parts.join(' › ') : 'the query'
}


/** ``message`` with each query path in it read as a position. */
export function humanizeQueryPaths(message: string): string {
    return message.replace(PATH, (_, lead: string, path: string) => lead + describeQueryPath(path))
}
