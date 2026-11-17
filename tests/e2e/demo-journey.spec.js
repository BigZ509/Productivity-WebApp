import { mkdirSync } from 'node:fs'
import { test, expect, signIn, dbProfile, expectNoConsoleErrors, DEMO } from './fixtures.js'

const SHOTS = 'docs/screenshots'
mkdirSync(SHOTS, { recursive: true })

function parseClock(text) {
  const [, m, s] = text.match(/(\d+):(\d{2})/)
  return Number(m) * 60 + Number(s)
}

// The spec's 10-step demo journey, run twice in a row without any reset.
const RUNS = [
  { quest: 'Ship 1 Small Feature', reward: 42, focus: true, expectRankUp: true, shots: true },
  { quest: 'Bug Zero Hour', reward: 30, focus: false, expectRankUp: false, shots: false },
]

for (const [index, run] of RUNS.entries()) {
  test(`demo journey run ${index + 1}: ${run.quest}`, async ({ page, consoleErrors }) => {
    // Step 1: entry loads without a stuck spinner.
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /turn the work you need to do/i })).toBeVisible({ timeout: 10_000 })
    if (run.shots) await page.screenshot({ path: `${SHOTS}/01-sign-in.png` })

    // Step 2: authenticate.
    await signIn(page)
    await expect(page.getByRole('heading', { name: /kai ardent/i })).toBeVisible({ timeout: 15_000 })

    // Step 3: character values match persisted data.
    const before = await dbProfile()
    expect(before.xp_total).toBe(before.ledger)
    await expect(page.locator('.char-summary')).toContainText(`${before.xp_total.toLocaleString()} total XP`)
    if (run.shots) await page.screenshot({ path: `${SHOTS}/02-command-center.png` })

    // Step 4: accept a coding quest on the board.
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Quests' }).click()
    await page.getByRole('button', { name: 'Coding', exact: true }).click()
    const card = page.locator('.quest-card', { hasText: run.quest })
    await card.getByRole('button', { name: 'Accept' }).click()
    await expect(page.getByText(`Accepted “${run.quest}”.`)).toBeVisible()
    const activeCard = page.locator('.quest-side .active-card', { hasText: run.quest })
    await expect(activeCard).toBeVisible()
    if (run.shots) await page.screenshot({ path: `${SHOTS}/03-quest-board.png` })

    // Step 5: focus on it, navigate away and back, reload; timer stays accurate.
    await activeCard.getByRole('button', { name: 'Focus' }).click()
    await expect(page).toHaveURL(/\/focus$/)
    await expect(page.getByLabel('Focus on')).toHaveValue(/.+/)
    await page.getByRole('button', { name: 'Custom' }).click()
    await page.getByLabel('Custom minutes').fill('1')
    await page.getByRole('button', { name: /begin 1-minute session/i }).click()
    await expect(page.getByText('Recording to your account')).toBeVisible()
    const startedAt = Date.now()
    if (run.shots) await page.screenshot({ path: `${SHOTS}/04-focus-running.png` })

    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Command' }).click()
    const pill = page.locator('.topbar .focus-pill, .focus-pill').first()
    await page.waitForTimeout(3000)
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Focus' }).click()
    let remaining = parseClock(await page.locator('.timer__readout').getAttribute('aria-label'))
    let expected = 60 - (Date.now() - startedAt) / 1000
    expect(Math.abs(remaining - expected)).toBeLessThanOrEqual(2)

    await page.reload()
    await expect(page.locator('.timer__readout')).toBeVisible()
    remaining = parseClock(await page.locator('.timer__readout').getAttribute('aria-label'))
    expected = 60 - (Date.now() - startedAt) / 1000
    expect(Math.abs(remaining - expected)).toBeLessThanOrEqual(2)
    void pill

    if (run.focus) {
      // Let the 1-minute session finish; the server verifies real elapsed time.
      await expect(page.getByText('Session complete')).toBeVisible({ timeout: 75_000 })
      await expect(page.getByText(/sessions under 5 minutes don’t earn xp/i)).toBeVisible()
      if (run.shots) await page.screenshot({ path: `${SHOTS}/05-focus-complete.png` })
      // Step 6: complete the linked quest from the session summary.
      await page.getByRole('button', { name: new RegExp(`complete quest \\(\\+${run.reward} xp\\)`, 'i') }).click()
    } else {
      // Reset the session and complete the quest from the board instead.
      await page.getByRole('button', { name: 'Reset' }).click()
      await page.getByRole('button', { name: 'End session' }).click()
      await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Quests' }).click()
      await page
        .locator('.quest-side .active-card', { hasText: run.quest })
        .getByRole('button', { name: 'Complete' })
        .click()
    }

    // Reward feedback.
    const reward = page.locator('.reward-card')
    await expect(reward).toBeVisible()
    await expect(reward.getByLabel(`${run.reward} XP gained`)).toBeVisible()
    if (run.expectRankUp) await expect(reward).toContainText('Rank up: D-Rank Hunter')
    if (run.shots) {
      await page.waitForTimeout(1100)
      await page.screenshot({ path: `${SHOTS}/06-reward.png` })
    }
    await reward.getByRole('button', { name: 'Continue' }).click()

    // Awarded exactly once, and the ledger agrees.
    const after = await dbProfile()
    expect(after.xp_total - before.xp_total).toBe(run.reward)
    expect(after.xp_total).toBe(after.ledger)

    // Step 7: Command Center and Character show the same persisted values.
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Command' }).click()
    await expect(page.locator('.char-summary')).toContainText(`${after.xp_total.toLocaleString()} total XP`)
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Character' }).click()
    await expect(page.locator('.char-hero')).toContainText(after.xp_total.toLocaleString())
    if (run.shots) await page.screenshot({ path: `${SHOTS}/07-character.png`, fullPage: true })

    // Step 8: guild membership and leaderboard.
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Guild' }).click()
    await expect(page.getByRole('heading', { name: 'Midnight Raiders' })).toBeVisible()
    await expect(page.locator('.board-row.is-self')).toContainText('Kai Ardent')
    if (run.shots) await page.screenshot({ path: `${SHOTS}/08-guild-hall.png` })

    // Step 9: refresh — everything persists.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Midnight Raiders' })).toBeVisible()
    await page.goto('/quests')
    await page.getByRole('tab', { name: 'History' }).click()
    await expect(page.locator('.history-row', { hasText: run.quest }).first()).toBeVisible()

    // Step 10: sign out and back in — state intact.
    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible()
    await signIn(page, DEMO)
    await expect(page.locator('.char-summary')).toContainText(`${after.xp_total.toLocaleString()} total XP`)

    expectNoConsoleErrors(consoleErrors)
  })
}
