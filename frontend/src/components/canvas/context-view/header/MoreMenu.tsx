/**
 * MoreMenu — the Business view's one door to the header's less-used tools.
 *
 * The Business view keeps the row to what reading a view needs: Lineage,
 * Display, the Focus Lens, Trace, Properties and the Import / Export menu.
 * What it tucks away is not taken away: picking several entities, the
 * entities with no parent (in a draft) and its drafts (on Published) are all
 * here, and the last item puts every tool back on the row (the Technical view)
 * for anyone who wants them all. The view's changes and history are Reviews in
 * the page header, on every canvas.
 *
 * With none of those to offer, the menu is not drawn: "Show every tool" alone
 * is the top bar's switch over again.
 *
 * NON-MODAL and portaled, as every dropdown in the header is: the header has
 * a backdrop blur, which makes a stacking context that would clip an inline
 * menu, and a modal dropdown strands a pointer-events lock on the body when
 * its trigger unmounts mid-open (see LayerSortMenu).
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as LucideIcons from 'lucide-react'

import { HoverTip } from '@/components/ui/HoverTip'
import { usePersonaStore } from '@/store/persona'
import { BRANCH_VOCAB } from '@/features/versioning/model/branchVocab'
import { formatShortcut } from '@/lib/platform'
import { cn } from '@/lib/utils'

const itemClass =
  'flex items-start gap-2.5 px-2.5 py-2 text-xs text-ink rounded-lg cursor-pointer outline-none ' +
  'hover:bg-accent-lineage/10 focus:bg-accent-lineage/10 data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed'

export interface MoreMenuProps {
  /** Pick several entities (the header's Select). Absent, not offered. */
  onToggleMultiSelect?: () => void
  multiSelectArmed?: boolean
  /** Open the panel of entities with no parent. Absent, not offered. */
  onOpenOrphans?: () => void
  /** Open the drafts of this view. Absent, not offered. */
  onOpenDrafts?: () => void
}

export function MoreMenu({
  onToggleMultiSelect,
  multiSelectArmed = false,
  onOpenOrphans,
  onOpenDrafts,
}: MoreMenuProps) {
  const setMode = usePersonaStore((s) => s.setMode)

  if (!onToggleMultiSelect && !onOpenOrphans && !onOpenDrafts) return null

  return (
    <DropdownMenu.Root modal={false}>
      <HoverTip className="inline-flex" label="More tools" detail="Select several, entities with no parent, and your drafts">
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="More tools"
            className={cn(
              'flex items-center justify-center px-2.5 py-2 rounded-xl text-sm font-medium transition duration-300',
              'bg-black/[0.03] border border-black/[0.06] text-ink-muted hover:text-ink hover:bg-black/[0.06]',
              'dark:bg-white/[0.03] dark:border-white/[0.06] dark:hover:bg-white/[0.08]',
              'data-[state=open]:text-ink data-[state=open]:bg-black/[0.06] dark:data-[state=open]:bg-white/[0.08]',
            )}
          >
            <LucideIcons.Ellipsis className="w-4 h-4" strokeWidth={2.2} />
          </button>
        </DropdownMenu.Trigger>
      </HoverTip>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          sideOffset={8}
          align="end"
          className="w-[268px] bg-canvas-elevated/95 backdrop-blur-xl border border-black/[0.10] dark:border-white/[0.08] rounded-xl shadow-2xl shadow-black/20 dark:shadow-black/40 p-1.5 z-50 animate-in fade-in zoom-in-95"
        >
          {onToggleMultiSelect && (
            <DropdownMenu.Item className={itemClass} onSelect={onToggleMultiSelect}>
              <LucideIcons.SquareCheckBig className="w-4 h-4 mt-px text-accent-lineage shrink-0" strokeWidth={2.2} />
              <span className="min-w-0">
                <span className="block font-medium">{multiSelectArmed ? 'Stop selecting several' : 'Select several'}</span>
                <span className="block text-[11px] text-ink-muted leading-snug">
                  {formatShortcut('mod')}-click adds one · Shift-click adds a range
                </span>
              </span>
            </DropdownMenu.Item>
          )}
          {onOpenOrphans && (
            <DropdownMenu.Item className={itemClass} onSelect={onOpenOrphans}>
              <LucideIcons.Unlink className="w-4 h-4 mt-px text-accent-lineage shrink-0" strokeWidth={2.2} />
              <span className="min-w-0">
                <span className="block font-medium">Entities with no parent…</span>
                <span className="block text-[11px] text-ink-muted leading-snug">Find them and place each one in a layer</span>
              </span>
            </DropdownMenu.Item>
          )}
          {onOpenDrafts && (
            <DropdownMenu.Item className={itemClass} onSelect={onOpenDrafts}>
              <LucideIcons.GitBranch className="w-4 h-4 mt-px text-accent-lineage shrink-0" strokeWidth={2.2} />
              <span className="min-w-0">
                <span className="block font-medium">{BRANCH_VOCAB.yourDrafts}…</span>
                <span className="block text-[11px] text-ink-muted leading-snug">The drafts of this view, and where each one stands</span>
              </span>
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Separator className="h-px bg-glass-border my-1.5 mx-1" />
          <DropdownMenu.Item className={itemClass} onSelect={() => setMode('technical')}>
            <LucideIcons.Code2 className="w-4 h-4 mt-px text-accent-technical shrink-0" strokeWidth={2.2} />
            <span className="min-w-0">
              <span className="block font-medium">Show every tool</span>
              <span className="block text-[11px] text-ink-muted leading-snug">
                Switch to the Technical view · {formatShortcut('mod+/')}
              </span>
            </span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
