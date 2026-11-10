/**
 * Who made a commit, and how (doc 19 §3.6), and what a draft behind Published must do about it
 * (§3.5).
 *
 * Automation is a commit made by any of:
 * - a service account;
 * - the platform itself;
 * - anyone's API key — a person's own key is a script acting as them.
 *
 * Everything else is a person's, by hand. History can show either side alone, and collapses a run
 * of one automation's commits into one row. A draft behind nothing but automation that touched
 * none of its changes publishes as it is.
 */
import type { PullReason } from '@/services/versioningApiService'

type Commit = Record<string, unknown>

export type ActorKind = 'human' | 'service' | 'system'

export function actorKindOf(c: Commit): ActorKind {
  const k = c.actor_kind
  if (k === 'human' || k === 'service' || k === 'system') return k
  const a = typeof c.actor === 'string' ? c.actor : ''
  if (!a || a === 'system' || a.startsWith('system:')) return 'system'
  return a.startsWith('svc_') || a.startsWith('svc:') ? 'service' : 'human'
}

/** Whether automation made it (the server's `automation`, else read from its actor and key). */
export function isAutomation(c: Commit): boolean {
  if (typeof c.automation === 'boolean') return c.automation
  return actorKindOf(c) !== 'human' || !!c.api_key_id
}

/** The key a commit came through, named when the log named it. */
export function keyLabel(c: Commit, apiKeyNames?: Record<string, string>): string | null {
  const id = typeof c.api_key_id === 'string' ? c.api_key_id : null
  if (!id) return null
  return apiKeyNames?.[id] ?? `key …${id.slice(-6)}`
}

/** What a run of commits is grouped by: one automation, through one key. */
export function runKey(c: Commit): string | null {
  if (!isAutomation(c)) return null
  return `${String(c.actor ?? '')}|${String(c.api_key_id ?? '')}`
}

export interface GateCopy {
  /** The strip's tone: `info` publishes as it is; `warn` must pull first. */
  tone: 'info' | 'warn'
  title: string
  body: string
}

/** What to tell the owner of a draft behind Published: why, and what to do next. ``reason`` null
 *  with the draft behind means automation alone moved Published, on nothing the draft changes. */
export function gateCopy(reason: PullReason | null | undefined, behindBy: number, behindByPeople = 0): GateCopy {
  const n = (k: number, one: string, many: string) => `${k.toLocaleString()} ${k === 1 ? one : many}`
  switch (reason) {
    case 'people':
      return {
        tone: 'warn',
        title: `Updates available — ${n(behindByPeople || behindBy, 'change', 'changes')} by people on the Published version`,
        body: 'Someone changed Published since you started. Get their changes into your draft and check they sit well with yours, then publish.',
      }
    case 'overlap':
      return {
        tone: 'warn',
        title: 'Automation changed something you’re changing',
        body: 'A sync or script updated items in this draft since you started. Get the latest to see what it changed and keep the values you want, then publish.',
      }
    case 'size':
      return {
        tone: 'warn',
        title: 'Get the latest before publishing a draft this large',
        body: 'Published has moved since you started, and a draft this size publishes only once it is up to date.',
      }
    default:
      return {
        tone: 'info',
        title: `Published moved — ${n(behindBy, 'update', 'updates')} from automation only`,
        body: 'None of it touched what you changed, so you can publish as it is: your changes land on top. Get the latest any time to see it in your draft.',
      }
  }
}

/** A refused publish or merge (409 not_up_to_date), said as what to do next. */
export function refusalCopy(reason: PullReason | undefined): string {
  switch (reason) {
    case 'overlap':
      return 'Automation changed something this draft changes. Get the latest updates to see what it changed, then publish.'
    case 'size':
      return 'This draft is large and Published has moved: get the latest updates, then publish.'
    default:
      return 'Someone changed Published since this draft started. Get the latest updates, check them, then publish.'
  }
}
