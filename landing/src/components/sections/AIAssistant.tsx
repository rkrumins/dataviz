import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, Send, MessageSquare, BarChart3, GitBranch, Search } from 'lucide-react'
import { Section } from '@/components/layout/Section'
import { Badge } from '@/components/ui/Badge'

/*
 * Interactive chat mockup showing the AI assistant querying
 * the underlying graph and responding with lineage insights.
 */

interface Message {
  role: 'user' | 'ai'
  text: string
  visual?: React.ReactNode
}

const CONVERSATIONS: Message[][] = [
  [
    { role: 'user', text: 'What feeds into the Customer 360 dashboard?' },
    {
      role: 'ai',
      text: 'The Customer 360 dashboard is fed by 3 upstream tables: dim_customers (from customer_db), fct_transactions (from events_stream), and dim_products (from product_catalog). The primary lineage path flows through 2 transformation layers.',
      visual: (
        <div className="flex items-center gap-2 mt-2">
          {['dim_customers', 'fct_transactions', 'dim_products'].map((t) => (
            <span key={t} className="text-2xs font-mono px-2 py-1 rounded-md bg-[#3b82f6]/10 text-[#3b82f6]">{t}</span>
          ))}
        </div>
      ),
    },
  ],
  [
    { role: 'user', text: 'If I change the email column in dim_customers, what breaks?' },
    {
      role: 'ai',
      text: 'Impact analysis: the email column flows downstream to 4 assets — Customer 360 dashboard, churn_model_v2, marketing_segments, and compliance_report. 2 of these are marked as Certified KPIs. I recommend coordinating with the Analytics and Compliance teams before changing.',
      visual: (
        <div className="flex items-center gap-3 mt-2">
          <span className="text-2xs font-semibold px-2 py-1 rounded-md bg-[#ef4444]/10 text-[#ef4444]">4 downstream impacts</span>
          <span className="text-2xs font-semibold px-2 py-1 rounded-md bg-[#f59e0b]/10 text-[#f59e0b]">2 certified KPIs</span>
        </div>
      ),
    },
  ],
  [
    { role: 'user', text: 'Show me all tables with PII columns in the Customer domain' },
    {
      role: 'ai',
      text: 'Found 5 tables in the Customer domain containing PII-tagged columns: dim_customers (email, phone, address), fct_orders (shipping_address), dim_contacts (name, email), stg_signups (ip_address), and raw_support_tickets (customer_email).',
      visual: (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {['dim_customers ×3', 'fct_orders ×1', 'dim_contacts ×2', 'stg_signups ×1', 'raw_support_tickets ×1'].map((t) => (
            <span key={t} className="text-2xs font-mono px-2 py-1 rounded-md bg-[#ef4444]/10 text-[#ef4444]">{t}</span>
          ))}
        </div>
      ),
    },
  ],
]

const CAPABILITIES = [
  { icon: Search, label: 'Natural language search', desc: 'Ask questions about your lineage in plain English' },
  { icon: GitBranch, label: 'Impact analysis', desc: '"What breaks if I change this column?"' },
  { icon: BarChart3, label: 'View-aware context', desc: 'AI sees the same graph you see on canvas' },
  { icon: MessageSquare, label: 'Graph query execution', desc: 'Translates questions into Cypher queries behind the scenes' },
]

export function AIAssistant() {
  const [activeConvo, setActiveConvo] = useState(0)
  const [visibleMessages, setVisibleMessages] = useState(0)
  const convo = CONVERSATIONS[activeConvo]

  // Auto-play messages
  useEffect(() => {
    setVisibleMessages(0)
    const t1 = setTimeout(() => setVisibleMessages(1), 400)
    const t2 = setTimeout(() => setVisibleMessages(2), 1600)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [activeConvo])

  // Auto-cycle conversations
  useEffect(() => {
    const interval = setInterval(() => {
      setActiveConvo((c) => (c + 1) % CONVERSATIONS.length)
    }, 8000)
    return () => clearInterval(interval)
  }, [])

  return (
    <Section id="ai-assistant">
      <div className="grid lg:grid-cols-2 gap-16 items-center">
        {/* Left — narrative */}
        <div>
          <motion.div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full glass-panel text-xs font-medium text-accent-lineage mb-6"
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <Sparkles size={12} />
            AI-Powered Exploration
            <Badge variant="coming-soon">Coming Soon</Badge>
          </motion.div>

          <h2 className="text-3xl md:text-4xl font-display font-bold tracking-tight mb-4">
            Ask your data lineage{' '}
            <span className="gradient-text">anything.</span>
          </h2>

          <p className="text-base text-ink-secondary leading-relaxed mb-4">
            Stop drilling through nodes and edges manually. An embedded AI assistant lets you
            ask questions in natural language — about the view you're looking at, the graph
            behind it, or the impact of a change you're planning.
          </p>

          <p className="text-base text-ink-secondary leading-relaxed mb-8">
            Behind the scenes, it translates your questions into queries against the underlying
            graph database, interprets the results, and answers in context. Think of it as a
            colleague who has already read every edge in your lineage and can explain any
            relationship on demand.
          </p>

          {/* Capability cards */}
          <div className="grid grid-cols-2 gap-3">
            {CAPABILITIES.map(({ icon: Icon, label, desc }, i) => (
              <motion.div
                key={label}
                className="glass-panel rounded-xl p-3"
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.08 }}
              >
                <Icon size={16} className="text-accent-lineage mb-2" />
                <div className="text-xs font-semibold text-ink mb-0.5">{label}</div>
                <div className="text-2xs text-ink-muted leading-relaxed">{desc}</div>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Right — interactive chat mockup */}
        <motion.div
          className="glass-panel rounded-2xl overflow-hidden max-w-md mx-auto w-full"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.2 }}
        >
          {/* Chat header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--nx-border-subtle)]">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[#6366f1] to-[#10b981] flex items-center justify-center">
              <Sparkles size={12} className="text-white" />
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
          <div className="p-4 space-y-3 min-h-[260px]">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeConvo}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="space-y-3"
              >
                {convo.map((msg, i) => {
                  if (i >= visibleMessages) return null
                  return (
                    <motion.div
                      key={`${activeConvo}-${i}`}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3 }}
                      className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 ${
                          msg.role === 'user'
                            ? 'bg-accent-lineage text-white rounded-br-md'
                            : 'bg-canvas rounded-bl-md border border-[var(--nx-border-subtle)]'
                        }`}
                      >
                        <p className={`text-xs leading-relaxed ${msg.role === 'ai' ? 'text-ink-secondary' : ''}`}>
                          {msg.text}
                        </p>
                        {msg.visual}
                      </div>
                    </motion.div>
                  )
                })}

                {/* Typing indicator */}
                {visibleMessages === 1 && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex items-center gap-1.5 px-4 py-2"
                  >
                    <div className="flex gap-1">
                      {[0, 1, 2].map((d) => (
                        <motion.div
                          key={d}
                          className="w-1.5 h-1.5 rounded-full bg-ink-muted"
                          animate={{ opacity: [0.3, 1, 0.3] }}
                          transition={{ duration: 1, repeat: Infinity, delay: d * 0.2 }}
                        />
                      ))}
                    </div>
                    <span className="text-2xs text-ink-muted">Querying graph...</span>
                  </motion.div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Input mockup */}
          <div className="px-4 pb-4">
            <div className="flex items-center gap-2 bg-canvas rounded-xl border border-[var(--nx-border-subtle)] px-3 py-2.5">
              <span className="text-xs text-ink-muted flex-1">Ask about this view...</span>
              <div className="w-7 h-7 rounded-lg bg-accent-lineage/10 flex items-center justify-center">
                <Send size={12} className="text-accent-lineage" />
              </div>
            </div>
          </div>

          {/* Conversation selector dots */}
          <div className="flex items-center justify-center gap-2 pb-3">
            {CONVERSATIONS.map((_, i) => (
              <button
                key={i}
                onClick={() => setActiveConvo(i)}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === activeConvo ? 'w-5 bg-accent-lineage' : 'w-1.5 bg-ink-muted/30'
                }`}
                aria-label={`Show conversation ${i + 1}`}
              />
            ))}
          </div>
        </motion.div>
      </div>
    </Section>
  )
}
