import { useEffect } from 'react'

const META_COLORS = { HUNTER: '#080D18', HEAVENLY_DEMON: '#0B0A12' }

// Applies the path theme (CSS tokens keyed on [data-path]) to <html>.
export function useThemePath(path) {
  useEffect(() => {
    const key = path === 'HEAVENLY_DEMON' ? 'HEAVENLY_DEMON' : 'HUNTER'
    document.documentElement.dataset.path = key
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META_COLORS[key])
  }, [path])
}
