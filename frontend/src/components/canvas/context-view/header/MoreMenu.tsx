/**
 * MoreMenu — the Business view's one door to the header's less-used tools.
 *
 * The Business view keeps the row to what reading a view needs: Lineage,
 * Display, the Focus Lens and Trace. What it tucks away is not taken away:
 * picking several entities, the Property Manager, the entities with no parent
 * (in a draft), the view's changes and history, its drafts (on Published) and
 * its files — import, export, updating it from a file, its layers as a
 * template — are all here, and the last item puts every tool back on the row
 * (the Technical view) for anyone who wants them all.
 *
 * NON-MODAL and portaled, as every dropdown in the header is: the header has
 * a backdrop blur, which makes a stacking context that would clip an inline
 * menu, and a modal dropdown strands a pointer-events lock on the body when
 * its trigger unmounts mid-open (see LayerSortMenu).
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as LucideIcons from 'lucide-react'

import { HoverTip } from '@/components/ui/HoverTip'
import { useFeature } from '@/store/features'
import { usePersonaStore } from '@/store/persona'
import { useViewPortability } from '@/features/view-transfer/useViewPortability'
import { BRANCH_VOCAB } from '@/features/versioning/model/branchVocab'
import { formatShortcut } from '@/lib/platform'
import { cn } from '@/lib/utils'

import type { ViewFileActions } from './ImportExportMenu'

const itemClass =
  'flex items-start gap-2.5 px-2.5 py-2 text-xs text-ink rounded-lg cursor-pointer outline-none ' +
  'hover:bg-accent-lineage/10 focus:bg-accent-lineage/10 data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed'

export interface MoreMenuProps {
  /** Pick several entities (the header's Select). Absent, not offered. */
  onToggleMultiSelect?: () => void
  multiSelectArmed?: boolean
  /** Open or close the Property Manager. Absent, not offered. */
  onTogglePropertyManager?: () => void
  propertyManagerOpen?: boolean
  /** Open the panel of entities with no parent. Absent, not offered. */
  onOpenOrphans?: () => void
  /** Open the view's changes and history. Absent, not offered. */
  onOpenHistory?: () => void
  /** Open the drafts of this view. Absent, not offered. */
  onOpenDrafts?: () => void
  /** Bring entities in from a file. Absent, not offered. */
  onImport?: () => void
  /** A draft is open. Import writes to it, so it needs one. */
  isDraft?: boolean
  /** Export the view's graph data. Absent, not offered. */
  onExport?: () => void
  /** The view's own file actions; all but its export with data are offered here. */
  thisView?: ViewFileActions
}

export function MoreMenu({
  onToggleMultiSelect,
  multiSelectArmed = false,
  onTogglePropertyManager,
  propertyManagerOpen = false,
  onOpenOrphans,
  onOpenHistory,
  onOpenDrafts,
  onImport,
  isDraft = false,
  onExport,
  thisView,
}: MoreMenuProps) {
  const setMode = usePersonaStore((s) => s.setMode)
  // Import writes to a draft: with versioning off there is none to write to.
  const versioningEnabled = useFeature('versioningEnabled')
  const graphExportEnabled = useFeature('graphExportEnabled')
  const { canExport: viewExportEnabled, canImport: viewImportEnabled } = useViewPortability()
  const importData = versioningEnabled ? onImport : undefined
  const exportView = viewExportEnabled ? thisView?.onExport : undefined
  const exportData = graphExportEnabled ? onExport : undefined
  const updateView = viewImportEnabled ? thisView?.onUpdateFromFile : undefined
  const saveTemplate = thisView?.onSaveAsTemplate
  const hasFiles = !!(importData || exportView || exportData || updateView || saveTemplate)

  return (
    <DropdownMenu.Root modal={false}>
      <HoverTip className="inline-flex" label="More tools" detail="Select several, properties and display rules, history and drafts, import and export">
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
          {onTogglePropertyManager && (
            <DropdownMenu.Item className={itemClass} onSelect={onTogglePropertyManager}>
              <LucideIcons.Tags className="w-4 h-4 mt-px text-accent-lineage shrink-0" strokeWidth={2.2} />
              <span className="min-w-0">
                <span className="block font-medium">
                  {propertyManagerOpen ? 'Close properties & display rules' : 'Properties & display rules'}
                </span>
                <span className="block text-[11px] text-ink-muted leading-snug">
                  Every property the view’s entities carry, and the rules that tag them
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
          {onOpenHistory && (
            <DropdownMenu.Item className={itemClass} onSelect={onOpenHistory}>
              <LucideIcons.History className="w-4 h-4 mt-px text-accent-lineage shrink-0" strokeWidth={2.2} />
              <span className="min-w-0">
                <span className="block font-medium">Changes &amp; history…</span>
                <span className="block text-[11px] text-ink-muted leading-snug">
                  {isDraft
                    ? 'Opens on the changes in your draft'
                    : `Opens on the history of the ${BRANCH_VOCAB.published.toLowerCase()} version`}
                </span>
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
          {hasFiles && (
            <>
              <DropdownMenu.Separator className="h-px bg-glass-border my-1.5 mx-1" />
              <DropdownMenu.Group aria-label="File">
                <DropdownMenu.Label className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                  File
                </DropdownMenu.Label>
                {importData && (
                  <DropdownMenu.Item className={itemClass} disabled={!isDraft} onSelect={importData}>
                    <LucideIcons.Upload className="w-4 h-4 mt-px text-accent-lineage shrink-0" strokeWidth={2.2} />
                    <span className="min-w-0">
                      <span className="block font-medium">Import…</span>
                      <span className="block text-[11px] text-ink-muted leading-snug">
                        {isDraft
                          ? 'Bring entities in from CSV, Excel or NDJSON'
                          : 'Available in Edit mode — start a draft to import'}
                      </span>
                    </span>
                  </DropdownMenu.Item>
                )}
                {exportView && (
                  <DropdownMenu.Item className={itemClass} onSelect={exportView}>
                    <LucideIcons.FileDown className="w-4 h-4 mt-px text-accent-lineage shrink-0" strokeWidth={2.2} />
                    <span className="min-w-0">
                      <span className="block font-medium">Export view…</span>
                      <span className="block text-[11px] text-ink-muted leading-snug">Its design as a file, to import in another environment</span>
                    </span>
                  </DropdownMenu.Item>
                )}
                {exportData && (
                  <DropdownMenu.Item className={itemClass} onSelect={exportData}>
                    <LucideIcons.PackageOpen className="w-4 h-4 mt-px text-accent-lineage shrink-0" strokeWidth={2.2} />
                    <span className="min-w-0">
                      <span className="block font-medium">Export data…</span>
                      <span className="block text-[11px] text-ink-muted leading-snug">The graph data this view reads</span>
                    </span>
                  </DropdownMenu.Item>
                )}
                {updateView && (
                  <DropdownMenu.Item className={itemClass} onSelect={updateView}>
                    <LucideIcons.FileUp className="w-4 h-4 mt-px text-accent-lineage shrink-0" strokeWidth={2.2} />
                    <span className="min-w-0">
                      <span className="block font-medium">Update this view from a file…</span>
                      <span className="block text-[11px] text-ink-muted leading-snug">Bring in a newer design of it from another environment</span>
                    </span>
                  </DropdownMenu.Item>
                )}
                {saveTemplate && (
                  <DropdownMenu.Item className={itemClass} onSelect={saveTemplate}>
                    <LucideIcons.LayoutTemplate className="w-4 h-4 mt-px text-accent-lineage shrink-0" strokeWidth={2.2} />
                    <span className="min-w-0">
                      <span className="block font-medium">Save layers as a template…</span>
                      <span className="block text-[11px] text-ink-muted leading-snug">Reuse its layer layout for new views — never the entities it placed</span>
                    </span>
                  </DropdownMenu.Item>
                )}
              </DropdownMenu.Group>
            </>
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
