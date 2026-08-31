/**
 * ViewScopeBadge — the three layers a view rests on, as pills.
 *
 * A coloured workspace pill, an emerald data source pill, and a sky provider
 * pill. Used across Explorer cards, list rows, hero, recent strip and the
 * preview drawer — which is why it is worth being exact here: one edit reaches
 * every catalogue surface in the app.
 *
 * EACH PILL SAYS WHAT IT IS, not just what it is called. Three pills sat in a
 * row wearing three colours and named three proper nouns — "Major Refactor
 * Agg", "Perf-Load-Test-Solidatus", "Falkor Docker" — with nothing on screen
 * saying which was a workspace, which a data source and which the database
 * serving it. A reader who did not already know the platform could not tell
 * them apart, and the only help was a native `title` that repeated the name
 * they had just read. They now carry the app's own HoverTip, naming the layer
 * and what it means for this view, in the same voice the canvas uses for the
 * same three facts.
 *
 * THE TINTS ARE REAL AGAIN. The source and provider pills were authored
 * `bg-emerald-500/8` and `bg-sky-500/8`, and `8` is not on Tailwind's opacity
 * scale — an off-scale modifier compiles to no rule at all, so for however long
 * that has shipped both pills have had NO fill on all five surfaces, reading as
 * bare text in a hairline outline while the workspace pill beside them was
 * properly tinted. The bracket form is exact and always compiles.
 */
import { Database, Layers, Server } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { workspaceColor } from '@/lib/workspaceColor'

interface ViewScopeBadgeProps {
  workspaceId: string
  workspaceName?: string | null
  dataSourceId?: string | null
  dataSourceName?: string | null
  /** Provider the data source is built from (resolved via catalog → provider). */
  providerName?: string | null
  providerType?: string | null
  /** The semantic layer the source is read through, from the same resolver. */
  ontologyName?: string | null
  ontologyVersion?: number | null
  /**
   * Name the provider inside the DATA SOURCE's tip instead of giving it a pill
   * of its own.
   *
   * A catalogue card had six chips in a 250px row and wrapped onto three lines,
   * which is what made a card of five facts read as overwhelming. Rendering the
   * provider and the semantic layer as bare glyphs was worse: two anonymous
   * squares read as broken pills, and the row still wrapped. The provider is
   * infrastructure — nobody browsing sixty-five views picks one by its graph
   * database — and it is a PROPERTY OF THE SOURCE, so folding it into that
   * pill's tip loses nothing and buys back a whole chip for the semantic layer,
   * which is a fact about meaning rather than plumbing.
   *
   * The drawer leaves this off: it has the width, and the chain below spells
   * all four layers out in full anyway.
   */
  foldProviderIntoSource?: boolean
  /** 'sm' for cards/rows, 'md' for hero/drawer */
  size?: 'sm' | 'md'
  /** Hide the workspace pill — for contexts already scoped to one workspace
   *  (e.g. the workspace-detail Views tab) where it's redundant on every row. */
  hideWorkspace?: boolean
}

export function ViewScopeBadge({
  workspaceId,
  workspaceName,
  dataSourceId,
  dataSourceName,
  providerName,
  providerType,
  ontologyName,
  ontologyVersion,
  size = 'sm',
  hideWorkspace,
  foldProviderIntoSource,
}: ViewScopeBadgeProps) {
  const wsColor = workspaceColor(workspaceId)
  const textSize = size === 'sm' ? 'text-[10px]' : 'text-xs'
  // Cap each pill so a long name truncates on ONE line (…) with a title
  // tooltip, instead of wrapping to multiple lines or overflowing a narrow
  // table column. min-w-0 lets the pill shrink further inside a constrained
  // flex track (e.g. the list-row scope cell).
  const pillMax = size === 'sm' ? 'max-w-[130px]' : 'max-w-[200px]'

  return (
    <>
      {/* Workspace pill */}
      {!hideWorkspace && (
        <HoverTip
          label={workspaceName ? `Workspace · ${workspaceName}` : 'Workspace'}
          detail={
            workspaceName
              ? `This view belongs to ${workspaceName}. Who can find and open it is decided here.`
              : 'The workspace this view belongs to. You are not a member, so its name is not shown.'
          }
        >
          <span
            className={cn(
              'inline-flex items-center rounded-full border px-2 py-0.5 font-semibold leading-none min-w-0',
              pillMax,
              textSize,
              wsColor.bg,
              wsColor.text,
              wsColor.border,
            )}
          >
            {/* Non-members have no name for this workspace — a neutral label
                beats leaking a raw UUID into the UI. */}
            <span className="truncate">{workspaceName ?? 'Workspace'}</span>
          </span>
        </HoverTip>
      )}

      {/* Data source pill */}
      {dataSourceId && (
        <HoverTip
          label={dataSourceName ? `Data source · ${dataSourceName}` : 'Data source'}
          detail={
            (dataSourceName
              ? `Everything in this view is drawn from ${dataSourceName}.`
              : 'Where this view draws its data from.')
            + (foldProviderIntoSource && providerName
              ? ` Served by ${providerName}${providerType ? ` (${providerType})` : ''}.`
              : '')
          }
        >
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/[0.08] px-2 py-0.5 font-medium leading-none text-emerald-600 dark:text-emerald-400 min-w-0',
              pillMax,
              textSize,
            )}
          >
            <Database className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{dataSourceName ?? 'Data source'}</span>
          </span>
        </HoverTip>
      )}

      {/* Provider pill */}
      {providerName && !foldProviderIntoSource && (
        <HoverTip
          label={`Graph provider · ${providerName}`}
          detail={
            providerType
              ? `The graph database serving this view — ${providerType}. It answers every question the canvas asks.`
              : 'The graph database serving this view. It answers every question the canvas asks.'
          }
        >
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full border border-sky-500/20 bg-sky-500/[0.08] px-2 py-0.5 font-medium leading-none text-sky-600 dark:text-sky-400 min-w-0',
              pillMax,
              textSize,
            )}
          >
            <Server className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{providerName}</span>
          </span>
        </HoverTip>
      )}

      {/* Semantic layer pill — the ontology the source is read through.
          The catalogue could never name this before: a view's own
          `contextModelName` is a different, usually-empty field, while the id
          that resolves to the ontology lives on the DATA SOURCE. It is the
          same fact the view's own details panel prints as "Semantic layer". */}
      {ontologyName && (
        <HoverTip
          label={`Semantic layer · ${ontologyName}`}
          detail={
            `The vocabulary this view reads its data through — the entity types and `
            + `relationships it can show`
            + (ontologyVersion != null ? `. Version ${ontologyVersion}.` : '.')
          }
        >
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full border border-indigo-500/20 bg-indigo-500/[0.08] px-2 py-0.5 font-medium leading-none text-indigo-600 dark:text-indigo-400 min-w-0',
              pillMax,
              textSize,
            )}
          >
            <Layers className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{ontologyName}</span>
          </span>
        </HoverTip>
      )}
    </>
  )
}
