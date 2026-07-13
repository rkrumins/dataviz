import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Search, ArrowRight, ChevronDown, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  docPersonas,
  docSections,
  docEntries,
  docKeyJourneys,
  faqEntries,
  getEntriesForSection,
  getSectionById,
} from './docsConfig'
import { markdownComponents } from './MarkdownComponents'
import { interpolateBrand } from '@/lib/brandText'
import { useBrand } from '@/store/branding'
import { useDocumentTitle } from '@/lib/useDocumentTitle'

const fade = {
  hidden: { opacity: 0, y: 16 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, delay: i * 0.05, ease: 'easeOut' },
  }),
}

export function DocsHome() {
  const brand = useBrand()
  const interp = (t: string) => interpolateBrand(t, brand)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()

  useDocumentTitle('Docs')

  const results = useMemo(
    () =>
      q
        ? docEntries.filter(
            (e) =>
              e.title.toLowerCase().includes(q) ||
              e.description?.toLowerCase().includes(q),
          )
        : [],
    [q],
  )

  return (
    <div className="relative">
      {/* Ambient gradient backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-gradient-to-b from-cyan-500/[0.07] via-slate-500/[0.04] to-transparent"
      />

      <div className="relative mx-auto max-w-6xl px-6 sm:px-10 py-14">
        {/* ── Hero ─────────────────────────────────────────── */}
        <motion.div initial="hidden" animate="show" custom={0} variants={fade}>
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold text-cyan-600 dark:text-cyan-400 bg-cyan-500/10 border border-cyan-500/20">
            <FileText className="w-3.5 h-3.5" />
            {brand.appName} Documentation
          </span>
          <h1 className="mt-5 font-display text-4xl sm:text-5xl font-bold tracking-tight text-ink leading-[1.1]">
            The technical reference
            <br className="hidden sm:block" />
            <span className="bg-gradient-to-r from-cyan-500 to-slate-600 bg-clip-text text-transparent">
              {' '}for building on {brand.appName}
            </span>
          </h1>
          <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-secondary leading-relaxed">
            Architecture, backend and frontend reference, versioning internals, security,
            and deployment — everything an engineer, architect, or operator needs to work
            on the platform with confidence.
          </p>

          {/* Search */}
          <div className="mt-7 max-w-xl relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the docs — try “migrations”, “RBAC”, “deployment”…"
              className="input pl-11 h-12 text-sm w-full shadow-sm"
            />
          </div>

          {/* Primary CTAs */}
          {!q && (
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Link to="/docs/overview" className="btn btn-primary">
                <FileText className="w-4 h-4" /> Read the overview
              </Link>
              <Link to="/docs/setup" className="btn btn-secondary">
                <ArrowRight className="w-4 h-4" /> Set up locally
              </Link>
              <Link to="/docs/faq" className="btn btn-ghost">
                <Search className="w-4 h-4" /> Browse the FAQ
              </Link>
            </div>
          )}
        </motion.div>

        {/* ── Search results ──────────────────────────────── */}
        {q ? (
          <div className="mt-10">
            <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted mb-4">
              {results.length} result{results.length === 1 ? '' : 's'} for “{query}”
            </h2>
            {results.length === 0 ? (
              <p className="text-sm text-ink-muted">
                Nothing matched. Try a simpler term, or browse the topics below by
                clearing the search.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {results.map((e) => {
                  const section = getSectionById(e.section)
                  return (
                    <Link
                      key={e.slug}
                      to={`/docs/${e.slug}`}
                      className="group flex items-start gap-3 rounded-xl border border-glass-border bg-canvas-elevated px-4 py-3.5 hover:border-cyan-500/30 hover:bg-cyan-500/[0.03] transition-colors"
                    >
                      <FileText className="w-4 h-4 mt-0.5 text-ink-muted shrink-0" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-ink truncate group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors">
                            {interp(e.title)}
                          </span>
                          {section && (
                            <span className="text-[10px] font-semibold text-ink-muted">
                              {section.label}
                            </span>
                          )}
                        </div>
                        {e.description && (
                          <p className="text-xs text-ink-muted truncate">{interp(e.description)}</p>
                        )}
                      </div>
                    </Link>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* ── Persona cards ───────────────────────────── */}
            <Section title="Choose your path" subtitle="Most people land here for one reason — start where you fit.">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                {docPersonas.map((p, i) => {
                  const entries = getEntriesForSection(p.sectionId)
                  return (
                    <motion.div
                      key={p.id}
                      initial="hidden"
                      whileInView="show"
                      viewport={{ once: true, margin: '-60px' }}
                      custom={i}
                      variants={fade}
                    >
                      <Link
                        to={`/docs/${p.startSlug}`}
                        className={cn(
                          'group block h-full rounded-2xl border bg-canvas-elevated p-6 transition-all duration-200 hover:-translate-y-1',
                          'border-glass-border hover:shadow-glass',
                          p.accent.glow,
                        )}
                      >
                        <div
                          className={cn(
                            'w-12 h-12 rounded-xl bg-gradient-to-br flex items-center justify-center shadow-lg mb-4',
                            p.accent.gradient,
                            p.accent.glow,
                          )}
                        >
                          <p.icon className="w-6 h-6 text-white" />
                        </div>
                        <h3 className="text-lg font-bold text-ink">{p.label}</h3>
                        <p className={cn('text-xs font-semibold mt-0.5', p.accent.text)}>
                          {interp(p.tagline)}
                        </p>
                        <p className="mt-3 text-sm text-ink-secondary leading-relaxed">
                          {interp(p.intro)}
                        </p>
                        <div className="mt-4 pt-4 border-t border-glass-border space-y-1.5">
                          {entries.slice(0, 3).map((e) => (
                            <div key={e.slug} className="flex items-center gap-2 text-xs text-ink-muted">
                              <div className={cn('w-1 h-1 rounded-full', p.accent.text)} />
                              <span className="truncate">{interp(e.title)}</span>
                            </div>
                          ))}
                        </div>
                        <span className={cn('mt-4 inline-flex items-center gap-1 text-sm font-semibold', p.accent.text)}>
                          Start here
                          <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                        </span>
                      </Link>
                    </motion.div>
                  )
                })}
              </div>
            </Section>

            {/* ── Key journeys ────────────────────────────── */}
            <Section title="Key journeys" subtitle="The things people actually come here to do.">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {docKeyJourneys.map((j, i) => (
                  <motion.div
                    key={j.title}
                    initial="hidden"
                    whileInView="show"
                    viewport={{ once: true, margin: '-40px' }}
                    custom={i % 4}
                    variants={fade}
                  >
                    <Link
                      to={`/docs/${j.slug}`}
                      className="group flex h-full flex-col rounded-xl border border-glass-border bg-canvas-elevated p-4 hover:border-cyan-500/30 hover:bg-cyan-500/[0.03] transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
                          <j.icon className="w-5 h-5" />
                        </div>
                        <span className="text-[10px] text-ink-muted">{j.time}</span>
                      </div>
                      <h3 className="mt-3 text-sm font-bold text-ink group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors">
                        {j.title}
                      </h3>
                      <p className="mt-1 text-xs text-ink-muted leading-relaxed flex-1">
                        {j.outcome}
                      </p>
                    </Link>
                  </motion.div>
                ))}
              </div>
            </Section>

            {/* ── Browse by topic ─────────────────────────── */}
            <Section title="Browse by topic" subtitle="The full table of contents.">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-6">
                {docSections
                  .filter((s) => s.id !== 'faq')
                  .map((section) => {
                    const entries = getEntriesForSection(section.id)
                    if (entries.length === 0) return null
                    const SectionIcon = section.icon
                    return (
                      <div key={section.id}>
                        <div className="flex items-center gap-2 mb-2">
                          <SectionIcon className="w-4 h-4 text-ink-muted" />
                          <h3 className="text-xs font-bold uppercase tracking-wider text-ink-muted">
                            {section.label}
                          </h3>
                        </div>
                        <ul className="space-y-1">
                          {entries.map((e) => (
                            <li key={e.slug}>
                              <Link
                                to={`/docs/${e.slug}`}
                                className="block rounded-lg px-2 py-1.5 -mx-2 text-sm text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                              >
                                {interp(e.title)}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )
                  })}
              </div>
            </Section>

            {/* ── FAQ ─────────────────────────────────────── */}
            <Section title="Popular questions" subtitle="Quick answers to the things people ask first.">
              <FaqAccordion />
            </Section>
          </>
        )}

        <div className="h-10" />
      </div>
    </div>
  )
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-14">
      <h2 className="font-display text-2xl font-bold tracking-tight text-ink">{title}</h2>
      {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
      <div className="mt-6">{children}</div>
    </section>
  )
}

function FaqAccordion() {
  const brand = useBrand()
  const interp = (t: string) => interpolateBrand(t, brand)
  const [open, setOpen] = useState<number | null>(0)
  return (
    <div className="space-y-2 max-w-3xl">
      {faqEntries.slice(0, 6).map((f, i) => {
        const isOpen = open === i
        return (
          <div
            key={f.question}
            className={cn(
              'rounded-xl border transition-all duration-200',
              isOpen
                ? 'border-cyan-500/20 bg-gradient-to-r from-cyan-500/5 to-slate-500/5'
                : 'border-glass-border bg-canvas-elevated hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
            )}
          >
            <button
              onClick={() => setOpen(isOpen ? null : i)}
              className="w-full flex items-center justify-between px-4 py-3.5 text-left"
            >
              <span className="text-sm font-semibold text-ink pr-4">{interp(f.question)}</span>
              <ChevronDown
                className={cn(
                  'w-4 h-4 text-ink-muted shrink-0 transition-transform duration-200',
                  isOpen && 'rotate-180',
                )}
              />
            </button>
            {isOpen && (
              <div className="px-4 pb-4 prose-synodic text-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {interp(f.answer)}
                </ReactMarkdown>
              </div>
            )}
          </div>
        )
      })}
      <Link
        to="/docs/faq"
        className="inline-flex items-center gap-1 mt-2 text-sm font-semibold text-cyan-600 dark:text-cyan-400"
      >
        See all questions
        <ArrowRight className="w-4 h-4" />
      </Link>
    </div>
  )
}
