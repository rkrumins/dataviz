import { Github, MessageCircle, BookOpen } from 'lucide-react'
import { Section } from '@/components/layout/Section'
import { Button } from '@/components/ui/Button'
import { AnimatedCounter } from '@/components/ui/AnimatedCounter'

const STATS = [
  { value: 2400, suffix: '+', label: 'GitHub Stars' },
  { value: 45, suffix: '+', label: 'Contributors' },
  { value: 890, suffix: '', label: 'Commits' },
]

export function CallToAction() {
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
            <Button variant="secondary" href="#" icon={<MessageCircle size={16} />}>
              Join Discord
            </Button>
            <Button variant="ghost" href="#" icon={<BookOpen size={16} />}>
              Read the Docs
            </Button>
          </div>
        </div>
      </div>

      {/* Contact anchor for demo CTA */}
      <div id="contact" className="pt-20">
        <div className="glass-panel rounded-2xl p-10 text-center max-w-2xl mx-auto">
          <h3 className="text-2xl font-display font-bold mb-3">Ready to see it in action?</h3>
          <p className="text-ink-secondary mb-6">
            Get a personalized walkthrough of Nexus Lineage for your data team.
          </p>
          <form
            className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto"
            onSubmit={(e) => e.preventDefault()}
          >
            <input
              type="email"
              placeholder="Enter your work email"
              className="flex-1 px-4 py-3 rounded-xl bg-canvas border border-[var(--nx-border-subtle)] text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-accent-lineage"
            />
            <Button>
              Request Demo
            </Button>
          </form>
          <p className="text-2xs text-ink-muted mt-3">No spam. We'll reach out within 24 hours.</p>
        </div>
      </div>
    </Section>
  )
}
