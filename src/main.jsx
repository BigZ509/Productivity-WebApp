import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import './hud.css'
import App from './App.jsx'
import { debugSupabase } from './debugSupabase'

if (import.meta.env.DEV) {
  window.debugSupabase = debugSupabase
}

if (import.meta.env.DEV && typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  // Prevent stale PWA caches from serving old hashed bundles during rapid local iterations.
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => registration.unregister())
  })
  if ('caches' in window) {
    caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)))
  }
}

if (import.meta.env.PROD) {
  registerSW({ immediate: true })
}

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
)
