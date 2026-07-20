import { GraduationCap, Wrench, BookText, Lightbulb, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Diátaxis document type — tells the reader what *kind* of page they're on, so
 * someone in "just give me the steps" mode isn't surprised by architecture
 * prose (and vice-versa). Reference: https://diataxis.fr
 */
export type DocType = 'tutorial' | 'how-to' | 'reference' | 'explanation'

const STYLE: Record<DocType, { label: string; icon: LucideIcon; cls: string }> = {
  tutorial: { label: 'Tutorial', icon: GraduationCap, cls: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  'how-to': { label: 'How-to', icon: Wrench, cls: 'text-accent-lineage bg-accent-lineage/10 border-accent-lineage/25' },
  reference: { label: 'Reference', icon: BookText, cls: 'text-slate-600 dark:text-slate-300 bg-slate-500/10 border-slate-500/20' },
  explanation: { label: 'Explanation', icon: Lightbulb, cls: 'text-violet-600 dark:text-violet-400 bg-violet-500/10 border-violet-500/20' },
}

/** Diátaxis classification per docs slug. Unlisted slugs simply show no badge. */
export const DOC_TYPES: Record<string, DocType> = {
  // Explanation — understanding-oriented
  overview: 'explanation',
  architecture: 'explanation',
  'data-architecture': 'explanation',
  decisions: 'explanation',
  'scaling-architecture': 'explanation',
  'aggregation-pipeline': 'explanation',
  'technical-debt': 'explanation',
  'versioning-overview': 'explanation',
  'services-overview': 'explanation',
  'services-insights': 'explanation',
  'services-search': 'explanation',
  'services-context-engine': 'explanation',
  'services-assignments': 'explanation',
  'sso-integration': 'explanation',
  'signup-service': 'explanation',
  'falkordb-deployment': 'explanation',
  'infra-launch-scale': 'explanation',
  'infra-scaling-250m': 'explanation',
  'read-path-performance': 'explanation',
  // Reference — information-oriented
  backend: 'reference',
  frontend: 'reference',
  'api-features': 'reference',
  rbac: 'reference',
  'versioning-api-reference': 'reference',
  'versioning-deep-dives': 'reference',
  changelog: 'reference',
  // How-to — task-oriented
  setup: 'how-to',
  'integration-testing': 'how-to',
  deployment: 'how-to',
  'falkordb-dr': 'how-to',
  sso: 'how-to',
  'versioning-e2e': 'how-to',
}

export function getDocType(slug: string): DocType | undefined {
  return DOC_TYPES[slug]
}

export function DocTypeBadge({ type }: { type?: DocType }) {
  if (!type) return null
  const { label, icon: Icon, cls } = STYLE[type]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border',
        cls,
      )}
      title={`Diátaxis: ${label}`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </span>
  )
}
