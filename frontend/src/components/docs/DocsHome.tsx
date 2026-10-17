import { useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Search, ArrowRight, ChevronDown, FileText, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  docPersonas,
  docSections,
  docKeyJourneys,
  faqEntries,
  getEntriesForSection,
  getEntryBySlug,
} from './docsConfig'
import { markdownComponents } from './MarkdownComponents'
import { interpolateBrand } from '@/lib/brandText'
import { useBrand } from '@/store/branding'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { HeroSearch } from './reading/HeroSearch'
import { ContinueReading } from './reading/ReadingPath'
import { useReadingStore } from './reading/readingStore'
import { getPath, personaCta, readKey } from './reading/paths'
import { useScrollLanding } from './reading/useScrollLanding'

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
  const read = useReadingStore((s) => s.read)
  const activePath = useReadingStore((s) => s.activePath.docs)
  const followPath = useReadingStore((s) => s.followPath)

  useDocumentTitle('Docs')
  useScrollLanding(true)

  return (
    <div className="relative">
      {/* Ambient gradient backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-gradient-to-b from-accent-lineage/[0.07] via-violet-500/[0.04] to-transparent"
      />

      <div className="relative mx-auto max-w-6xl px-6 sm:px-10 py-14">
        {/* ── Hero ─────────────────────────────────────────── */}
        <motion.div initial="hidden" animate="show" custom={0} variants={fade}>
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold text-accent-lineage dark:text-accent-lineage bg-accent-lineage/10 border border-accent-lineage/20">
            <FileText className="w-3.5 h-3.5" />
            {brand.appName} Documentation
          </span>
          <h1 className="mt-5 font-display text-4xl sm:text-5xl font-bold tracking-tight text-ink leading-[1.1]">
            The technical reference
            <br className="hidden sm:block" />
            <span className="bg-gradient-to-r from-accent-lineage to-violet-500 bg-clip-text text-transparent">
              {' '}for building on {brand.appName}
            </span>
          </h1>
          <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-secondary leading-relaxed">
            Architecture, backend and frontend reference, versioning internals, security,
            and deployment — everything an engineer, architect, or operator needs to work
            on the platform with confidence.
          </p>

          <HeroSearch placeholder="Search the docs — try “migrations”, “RBAC”, “deployment”…" />

          {/* Primary CTAs */}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Link to="/docs/overview" className="btn btn-primary btn-md">
              <FileText className="w-4 h-4" /> Read the overview
            </Link>
            <Link to="/docs/setup" className="btn btn-secondary btn-md">
              <ArrowRight className="w-4 h-4" /> Set up locally
            </Link>
            <Link to="/docs/faq" className="btn btn-ghost btn-md">
              <Search className="w-4 h-4" /> Browse the FAQ
            </Link>
          </div>

          <ContinueReading area="docs" />
        </motion.div>

        {/* ── Persona cards ───────────────────────────── */}
        <Section title="Choose your path" subtitle="Most people land here for one reason — start where you fit.">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {docPersonas.map((p, i) => {
              const path = getPath('docs', p.id)
              const cta = path ? personaCta(path, read) : { href: `/docs/${p.startSlug}`, label: 'Start here', done: 0 }
              const total = p.path.length
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
                    to={cta.href}
                    onClick={() => followPath('docs', p.id)}
                    className={cn(
                      'group flex flex-col h-full rounded-2xl border bg-canvas-elevated p-6 transition-all duration-200 hover:-translate-y-1',
                      activePath === p.id ? p.accent.border : 'border-glass-border',
                      'hover:shadow-glass',
                      p.accent.glow,
                    )}
                  >
                    <div className="flex items-start justify-between gap-3 mb-4">
                      <div
                        className={cn(
                          'w-12 h-12 rounded-xl bg-gradient-to-br flex items-center justify-center shadow-lg',
                          p.accent.gradient,
                          p.accent.glow,
                        )}
                      >
                        <p.icon className="w-6 h-6 text-white" />
                      </div>
                      <span className="text-[11px] font-medium text-ink-muted">{total} pages</span>
                    </div>
                    <h3 className="text-lg font-bold text-ink">{p.label}</h3>
                    <p className={cn('text-xs font-semibold mt-0.5', p.accent.text)}>
                      {interp(p.tagline)}
                    </p>
                    <p className="mt-3 text-sm text-ink-secondary leading-relaxed">
                      {interp(p.intro)}
                    </p>
                    <ol className="mt-4 pt-4 border-t border-glass-border space-y-1.5 flex-1">
                      {p.path.slice(0, 4).map((slug, step) => {
                        const done = !!read[readKey('docs', slug)]
                        const title = getEntryBySlug(slug)?.title ?? slug
                        return (
                          <li key={slug} className="flex items-center gap-2 text-xs text-ink-muted">
                            {done ? (
                              <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-500" aria-label="Read" />
                            ) : (
                              <span className={cn('w-3.5 text-center text-[10px] font-bold shrink-0', p.accent.text)}>{step + 1}</span>
                            )}
                            <span className="truncate">{interp(title)}</span>
                          </li>
                        )
                      })}
                      {total > 4 && <li className="pl-5 text-[11px] text-ink-muted">and {total - 4} more</li>}
                    </ol>
                    {cta.done > 0 && (
                      <div className="mt-4 h-1 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden" aria-hidden>
                        <div
                          className={cn('h-full rounded-full bg-gradient-to-r', p.accent.gradient)}
                          style={{ width: `${Math.round((cta.done / total) * 100)}%` }}
                        />
                      </div>
                    )}
                    <span className={cn('mt-4 inline-flex items-center gap-1 text-sm font-semibold', p.accent.text)}>
                      {cta.label}
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
                  className="group flex h-full flex-col rounded-xl border border-glass-border bg-canvas-elevated p-4 hover:border-accent-lineage/30 hover:bg-accent-lineage/[0.03] transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-accent-lineage/10 text-accent-lineage dark:text-accent-lineage">
                      <j.icon className="w-5 h-5" />
                    </div>
                  </div>
                  <h3 className="mt-3 text-sm font-bold text-ink group-hover:text-accent-lineage dark:group-hover:text-accent-lineage transition-colors">
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
        <Section id="browse-by-topic" title="Browse by topic" subtitle="The full table of contents.">
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
        <Section id="popular-questions" title="Popular questions" subtitle="Quick answers to the things people ask first.">
          <FaqAccordion />
        </Section>

        <div className="h-10" />
      </div>
    </div>
  )
}

function Section({
  id,
  title,
  subtitle,
  children,
}: {
  id?: string
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section id={id} className="mt-14 scroll-mt-6">
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
                ? 'border-accent-lineage/20 bg-gradient-to-r from-accent-lineage/5 to-violet-500/5'
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
        className="inline-flex items-center gap-1 mt-2 text-sm font-semibold text-accent-lineage dark:text-accent-lineage"
      >
        See all questions
        <ArrowRight className="w-4 h-4" />
      </Link>
    </div>
  )
}
