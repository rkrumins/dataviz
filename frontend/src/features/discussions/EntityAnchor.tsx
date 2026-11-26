/**
 * The entity a question is about, named so a reader can tell which it is: its name, after the
 * containers it sits in (muted, shortened when deep), and its ID. Hovering it shows all of it —
 * the type, the name, the whole path and the whole ID.
 *
 * `compact` (a thread's row, the list's filter chip) names the nearest container only. `full`
 * (a thread's header, the ask box) shows more of the path and the ID beneath it. A question asked
 * before its name was kept shows the name of the canvas node with its ID when one is loaded, and
 * otherwise its ID, once, as an ID.
 */
import { useMemo } from 'react'
import { MapPin } from 'lucide-react'
import { HoverTip } from '@/components/ui/HoverTip'
import { CopyableId, EntityTypeTag } from '@/components/panels/shell/EntityRef'
import { nodeIndexOf } from '@/lib/storeIndex'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/store/canvas'
import { anchorOf, anchorWords, ownName, PATH_SEP as SEP, type AnchorEntity } from './anchorOf'

/** Its own name, path and type — or, for a question that kept no name, the loaded node's. */
function useNamed(entity: AnchorEntity): { name: string | null; path: readonly string[]; type: string | null } {
    const own = ownName(entity)
    const loaded = useCanvasStore((s) => (own ? undefined : nodeIndexOf(s.nodes).get(entity.id)))
    return useMemo(() => {
        if (own || !loaded) return { name: own, path: entity.path ?? [], type: entity.type ?? null }
        const found = anchorOf(entity.id)
        return { name: found.label !== entity.id ? found.label : null, path: found.path ?? [], type: found.type ?? null }
    }, [own, loaded, entity.id, entity.path, entity.type])
}

/** The path as a reader takes it in at a glance: the nearest container, or the start and the end. */
function shortened(path: readonly string[], variant: 'compact' | 'full'): string {
    if (variant === 'compact') return path.length > 1 ? `…${SEP}${path[path.length - 1]}` : path.join(SEP)
    return (path.length > 3 ? [path[0], '…', ...path.slice(-2)] : path).join(SEP)
}

function Details({ id, name, path, type }: { id: string; name: string | null; path: readonly string[]; type: string | null }) {
    return (
        <span className="block space-y-1.5" data-testid="entity-anchor-details">
            {(type || name) && (
                <span className="flex items-center gap-1.5 min-w-0">
                    {type && <EntityTypeTag typeId={type} />}
                    {name && <span className="font-semibold text-ink break-words">{name}</span>}
                </span>
            )}
            {path.length > 0 && (
                <span className="block text-[11px] leading-snug text-ink-secondary">
                    <span className="text-ink-muted">In </span>{path.join(SEP)}
                </span>
            )}
            <span className="block text-[11px] leading-snug">
                <span className="text-ink-muted">ID </span>
                <code className="font-mono text-ink-secondary break-all">{id}</code>
            </span>
        </span>
    )
}

export function EntityAnchor({ entity, variant = 'compact', prefix, copy = false, className }: {
    entity: AnchorEntity
    variant?: 'compact' | 'full'
    /** A word before it ("About"). */
    prefix?: string
    /** `full`: a button to copy the ID. */
    copy?: boolean
    className?: string
}) {
    const { name, path, type } = useNamed(entity)
    const crumb = path.length ? shortened(path, variant) : ''
    const line = (
        <HoverTip width="data" label={<Details id={entity.id} name={name} path={path} type={type} />}
            className="flex min-w-0 max-w-full">
            <span className="inline-flex items-center gap-1 min-w-0 max-w-full" data-testid="entity-anchor">
                <span className="sr-only">{`${prefix ? `${prefix} ` : ''}${anchorWords(name, path, entity.id)}`}</span>
                <MapPin className={cn('shrink-0', variant === 'full' ? 'w-3.5 h-3.5' : 'w-3 h-3')} aria-hidden />
                {prefix && <span aria-hidden className="shrink-0 opacity-80">{prefix}</span>}
                {crumb && (
                    <span aria-hidden className="min-w-0 truncate shrink-[100] font-normal opacity-75" data-testid="entity-anchor-path">
                        {crumb}{SEP}
                    </span>
                )}
                {name
                    ? <span aria-hidden className="min-w-0 truncate font-semibold">{name}</span>
                    : <code aria-hidden className="min-w-0 truncate font-mono font-medium">{entity.id}</code>}
            </span>
        </HoverTip>
    )
    if (variant === 'compact' || !name) return <span className={cn('flex min-w-0 max-w-full', className)}>{line}</span>
    return (
        <span className={cn('flex flex-col min-w-0 max-w-full', className)}>
            {line}
            {copy
                ? <CopyableId id={entity.id} className="pl-5 -my-1" />
                : <code aria-hidden className="pl-[18px] min-w-0 truncate text-[10.5px] font-mono font-normal opacity-75" data-testid="entity-anchor-id">{entity.id}</code>}
        </span>
    )
}
