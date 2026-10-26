/**
 * Recipes — ready-made questions, grouped by what someone sets out to do:
 * see what a change would affect, trace something to where it comes from,
 * find sensitive data, close documentation and ownership gaps, clear out
 * what nothing uses, or get the lay of a view.
 *
 * Each is put in the view's own words — its types, tags, keys and layers —
 * and one that names something the view doesn't have isn't offered there.
 * One with a name or value still to fill in opens for it rather than
 * running.
 */
import type { Predicate } from '@/types/search'

import { filterKindById } from '../vocabulary/filterKinds'


export type RecipeIntent =
    | 'impact' | 'rootCause' | 'governance' | 'documentation' | 'ownership' | 'cleanup' | 'discovery'

export const RECIPE_INTENTS: ReadonlyArray<{ id: RecipeIntent; title: string; question: string }> = [
    { id: 'impact', title: 'Impact', question: 'What would a change affect?' },
    { id: 'rootCause', title: 'Root cause', question: 'Where does it come from?' },
    { id: 'governance', title: 'Governance & PII', question: 'Where is the sensitive data?' },
    { id: 'documentation', title: 'Documentation gaps', question: 'What is undocumented?' },
    { id: 'ownership', title: 'Ownership', question: 'Who looks after what?' },
    { id: 'cleanup', title: 'Cleanup', question: 'What could go?' },
    { id: 'discovery', title: 'Discovery', question: 'What does this view hold?' },
]

/** What a view holds, as the recipes read it. */
export interface RecipeView {
    /** Its types, most common first. */
    types: readonly string[]
    tags: readonly string[]
    keys: readonly string[]
    layers: ReadonlyArray<{ value: string; label: string }>
}

/** A type's name in the view's words, plural when asked. */
export type TypeName = (type: string, plural?: boolean) => string

export interface Recipe {
    id: string
    intent: RecipeIntent
    /** A lucide icon name. */
    icon: string
    title: string
    description: string
    predicate: Predicate
    /** It names something still to fill in: it opens for that, not to run. */
    blank: boolean
}


/** The parts of a view the recipes are put in terms of. */
interface Roles {
    /** What holds the data: datasets, tables. */
    data?: string
    /** What reads it to show people: dashboards, reports. */
    consumer?: string
    /** What a dataset is made of: columns, fields. */
    field?: string
    sensitive: string[]
    deprecated?: string
    ownerKey?: string
    described: boolean
    view: RecipeView
}

interface RecipeDef {
    id: string
    intent: RecipeIntent
    icon: string
    blank?: boolean
    make: (r: Roles, name: TypeName) => Pick<Recipe, 'title' | 'description' | 'predicate'> | null
}

const SENSITIVE = /^(pii|phi|pci|gdpr|hipaa|sensitive|confidential|restricted)$/i

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const lower = (s: string) => s.toLowerCase()
const list = (words: readonly string[]) => (words.length < 3
    ? words.join(' or ') : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`)

const and = (...children: Predicate[]): Predicate => ({ kind: 'group', op: 'and', children })
const typeIs = (type: string): Predicate => ({ kind: 'entityType', op: 'in', values: [type] })
const tagged = (tags: string[]): Predicate => ({ kind: 'tag', op: 'hasAny', values: tags })
const lacks = (key: string): Predicate => ({ kind: 'hasProperty', key, negate: true })
const named = (): Predicate => ({ kind: 'is', refs: [] })
const related = (axis: 'upstream' | 'downstream' | 'child' | 'ancestor', where?: Predicate,
    maxHops?: number): Predicate => ({ kind: 'related', axis, ...(maxHops ? { maxHops } : {}), ...(where ? { where } : {}) })
const LINEAGE = { edgeClass: 'lineage' } as const


const RECIPES: readonly RecipeDef[] = [
    {
        id: 'feeds-from-one', intent: 'impact', icon: 'Workflow', blank: true,
        make: () => ({
            title: 'Everything one entity feeds',
            description: 'Pick an entity to see what reads from it, up to 3 hops downstream.',
            predicate: related('upstream', named(), 3),
        }),
    },
    {
        id: 'widely-read', intent: 'impact', icon: 'Share2',
        make: (r, name) => (r.data ? {
            title: `${cap(name(r.data, true))} that feed 3 or more others`,
            description: 'The most depended on, and so the riskiest to change.',
            predicate: and(typeIs(r.data), { kind: 'related', axis: 'downstream', count: { op: 'gte', value: 3 } }),
        } : null),
    },
    {
        id: 'built-on-sensitive', intent: 'impact', icon: 'ShieldAlert',
        make: (r, name) => (r.consumer && r.sensitive.length ? {
            title: `${cap(name(r.consumer, true))} built on ${list(r.sensitive)} data`,
            description: 'Where sensitive data ends up, within 3 hops downstream of it.',
            predicate: and(typeIs(r.consumer), related('upstream', tagged(r.sensitive), 3)),
        } : null),
    },
    {
        id: 'feeding-one', intent: 'rootCause', icon: 'GitMerge', blank: true,
        make: () => ({
            title: 'Everything that feeds one entity',
            description: 'Pick an entity to see what it reads from, up to 3 hops upstream.',
            predicate: related('downstream', named(), 3),
        }),
    },
    {
        id: 'feeds-consumers', intent: 'rootCause', icon: 'Workflow',
        make: (r, name) => (r.data && r.consumer ? {
            title: `${cap(name(r.data, true))} that feed ${lower(name(r.consumer, true))}`,
            description: `Where the ${lower(name(r.consumer, true))} get their data, within 3 hops.`,
            predicate: and(typeIs(r.data), related('downstream', typeIs(r.consumer), 3)),
        } : null),
    },
    {
        id: 'lineage-starts', intent: 'rootCause', icon: 'ArrowUpToLine',
        make: () => ({
            title: 'Where lineage starts',
            description: 'Sources nothing feeds, that feed something: where the data comes in.',
            predicate: and({ kind: 'isRoot', ...LINEAGE }, { kind: 'hasOutgoing', ...LINEAGE }),
        }),
    },
    {
        id: 'route', intent: 'rootCause', icon: 'Route', blank: true,
        make: () => {
            const path = filterKindById('path')?.build?.()
            return path ? {
                title: 'How one entity reaches another',
                description: 'Every lineage route from one to the other.',
                predicate: path,
            } : null
        },
    },
    {
        id: 'sensitive', intent: 'governance', icon: 'ShieldCheck',
        make: (r) => (r.sensitive.length ? {
            title: `Everything tagged ${list(r.sensitive)}`,
            description: 'Every entity carrying a sensitive-data tag.',
            predicate: tagged(r.sensitive),
        } : null),
    },
    {
        id: 'holding-sensitive', intent: 'governance', icon: 'FolderLock',
        make: (r, name) => (r.data && r.sensitive.length ? {
            title: `${cap(name(r.data, true))} holding ${list(r.sensitive)} data`,
            description: 'Something inside them, a column or a field, is tagged sensitive.',
            predicate: and(typeIs(r.data), related('child', tagged(r.sensitive))),
        } : null),
    },
    {
        id: 'unclassified', intent: 'governance', icon: 'ShieldQuestion',
        make: (r, name) => (r.data && r.sensitive.length ? {
            title: `${cap(name(r.data, true))} with no ${list(r.sensitive)} tag`,
            description: 'Not classified yet: worth a look before they are shared.',
            predicate: and(typeIs(r.data), { kind: 'tag', op: 'notHas', values: r.sensitive }),
        } : null),
    },
    {
        id: 'undocumented', intent: 'documentation', icon: 'FileQuestion',
        make: (r, name) => (r.data && r.described ? {
            title: `${cap(name(r.data, true))} without a description`,
            description: 'Nothing says what they hold or how to use them.',
            predicate: and(typeIs(r.data), lacks('description')),
        } : null),
    },
    {
        id: 'undocumented-fields', intent: 'documentation', icon: 'Columns3',
        make: (r, name) => (r.field && r.described ? {
            title: `${cap(name(r.field, true))} without a description`,
            description: 'Fields no one has explained yet.',
            predicate: and(typeIs(r.field), lacks('description')),
        } : null),
    },
    {
        id: 'unowned', intent: 'ownership', icon: 'UserX',
        make: (r, name) => (r.data && r.ownerKey ? {
            title: `${cap(name(r.data, true))} without an owner`,
            description: 'No one to ask about them, or to tell when they change.',
            predicate: and(typeIs(r.data), lacks(r.ownerKey)),
        } : null),
    },
    {
        id: 'owned-by', intent: 'ownership', icon: 'UserCheck', blank: true,
        make: (r) => (r.ownerKey ? {
            title: 'Everything one person owns',
            description: 'Pick an owner to see everything they look after.',
            predicate: { kind: 'property', key: r.ownerKey, op: 'eq', value: '' } as Predicate,
        } : null),
    },
    {
        id: 'sensitive-unowned', intent: 'ownership', icon: 'ShieldOff',
        make: (r) => (r.sensitive.length && r.ownerKey ? {
            title: `${list(r.sensitive)} data without an owner`,
            description: 'Sensitive data no one has taken responsibility for.',
            predicate: and(tagged(r.sensitive), lacks(r.ownerKey)),
        } : null),
    },
    {
        id: 'no-lineage', intent: 'cleanup', icon: 'Unplug',
        make: (r, name) => ({
            title: r.data ? `${cap(name(r.data, true))} with no lineage at all` : 'Entities with no lineage at all',
            description: 'Nothing feeds them and they feed nothing: often left behind.',
            predicate: r.data ? and(typeIs(r.data), { kind: 'isOrphan', ...LINEAGE }) : { kind: 'isOrphan', ...LINEAGE },
        }),
    },
    {
        id: 'dead-ends', intent: 'cleanup', icon: 'ArrowDownToLine',
        make: (r, name) => {
            const shape: Predicate[] = [{ kind: 'hasIncoming', ...LINEAGE }, { kind: 'isLeaf', ...LINEAGE }]
            return {
                title: r.data ? `${cap(name(r.data, true))} nothing reads from` : 'Dead ends nothing reads from',
                description: 'Fed, but feeding nothing: final outputs, or candidates for cleanup.',
                predicate: r.data ? and(typeIs(r.data), ...shape) : and(...shape),
            }
        },
    },
    {
        id: 'deprecated-in-use', intent: 'cleanup', icon: 'TriangleAlert',
        make: (r) => (r.deprecated ? {
            title: `Tagged ${r.deprecated}, but still feeding something`,
            description: 'Retired on paper, still in use: what to move off before removing.',
            predicate: and(tagged([r.deprecated]), { kind: 'hasOutgoing', ...LINEAGE }),
        } : null),
    },
    {
        id: 'all-of-type', intent: 'discovery', icon: 'List',
        make: (r, name) => {
            const type = r.data ?? r.view.types[0]
            return type ? {
                title: `All ${lower(name(type, true))}`,
                description: `Every ${lower(name(type))} in this view, to narrow from there.`,
                predicate: typeIs(type),
            } : null
        },
    },
    {
        id: 'by-name', intent: 'discovery', icon: 'Search', blank: true,
        make: () => {
            const text = filterKindById('text-name')?.build?.()
            return text ? {
                title: 'Find something by name',
                description: 'Everything whose name holds the words you type.',
                predicate: text,
            } : null
        },
    },
    {
        id: 'inside-one', intent: 'discovery', icon: 'FolderTree', blank: true,
        make: () => ({
            title: 'Everything inside one container',
            description: 'Pick a container, a database or a folder, to see what it holds.',
            predicate: related('ancestor', named()),
        }),
    },
    {
        id: 'in-layer', intent: 'discovery', icon: 'Layers',
        make: (r) => {
            const layer = r.view.layers[0]
            return layer ? {
                title: `Everything in the ${layer.label} layer`,
                description: 'One stage of the pipeline, all of it.',
                predicate: { kind: 'layer', layerAssignment: layer.value },
            } : null
        },
    },
    {
        id: 'tagged', intent: 'discovery', icon: 'Tag',
        make: (r) => {
            const tag = r.view.tags.find((t) => !r.sensitive.includes(t) && t !== r.deprecated)
            return tag ? {
                title: `Everything tagged ${tag}`,
                description: `Where the ${tag} tag has been put to use.`,
                predicate: tagged([tag]),
            } : null
        },
    },
]


function rolesOf(view: RecipeView): Roles {
    const pick = (re: RegExp) => view.types.find((t) => re.test(t))
    const data = pick(/dataset|table|view|object/i)
    return {
        data,
        // The commonest kind that reads data, as the Ask bar's examples
        // take it: the two never disagree on what "feeds" what.
        consumer: view.types.find((t) => t !== data && /dashboard|report|chart|model/i.test(t)),
        field: pick(/column|field/i),
        sensitive: view.tags.filter((t) => SENSITIVE.test(t)),
        deprecated: view.tags.find((t) => /deprecat/i.test(t)),
        ownerKey: view.keys.includes('owner') ? 'owner' : view.keys.find((k) => /owner/i.test(k)),
        described: view.keys.includes('description'),
        view,
    }
}


/** The recipes this view can use, in its own words: by intent, in order. */
export function recipesFor(view: RecipeView, name: TypeName): Recipe[] {
    const roles = rolesOf(view)
    const out: Recipe[] = []
    for (const def of RECIPES) {
        const made = def.make(roles, name)
        if (made) out.push({ id: def.id, intent: def.intent, icon: def.icon, blank: !!def.blank, ...made })
    }
    return out
}


/** A few to start from: the first ready-to-run recipe of each intent. */
export function startingRecipes(recipes: readonly Recipe[], max: number): Recipe[] {
    const out: Recipe[] = []
    for (const { id } of RECIPE_INTENTS) {
        const first = recipes.find((r) => r.intent === id && !r.blank)
        if (first) out.push(first)
        if (out.length === max) break
    }
    return out
}
