// Game balance: how stats, levels, items, and powers turn into numbers.
// Kept free of rendering code so it can be unit-tested and reused server-side.

import { STAT_KEYS, isMovement, type Character, type Element, type Item, type Power, type PowerKind, type Rarity, type Stats, type UniverseRules } from './types';

export const STAT_MIN = 1;
export const STAT_MAX = 10;
/** Items can push an effective stat past the base cap up to this value. */
export const EFFECTIVE_STAT_MAX = 15;
export const MAX_LEVEL = 60;
/** Number of power slots usable in combat (movement powers take none). */
export const SKILL_SLOTS = 4;

export const ELEMENT_COLORS: Record<Element, string> = {
  kinetic: '#e8e8f0',
  energy: '#3ee8ff',
  fire: '#ff6a1f',
  ice: '#8fd8ff',
  lightning: '#ffe93e',
  cosmic: '#b06bff',
  shadow: '#7a3dff',
  psychic: '#ff4fd8',
  nature: '#4fff7a',
  tech: '#3e8bff',
};

export const RARITY_COLORS: Record<Rarity, string> = {
  common: '#a0a8b8',
  rare: '#3e9bff',
  epic: '#b05cff',
  legendary: '#ffb22e',
  mythic: '#ff3e5c',
};

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function effectiveStats(character: Character, items: readonly Item[]): Stats {
  const out = { ...character.stats };
  for (const id of character.itemIds) {
    const item = items.find((i) => i.id === id);
    if (!item) continue;
    for (const key of STAT_KEYS) out[key] += item.bonuses[key] ?? 0;
  }
  for (const key of STAT_KEYS) out[key] = clamp(out[key], STAT_MIN, EFFECTIVE_STAT_MAX);
  return out;
}

export function maxHealth(stats: Stats, level: number): number {
  return Math.round(200 + stats.durability * 60 + (level - 1) * 40);
}

export function maxEnergy(stats: Stats): number {
  return Math.round(60 + stats.energy * 14);
}

export function energyRegen(stats: Stats): number {
  return 6 + stats.energy * 1.2;
}

export function moveSpeed(stats: Stats): number {
  return 7 + stats.speed * 0.8;
}

export function basicDamage(stats: Stats, level: number): number {
  return Math.round(12 + stats.strength * 3 + stats.combat * 2 + level * 2);
}

export function critChance(stats: Stats): number {
  return clamp(0.05 + stats.combat * 0.02 + stats.intelligence * 0.01, 0, 0.6);
}

const KIND_DAMAGE: Record<PowerKind, number> = {
  blast: 1,
  beam: 0.45, // per tick
  nova: 1.4,
  dash: 1.2,
  shield: 0,
  heal: 0,
  flight: 0,
  teleport: 0.6, // arrival shockwave
  superspeed: 0,
  leap: 1.1, // landing slam
};

export function powerDamage(power: Power, stats: Stats, level: number, powerScale = 1): number {
  const base = power.potency * 8 + stats.energy * 3 + level * 3;
  return Math.round(base * KIND_DAMAGE[power.kind] * powerScale);
}

const KIND_COOLDOWN: Record<PowerKind, number> = {
  blast: 3,
  beam: 8,
  nova: 10,
  dash: 6,
  shield: 16,
  heal: 20,
  flight: 0,
  teleport: 3.5,
  superspeed: 0,
  leap: 5,
};

/** Seconds. Smarter characters recover faster. */
export function powerCooldown(power: Power, stats: Stats): number {
  const base = KIND_COOLDOWN[power.kind] * (1 + power.potency * 0.04);
  return Math.round(base * (1 - stats.intelligence * 0.025) * 10) / 10;
}

export function powerCost(power: Power): number {
  if (isMovement(power.kind)) return 0;
  return Math.round(10 + power.potency * 3);
}

/** Run-speed multiplier from a Super Speed power (1 without one). */
export function speedMultiplier(powers: readonly Power[]): number {
  const p = powers.find((x) => x.kind === 'superspeed');
  return p ? 1.25 + p.potency * 0.05 : 1;
}

/** How far a teleport carries, in meters. */
export function teleportRange(power: Power): number {
  return 9 + power.potency * 0.8;
}

/** Radius of a Super Leap's landing slam, in meters. */
export function leapSlamRadius(power: Power): number {
  return 4 + power.potency * 0.3;
}

// --- Threat tiers ----------------------------------------------------------------

export interface ThreatTier {
  id: 'street' | 'city' | 'nation' | 'global' | 'cosmic';
  label: string;
  /** Added to enemy levels. */
  levelBonus: number;
  health: number;
  damage: number;
  xp: number;
  /** Chance a minion spawns as a tougher Elite. */
  eliteChance: number;
}

export const THREAT_TIERS: readonly ThreatTier[] = [
  { id: 'street', label: 'Street', levelBonus: -2, health: 0.7, damage: 0.7, xp: 0.6, eliteChance: 0 },
  { id: 'city', label: 'City', levelBonus: 0, health: 1, damage: 1, xp: 1, eliteChance: 0.05 },
  { id: 'nation', label: 'Nation', levelBonus: 4, health: 1.4, damage: 1.25, xp: 1.5, eliteChance: 0.12 },
  { id: 'global', label: 'Global', levelBonus: 10, health: 2, damage: 1.6, xp: 2.2, eliteChance: 0.2 },
  { id: 'cosmic', label: 'Cosmic', levelBonus: 20, health: 3, damage: 2.2, xp: 3.5, eliteChance: 0.3 },
];

export function tierById(id: string): ThreatTier {
  return THREAT_TIERS.find((t) => t.id === id) ?? THREAT_TIERS[1];
}

// --- Layered rules ------------------------------------------------------------------

export type RuleKey = keyof UniverseRules;
export const RULE_KEYS: readonly RuleKey[] = ['powerScale', 'gravity', 'enemyDensity'];

export interface RuleLayer {
  /** Shown to the player as where a value came from, e.g. "Universe". */
  label: string;
  rules: Partial<UniverseRules>;
}

/**
 * Stacks rule layers (e.g. universe, then location, then sandbox session).
 * Later layers override earlier ones; `source` names the layer each value came from.
 */
export function resolveRules(base: UniverseRules, layers: readonly RuleLayer[]): { rules: UniverseRules; source: Record<RuleKey, string> } {
  const rules = { ...base };
  const source = { powerScale: 'Universe', gravity: 'Universe', enemyDensity: 'Universe' } as Record<RuleKey, string>;
  for (const layer of layers) {
    for (const key of RULE_KEYS) {
      const v = layer.rules[key];
      if (typeof v === 'number') {
        rules[key] = v;
        source[key] = layer.label;
      }
    }
  }
  return { rules, source };
}

export function xpForLevel(level: number): number {
  return Math.round(100 * Math.pow(level, 1.5));
}

/** Adds XP and applies level-ups. Returns how many levels were gained. */
export function grantXp(character: Character, amount: number): number {
  let gained = 0;
  character.xp += Math.max(0, Math.round(amount));
  while (character.level < MAX_LEVEL && character.xp >= xpForLevel(character.level)) {
    character.xp -= xpForLevel(character.level);
    character.level++;
    gained++;
  }
  if (character.level >= MAX_LEVEL) character.xp = 0;
  return gained;
}

export function xpReward(enemyLevel: number, isBoss: boolean): number {
  return Math.round((20 + enemyLevel * 8) * (isBoss ? 10 : 1));
}

const RARITY_WEIGHT: Record<Rarity, number> = { common: 1, rare: 1.5, epic: 2.2, legendary: 3.2, mythic: 4.5 };

/**
 * A single headline number, like the CP rating in mobile action RPGs, that
 * summarizes how strong a character is.
 */
export function combatPower(character: Character, items: readonly Item[]): number {
  const stats = effectiveStats(character, items);
  const statSum = STAT_KEYS.reduce((sum, k) => sum + stats[k], 0);
  const powerSum = character.powers.reduce((sum, p) => sum + p.potency * (isMovement(p.kind) ? 0.5 : 1), 0);
  const gear = character.itemIds.reduce((sum, id) => {
    const item = items.find((i) => i.id === id);
    return item ? sum + RARITY_WEIGHT[item.rarity] : sum;
  }, 0);
  return Math.round((statSum * 120 + powerSum * 90 + gear * 150) * (1 + (character.level - 1) * 0.08));
}

/** Stats for a generic enemy minion of a given level and archetype. */
export function minionStats(level: number, archetype: 'grunt' | 'gunner' | 'brute'): Stats {
  const base = clamp(1 + Math.floor(level / 6), 1, 10);
  const s: Stats = {
    strength: base,
    speed: base,
    durability: base,
    energy: base,
    intelligence: base,
    combat: base,
  };
  if (archetype === 'brute') {
    s.strength = clamp(base + 3, 1, 10);
    s.durability = clamp(base + 4, 1, 10);
    s.speed = clamp(base - 2, 1, 10);
  } else if (archetype === 'gunner') {
    s.energy = clamp(base + 2, 1, 10);
    s.durability = clamp(base - 1, 1, 10);
  }
  return s;
}

/** Minions have a fraction of a hero's health so fights stay snappy. */
export function minionHealth(stats: Stats, level: number, archetype: 'grunt' | 'gunner' | 'brute'): number {
  const mult = archetype === 'brute' ? 0.9 : archetype === 'gunner' ? 0.3 : 0.4;
  return Math.round(maxHealth(stats, level) * mult);
}

export interface DamageRoll {
  amount: number;
  crit: boolean;
}

/** Applies crit and defender durability. `random` is injectable for tests. */
export function rollDamage(raw: number, attacker: Stats, defender: Stats, random: () => number = Math.random): DamageRoll {
  const crit = random() < critChance(attacker);
  const mitigation = 1 - clamp(defender.durability * 0.025, 0, 0.35);
  const variance = 0.9 + random() * 0.2;
  return { amount: Math.max(1, Math.round(raw * mitigation * variance * (crit ? 1.75 : 1))), crit };
}
