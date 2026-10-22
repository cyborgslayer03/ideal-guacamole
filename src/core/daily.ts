// Daily Challenge: one seeded mission per calendar day, the same for every
// player: a generated universe, a hero and squad, rule modifiers, and a boss.
// Scores are kept per day with a streak.

import { generateUniverse } from './generator';
import type { MissionPlan } from './missions';
import { Rng } from './rng';
import type { Universe, UniverseRules } from './types';

export interface DailyModifier {
  id: string;
  label: string;
  detail: string;
  rules: Partial<UniverseRules>;
}

export const DAILY_MODIFIERS: readonly DailyModifier[] = [
  { id: 'lowgrav', label: 'Low Gravity', detail: 'Everyone jumps and falls in slow motion.', rules: { gravity: 0.4 } },
  { id: 'swarm', label: 'Swarm', detail: 'Nearly twice as many enemies.', rules: { enemyDensity: 1.8 } },
  { id: 'overcharged', label: 'Overcharged', detail: 'Every power hits twice as hard, on both sides.', rules: { powerScale: 2 } },
  { id: 'heavy', label: 'Heavy World', detail: 'Crushing gravity: short jumps, hard landings.', rules: { gravity: 1.8 } },
  { id: 'skeleton', label: 'Skeleton Crew', detail: 'Fewer enemies, but powers are weaker.', rules: { enemyDensity: 0.6, powerScale: 0.7 } },
];

export interface DailyChallenge {
  date: string;
  seed: number;
  universe: Universe;
  heroId: string;
  modifiers: DailyModifier[];
  plan: MissionPlan;
}

/** Local calendar date as YYYY-MM-DD. */
export function todayKey(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function dateSeed(date: string): number {
  let h = 2166136261;
  for (let i = 0; i < date.length; i++) h = Math.imul(h ^ date.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Today's challenge. Deterministic: the same date always gives the same challenge. */
export function dailyChallenge(date: string): DailyChallenge {
  const seed = dateSeed(`daily:${date}`);
  const rng = new Rng(seed);
  const universe = generateUniverse(seed);
  universe.name = `Daily Challenge · ${date}`;
  const heroes = universe.characters.filter((c) => c.role !== 'villain');
  const villains = universe.characters.filter((c) => c.role === 'villain');
  const hero = heroes[0] ?? universe.characters[0];
  const allies = heroes.filter((c) => c !== hero).slice(0, rng.int(0, 2));
  const boss = villains[0] ?? universe.characters[universe.characters.length - 1];
  const level = rng.int(8, 20);
  for (const c of universe.characters) c.level = level;
  const modifiers = rng.shuffle([...DAILY_MODIFIERS]).slice(0, rng.int(1, 2));
  for (const m of modifiers) Object.assign(universe.rules, m.rules);
  const location = rng.pick(universe.locations);
  location.rules = {};
  const plan: MissionPlan = {
    title: 'Daily Challenge',
    subtitle: modifiers.map((m) => m.label).join(' · '),
    locationId: location.id,
    factionId: boss.factionId,
    level,
    intro: [{ speaker: 'Command', text: `Today's threat: ${boss.alias}. Rules in effect: ${modifiers.map((m) => m.label).join(', ')}. Fast, clean runs score highest.` }],
    phases: [
      { kind: 'defeat', count: 12, label: 'Clear the area' },
      { kind: 'bosses', bossIds: [boss.id], minions: true, label: `Defeat ${boss.alias}` },
    ],
    outro: [{ speaker: 'Command', text: 'Challenge complete. Come back tomorrow for a new one.' }],
    choice: null,
    rewardItemId: null,
    xp: 0,
    allyIds: allies.map((a) => a.id),
    teamName: allies.length ? 'Daily squad' : null,
    ambushId: null,
    ambushLine: '',
    decideBosses: false,
    bossPower: { [boss.id]: 1 },
    ambient: null,
  };
  return { date, seed, universe, heroId: hero.id, modifiers, plan };
}

export interface DailyRecord {
  score: number;
  grade: string;
}

/** Days in a row (ending today or yesterday) with a completed challenge. */
export function dailyStreak(records: Record<string, DailyRecord>, today: string): number {
  let streak = 0;
  const d = new Date(`${today}T12:00:00`);
  if (!records[today]) d.setDate(d.getDate() - 1);
  while (records[todayKey(d)]) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}
