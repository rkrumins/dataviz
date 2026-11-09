/**
 * CommitProvenance — how a commit was made, beside who made it (doc 19 §3.6).
 *
 * A person's commit by hand shows nothing extra. Otherwise:
 * - a service account's shows "Service account";
 * - the platform's shows "Platform";
 * - one made through an API key names the key, and its tooltip gives the request the change came
 *   from, for the audit trail.
 */
import { Bot, Cpu, KeyRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { actorKindOf, keyLabel } from '../model/provenance'

const CHIP = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold leading-none ring-1 ring-inset'

export function CommitProvenance({ commit, apiKeyNames, className }: {
  commit: Record<string, unknown>
  apiKeyNames?: Record<string, string>
  className?: string
}) {
  const kind = actorKindOf(commit)
  const key = keyLabel(commit, apiKeyNames)
  const request = typeof commit.correlation_id === 'string' ? commit.correlation_id : null
  if (kind === 'human' && !key) return null
  return (
    <span className={cn('inline-flex items-center gap-1', className)} onClick={(e) => e.stopPropagation()}>
      {kind === 'service' && (
        <HoverTip className="inline-flex" label="Made by a service account"
          detail="Automation: an integration acting under its own identity and roles.">
          <span className={cn(CHIP, 'bg-violet-500/10 text-violet-700 ring-violet-500/20 dark:text-violet-300')}>
            <Bot className="w-3 h-3" aria-hidden /> Service account
          </span>
        </HoverTip>
      )}
      {kind === 'system' && (
        <HoverTip className="inline-flex" label="Made by the platform itself"
          detail="Turning version control on, a re-sync, or a maintenance step.">
          <span className={cn(CHIP, 'bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:text-slate-300')}>
            <Cpu className="w-3 h-3" aria-hidden /> Platform
          </span>
        </HoverTip>
      )}
      {key && (
        <HoverTip
          className="inline-flex"
          label={<>Made with the API key <span className="font-semibold">“{key}”</span></>}
          detail={request ? <>Request <code className="font-mono text-[10px]">{request}</code></> : 'A script or integration, acting through this key.'}
        >
          <span className={cn(CHIP, 'bg-amber-500/10 text-amber-700 ring-amber-500/20 dark:text-amber-300 max-w-[12rem]')}>
            <KeyRound className="w-3 h-3 shrink-0" aria-hidden />
            <span className="truncate">{key}</span>
          </span>
        </HoverTip>
      )}
    </span>
  )
}
