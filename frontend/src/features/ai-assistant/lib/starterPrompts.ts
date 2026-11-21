import type { AssistantPageKind, AssistantPersona, ContextBrief } from '../api/types'

/** Where the person is, as far as the first questions to offer go. */
export interface StarterSituation {
    onView: boolean
    selectedCount: number
    focused: boolean
    /** The page, when it says what it is (a view, or a page that registered itself). */
    page?: { kind: AssistantPageKind; title?: string } | null
}

const ANYWHERE = [
    'Do we have views about supply-chain failures?',
    'Which tables hold PII, and were any updated last week?',
    'Who owns our customer data?',
]
const KINDS = 'What kinds of things are in here?'
const PII = /pii|personal|gdpr|sensitive/i
const OWNER = /owner|steward|team/i

/** A type name as it reads mid-sentence: "Dashboards" → "dashboards"; "APIs" stays. */
function midSentence(name: string): string {
    return name.split(' ').map((w) => (/^[A-Z][a-z]/.test(w) ? w.toLowerCase() : w)).join(' ')
}

/** Questions about the view the brief describes: what it knows, how data moves, who or what is in it. */
function viewPrompts(b: ContextBrief): string[] {
    const types = new Map((b.types ?? []).map((t) => [t.id, t]))
    const name = (id: string) => midSentence(types.get(id)?.name ?? id)
    const plural = (id: string) => {
        const t = types.get(id)
        return midSentence(t?.plural || `${t?.name ?? id}s`)
    }
    const out = ['What do you know about this view?']

    const layers = b.layers ?? []
    const lineage = (b.connections ?? []).filter((c) => c.class === 'lineage')
    const feeding = new Set(lineage.flatMap((c) => c.from))
    const ends = lineage.flatMap((c) => c.to).filter((t) => !feeding.has(t))
    const chain = b.hierarchy?.chains.find((c) => c.length > 1)
    if (layers.length >= 2) out.push(`How does data flow from ${layers[0].name} to ${layers[layers.length - 1].name}?`)
    else if (ends.length) out.push(`What feeds the ${plural(ends[0])}?`)
    else if (chain) out.push(`What’s inside the biggest ${name(chain[0])}?`)

    const top = b.types?.[0]
    const properties = b.contents?.properties ?? []
    const kinds = b.typeProperty?.status === 'suggested'
    if ((b.contents?.tags ?? []).some((t) => PII.test(t.tag)) || properties.some((p) => PII.test(p.key))) {
        out.push(top ? `Which ${plural(top.id)} hold PII?` : 'What here holds PII?')
    } else if (top && properties.some((p) => OWNER.test(p.key))) {
        out.push(`Who owns the ${plural(top.id)}?`)
    } else if (kinds) {
        out.push(KINDS)
    }
    // A generic schema's most useful question, whenever there is room for it.
    if (kinds && out.length < 3 && !out.includes(KINDS)) out.push(KINDS)
    return out
}

/** Questions to start from, for where the person is, who they are asking, and what is known here. */
export function starterPrompts(persona: AssistantPersona, at: StarterSituation, brief?: ContextBrief | null): string[] {
    const kind = at.page?.kind
    if (persona === 'help') {
        const help = ['How do I share a view?', 'What is a data source?', 'How do I see where data comes from?']
        return kind === 'doc' ? ['Summarise this page', ...help.slice(0, 2)] : help
    }
    if (at.onView && at.selectedCount > 1) {
        return ['What breaks if this changes?', 'Where does this come from?', 'Which of these hold PII?']
    }
    if (at.onView && (at.selectedCount === 1 || at.focused)) {
        return ['What breaks if this changes?', 'Where does this come from?', 'Does this hold PII?']
    }
    if (at.onView) {
        return brief ? viewPrompts(brief) : ['What does this view show?', 'Which tables here hold PII?', 'Do we have views about supply-chain failures?']
    }
    const name = brief?.about.name || at.page?.title
    switch (kind) {
        case 'workspace':
            if (name) return [`What’s in ${name}?`, 'Which data sources does it use?', 'Which views should I start from?']
            break
        case 'data_source':
            if (name) return [`How is ${name} organised?`, 'What kinds of things are in it?', 'Which views read it?']
            break
        case 'ontology':
            if (name) return [`Explain the ${name} semantic layer`, 'How do its types fit together?', 'Which data sources use it?']
            break
        case 'explorer':
            return [name ? `What’s in ${name}?` : 'Which views should I start from?', ...ANYWHERE.slice(0, 2)]
        case 'doc':
            return ['Summarise this page', ...ANYWHERE.slice(0, 2)]
    }
    return ANYWHERE
}
