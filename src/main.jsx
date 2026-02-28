import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import './hud.css'
import App from './App.jsx'
import { debugSupabase } from './debugSupabase'

if (import.meta.env.DEV) {
  window.debugSupabase = debugSupabase
}

// Prevent stale PWA caches from serving old hashed bundles during rapid local iterations.
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => {
      registration.unregister()
    })
  })
  if ('caches' in window) {
    caches.keys().then((keys) => {
      keys.forEach((key) => caches.delete(key))
    })
  }
}

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
)
