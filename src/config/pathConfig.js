export const PATH_KEYS = ['HUNTER', 'HEAVENLY_DEMON']

// Both paths share one architecture; only identity, vocabulary and theme differ.
export const PATH_CONFIG = {
  HUNTER: {
    key: 'HUNTER',
    title: 'Hunter',
    tagline: 'Clear gates. Climb ranks. Raid with your guild.',
    description:
      'Treat each piece of work as a gate to clear. Fast, precise, built for momentum and team competition.',
    questNoun: 'Quest',
    questNounPlural: 'Quests',
    boardTitle: 'Quest Board',
    boardLede: 'Pick the work that moves you forward. Accept it, do it, claim it.',
    focusTitle: 'Focus Chamber',
    focusLede: 'One quest. One timer. Nothing else.',
    gymTitle: 'Training Grounds',
    gymLede: 'Log real sessions. Consistency builds the streak.',
    guildTitle: 'Guild Hall',
    characterTitle: 'Hunter Profile',
    welcome: 'Ready for the next gate',
  },
  HEAVENLY_DEMON: {
    key: 'HEAVENLY_DEMON',
    title: 'Heavenly Demon',
    tagline: 'Cultivate discipline. Refine mastery. Ascend.',
    description:
      'Treat each piece of work as a trial of discipline. Deliberate, relentless, built for mastery over time.',
    questNoun: 'Trial',
    questNounPlural: 'Trials',
    boardTitle: 'Trial Scrolls',
    boardLede: 'Take only what you will finish. Precision outlasts ambition.',
    focusTitle: 'Meditation Chamber',
    focusLede: 'Still the mind. Hold one intention until the bell.',
    gymTitle: 'Body Tempering Hall',
    gymLede: 'Temper the vessel. Every logged session refines it.',
    guildTitle: 'Sect Hall',
    characterTitle: 'Cultivation Record',
    welcome: 'Your cultivation continues',
  },
}

export function getPathConfig(pathKey) {
  return PATH_CONFIG[pathKey] || PATH_CONFIG.HUNTER
}

export const CATEGORY_META = {
  coding: { label: 'Coding', short: 'Code' },
  study: { label: 'Study', short: 'Study' },
  business: { label: 'Business', short: 'Business' },
  gym: { label: 'Fitness', short: 'Fitness' },
  general: { label: 'General', short: 'General' },
}

export const DIFFICULTY_META = {
  easy: { label: 'Easy', pips: 1 },
  medium: { label: 'Medium', pips: 2 },
  hard: { label: 'Hard', pips: 3 },
}
