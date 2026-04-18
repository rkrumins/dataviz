import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Github, MessageCircle, CheckCircle2 } from 'lucide-react'
import { Section } from '@/components/layout/Section'
import { Button } from '@/components/ui/Button'
import { AnimatedCounter } from '@/components/ui/AnimatedCounter'

const STATS = [
  { value: 2400, suffix: '+', label: 'GitHub Stars' },
  { value: 45, suffix: '+', label: 'Contributors' },
  { value: 890, suffix: '', label: 'Commits' },
]

export function CallToAction() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (!email.trim()) {
      setError('Please enter your email address.')
      return
    }

    // Basic email format validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid email address.')
      return
    }

    // In production, this would POST to an API.
    // For now, simulate success so the UI is complete.
    setSubmitted(true)
  }

  return (
    <Section id="community">
      <div className="relative rounded-3xl overflow-hidden">
        {/* Background */}
        <div className="absolute inset-0 bg-gradient-to-br from-accent-lineage/10 via-transparent to-accent-business/10" />
        <div className="absolute inset-0 hero-grid-bg opacity-40" />

        <div className="relative text-center py-20 px-8">
          <h2 className="text-3xl md:text-4xl font-display font-bold tracking-tight mb-4">
            Open source.{' '}
            <span className="gradient-text">Community driven.</span>
          </h2>
          <p className="text-lg text-ink-secondary max-w-xl mx-auto mb-10">
            Nexus Lineage is open source under the Apache 2.0 license. Join the community shaping
            the future of data lineage.
          </p>

          {/* Stats */}
          <div className="flex justify-center gap-12 mb-10">
            {STATS.map(({ value, suffix, label }) => (
              <div key={label}>
                <div className="text-2xl md:text-3xl font-display font-bold text-ink">
                  <AnimatedCounter value={value} suffix={suffix} />
                </div>
                <div className="text-xs text-ink-muted mt-1">{label}</div>
              </div>
            ))}
          </div>

          {/* CTAs */}
          <div className="flex flex-wrap justify-center gap-4">
            <Button href="https://github.com" icon={<Github size={16} />}>
              Star on GitHub
            </Button>
            <Button variant="secondary" href="https://discord.gg" icon={<MessageCircle size={16} />}>
              Join Discord
            </Button>
          </div>
        </div>
      </div>

      {/* Contact anchor for demo CTA */}
      <div id="contact" className="pt-20">
        <div className="glass-panel rounded-2xl p-10 text-center max-w-2xl mx-auto">
          <AnimatePresence mode="wait">
            {submitted ? (
              <motion.div
                key="success"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="py-4"
              >
                <CheckCircle2 size={40} className="text-accent-business mx-auto mb-4" />
                <h3 className="text-xl font-display font-bold mb-2">You're on the list!</h3>
                <p className="text-sm text-ink-secondary">
                  We'll reach out to <span className="font-medium text-ink">{email}</span> within 24 hours
                  to schedule your walkthrough.
                </p>
              </motion.div>
            ) : (
              <motion.div key="form" exit={{ opacity: 0, scale: 0.95 }}>
                <h3 className="text-2xl font-display font-bold mb-3">Ready to see it in action?</h3>
                <p className="text-ink-secondary mb-6">
                  Get a personalized walkthrough of Nexus Lineage for your data team.
                </p>
                <form
                  className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto"
                  onSubmit={handleSubmit}
                  noValidate
                >
                  <div className="flex-1">
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => { setEmail(e.target.value); setError('') }}
                      placeholder="Enter your work email"
                      required
                      className={`w-full px-4 py-3 rounded-xl bg-canvas border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-accent-lineage transition-colors ${
                        error
                          ? 'border-accent-warning ring-1 ring-accent-warning/30'
                          : 'border-[var(--nx-border-subtle)]'
                      }`}
                      aria-invalid={!!error}
                      aria-describedby={error ? 'email-error' : undefined}
                    />
                    {error && (
                      <p id="email-error" className="text-2xs text-accent-warning mt-1.5 text-left" role="alert">
                        {error}
                      </p>
                    )}
                  </div>
                  <Button className="whitespace-nowrap">
                    Request Demo
                  </Button>
                </form>
                <p className="text-2xs text-ink-muted mt-3">No spam. We'll reach out within 24 hours.</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </Section>
  )
}
