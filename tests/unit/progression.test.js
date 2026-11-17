import { describe, expect, it } from 'vitest'
import { describeGain, levelFromXp, levelProgress, rankFromXp, toXp } from '../../src/lib/progression'

describe('progression', () => {
  it('derives level from XP (100 XP per level, starting at 1)', () => {
    expect(levelFromXp(0)).toBe(1)
    expect(levelFromXp(99)).toBe(1)
    expect(levelFromXp(100)).toBe(2)
    expect(levelFromXp(1234)).toBe(13)
  })

  it('treats invalid or negative XP as zero', () => {
    expect(toXp(undefined)).toBe(0)
    expect(toXp(-50)).toBe(0)
    expect(toXp('abc')).toBe(0)
    expect(levelFromXp(null)).toBe(1)
  })

  it('reports progress inside the current level', () => {
    expect(levelProgress(250)).toMatchObject({ level: 3, into: 50, remaining: 50, nextLevelAt: 300 })
  })

  it('maps rank thresholds consistently at the boundaries', () => {
    expect(rankFromXp(0).rank).toBe('E')
    expect(rankFromXp(499).rank).toBe('E')
    expect(rankFromXp(500).rank).toBe('D')
    expect(rankFromXp(1500).rank).toBe('C')
    expect(rankFromXp(5000).rank).toBe('B')
    expect(rankFromXp(15000).rank).toBe('A')
    expect(rankFromXp(50000).rank).toBe('S')
    expect(rankFromXp(50000).next).toBeNull()
  })

  it('uses path-specific rank titles over the same thresholds', () => {
    expect(rankFromXp(600, 'HUNTER').title).toBe('D-Rank Hunter')
    expect(rankFromXp(600, 'HEAVENLY_DEMON').title).toBe('Qi Refiner')
  })

  it('describes level-ups and rank-ups for reward feedback', () => {
    expect(describeGain(90, 130)).toMatchObject({ gained: 40, leveledUp: true, newLevel: 2, rankedUp: false })
    expect(describeGain(480, 520)).toMatchObject({ rankedUp: true })
    expect(describeGain(10, 20)).toMatchObject({ leveledUp: false, rankedUp: false })
  })
})
