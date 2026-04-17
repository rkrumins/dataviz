import { Navbar } from '@/components/layout/Navbar'
import { Footer } from '@/components/layout/Footer'
import { Hero } from '@/components/sections/Hero'
import { LogoBar } from '@/components/sections/LogoBar'
import { ValueProps } from '@/components/sections/ValueProps'
import { FeatureShowcase } from '@/components/sections/FeatureShowcase'
import { Architecture } from '@/components/sections/Architecture'
import { Integrations } from '@/components/sections/Integrations'
import { CallToAction } from '@/components/sections/CallToAction'

function App() {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <Navbar />
      <main>
        <Hero />
        <LogoBar />
        <ValueProps />
        <FeatureShowcase />
        <Architecture />
        <Integrations />
        <CallToAction />
      </main>
      <Footer />
    </div>
  )
}

export default App
