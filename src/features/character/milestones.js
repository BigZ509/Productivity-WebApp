// Achievement + mastery rules, derived purely from persisted records.
// Nothing here grants gameplay effects; these are earned recognitions.

export const MASTERY_TIERS = [
  { name: 'Novice', min: 0 },
  { name: 'Apprentice', min: 3 },
  { name: 'Adept', min: 10 },
  { name: 'Expert', min: 25 },
  { name: 'Master', min: 50 },
]

export function masteryFor(count) {
  let index = 0
  MASTERY_TIERS.forEach((t, i) => {
    if (count >= t.min) index = i
  })
  const tier = MASTERY_TIERS[index]
  const next = MASTERY_TIERS[index + 1] || null
  return {
    tier: tier.name,
    count,
    next: next?.name || null,
    nextAt: next?.min ?? null,
    ratio: next ? (count - tier.min) / (next.min - tier.min) : 1,
  }
}

export function buildAchievements({ level, questsCompleted, focusMinutes, focusSessions, workouts, longestStreak, guildCount }) {
  const list = [
    { id: 'first-quest', title: 'First Clear', desc: 'Complete your first quest.', value: questsCompleted, goal: 1 },
    { id: 'ten-quests', title: 'Steady Hands', desc: 'Complete 10 quests.', value: questsCompleted, goal: 10 },
    { id: 'fifty-quests', title: 'Gatebreaker', desc: 'Complete 50 quests.', value: questsCompleted, goal: 50 },
    { id: 'first-focus', title: 'Into the Chamber', desc: 'Finish a recorded focus session.', value: focusSessions, goal: 1 },
    { id: 'focus-5h', title: 'Deep Current', desc: 'Accumulate 5 hours of recorded focus.', value: focusMinutes, goal: 300, unit: 'min' },
    { id: 'first-workout', title: 'Tempered', desc: 'Log a completed workout.', value: workouts, goal: 1 },
    { id: 'streak-7', title: 'Unbroken Week', desc: 'Reach a 7-day workout streak.', value: longestStreak, goal: 7, unit: 'days' },
    { id: 'guild', title: 'Bannerman', desc: 'Join or found a guild.', value: guildCount, goal: 1 },
    { id: 'level-5', title: 'Awakened', desc: 'Reach level 5.', value: level, goal: 5 },
    { id: 'level-10', title: 'Ascendant', desc: 'Reach level 10.', value: level, goal: 10 },
    { id: 'level-25', title: 'Paragon', desc: 'Reach level 25.', value: level, goal: 25 },
  ]
  return list.map((a) => ({ ...a, earned: a.value >= a.goal, shown: Math.min(a.value, a.goal) }))
}
