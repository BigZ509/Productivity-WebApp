import { randomBytes, randomUUID } from 'node:crypto'
import { test, expect, signIn, expectNoConsoleErrors } from './fixtures.js'
import { admin } from '../integration/helpers.js'

const SHOTS = 'docs/screenshots'
const ROUTES = ['dashboard', 'quests', 'focus', 'character', 'guild', 'gym', 'lab']
const WIDTHS = [
  [1440, 900],
  [1280, 800],
  [768, 1024],
  [390, 844],
  [320, 640],
]

test('responsive: no horizontal overflow on any main screen at 5 widths', async ({ page, consoleErrors }) => {
  await signIn(page)
  await expect(page.locator('.dashboard')).toBeVisible({ timeout: 15_000 })
  for (const [width, height] of WIDTHS) {
    await page.setViewportSize({ width, height })
    for (const route of ROUTES) {
      await page.goto(`/${route}`)
      await expect(page.locator('#main h1').first()).toBeVisible()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow, `/${route} at ${width}px`).toBeLessThanOrEqual(0)
    }
    if (width === 390) {
      await page.goto('/dashboard')
      await page.waitForTimeout(800)
      await page.screenshot({ path: `${SHOTS}/mobile-390-command-center.png`, fullPage: true })
      await page.goto('/quests')
      await page.waitForTimeout(800)
      await page.screenshot({ path: `${SHOTS}/mobile-390-quest-board.png` })
    }
    if (width === 768) {
      await page.goto('/dashboard')
      await page.waitForTimeout(800)
      await page.screenshot({ path: `${SHOTS}/tablet-768-command-center.png` })
    }
  }
  // Mobile navigation: bottom bar + "More" sheet reach every area.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/dashboard')
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('dialog', { name: 'More' }).getByRole('link', { name: 'Training' }).click()
  await expect(page).toHaveURL(/\/gym$/)
  expectNoConsoleErrors(consoleErrors)
})

test('nested routes survive a hard refresh and deep links', async ({ page, consoleErrors }) => {
  await signIn(page)
  await expect(page.locator('.dashboard')).toBeVisible({ timeout: 15_000 })
  for (const route of ['/guild', '/character', '/quests', '/leaderboard', '/skills']) {
    await page.goto(route)
    await page.reload()
    await expect(page.locator('#main h1').first()).toBeVisible()
  }
  await expect(page).toHaveURL(/\/character$/) // /skills redirects to the milestone screen
  await page.goto('/no-such-place')
  await expect(page.getByText('This area isn’t on the map')).toBeVisible()
  expectNoConsoleErrors(consoleErrors)
})

test('keyboard: skip link first on page load, then keyboard-only navigation', async ({ page }) => {
  await signIn(page)
  await expect(page.locator('.dashboard')).toBeVisible({ timeout: 15_000 })
  await page.reload() // fresh load with a restored session
  await expect(page.locator('.dashboard')).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#main')).toBeFocused()
  // Navigate with the keyboard only.
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Guild' }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/guild$/)
})

test('reduced motion disables animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await signIn(page)
  await expect(page.locator('.dashboard')).toBeVisible({ timeout: 15_000 })
  const duration = await page.locator('.route-transition').evaluate((el) => getComputedStyle(el).animationDuration)
  expect(parseFloat(duration)).toBeLessThan(0.01)
})

test('loading and API error states are explicit', async ({ page }) => {
  await signIn(page)
  await expect(page.locator('.dashboard')).toBeVisible({ timeout: 15_000 })

  // Slow profile load shows a bounded splash, then the app.
  await page.route('**/rest/v1/rpc/ensure_profile', async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    await route.continue()
  })
  await page.reload()
  await expect(page.getByText('Loading your character…')).toBeVisible()
  await expect(page.locator('.dashboard')).toBeVisible({ timeout: 15_000 })
  await page.unroute('**/rest/v1/rpc/ensure_profile')

  // A failing API call surfaces an error with a working retry.
  let fail = true
  await page.route('**/rest/v1/rpc/guild_list_public', (route) =>
    fail ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"Simulated outage"}' }) : route.continue(),
  )
  await page.goto('/guild')
  await expect(page.getByText('Simulated outage')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/state-api-error.png` })
  fail = false
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.locator('.directory')).toBeVisible()
})

test('auth edge cases: bad password, session restore, callback errors, expired session', async ({ page, consoleErrors }) => {
  await signIn(page, { email: process.env.DEMO_USER_EMAIL, password: 'definitely-not-it' })
  await expect(page.getByText(/invalid login credentials/i)).toBeVisible()

  await signIn(page)
  await expect(page.locator('.dashboard')).toBeVisible({ timeout: 15_000 })
  await page.reload()
  await expect(page.locator('.dashboard')).toBeVisible({ timeout: 10_000 }) // returning session, no login

  await page.goto('/auth/callback?error=access_denied&error_description=Email+link+is+invalid+or+has+expired')
  await expect(page).toHaveURL(/\/dashboard$/) // already signed in: callback forwards
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible()
  await page.goto('/auth/callback?error=access_denied&error_description=Email+link+is+invalid+or+has+expired')
  await expect(page.getByText('Email link is invalid or has expired')).toBeVisible()
  await page.getByRole('link', { name: 'Go to sign in' }).click()
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible()

  // Expired/revoked session: the server rejects the refresh token, the app
  // returns to sign-in instead of hanging.
  await signIn(page)
  await expect(page.locator('.dashboard')).toBeVisible({ timeout: 15_000 })
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.endsWith('-auth-token'))
    const session = JSON.parse(localStorage.getItem(key))
    session.expires_at = Math.floor(Date.now() / 1000) - 60
    session.refresh_token = 'revoked-token'
    localStorage.setItem(key, JSON.stringify(session))
  })
  await page.reload()
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible({ timeout: 15_000 })
  // The refresh endpoint legitimately returns 400 for the revoked token.
  expectNoConsoleErrors(consoleErrors, [/status of 400/, /Invalid Refresh Token/i, /AuthApiError/])
})

test('new Heavenly Demon account: onboarding, empty states, and the Demon theme', async ({ page, consoleErrors }) => {
  const email = `e2e-${randomUUID().slice(0, 8)}@zbxp.test`
  const password = randomBytes(18).toString('base64url')
  const { data } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  try {
    await signIn(page, { email, password })
    await expect(page.getByRole('heading', { name: 'Choose your path' })).toBeVisible({ timeout: 15_000 })
    await page.getByText('Heavenly Demon', { exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-path', 'HEAVENLY_DEMON')
    await page.screenshot({ path: `${SHOTS}/09-onboarding-demon.png` })
    await page.getByLabel('Display name').fill('Crimson Lotus')
    await page.getByRole('button', { name: /begin as heavenly demon/i }).click()

    await expect(page.getByRole('heading', { name: /crimson lotus/i })).toBeVisible()
    await expect(page.getByText('Choose your first trial')).toBeVisible()
    await expect(page.getByText('No active trials')).toBeVisible()
    await expect(page.getByText('No rewards yet')).toBeVisible()
    await expect(page.getByText('Not in a guild')).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/10-demon-command-center-empty.png` })

    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Trials' }).click()
    await expect(page.getByRole('heading', { name: 'Trial Scrolls' })).toBeVisible()
    await page.getByRole('button', { name: 'Accept' }).first().click()
    await expect(page.locator('.quest-side .active-card')).toHaveCount(1)
    await page.screenshot({ path: `${SHOTS}/11-demon-trial-scrolls.png` })
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Focus' }).click()
    await expect(page.getByRole('heading', { name: 'Meditation Chamber' })).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/12-demon-focus.png` })
    await page.goto('/character')
    await expect(page.getByText('Mortal Disciple').first()).toBeVisible()
    expectNoConsoleErrors(consoleErrors)
  } finally {
    await admin.auth.admin.deleteUser(data.user.id)
  }
})
