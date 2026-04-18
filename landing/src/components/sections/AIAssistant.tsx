import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, Send, MessageSquare, BarChart3, GitBranch, Search, ShieldCheck, Zap } from 'lucide-react'
import { Section } from '@/components/layout/Section'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'

/*
 * AI Assistant — a key selling point. Full section with interactive
 * chat mockup, capability cards, and clear value narrative.
 */

const EXCHANGES: { q: string; a: string; tags: { label: string; color: string }[] }[] = [
  {
    q: 'What feeds into the Customer 360 dashboard?',
    a: '3 upstream tables: dim_customers, fct_transactions, dim_products — flowing through 2 transformation layers via the analytics.stg_customer_events pipeline.',
    tags: [
      { label: 'dim_customers', color: '#3b82f6' },
      { label: 'fct_transactions', color: '#3b82f6' },
      { label: 'dim_products', color: '#f59e0b' },
    ],
  },
  {
    q: 'What breaks if I change the email column?',
    a: 'Impact analysis: the email column flows downstream to 4 assets — Customer 360 dashboard, churn_model_v2, marketing_segments, and compliance_report. 2 of these are Certified KPIs.',
    tags: [
      { label: '4 downstream impacts', color: '#ef4444' },
      { label: '2 certified KPIs', color: '#f59e0b' },
    ],
  },
  {
    q: 'Show me all PII columns in the Customer domain',
    a: '5 tables contain PII-tagged columns across the Customer domain: dim_customers (email, phone, address), fct_orders (shipping_address), dim_contacts (name, email), and 2 more.',
    tags: [
      { label: '5 tables', color: '#ef4444' },
      { label: '8 PII columns', color: '#ef4444' },
      { label: 'GDPR scope', color: '#8b5cf6' },
    ],
  },
]

const CAPABILITIES = [
  {
    icon: Search,
    title: 'Natural language queries',
    description: 'Ask questions about upstream dependencies, data owners, or transformation logic in plain English.',
    color: '#6366f1',
  },
  {
    icon: GitBranch,
    title: 'Impact analysis on demand',
    description: '"What breaks if I change this column?" — instant downstream traversal with certified asset flags.',
    color: '#ef4444',
  },
  {
    icon: BarChart3,
    title: 'View-aware context',
    description: 'The AI sees the same canvas you do — your current scope, filters, persona, and ontology inform every answer.',
    color: '#10b981',
  },
  {
    icon: MessageSquare,
    title: 'Graph queries under the hood',
    description: 'Your question becomes a Cypher query against the underlying graph. Results are interpreted and summarized in context.',
    color: '#8b5cf6',
  },
  {
    icon: ShieldCheck,
    title: 'Governance & compliance',
    description: 'Find PII exposure, trace data lineage for audit, and surface compliance gaps — without writing queries yourself.',
    color: '#f59e0b',
  },
  {
    icon: Zap,
    title: 'No context-switching',
    description: 'Embedded directly in the canvas. Ask, get answers, and keep exploring — all in one interface.',
    color: '#06b6d4',
  },
]

export function AIAssistant() {
  const [active, setActive] = useState(0)
  const [phase, setPhase] = useState<'question' | 'typing' | 'answer'>('question')

  useEffect(() => {
    setPhase('question')
    const t1 = setTimeout(() => setPhase('typing'), 600)
    const t2 = setTimeout(() => setPhase('answer'), 2000)
    const t3 = setTimeout(() => setActive((a) => (a + 1) % EXCHANGES.length), 7000)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [active])

  const ex = EXCHANGES[active]

  return (
    <Section id="ai-assistant" alt>
      {/* Header */}
      <div className="text-center mb-16">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full glass-panel text-xs font-medium text-accent-lineage mb-6">
          <Sparkles size={12} />
          AI-Powered Exploration
          <Badge variant="coming-soon">Coming Soon</Badge>
        </div>

        <h2 className="text-3xl md:text-4xl font-display font-bold tracking-tight mb-4">
          Ask your lineage{' '}
          <span className="gradient-text">anything.</span>
        </h2>
        <p className="text-lg text-ink-secondary max-w-2xl mx-auto">
          Stop drilling through nodes manually. An embedded AI assistant translates natural
          language into graph queries and answers in the context of what you're looking at.
        </p>
      </div>

      {/* Chat mockup + capabilities grid */}
      <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-start mb-16">
        {/* Chat mockup */}
        <motion.div
          className="glass-panel rounded-2xl overflow-hidden max-w-md mx-auto lg:mx-0 w-full"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.1 }}
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--nx-border-subtle)]">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[#6366f1] to-[#10b981] flex items-center justify-center">
              <Sparkles size={11} className="text-white" />
            </div>
            <div>
              <div className="text-xs font-semibold text-ink">Nexus AI</div>
              <div className="text-2xs text-ink-muted">Querying Customer Pipeline view</div>
            </div>
            <div className="ml-auto flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-accent-business animate-pulse" />
              <span className="text-2xs text-ink-muted">Active</span>
            </div>
          </div>

          {/* Messages */}
          <div className="p-4 min-h-[220px] flex flex-col justify-end gap-2.5">
            <AnimatePresence mode="wait">
              <motion.div key={`${active}-q`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <div className="flex justify-end">
                  <div className="bg-accent-lineage text-white rounded-2xl rounded-br-md px-3.5 py-2.5 max-w-[85%]">
                    <p className="text-xs leading-relaxed">{ex.q}</p>
                  </div>
                </div>
              </motion.div>
            </AnimatePresence>

            {phase === 'typing' && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-1.5 px-2">
                <div className="flex gap-0.5">
                  {[0, 1, 2].map((d) => (
                    <motion.div key={d} className="w-1.5 h-1.5 rounded-full bg-ink-muted"
                      animate={{ opacity: [0.3, 1, 0.3] }}
                      transition={{ duration: 0.8, repeat: Infinity, delay: d * 0.15 }} />
                  ))}
                </div>
                <span className="text-2xs text-ink-muted">Querying graph...</span>
              </motion.div>
            )}

            <AnimatePresence>
              {phase === 'answer' && (
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                  <div className="bg-canvas rounded-2xl rounded-bl-md px-3.5 py-2.5 border border-[var(--nx-border-subtle)] max-w-[90%]">
                    <p className="text-xs text-ink-secondary leading-relaxed">{ex.a}</p>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {ex.tags.map((t) => (
                        <span key={t.label} className="text-2xs font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: `${t.color}12`, color: t.color }}>
                          {t.label}
                        </span>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Input */}
          <div className="px-4 pb-3">
            <div className="flex items-center gap-2 bg-canvas rounded-xl border border-[var(--nx-border-subtle)] px-3 py-2.5">
              <span className="text-xs text-ink-muted flex-1">Ask about this view...</span>
              <div className="w-7 h-7 rounded-lg bg-accent-lineage/10 flex items-center justify-center">
                <Send size={12} className="text-accent-lineage" />
              </div>
            </div>
          </div>

          {/* Dots */}
          <div className="flex items-center justify-center gap-1.5 pb-3">
            {EXCHANGES.map((_, i) => (
              <button key={i} onClick={() => setActive(i)}
                className={`h-1.5 rounded-full transition-all duration-300 ${i === active ? 'w-5 bg-accent-lineage' : 'w-1.5 bg-ink-muted/25'}`}
                aria-label={`Show example ${i + 1}`} />
            ))}
          </div>
        </motion.div>

        {/* Capability cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {CAPABILITIES.map(({ icon: Icon, title, description, color }, i) => (
            <motion.div
              key={title}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.07 }}
            >
              <Card hover={false} className="h-full">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center mb-3" style={{ backgroundColor: `${color}12` }}>
                  <Icon size={16} style={{ color }} />
                </div>
                <h4 className="text-sm font-display font-semibold mb-1">{title}</h4>
                <p className="text-xs text-ink-secondary leading-relaxed">{description}</p>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </Section>
  )
}
