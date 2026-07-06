import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  Search,
  ArrowRight,
  Rocket,
  Compass,
  BookOpen,
  Sparkles,
  ChevronDown,
  FileText,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  guidePersonas,
  guideSections,
  guideEntries,
  getEntriesForSection,
  getPersona,
  keyJourneys,
  quickStartSteps,
  glossaryChips,
  guideFaqs,
} from './guideConfig'
import { guideMarkdownComponents } from './guideMarkdown'
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

export function GuideHome() {
  const brand = useBrand()
  const interp = (t: string) => interpolateBrand(t, brand)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()

  useDocumentTitle('User Guide')

  const results = useMemo(
    () =>
      q
        ? guideEntries.filter(
            (e) =>
              e.title.toLowerCase().includes(q) ||
              e.description.toLowerCase().includes(q),
          )
        : [],
    [q],
  )

  return (
    <div className="relative">
      {/* Ambient gradient backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-gradient-to-b from-indigo-500/[0.08] via-violet-500/[0.04] to-transparent"
      />

      <div className="relative mx-auto max-w-6xl px-6 sm:px-10 py-14">
        {/* ── Hero ─────────────────────────────────────────── */}
        <motion.div initial="hidden" animate="show" custom={0} variants={fade}>
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-500/10 border border-indigo-500/20">
            <Sparkles className="w-3.5 h-3.5" />
            {brand.appName} User Guide
          </span>
          <h1 className="mt-5 font-display text-4xl sm:text-5xl font-bold tracking-tight text-ink leading-[1.1]">
            Everything you need to make
            <br className="hidden sm:block" />
            <span className="bg-gradient-to-r from-indigo-500 to-violet-600 bg-clip-text text-transparent">
              {' '}the most of your data
            </span>
          </h1>
          <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-secondary leading-relaxed">
            A single stop-shop for using {brand.appName} — what it does, how to use it,
            and the key journeys for everyone from people browsing views to the
            admins who run the platform.
          </p>

          {/* Search */}
          <div className="mt-7 max-w-xl relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the guide — try “lineage”, “share a view”, “roles”…"
              className="input pl-11 h-12 text-sm w-full shadow-sm"
            />
          </div>

          {/* Primary CTAs */}
          {!q && (
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Link to="/guide/quick-start" className="btn btn-primary">
                <Rocket className="w-4 h-4" /> Quick start
              </Link>
              <Link to="/guide/key-concepts" className="btn btn-secondary">
                <Compass className="w-4 h-4" /> Key concepts
              </Link>
              <Link to="/guide/welcome" className="btn btn-ghost">
                <BookOpen className="w-4 h-4" /> Read the welcome
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
                Nothing matched. Try a simpler term, or browse the personas below by
                clearing the search.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {results.map((e) => {
                  const persona = getPersona(e.persona)
                  return (
                    <Link
                      key={e.slug}
                      to={`/guide/${e.slug}`}
                      className="group flex items-start gap-3 rounded-xl border border-glass-border bg-canvas-elevated px-4 py-3.5 hover:border-indigo-500/30 hover:bg-indigo-500/[0.03] transition-colors"
                    >
                      <FileText className="w-4 h-4 mt-0.5 text-ink-muted shrink-0" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-ink truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                            {interp(e.title)}
                          </span>
                          {persona && (
                            <span className={cn('text-[10px] font-semibold', persona.accent.text)}>
                              {persona.label}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-ink-muted truncate">{interp(e.description)}</p>
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
            <Section title="Choose your path" subtitle="Most people are mainly one of these — start where you fit.">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                {guidePersonas.map((p, i) => {
                  const entries = getEntriesForSection(p.id)
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
                        to={`/guide/${p.startSlug}`}
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
                          {p.tagline}
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
            <Section title="Key journeys" subtitle={`The things people actually come to ${brand.appName} to do.`}>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {keyJourneys.map((j, i) => {
                  const persona = getPersona(j.persona)
                  return (
                    <motion.div
                      key={j.title}
                      initial="hidden"
                      whileInView="show"
                      viewport={{ once: true, margin: '-40px' }}
                      custom={i % 3}
                      variants={fade}
                    >
                      <Link
                        to={`/guide/${j.slug}`}
                        className="group flex h-full flex-col rounded-xl border border-glass-border bg-canvas-elevated p-4 hover:border-indigo-500/30 hover:bg-indigo-500/[0.03] transition-colors"
                      >
                        <div className="flex items-center justify-between">
                          <div
                            className={cn(
                              'w-9 h-9 rounded-lg flex items-center justify-center',
                              persona?.accent.soft,
                              persona?.accent.text,
                            )}
                          >
                            <j.icon className="w-5 h-5" />
                          </div>
                          <span className="text-[10px] text-ink-muted">{j.time}</span>
                        </div>
                        <h3 className="mt-3 text-sm font-bold text-ink group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                          {j.title}
                        </h3>
                        <p className="mt-1 text-xs text-ink-muted leading-relaxed flex-1">
                          {j.outcome}
                        </p>
                        {persona && (
                          <span className={cn('mt-3 text-[10px] font-semibold uppercase tracking-wide', persona.accent.text)}>
                            {persona.label}
                          </span>
                        )}
                      </Link>
                    </motion.div>
                  )
                })}
              </div>
            </Section>

            {/* ── Quick start strip ───────────────────────── */}
            <Section title="Your first 10 minutes" subtitle="Five steps from sign-in to your first saved View.">
              <Link
                to="/guide/quick-start"
                className="group block rounded-2xl border border-glass-border bg-gradient-to-br from-indigo-500/[0.06] to-violet-500/[0.04] p-6 hover:border-indigo-500/30 transition-colors"
              >
                <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                  {quickStartSteps.map((step, i) => (
                    <li key={step} className="flex items-start gap-3 lg:flex-col lg:items-start">
                      <span className="shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white text-xs font-bold flex items-center justify-center shadow-md shadow-indigo-500/20">
                        {i + 1}
                      </span>
                      <span className="text-sm text-ink-secondary leading-snug">{step}</span>
                    </li>
                  ))}
                </ol>
                <span className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-indigo-600 dark:text-indigo-400">
                  Open the Quick Start
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                </span>
              </Link>
            </Section>

            {/* ── Browse by topic ─────────────────────────── */}
            <Section title="Browse by topic" subtitle="The full table of contents.">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-6">
                {guideSections.map((section) => {
                  const entries = getEntriesForSection(section.id)
                  if (entries.length === 0) return null
                  const persona = getPersona(section.persona)
                  const SectionIcon = section.icon
                  return (
                    <div key={section.id}>
                      <div className="flex items-center gap-2 mb-2">
                        <SectionIcon className={cn('w-4 h-4', persona ? persona.accent.text : 'text-ink-muted')} />
                        <h3 className="text-xs font-bold uppercase tracking-wider text-ink-muted">
                          {section.label}
                        </h3>
                      </div>
                      <ul className="space-y-1">
                        {entries.map((e) => (
                          <li key={e.slug}>
                            <Link
                              to={`/guide/${e.slug}`}
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

            {/* ── Acronyms at a glance ────────────────────── */}
            <Section title="Acronyms at a glance" subtitle="The vocabulary you’ll meet most.">
              <div className="flex flex-wrap gap-2">
                {glossaryChips.map((c) => (
                  <Link
                    key={c.term}
                    to="/guide/glossary"
                    title={c.full}
                    className="group inline-flex items-center gap-1.5 rounded-full border border-glass-border bg-canvas-elevated px-3 py-1.5 text-xs hover:border-indigo-500/30 hover:bg-indigo-500/[0.03] transition-colors"
                  >
                    <span className="font-semibold text-ink">{c.term}</span>
                    <span className="text-ink-muted hidden sm:inline">— {c.full}</span>
                  </Link>
                ))}
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
      {guideFaqs.map((f, i) => {
        const isOpen = open === i
        return (
          <div
            key={f.question}
            className={cn(
              'rounded-xl border transition-all duration-200',
              isOpen
                ? 'border-indigo-500/20 bg-gradient-to-r from-indigo-500/5 to-violet-500/5'
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
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={guideMarkdownComponents}>
                  {interp(f.answer)}
                </ReactMarkdown>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
