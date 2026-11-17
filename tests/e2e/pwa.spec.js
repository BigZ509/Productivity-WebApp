import { test, expect, signIn } from './fixtures.js'

// Runs against `vite preview` of a production build (project "pwa").
test('service worker precaches the shell but never serves API responses', async ({ page }) => {
  await page.goto('/')
  const swUrl = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready
    return reg.active?.scriptURL || ''
  })
  expect(swUrl).toMatch(/\/sw\.js$/)

  const apiFromSw = []
  page.on('response', (res) => {
    if (/\/(rest|auth)\/v1\//.test(res.url()) && res.fromServiceWorker()) apiFromSw.push(res.url())
  })

  await page.reload() // now controlled by the service worker
  await signIn(page)
  await expect(page.locator('.dashboard')).toBeVisible({ timeout: 15_000 })
  await page.goto('/guild')
  await expect(page.getByRole('heading', { name: 'Midnight Raiders' })).toBeVisible()
  expect(apiFromSw).toEqual([])

  // Deep link refresh works offline-first via navigateFallback.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Midnight Raiders' })).toBeVisible()

  const cacheNames = await page.evaluate(() => caches.keys())
  for (const name of cacheNames) {
    const urls = await page.evaluate(async (n) => (await (await caches.open(n)).keys()).map((r) => r.url), name)
    expect(urls.filter((u) => /\/(rest|auth)\/v1\//.test(u))).toEqual([])
  }
})
