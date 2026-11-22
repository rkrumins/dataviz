/** The colours a property's values wear across the comparison: its three most held, then the rest. */
export const GROUP_TONES = ['bg-accent-lineage', 'bg-sky-500', 'bg-amber-500'] as const
export const OTHER_TONE = 'bg-slate-400 dark:bg-slate-500'
export const toneOf = (i: number): string => GROUP_TONES[i] ?? OTHER_TONE
