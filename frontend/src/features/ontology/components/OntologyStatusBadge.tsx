import { Shield, CheckCircle2, PenLine } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

export function OntologyStatusBadge({
  ontology,
  size = 'sm',
}: {
  ontology: OntologyDefinitionResponse
  size?: 'xs' | 'sm'
}) {
  const base = size === 'xs'
    ? 'text-[9px] px-1.5 py-0 gap-0.5'
    : 'text-[10px] px-2 py-0.5 gap-1'
  const iconSize = size === 'xs' ? 'w-2.5 h-2.5' : 'w-3 h-3'

  if (ontology.isSystem) {
    return (
      <span className={cn(
        'inline-flex items-center rounded-full font-bold border',
        'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
        base,
      )}>
        <Shield className={iconSize} />
        system
      </span>
    )
  }
  if (ontology.isPublished) {
    return (
      <span className={cn(
        'inline-flex items-center rounded-full font-bold border',
        'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
        base,
      )}>
        <CheckCircle2 className={iconSize} />
        published
      </span>
    )
  }
  return (
    <span className={cn(
      'inline-flex items-center rounded-full font-bold border',
      'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
      base,
    )}>
      <PenLine className={iconSize} />
      draft
    </span>
  )
}
