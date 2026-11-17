import { test as base, expect } from '@playwright/test'
import { admin } from '../integration/helpers.js'

export const DEMO = { email: process.env.DEMO_USER_EMAIL, password: process.env.DEMO_USER_PASSWORD }

// Fails a test on any uncaught exception or console error during it.
export const test = base.extend({
  consoleErrors: [
    async ({ page }, use) => {
      const errors = []
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text())
      })
      await use(errors)
    },
    { auto: true },
  ],
})

export { expect }

export async function signIn(page, { email = DEMO.email, password = DEMO.password } = {}) {
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: /^sign in$/i }).click()
}

export async function dbProfile(email = DEMO.email) {
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const user = users.users.find((u) => u.email === email)
  const { data } = await admin.from('profiles').select('id, xp_total, display_name').eq('id', user.id).single()
  const { data: events } = await admin.from('xp_events').select('amount').eq('user_id', user.id)
  return { ...data, ledger: events.reduce((s, e) => s + e.amount, 0) }
}

export function expectNoConsoleErrors(errors, allow = []) {
  const unexpected = errors.filter((e) => !allow.some((pattern) => pattern.test(e)))
  expect(unexpected, unexpected.join('\n')).toEqual([])
}
