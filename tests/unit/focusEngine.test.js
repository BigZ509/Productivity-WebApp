import { describe, expect, it } from 'vitest'
import * as engine from '../../src/features/focus/focusEngine'

const T0 = 1_700_000_000_000
const MIN = 60_000

describe('focus engine', () => {
  it('starts running with the planned duration', () => {
    const s = engine.start(engine.IDLE_STATE, { plannedSeconds: 1500, now: T0 })
    expect(s.status).toBe('running')
    expect(engine.remainingMs(s, T0)).toBe(1500 * 1000)
    expect(engine.remainingMs(s, T0 + 10 * MIN)).toBe(15 * MIN)
  })

  it('pauses and resumes without counting paused time', () => {
    let s = engine.start(engine.IDLE_STATE, { plannedSeconds: 1500, now: T0 })
    s = engine.pause(s, T0 + 5 * MIN)
    expect(s.status).toBe('paused')
    // 30 minutes pass while paused: nothing changes
    expect(engine.remainingMs(s, T0 + 35 * MIN)).toBe(20 * MIN)
    s = engine.resume(s, T0 + 35 * MIN)
    expect(engine.remainingMs(s, T0 + 40 * MIN)).toBe(15 * MIN)
  })

  it('computes time from timestamps, so throttled ticks cannot drift it', () => {
    const s = engine.start(engine.IDLE_STATE, { plannedSeconds: 600, now: T0 })
    // Simulate a background tab that only "ticks" once after 7 minutes.
    expect(engine.remainingMs(s, T0 + 7 * MIN)).toBe(3 * MIN)
  })

  it('becomes due exactly at the planned duration', () => {
    const s = engine.start(engine.IDLE_STATE, { plannedSeconds: 60, now: T0 })
    expect(engine.isDue(s, T0 + 59_999)).toBe(false)
    expect(engine.isDue(s, T0 + 60_000)).toBe(true)
  })

  it('never reports negative elapsed time if the clock jumps backwards', () => {
    const s = engine.start(engine.IDLE_STATE, { plannedSeconds: 600, now: T0 })
    expect(engine.elapsedMs(s, T0 - 5 * MIN)).toBe(0)
  })

  it('resets to idle', () => {
    const s = engine.start(engine.IDLE_STATE, { plannedSeconds: 600, now: T0 })
    expect(engine.reset(s).status).toBe('idle')
  })

  it('survives a reload via serialize/deserialize (running and paused)', () => {
    let s = engine.start(engine.IDLE_STATE, { plannedSeconds: 1500, now: T0, quest: { activeQuestId: 'q1', title: 'Ship' } })
    s = engine.attachServerSession(s, { sessionId: 'srv-1', startedAt: 'x' })
    const restored = engine.deserialize(engine.serialize(s))
    expect(restored.status).toBe('running')
    expect(restored.sessionId).toBe('srv-1')
    expect(restored.quest.title).toBe('Ship')
    expect(engine.remainingMs(restored, T0 + 10 * MIN)).toBe(15 * MIN)

    const paused = engine.pause(s, T0 + 4 * MIN)
    const restoredPaused = engine.deserialize(engine.serialize(paused))
    expect(engine.remainingMs(restoredPaused, T0 + 999 * MIN)).toBe(21 * MIN)
  })

  it('resumes a reload during completion as running-and-due so completion retries', () => {
    const s = engine.markFinishing(engine.start(engine.IDLE_STATE, { plannedSeconds: 60, now: T0 }))
    const restored = engine.deserialize(engine.serialize(s))
    expect(restored.status).toBe('running')
    expect(engine.isDue(restored, Date.now())).toBe(true)
  })

  it('rejects corrupt or out-of-range stored state', () => {
    expect(engine.deserialize('not json').status).toBe('idle')
    expect(engine.deserialize(JSON.stringify({ v: 1, status: 'running', plannedSeconds: 5 })).status).toBe('idle')
    expect(engine.deserialize(JSON.stringify({ v: 99, status: 'running', plannedSeconds: 600 })).status).toBe('idle')
  })

  it('clamps custom minutes into the supported range', () => {
    expect(engine.clampMinutes(0)).toBe(1)
    expect(engine.clampMinutes(999)).toBe(240)
    expect(engine.clampMinutes('abc')).toBe(25)
  })
})
