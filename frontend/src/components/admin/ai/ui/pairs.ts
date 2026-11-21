/** Name/value rows as edited, and the object they save as. A row with no name is dropped. */
export interface Pair { key: string; value: string }

export const pairsFrom = (o: Record<string, string> | undefined): Pair[] =>
    Object.entries(o ?? {}).map(([key, value]) => ({ key, value: String(value) }))

export const objectFrom = (pairs: Pair[]): Record<string, string> =>
    Object.fromEntries(pairs.filter(p => p.key.trim()).map(p => [p.key.trim(), p.value]))
