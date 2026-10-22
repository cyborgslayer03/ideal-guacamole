// Long-term progression: power mastery trees, gear perks and upgrades, loot
// drops, and salvage. Pure functions, so combat, campaign and UI share one
// source of truth.

import { ELEMENT_COLORS, POWER_LABELS } from './rules';
export { upgradedBonus } from './rules';
import type { Rng } from './rng';
import {
  ELEMENTS, ITEM_SLOTS, MASTERY_TIER_COUNT, MAX_ITEM_LEVEL, RARITIES, STAT_KEYS, takesSkillSlot,
  type Character, type Element, type Item, type ItemPerk, type ItemSlot, type PerkType, type Power, type PowerKind, type Rarity, type Stats,
} from './types';

// --- Mastery -----------------------------------------------------------------------

export type MasteryId = 'amplify' | 'quicken' | 'empower' | 'efficient' | 'overload' | 'lifeline';

export interface MasteryOption {
  id: MasteryId;
  label: string;
  text: string;
}

export interface MasteryTier {
  /** Character level that unlocks the choice. */
  level: number;
  options: [MasteryOption, MasteryOption];
}

/** Every attack or support power has the same three-tier tree: pick one option per tier. */
export const MASTERY_TIERS: readonly MasteryTier[] = [
  {
    level: 5,
    options: [
      { id: 'amplify', label: 'Amplify', text: '+25% damage and healing' },
      { id: 'quicken', label: 'Quicken', text: '25% shorter cooldown' },
    ],
  },
  {
    level: 15,
    options: [
      { id: 'empower', label: 'Empower', text: '+3 potency: more projectiles, bigger areas, longer effects' },
      { id: 'efficient', label: 'Efficient', text: 'Half the energy cost' },
    ],
  },
  {
    level: 30,
    options: [
      { id: 'overload', label: 'Overload', text: 'Each cast also detonates a burst of its element around you' },
      { id: 'lifeline', label: 'Lifeline', text: 'Each cast heals you for 6% of max health' },
    ],
  },
];

if (MASTERY_TIERS.length !== MASTERY_TIER_COUNT) throw new Error('Mastery tier count mismatch');

/** The options a character has picked for a power (only tiers they've reached). */
export function masteryPicks(c: Character, power: Power): MasteryId[] {
  if (!takesSkillSlot(power.kind)) return [];
  const picks = c.mastery[power.id] ?? [];
  return MASTERY_TIERS.flatMap((tier, i) => {
    const pick = picks[i];
    return c.level >= tier.level && (pick === 1 || pick === 2) ? [tier.options[pick - 1].id] : [];
  });
}

/** Mastery tiers unlocked between two levels (for "new mastery" notices). */
export function masteryUnlocked(from: number, to: number): MasteryTier[] {
  return MASTERY_TIERS.filter((t) => t.level > from && t.level <= to);
}

/** Powers that still have an unlocked tier with no pick. */
export function unspentMastery(c: Character): number {
  let n = 0;
  for (const p of c.powers) {
    if (!takesSkillSlot(p.kind)) continue;
    MASTERY_TIERS.forEach((t, i) => {
      if (c.level >= t.level && !(c.mastery[p.id]?.[i] > 0)) n++;
    });
  }
  return n;
}

export function setMastery(c: Character, powerId: string, tier: number, pick: 0 | 1 | 2) {
  const row = (c.mastery[powerId] ??= Array.from({ length: MASTERY_TIER_COUNT }, () => 0));
  row[tier] = pick;
}

// --- Gear ----------------------------------------------------------------------------

/** A perk's value after upgrades. */
export function perkValue(item: Item): number {
  const p = item.perk;
  if (!p) return 0;
  if (p.type === 'powerPotency') return p.value + (item.level >= 4 ? 1 : 0);
  return Math.round(p.value * (1 + item.level * 0.12));
}

export const PERK_LABELS: Record<PerkType, string> = {
  powerDamage: 'Power damage',
  powerCooldown: 'Power cooldown',
  powerPotency: 'Power potency',
  elementDamage: 'Element damage',
  lifesteal: 'Lifesteal',
  ultCharge: 'Ultimate charge',
};

/** "+20% Telekinesis damage" and so on. */
export function perkText(perk: ItemPerk, value = perk.value): string {
  const power = perk.power ? POWER_LABELS[perk.power] : '';
  switch (perk.type) {
    case 'powerDamage': return `+${value}% ${power} damage`;
    case 'powerCooldown': return `${value}% shorter ${power} cooldown`;
    case 'powerPotency': return `+${value} ${power} potency`;
    case 'elementDamage': return `+${value}% ${perk.element ?? 'energy'} damage`;
    case 'lifesteal': return `Heal for ${value}% of damage dealt`;
    case 'ultCharge': return `Ultimate charges ${value}% faster`;
  }
}

const PERK_RANGE: Record<PerkType, [number, number]> = {
  powerDamage: [10, 30],
  powerCooldown: [8, 25],
  powerPotency: [1, 2],
  elementDamage: [8, 25],
  lifesteal: [2, 8],
  ultCharge: [10, 30],
};
const RARITY_SCALE: Record<Rarity, number> = { common: 0.4, rare: 0.55, epic: 0.7, legendary: 0.85, mythic: 1 };

/** A random perk, aimed at the given powers when there are any (loot tailored to the hero). */
export function randomPerk(rng: Rng, rarity: Rarity, powers: readonly Power[] = []): ItemPerk {
  const usable = powers.filter((p) => takesSkillSlot(p.kind));
  const type = rng.pick(['powerDamage', 'powerCooldown', 'powerPotency', 'elementDamage', 'lifesteal', 'ultCharge'] as const);
  const [lo, hi] = PERK_RANGE[type];
  const scale = RARITY_SCALE[rarity];
  const value = Math.max(lo, Math.round(lo + (hi - lo) * scale * rng.float(0.7, 1)));
  const target = usable.length ? rng.pick(usable) : null;
  const power: PowerKind | null = type.startsWith('power') ? target?.kind ?? rng.pick(['blast', 'beam', 'nova', 'dash'] as const) : null;
  const element: Element | null = type === 'elementDamage' ? target?.element ?? rng.pick(ELEMENTS) : null;
  return { type, power, element, value };
}

// --- Loot ----------------------------------------------------------------------------

const LOOT_WEIGHTS: Record<Rarity, number> = { common: 40, rare: 34, epic: 17, legendary: 7, mythic: 2 };
const RARITY_STATS: Record<Rarity, [number, number, number]> = {
  // [stat count, min, max]
  common: [1, 1, 1],
  rare: [2, 1, 2],
  epic: [2, 2, 3],
  legendary: [3, 2, 4],
  mythic: [3, 3, 5],
};
const LOOT_ADJ: Record<Rarity, string[]> = {
  common: ['Standard', 'Field', 'Issue', 'Patched'],
  rare: ['Reinforced', 'Tuned', 'Veteran', 'Charged'],
  epic: ['Quantum', 'Phantom', 'Arc', 'Starborn'],
  legendary: ['Celestial', 'Titan', 'Eternal', 'Dread'],
  mythic: ['Omniversal', 'Primordial', 'Infinity', 'Godforged'],
};
const LOOT_NOUN: Record<ItemSlot, string[]> = {
  weapon: ['Gauntlet', 'Blade', 'Hammer', 'Staff', 'Spear', 'Knuckles'],
  armor: ['Battlesuit', 'Exo-Plate', 'Cloak', 'Nanoweave', 'Carapace', 'Mantle'],
  artifact: ['Gem', 'Amulet', 'Crown', 'Orb', 'Codex', 'Ring'],
  gadget: ['Visor', 'Grapple', 'Drone', 'Jetpack', 'Wrist-Comp', 'Comm Bead'],
};
const RARITY_TINT: Record<Rarity, string> = { common: '#a0a8b8', rare: '#3e9bff', epic: '#b05cff', legendary: '#ffb22e', mythic: '#ff3e5c' };

/** Picks a rarity; luck (0 and up) shifts the odds toward the top. */
export function rollRarity(rng: Rng, luck = 0): Rarity {
  const weights = RARITIES.map((r, i) => LOOT_WEIGHTS[r] * Math.pow(1 + luck, i));
  let roll = rng.float(0, weights.reduce((a, b) => a + b, 0));
  for (let i = 0; i < RARITIES.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return RARITIES[i];
  }
  return 'mythic';
}

/** A dropped item. Deterministic for a given rng; perks favor the hero's own powers. */
export function rollLoot(rng: Rng, rarity: Rarity, hero?: Character): Item {
  const slot = rng.pick(ITEM_SLOTS);
  const [count, lo, hi] = RARITY_STATS[rarity];
  const bonuses: Partial<Stats> = {};
  for (const key of rng.shuffle(STAT_KEYS).slice(0, count)) bonuses[key] = rng.int(lo, hi);
  const perk = rarity === 'common' ? null : rarity === 'rare' && !rng.chance(0.5) ? null : randomPerk(rng, rarity, hero?.powers);
  const element = perk?.element ?? (perk?.power ? hero?.powers.find((p) => p.kind === perk.power)?.element : undefined);
  return {
    id: `itm_loot${rng.int(0, 2 ** 30).toString(36)}${rng.int(0, 2 ** 30).toString(36)}`,
    name: `${rng.pick(LOOT_ADJ[rarity])} ${rng.pick(LOOT_NOUN[slot])}`,
    slot,
    rarity,
    description: '',
    bonuses,
    color: element ? ELEMENT_COLORS[element] : RARITY_TINT[rarity],
    level: 0,
    perk,
  };
}

const SALVAGE: Record<Rarity, number> = { common: 5, rare: 12, epic: 30, legendary: 70, mythic: 150 };
const UPGRADE: Record<Rarity, number> = { common: 8, rare: 15, epic: 30, legendary: 55, mythic: 90 };

/** Shards to raise an item one level, or null at max. */
export function upgradeCost(item: Item): number | null {
  return item.level >= MAX_ITEM_LEVEL ? null : UPGRADE[item.rarity] * (item.level + 1);
}

/** Shards from breaking an item down (refunds half of what was spent upgrading it). */
export function salvageValue(item: Item): number {
  let spent = 0;
  for (let l = 0; l < item.level; l++) spent += UPGRADE[item.rarity] * (l + 1);
  return SALVAGE[item.rarity] + Math.floor(spent / 2);
}

// --- Loadout (what combat needs) -------------------------------------------------------

export interface PowerMods {
  damage: number;
  cooldown: number;
  cost: number;
  potency: number;
  overload: boolean;
  lifeline: boolean;
}

export interface Loadout {
  /** Keyed by power id. */
  mods: Record<string, PowerMods>;
  /** Fraction of damage dealt healed back. */
  lifesteal: number;
  /** Multiplier on ultimate charge. */
  ultCharge: number;
  /** Extra damage fraction per element. */
  elementDamage: Partial<Record<Element, number>>;
}

export const NO_MODS: PowerMods = { damage: 1, cooldown: 1, cost: 1, potency: 0, overload: false, lifeline: false };
export const EMPTY_LOADOUT: Loadout = { mods: {}, lifesteal: 0, ultCharge: 1, elementDamage: {} };

/** Highest potency mastery and gear can push a power to. */
export const MAX_BOOSTED_POTENCY = 14;

/** The power as combat uses it: potency raised by mastery and gear (capped). */
export function boostedPower(p: Power, m: PowerMods): Power {
  return m.potency ? { ...p, potency: Math.min(MAX_BOOSTED_POTENCY, p.potency + m.potency) } : p;
}

/** Combines mastery picks and equipped gear perks into combat modifiers. */
export function loadoutFor(c: Character, items: readonly Item[]): Loadout {
  const gear = c.itemIds.map((id) => items.find((i) => i.id === id)).filter((i): i is Item => !!i);
  const out: Loadout = { mods: {}, lifesteal: 0, ultCharge: 1, elementDamage: {} };
  for (const item of gear) {
    const p = item.perk;
    if (!p) continue;
    const v = perkValue(item);
    if (p.type === 'lifesteal') out.lifesteal += v / 100;
    if (p.type === 'ultCharge') out.ultCharge += v / 100;
    if (p.type === 'elementDamage' && p.element) out.elementDamage[p.element] = (out.elementDamage[p.element] ?? 0) + v / 100;
  }
  out.lifesteal = Math.min(0.3, out.lifesteal);
  for (const power of c.powers) {
    const m: PowerMods = { ...NO_MODS };
    for (const pick of masteryPicks(c, power)) {
      if (pick === 'amplify') m.damage *= 1.25;
      if (pick === 'quicken') m.cooldown *= 0.75;
      if (pick === 'empower') m.potency += 3;
      if (pick === 'efficient') m.cost *= 0.5;
      if (pick === 'overload') m.overload = true;
      if (pick === 'lifeline') m.lifeline = true;
    }
    for (const item of gear) {
      const p = item.perk;
      if (!p || p.power !== power.kind) continue;
      const v = perkValue(item);
      if (p.type === 'powerDamage') m.damage *= 1 + v / 100;
      if (p.type === 'powerCooldown') m.cooldown *= Math.max(0.4, 1 - v / 100);
      if (p.type === 'powerPotency') m.potency += v;
    }
    out.mods[power.id] = m;
  }
  return out;
}
