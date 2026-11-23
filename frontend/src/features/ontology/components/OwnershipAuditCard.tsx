/**
 * OwnershipAuditCard — who a semantic layer belongs to, who made and changed it, and who may.
 *
 * The answers lived in a header row that only opened when the layer had a description, and named
 * people by their raw ids. A layer is a shared governance object: every view resolving through it
 * feels a change, so "who made this, who last touched it, can I?" deserves one place that answers
 * all three, by name, with the exact instant a hover away.
 */
import { motion } from 'framer-motion'
import { ArrowRight, Building2, CheckCircle2, Clock, Fingerprint, Lock, ShieldCheck, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'

import { CopyButton } from '@/components/ui/CopyButton'
import { DateTime } from '@/components/ui/DateTime'
import { PersonChip } from '@/components/ui/PersonChip'
import { MOTION } from '@/lib/motion'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { WorkspaceResponse } from '@/services/workspaceService'

import { BLOCKED_REASON, useSemanticLayerAccess } from '../lib/useSemanticLayerAccess'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-center gap-3 py-2 border-b border-glass-border/50 last:border-b-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">{label}</dt>
      <dd className="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink">{children}</dd>
    </div>
  )
}

/** When, and by whom — or, for a record from before people were recorded, when alone. */
function Stamp({ at, by }: { at: string | null | undefined; by: string | null | undefined }) {
  return (
    <>
      <DateTime at={at} className="font-medium" />
      {by ? <><span className="text-ink-muted">by</span><PersonChip id={by} size="xs" /></>
        : <span className="text-ink-muted">· not recorded who</span>}
    </>
  )
}

export function OwnershipAuditCard({ ontology, workspaces, onOpenHistory }: {
  ontology: OntologyDefinitionResponse
  workspaces?: WorkspaceResponse[]
  /** Open the History tab — offered only while this reader may see it. */
  onOpenHistory?: () => void
}) {
  const access = useSemanticLayerAccess(ontology)
  const openHistory = access.canSeeHistory ? onOpenHistory : undefined
  const owner = ontology.ownerWorkspaceId
    ? workspaces?.find(w => w.id === ontology.ownerWorkspaceId)?.name ?? ontology.ownerWorkspaceId
    : null
  const status = ontology.isSystem ? 'built in' : ontology.isPublished ? 'published' : 'draft'

  return (
    <motion.section
      initial={{ opacity: 0, y: MOTION.cardY }}
      animate={{ opacity: 1, y: 0 }}
      transition={MOTION.cardEntry}
      aria-labelledby="ontology-ownership"
      className="rounded-2xl border border-glass-border bg-canvas-elevated/50 p-4"
    >
      <div className="flex items-center gap-2 mb-1">
        <div className="w-7 h-7 rounded-lg bg-accent-lineage/10 text-accent-lineage flex items-center justify-center">
          <ShieldCheck className="w-4 h-4" />
        </div>
        <h3 id="ontology-ownership" className="text-sm font-bold text-ink">Ownership &amp; audit</h3>
        {openHistory && (
          <button
            type="button"
            onClick={openHistory}
            className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-accent-lineage hover:bg-accent-lineage/10 transition-colors"
          >
            <Clock className="w-3 h-3" />
            Full history
            <ArrowRight className="w-3 h-3" />
          </button>
        )}
      </div>

      <dl>
        <Row label="Created"><Stamp at={ontology.createdAt} by={ontology.createdBy} /></Row>
        <Row label="Last changed"><Stamp at={ontology.updatedAt} by={ontology.updatedBy} /></Row>
        <Row label="Published">
          {ontology.publishedAt
            ? <Stamp at={ontology.publishedAt} by={ontology.publishedBy} />
            : <span className="text-ink-muted">{ontology.isSystem ? 'Built in — never published by hand' : 'Not yet — this version is a draft'}</span>}
        </Row>
        {ontology.deletedAt && (
          <Row label="Deleted">
            <Trash2 className="w-3 h-3 text-red-500" />
            <Stamp at={ontology.deletedAt} by={ontology.deletedBy} />
          </Row>
        )}
        <Row label="Version">
          <span className="font-mono font-semibold">v{ontology.version}</span>
          <span className="text-ink-muted">· {status}</span>
        </Row>
        <Row label="Schema id">
          <Fingerprint className="w-3 h-3 text-ink-muted" />
          <code className="font-mono text-[11px] text-ink-secondary truncate">{ontology.schemaId}</code>
          <CopyButton value={ontology.schemaId} label="Copy the schema id" />
          {ontology.schemaId !== ontology.id && (
            <span className="text-[11px] text-ink-muted">every version shares it</span>
          )}
        </Row>
        <Row label="Owner">
          <Building2 className="w-3 h-3 text-ink-muted" />
          {owner
            ? <span className="font-medium">{owner}</span>
            : <span><span className="font-medium">The organisation</span><span className="text-ink-muted"> — any workspace can use it</span></span>}
        </Row>
        <Row label="Who can change it">
          {access.canEdit ? (
            <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="w-3.5 h-3.5" />
              You can
            </span>
          ) : (
            <span className="inline-flex items-start gap-1.5 text-ink-secondary leading-snug">
              <Lock className="w-3 h-3 mt-0.5 flex-shrink-0 text-ink-muted" />
              {BLOCKED_REASON[access.editingBlockedBy ?? 'permission']}
            </span>
          )}
        </Row>
      </dl>
    </motion.section>
  )
}
