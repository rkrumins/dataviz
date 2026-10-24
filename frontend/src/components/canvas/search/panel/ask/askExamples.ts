import type { PersonaMode } from '@/store/persona'


/** Questions to try, in this view's own words — plain ones for Business,
 *  a notch more technical for Technical. */
export function askExamples(types: readonly string[], tags: readonly string[],
    typeName: (type: string, plural?: boolean) => string, persona: PersonaMode): string[] {
    // A pair that reads like lineage: data first, what consumes it second.
    const first = types.find((t) => /dataset|table|view|object/i.test(t)) ?? types[0]
    const second = types.find((t) => t !== first && /dashboard|report|chart|model/i.test(t))
        ?? types.find((t) => t !== first)
    const [a, b] = [first, second].map((t) => (t ? typeName(t, true).toLowerCase() : undefined))
    const tag = tags[0]
    const out: string[] = []
    if (persona === 'technical') {
        if (a && b) out.push(`${a} fed by ${b} within 2 hops`)
        if (a) out.push(`${a} with no downstream`)
        if (a && tag) out.push(`${a} tagged ${tag} without an owner`)
    } else {
        if (a && b) out.push(`${a} that feed ${b}`)
        if (a && tag) out.push(`${a} tagged ${tag}`)
        if (a) out.push(`unused ${a}`)
    }
    if (out.length === 0) out.push('dead ends', 'undocumented')
    return out
}
