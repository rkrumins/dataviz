/**
 * Reading paths in the reader: where you are on yours, what to read next,
 * and how far along you are — at the top of an article, at its end, and in
 * the sidebar. Paths come from the personas (`paths.ts`); progress lives in
 * the reader's browser (`readingStore.ts`).
 */
import { Link } from 'react-router-dom'
import { ArrowRight, CheckCircle2, Flag, Route, Trophy, X, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { interpolateBrand } from '@/lib/brandText'
import { useBrand } from '@/store/branding'
import { useReadingStore } from './readingStore'
import {
  READING_PATHS, getPath, nextUnread, pageInfo, pathsContaining, readCount, readKey,
  type ReaderArea, type ReadingPath,
} from './paths'

function Segments({ path, current }: { path: ReadingPath; current?: string }) {
  const brand = useBrand()
  const read = useReadingStore((s) => s.read)
  return (
    <ol className="flex items-center gap-1" aria-label={`${path.label} path`}>
      {path.slugs.map((slug, i) => {
        const done = !!read[readKey(path.area, slug)]
        const here = slug === current
        const title = pageInfo(path.area, slug)?.title ?? slug
        return (
          <li key={slug} className="flex-1 min-w-[10px]">
            <Link
              to={`/${path.area}/${slug}`}
              title={`${i + 1}. ${interpolateBrand(title, brand)}${done ? ' — read' : ''}`}
              aria-label={`Step ${i + 1}: ${interpolateBrand(title, brand)}${done ? ' (read)' : ''}`}
              aria-current={here ? 'step' : undefined}
              className={cn(
                'block h-1.5 rounded-full transition-all hover:opacity-80',
                done ? cn('bg-gradient-to-r', path.accent.gradient) : 'bg-black/10 dark:bg-white/10',
                here && 'ring-2 ring-offset-1 ring-offset-canvas ring-accent-lineage/50',
              )}
            />
          </li>
        )
      })}
    </ol>
  )
}

/** At the top of an article on the reader's path: "Step 2 of 6", with the steps to jump between. */
export function PathProgress({ area, slug }: { area: ReaderArea; slug: string }) {
  const activeId = useReadingStore((s) => s.activePath[area])
  const read = useReadingStore((s) => s.read)
  const leavePath = useReadingStore((s) => s.leavePath)
  const path = getPath(area, activeId)
  if (!path) return null
  const step = path.slugs.indexOf(slug)
  if (step === -1) return null
  const Icon = path.icon
  return (
    <div className={cn('mb-6 rounded-xl border px-4 py-3', path.accent.border, path.accent.soft)}>
      <div className="flex items-center gap-3">
        <div className={cn('w-8 h-8 rounded-lg bg-gradient-to-br flex items-center justify-center shrink-0', path.accent.gradient)}>
          <Icon className="w-4 h-4 text-white" aria-hidden />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-ink truncate">
            <span className={path.accent.text}>{path.label} path</span>
            <span className="text-ink-muted font-medium"> · Step {step + 1} of {path.slugs.length}</span>
          </p>
          <p className="text-[11px] text-ink-muted">
            {readCount(path, read)} of {path.slugs.length} read
          </p>
        </div>
        <button
          type="button"
          onClick={() => leavePath(area)}
          className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10"
          aria-label={`Stop following the ${path.label} path`}
          title="Stop following this path"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="mt-2.5">
        <Segments path={path} current={slug} />
      </div>
    </div>
  )
}

/**
 * At the end of an article: the next page on the reader's path, the end of
 * the path, the way back to it — or, on a page some path includes, an offer
 * to follow that path.
 */
export function NextStep({ area, slug }: { area: ReaderArea; slug: string }) {
  const brand = useBrand()
  const interp = (t: string) => interpolateBrand(t, brand)
  const activeId = useReadingStore((s) => s.activePath[area])
  const read = useReadingStore((s) => s.read)
  const followPath = useReadingStore((s) => s.followPath)
  const leavePath = useReadingStore((s) => s.leavePath)
  const forget = useReadingStore((s) => s.forget)
  const path = getPath(area, activeId)

  if (path) {
    const step = path.slugs.indexOf(slug)
    const Icon = path.icon
    // Off the path: the way back.
    if (step === -1) {
      const resume = nextUnread(path, read) ?? path.slugs[0]
      const info = pageInfo(area, resume)
      return (
        <Card path={path}>
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
            You’re following the {path.label} path
          </p>
          <Link to={`/${area}/${resume}`} className="group mt-2 flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-base font-bold text-ink group-hover:text-accent-lineage transition-colors">
                Back to your path: {interp(info?.title ?? resume)}
              </span>
              <span className="block text-xs text-ink-muted mt-0.5">
                Step {path.slugs.indexOf(resume) + 1} of {path.slugs.length}
              </span>
            </span>
            <ArrowRight className="w-5 h-5 text-ink-muted group-hover:text-accent-lineage group-hover:translate-x-0.5 transition-all shrink-0" />
          </Link>
        </Card>
      )
    }

    const next = path.slugs[step + 1]
    if (next) {
      const info = pageInfo(area, next)
      return (
        <Card path={path}>
          <div className="flex items-center justify-between gap-3">
            <p className={cn('flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider', path.accent.text)}>
              <Icon className="w-3.5 h-3.5" aria-hidden />
              Next in your path · Step {step + 2} of {path.slugs.length}
            </p>
            <span className="text-[11px] text-ink-muted shrink-0">{readCount(path, read)} of {path.slugs.length} read</span>
          </div>
          <Link to={`/${area}/${next}`} className="group mt-2 flex items-center justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-lg font-bold text-ink group-hover:text-accent-lineage transition-colors">
                {interp(info?.title ?? next)}
              </span>
              {info?.description && (
                <span className="block text-sm text-ink-secondary mt-0.5">{interp(info.description)}</span>
              )}
            </span>
            <span
              className={cn(
                'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-gradient-to-r shadow-md shrink-0',
                'group-hover:shadow-lg transition-shadow',
                path.accent.gradient,
              )}
            >
              Continue <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </span>
          </Link>
          <div className="mt-4">
            <Segments path={path} current={slug} />
          </div>
        </Card>
      )
    }

    // The last step — the page being read counts as read.
    const missing = path.slugs.filter((s) => !read[readKey(area, s)] && s !== slug)
    const done = path.slugs.length - missing.length
    const others = READING_PATHS.filter((p) => p.area === area && p.id !== path.id).slice(0, 3)
    return (
      <Card path={path}>
        <div className="flex items-start gap-3">
          <div className={cn('w-10 h-10 rounded-xl bg-gradient-to-br flex items-center justify-center shrink-0 shadow-md', path.accent.gradient)}>
            <Trophy className="w-5 h-5 text-white" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="text-base font-bold text-ink">This is the last step of the {path.label} path</p>
            <p className="text-sm text-ink-secondary mt-0.5">
              {missing.length === 0
                ? `You’ve read all ${path.slugs.length} pages.`
                : `You’ve read ${done} of ${path.slugs.length} pages.`}
            </p>
          </div>
        </div>
        {missing.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {missing.map((s) => (
              <Link
                key={s}
                to={`/${area}/${s}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-glass-border bg-canvas-elevated px-3 py-1 text-xs font-medium text-ink-secondary hover:text-ink hover:border-accent-lineage/30"
              >
                <Flag className="w-3 h-3" aria-hidden /> {interp(pageInfo(area, s)?.title ?? s)}
              </Link>
            ))}
          </div>
        )}
        <div className="mt-4 pt-4 border-t border-glass-border">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">Where to next</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {others.map((p) => (
              <Link
                key={p.id}
                to={`/${area}/${p.slugs[0]}`}
                onClick={() => followPath(area, p.id)}
                className="group flex items-center gap-2 rounded-lg border border-glass-border bg-canvas-elevated px-3 py-2 hover:border-accent-lineage/30"
              >
                <p.icon className={cn('w-4 h-4 shrink-0', p.accent.text)} aria-hidden />
                <span className="text-xs font-semibold text-ink truncate group-hover:text-accent-lineage">{p.label}</span>
              </Link>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-xs">
            <button type="button" onClick={() => leavePath(area)} className="text-ink-muted hover:text-ink">
              Stop following this path
            </button>
            <button
              type="button"
              onClick={() => forget(area, path.slugs)}
              className="inline-flex items-center gap-1 text-ink-muted hover:text-ink"
            >
              <RotateCcw className="w-3 h-3" aria-hidden /> Start the path again
            </button>
          </div>
        </div>
      </Card>
    )
  }

  // Not following a path: offer the one this page belongs to.
  const offer = pathsContaining(area, slug)[0]
  if (!offer) return null
  const step = offer.slugs.indexOf(slug)
  const Icon = offer.icon
  return (
    <Card path={offer}>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className={cn('w-10 h-10 rounded-xl bg-gradient-to-br flex items-center justify-center shrink-0 shadow-md', offer.accent.gradient)}>
          <Icon className="w-5 h-5 text-white" aria-hidden />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-ink">
            {step === 0 ? `This page starts the ${offer.label} path` : `Step ${step + 1} of the ${offer.label} path`}
          </p>
          <p className="text-xs text-ink-secondary mt-0.5">
            {offer.slugs.length} pages, in the order that builds on itself — we’ll keep your place.
          </p>
        </div>
        <button
          type="button"
          onClick={() => followPath(area, offer.id)}
          className={cn(
            'inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-gradient-to-r shadow-md shrink-0',
            offer.accent.gradient,
          )}
        >
          <Route className="w-4 h-4" aria-hidden /> Follow this path
        </button>
      </div>
    </Card>
  )
}

function Card({ path, children }: { path: ReadingPath; children: React.ReactNode }) {
  return (
    <section
      aria-label="Your reading path"
      className={cn('mt-12 rounded-2xl border bg-canvas-elevated p-5 shadow-sm', path.accent.border)}
    >
      {children}
    </section>
  )
}

/** A check beside a page the reader has read, in the sidebar. */
export function ReadMark({ area, slug }: { area: ReaderArea; slug: string }) {
  const isRead = useReadingStore((s) => !!s.read[readKey(area, slug)])
  if (!isRead) return null
  return (
    <>
      <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-500" aria-hidden />
      <span className="sr-only">(read)</span>
    </>
  )
}

/** The sidebar's reminder of the path being followed, and its next page. */
export function SidebarPathCard({ area }: { area: ReaderArea }) {
  const brand = useBrand()
  const activeId = useReadingStore((s) => s.activePath[area])
  const read = useReadingStore((s) => s.read)
  const path = getPath(area, activeId)
  if (!path) return null
  const next = nextUnread(path, read)
  const done = readCount(path, read)
  const pct = Math.round((done / path.slugs.length) * 100)
  return (
    <div className="mx-3 mb-3 rounded-xl border border-glass-border bg-canvas px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold text-ink truncate">
          <span className={path.accent.text}>{path.label}</span> path
        </p>
        <span className="text-[10px] text-ink-muted tabular-nums shrink-0">
          {done}/{path.slugs.length}
        </span>
      </div>
      <div className="mt-1.5 h-1 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden" aria-hidden>
        <div className={cn('h-full rounded-full bg-gradient-to-r', path.accent.gradient)} style={{ width: `${pct}%` }} />
      </div>
      {next ? (
        <Link
          to={`/${area}/${next}`}
          className="mt-2 flex items-center gap-1 text-[11px] font-medium text-ink-secondary hover:text-accent-lineage"
        >
          <span className="truncate">Next: {interpolateBrand(pageInfo(area, next)?.title ?? next, brand)}</span>
          <ArrowRight className="w-3 h-3 shrink-0" aria-hidden />
        </Link>
      ) : (
        <p className="mt-2 flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="w-3 h-3" aria-hidden /> Path complete
        </p>
      )}
    </div>
  )
}

/**
 * On a hub, for a returning reader: the path they are following and its
 * next page, or the page they were last on.
 */
export function ContinueReading({ area }: { area: ReaderArea }) {
  const brand = useBrand()
  const interp = (t: string) => interpolateBrand(t, brand)
  const last = useReadingStore((s) => s.last[area])
  const activeId = useReadingStore((s) => s.activePath[area])
  const read = useReadingStore((s) => s.read)
  const path = getPath(area, activeId)

  if (path) {
    const next = nextUnread(path, read)
    const done = readCount(path, read)
    const target = next ?? path.slugs[0]
    const Icon = path.icon
    return (
      <div className={cn('mt-8 max-w-3xl rounded-2xl border bg-canvas-elevated p-4 sm:p-5 shadow-sm', path.accent.border)}>
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className={cn('w-11 h-11 rounded-xl bg-gradient-to-br flex items-center justify-center shrink-0 shadow-md', path.accent.gradient)}>
            <Icon className="w-5 h-5 text-white" aria-hidden />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
              {next ? 'Pick up where you left off' : 'Path complete'}
            </p>
            <p className="mt-0.5 text-base font-bold text-ink truncate">
              {next ? interp(pageInfo(area, next)?.title ?? next) : `You’ve read the whole ${path.label} path`}
            </p>
            <div className="mt-2 flex items-center gap-3">
              <div className="flex-1 max-w-56"><Segments path={path} /></div>
              <span className="text-[11px] text-ink-muted shrink-0">
                {path.label} · {done} of {path.slugs.length} read
              </span>
            </div>
          </div>
          <Link
            to={`/${area}/${target}`}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-gradient-to-r shadow-md shrink-0',
              path.accent.gradient,
            )}
          >
            {next ? (done === 0 ? 'Start' : 'Continue') : 'Read again'} <ArrowRight className="w-4 h-4" aria-hidden />
          </Link>
        </div>
      </div>
    )
  }

  const lastInfo = last ? pageInfo(area, last.slug) : undefined
  if (!last || !lastInfo) return null
  return (
    <Link
      to={`/${area}/${last.slug}`}
      className="group mt-8 max-w-3xl flex items-center gap-4 rounded-2xl border border-glass-border bg-canvas-elevated p-4 hover:border-accent-lineage/30 transition-colors"
    >
      <div className="w-10 h-10 rounded-xl bg-accent-lineage/10 text-accent-lineage flex items-center justify-center shrink-0">
        <RotateCcw className="w-4 h-4" aria-hidden />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Continue reading</p>
        <p className="mt-0.5 text-sm font-bold text-ink truncate group-hover:text-accent-lineage transition-colors">
          {interp(lastInfo.title)}
        </p>
      </div>
      <ArrowRight className="w-4 h-4 text-ink-muted group-hover:text-accent-lineage group-hover:translate-x-0.5 transition-all" aria-hidden />
    </Link>
  )
}
