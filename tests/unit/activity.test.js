import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/lib/supabaseClient', () => ({ supabase: null, hasSupabaseEnv: false, supabaseEnvError: '' }))

const { activityStreak, summarizeWeek } = await import('../../src/services/activity')
const { buildAchievements, masteryFor } = await import('../../src/features/character/milestones')
const { toAppError } = await import('../../src/lib/errors')

// Wednesday, local time
const NOW = new Date(2026, 10, 18, 15, 0, 0)
const at = (dayOffset, hour = 12) => {
  const d = new Date(NOW)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}

describe('weekly summary', () => {
  const events = [
    { sourceType: 'quest', amount: 30, createdAt: at(0) },
    { sourceType: 'focus', amount: 5, createdAt: at(-1) },
    { sourceType: 'workout', amount: 40, createdAt: at(-2) }, // Monday
    { sourceType: 'quest', amount: 99, createdAt: at(-3) }, // previous Sunday: excluded
    { sourceType: 'reconciliation', amount: 500, createdAt: at(0) }, // never counts as activity
  ]

  it('counts only this week (Monday start) and excludes reconciliation', () => {
    const w = summarizeWeek(events, NOW)
    expect(w.xp).toBe(75)
    expect(w.quests).toBe(1)
    expect(w.focusSessions).toBe(1)
    expect(w.workouts).toBe(1)
    expect(w.activeDays).toBe(3)
  })
})

describe('activity streak', () => {
  it('counts consecutive active days ending today', () => {
    const events = [0, -1, -2, -4].map((d) => ({ sourceType: 'quest', amount: 1, createdAt: at(d) }))
    expect(activityStreak(events, NOW)).toEqual({ streak: 3, activeToday: true })
  })

  it('keeps yesterday’s streak alive until today ends', () => {
    const events = [-1, -2].map((d) => ({ sourceType: 'quest', amount: 1, createdAt: at(d) }))
    expect(activityStreak(events, NOW)).toEqual({ streak: 2, activeToday: false })
  })

  it('ignores reconciliation events', () => {
    const events = [{ sourceType: 'reconciliation', amount: 100, createdAt: at(0) }]
    expect(activityStreak(events, NOW).streak).toBe(0)
  })
})

describe('milestones', () => {
  it('assigns mastery tiers by completed count', () => {
    expect(masteryFor(0).tier).toBe('Novice')
    expect(masteryFor(3).tier).toBe('Apprentice')
    expect(masteryFor(50)).toMatchObject({ tier: 'Master', next: null, ratio: 1 })
  })

  it('marks achievements earned only from recorded values', () => {
    const list = buildAchievements({ level: 5, questsCompleted: 1, focusMinutes: 0, focusSessions: 0, workouts: 0, longestStreak: 0, guildCount: 1 })
    const earned = list.filter((a) => a.earned).map((a) => a.id)
    expect(earned).toEqual(['first-quest', 'guild', 'level-5'])
  })
})

describe('error mapping', () => {
  it('uses server hint codes and messages', () => {
    const e = toAppError({ message: 'You already have 5 active quests.', hint: 'QUEST_LIMIT', code: 'P0001' })
    expect(e.code).toBe('QUEST_LIMIT')
    expect(e.message).toMatch(/5 active quests/)
  })

  it('maps network and permission failures to friendly text', () => {
    expect(toAppError(new TypeError('Failed to fetch')).code).toBe('NETWORK')
    expect(toAppError({ code: '42501', message: 'permission denied for table profiles' }).code).toBe('FORBIDDEN')
    expect(toAppError({ code: 'PGRST202', message: 'Could not find the function' }).code).toBe('SCHEMA_OUTDATED')
  })
})
