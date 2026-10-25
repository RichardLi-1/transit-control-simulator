import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import posthog from 'posthog-js'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@fontsource/ibm-plex-mono/700.css'
import './styles/app.css'
import { FONT } from './constants/theme'
import App from './App'

posthog.init(import.meta.env.VITE_PUBLIC_POSTHOG_KEY as string, {
  api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST as string,
  person_profiles: 'identified_only',
  capture_pageview: false,
  capture_pageleave: false,
  capture_exceptions: true,
  loaded: (ph) => {
    if (import.meta.env.DEV) ph.opt_out_capturing()
  },
})

/**
 * The canvas measures and caches label widths, so load the faces it draws with before the first
 * frame (bundled, so this is quick); never hold the first paint for more than 1.5 s.
 */
function loadCanvasFonts(): Promise<unknown> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve()
  const faces = ['400', '500', '600', '700'].flatMap((w) => [`${w} 12px ${FONT.ui}`, `${w} 12px ${FONT.mono}`])
  return Promise.race([
    Promise.all(faces.map((f) => document.fonts.load(f))),
    new Promise((r) => setTimeout(r, 1500)),
  ]).catch(() => undefined)
}

void loadCanvasFonts().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
