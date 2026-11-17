// Single source of truth for level/rank rules. Everything derives from the
// persisted, server-authoritative profiles.xp_total value.

export const XP_PER_LEVEL = 100

export const RANK_TIERS = [
  { rank: 'E', min: 0, hunter: 'E-Rank Hunter', demon: 'Mortal Disciple' },
  { rank: 'D', min: 500, hunter: 'D-Rank Hunter', demon: 'Qi Refiner' },
  { rank: 'C', min: 1500, hunter: 'C-Rank Hunter', demon: 'Foundation Builder' },
  { rank: 'B', min: 5000, hunter: 'B-Rank Hunter', demon: 'Core Former' },
  { rank: 'A', min: 15000, hunter: 'A-Rank Hunter', demon: 'Nascent Soul' },
  { rank: 'S', min: 50000, hunter: 'S-Rank Hunter', demon: 'Heavenly Demon' },
]

export function toXp(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function levelFromXp(totalXp) {
  return Math.floor(toXp(totalXp) / XP_PER_LEVEL) + 1
}

export function levelProgress(totalXp) {
  const xp = toXp(totalXp)
  const level = levelFromXp(xp)
  const levelStart = (level - 1) * XP_PER_LEVEL
  const into = xp - levelStart
  return {
    level,
    into,
    needed: XP_PER_LEVEL,
    remaining: XP_PER_LEVEL - into,
    nextLevelAt: levelStart + XP_PER_LEVEL,
    ratio: into / XP_PER_LEVEL,
  }
}

export function rankIndexFromXp(totalXp) {
  const xp = toXp(totalXp)
  let index = 0
  RANK_TIERS.forEach((tier, i) => {
    if (xp >= tier.min) index = i
  })
  return index
}

export function rankFromXp(totalXp, path = 'HUNTER') {
  const xp = toXp(totalXp)
  const index = rankIndexFromXp(xp)
  const tier = RANK_TIERS[index]
  const next = RANK_TIERS[index + 1] || null
  const span = next ? next.min - tier.min : 1
  return {
    index,
    rank: tier.rank,
    title: path === 'HEAVENLY_DEMON' ? tier.demon : tier.hunter,
    min: tier.min,
    next: next
      ? { rank: next.rank, min: next.min, title: path === 'HEAVENLY_DEMON' ? next.demon : next.hunter }
      : null,
    ratio: next ? Math.min(1, (xp - tier.min) / span) : 1,
    remaining: next ? next.min - xp : 0,
  }
}

export function progressionSnapshot(totalXp, path) {
  const xp = toXp(totalXp)
  return { xp, ...levelProgress(xp), rankInfo: rankFromXp(xp, path) }
}

// Compare two balances and describe what changed (for reward feedback).
export function describeGain(beforeXp, afterXp, path) {
  const before = progressionSnapshot(beforeXp, path)
  const after = progressionSnapshot(afterXp, path)
  return {
    gained: after.xp - before.xp,
    leveledUp: after.level > before.level,
    newLevel: after.level,
    rankedUp: after.rankInfo.index > before.rankInfo.index,
    newRank: after.rankInfo,
  }
}
