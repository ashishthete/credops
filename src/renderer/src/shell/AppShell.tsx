import { motion } from 'framer-motion'
import { useEffect, useRef } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'
import { AuditPage } from '../pages/AuditPage'
import { PlaceholderPage } from '../pages/PlaceholderPage'
import { ProductsPage } from '../pages/products/ProductsPage'
import { VaultsPage } from '../pages/vaults/VaultsPage'
import { registerCommand } from '../ui/commands'
import { fast, useMotionSafe } from '../ui/motion'
import { useShortcut } from '../ui/shortcuts'
import { SECTIONS, sectionShortcut } from './sections'
import { SECTION_ICONS, Sidebar } from './Sidebar'

// Sections a later phase builds out; each renders a placeholder until then.
const PLACEHOLDERS = [
  { id: 'hosts', phase: 3, blurb: 'Your fleet, one click from a shell' },
  { id: 'tunnels', phase: 5, blurb: 'Port forwards that stay up' },
  { id: 'deployments', phase: 8, blurb: 'Ansible runs, streamed live' },
] as const

/** Sidebar plus routed pages. Needs a router above it (HashRouter in the app, MemoryRouter in tests). */
export function AppShell() {
  const location = useLocation()
  const motionSafe = useMotionSafe()
  useSectionNavigation()

  return (
    <div className="flex h-screen overflow-hidden bg-canvas text-fg">
      <Sidebar />
      <main className="relative min-w-0 flex-1 overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(60%_100%_at_30%_0%,color-mix(in_oklab,var(--accent)_7%,transparent),transparent)]"
        />
        {/* Enter-only transition: the next page never waits on the previous one to leave. */}
        <motion.div
          key={location.pathname}
          className="relative h-full"
          initial={motionSafe ? { opacity: 0, y: 6 } : { opacity: 0 }}
          animate={motionSafe ? { opacity: 1, y: 0 } : { opacity: 1 }}
          transition={fast}
        >
          <Routes location={location}>
            <Route path="/" element={<Navigate to={SECTIONS[0].path} replace />} />
            {PLACEHOLDERS.map((p) => {
              const section = SECTIONS.find((s) => s.id === p.id)!
              return (
                <Route
                  key={p.id}
                  path={section.path}
                  element={
                    <PlaceholderPage title={section.label} icon={SECTION_ICONS[p.id]} phase={p.phase} blurb={p.blurb} />
                  }
                />
              )
            })}
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/environments" element={<Navigate to="/products" replace />} />
            <Route path="/vaults" element={<VaultsPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="*" element={<Navigate to={SECTIONS[0].path} replace />} />
          </Routes>
        </motion.div>
      </main>
    </div>
  )
}

// mod+1…mod+6 and a "Go to …" palette command per section.
function useSectionNavigation() {
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => {
    navigateRef.current = navigate
  })

  useEffect(() => {
    const unregister = SECTIONS.map((s, i) =>
      registerCommand({
        id: `nav.${s.id}`,
        title: `Go to ${s.label}`,
        section: 'Navigate',
        keywords: [s.id],
        shortcut: sectionShortcut(i),
        run: () => navigateRef.current(s.path),
      }),
    )
    return () => unregister.forEach((fn) => fn())
  }, [])

  // SECTIONS is a fixed-length constant, so the hook order is stable.
  for (let i = 0; i < SECTIONS.length; i++) {
    useShortcut(sectionShortcut(i), () => navigate(SECTIONS[i].path))
  }
}
