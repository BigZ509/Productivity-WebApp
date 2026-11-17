import { execFileSync } from 'node:child_process'
import { integrationEnabled } from '../integration/helpers.js'

// Rebuild the demo fixtures (local stack only) so every E2E run starts from
// the same deterministic state.
export default async function globalSetup() {
  if (!integrationEnabled) throw new Error('E2E requires the local Supabase stack and .env.test.local')
  if (!process.env.DEMO_USER_EMAIL || !process.env.DEMO_USER_PASSWORD) {
    throw new Error('Set DEMO_USER_EMAIL and DEMO_USER_PASSWORD for the E2E run (never committed).')
  }
  execFileSync('node', ['scripts/demo-seed.mjs', '--reset'], { stdio: 'inherit', env: process.env })
}
