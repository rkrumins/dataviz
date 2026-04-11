/**
 * OntologyDriftBanner — non-blocking notice shown when a view is edited
 * after its underlying ontology has been mutated.
 *
 * Detection:
 *   The view row carries an `ontology_digest` snapshot taken at save time
 *   (see backend `_compute_ontology_digest`). When the user opens the
 *   wizard to edit that view, we compare the stored digest against the
 *   digest of the CURRENT ontology for the view's scope. If they differ,
 *   some entity classifications may no longer be valid — e.g. a Platform
 *   type that the user had put inside the "Sources" layer may no longer
 *   satisfy the new containment rules.
 *
 * Intentionally non-blocking:
 *   We do NOT auto-migrate or auto-remove assignments. The user decides.
 *   Saving the edited view stamps the current digest onto the row, which
 *   implicitly acknowledges the drift.
 *
 * Rendered by ViewWizardBody above the step content when
 *   viewMetadata.ontologyDigest !== currentSchemaDigest (both non-null).
 */
import { useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface OntologyDriftBannerProps {
  /** The digest captured when the view was last saved. */
  viewDigest: string | null
  /** The digest of the current ontology for the view's scope. */
  currentDigest: string | null
  /** Called when the user dismisses the banner for this session. */
  onDismiss?: () => void
  className?: string
}

/**
 * Returns true when both digests are non-null AND differ. A null digest
 * on either side means "drift check not possible" — e.g. views created
 * before drift tracking was added (Phase 1.6) or an ontology the backend
 * couldn't digest. In those cases we stay silent instead of crying wolf.
 */
export function hasOntologyDrifted(
  viewDigest: string | null | undefined,
  currentDigest: string | null | undefined,
): boolean {
  if (!viewDigest || !currentDigest) return false
  return viewDigest !== currentDigest
}

export function OntologyDriftBanner({
  viewDigest,
  currentDigest,
  onDismiss,
  className,
}: OntologyDriftBannerProps) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  if (!hasOntologyDrifted(viewDigest, currentDigest)) return null

  return (
    <div
      className={cn(
        'flex items-start gap-3 px-4 py-3 mb-4',
        'rounded-xl border border-amber-200 bg-amber-50',
        'dark:border-amber-800 dark:bg-amber-900/20',
        className,
      )}
      role="alert"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="flex-1 text-xs text-amber-800 dark:text-amber-200">
        <p className="font-semibold">Ontology has changed since this view was created.</p>
        <p className="mt-1 leading-relaxed">
          Some entity classifications may no longer be valid. Review the
          Assignment step carefully — saving this view will re-baseline
          the ontology snapshot and suppress this warning on the next edit.
        </p>
      </div>
      <button
        onClick={() => {
          setDismissed(true)
          onDismiss?.()
        }}
        className="flex-shrink-0 rounded-md p-1 text-amber-600 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-900/40"
        aria-label="Dismiss ontology drift warning"
        type="button"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
