// Normalizes untrusted JSON (imports, old saves, and later downloads from
// other players) into well-formed data. Unknown fields are dropped, missing
// ones get defaults, numbers are clamped, and dangling references are cleared.

import { clamp } from './rules';
import { newId } from './id';
import {
  BIOMES, BUILDS, MODEL_STATES, ELEMENTS, EMBLEMS, HEAD_STYLES, ITEM_SLOTS, POWER_KINDS, RARITIES, ROLES,
  MASTERY_TIER_COUNT, MAX_ITEM_LEVEL, PERK_TYPES, SCHEMA_VERSION, STAT_KEYS,
  type Appearance, type ItemPerk, type Chapter, type ModelRef, type ModelState, type ChapterCondition, type ChoiceOption, type StoryChoice, type Character, type DialogueLine, type Faction, type Item,
  type Location, type Objective, type UniverseRules, type Power, type Stats, type Story, type Universe,
} from './types';

type Obj = Record<string, unknown>;

const MAX_TEXT = 4000;
const MAX_NAME = 80;
const MAX_LIST = 500;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, MAX_LIST) : []);

function str(v: unknown, fallback: string, max = MAX_TEXT): string {
  return typeof v === 'string' ? v.slice(0, max) : fallback;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, min, max) : fallback;
}

function int(v: unknown, fallback: number, min: number, max: number): number {
  return Math.round(num(v, fallback, min, max));
}

function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return options.includes(v as T) ? (v as T) : fallback;
}

function color(v: unknown, fallback: string): string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback;
}

function id(v: unknown, prefix: string): string {
  return typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : newId(prefix);
}

function nullableRef(v: unknown, valid: Set<string>): string | null {
  return typeof v === 'string' && valid.has(v) ? v : null;
}

export function normalizeStats(raw: unknown): Stats {
  const o = obj(raw);
  return Object.fromEntries(STAT_KEYS.map((k) => [k, int(o[k], 5, 1, 10)])) as Stats;
}

function normalizeBonuses(raw: unknown): Partial<Stats> {
  const o = obj(raw);
  const out: Partial<Stats> = {};
  for (const k of STAT_KEYS) {
    if (typeof o[k] === 'number') out[k] = int(o[k], 0, -5, 5);
  }
  return out;
}

export function normalizePower(raw: unknown): Power {
  const o = obj(raw);
  return {
    id: id(o.id, 'pow'),
    name: str(o.name, 'Power', MAX_NAME),
    kind: oneOf(o.kind, POWER_KINDS, 'blast'),
    element: oneOf(o.element, ELEMENTS, 'energy'),
    potency: int(o.potency, 5, 1, 10),
    description: str(o.description, ''),
  };
}

const MODEL_SRC = /^(builtin:[a-z0-9-]{1,40}|asset:[\w-]{1,64}|https:\/\/[^\s"'<>]{1,500})$/;

/** Validates an imported-model reference; anything malformed means "no model". */
export function normalizeModelRef(raw: unknown): ModelRef | null {
  if (!isObj(raw) || typeof raw.src !== 'string' || !MODEL_SRC.test(raw.src)) return null;
  const clips: Partial<Record<ModelState, string>> = {};
  const rc = obj(raw.clips);
  for (const state of MODEL_STATES) {
    const v = rc[state];
    if (typeof v === 'string' && (MODEL_SRC.test(v) || /^clip:.{1,80}$/.test(v))) clips[state] = v;
  }
  return { src: raw.src, scale: num(raw.scale, 1, 0.3, 3), yaw: num(raw.yaw, 0, -180, 180), tint: raw.tint === true, clips };
}

export function normalizeAppearance(raw: unknown): Appearance {
  const o = obj(raw);
  return {
    primary: color(o.primary, '#c0303a'),
    secondary: color(o.secondary, '#1a2240'),
    accent: color(o.accent, '#ffd23e'),
    build: oneOf(o.build, BUILDS, 'athletic'),
    height: num(o.height, 1, 0.8, 1.3),
    head: oneOf(o.head, HEAD_STYLES, 'mask'),
    emblem: oneOf(o.emblem, EMBLEMS, 'star'),
    cape: o.cape === true,
    aura: o.aura === true,
    model: normalizeModelRef(o.model),
  };
}

export function normalizeCharacter(raw: unknown, factionIds = new Set<string>(), itemIds = new Set<string>()): Character {
  const o = obj(raw);
  return {
    id: id(o.id, 'chr'),
    name: str(o.name, '', MAX_NAME),
    alias: str(o.alias, 'Unnamed Hero', MAX_NAME),
    role: oneOf(o.role, ROLES, 'hero'),
    factionId: nullableRef(o.factionId, factionIds),
    origin: str(o.origin, ''),
    bio: str(o.bio, ''),
    stats: normalizeStats(o.stats),
    powers: list(o.powers).slice(0, 12).map(normalizePower),
    appearance: normalizeAppearance(o.appearance),
    itemIds: list(o.itemIds).filter((x): x is string => typeof x === 'string' && itemIds.has(x)).slice(0, 4),
    level: int(o.level, 1, 1, 60),
    xp: int(o.xp, 0, 0, 1e9),
    mastery: normalizeMastery(o.mastery),
    stars: int(o.stars, 1, 1, 6),
  };
}

function normalizeMastery(raw: unknown): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(obj(raw)).slice(0, 12)) {
    if (!/^[\w-]{1,64}$/.test(k) || !Array.isArray(v)) continue;
    out[k] = Array.from({ length: MASTERY_TIER_COUNT }, (_, i) => int(v[i], 0, 0, 2));
  }
  return out;
}

export function normalizePerk(raw: unknown): ItemPerk | null {
  if (!isObj(raw)) return null;
  const type = oneOf(raw.type, PERK_TYPES, 'powerDamage');
  const needsPower = type === 'powerDamage' || type === 'powerCooldown' || type === 'powerPotency';
  return {
    type,
    power: needsPower ? oneOf(raw.power, POWER_KINDS, 'blast') : null,
    element: type === 'elementDamage' ? oneOf(raw.element, ELEMENTS, 'energy') : null,
    value: type === 'powerPotency' ? int(raw.value, 1, 1, 3) : int(raw.value, 10, 1, type === 'lifesteal' ? 15 : 40),
  };
}

export function normalizeItem(raw: unknown): Item {
  const o = obj(raw);
  return {
    id: id(o.id, 'itm'),
    name: str(o.name, 'Item', MAX_NAME),
    slot: oneOf(o.slot, ITEM_SLOTS, 'artifact'),
    rarity: oneOf(o.rarity, RARITIES, 'common'),
    description: str(o.description, ''),
    bonuses: normalizeBonuses(o.bonuses),
    color: color(o.color, '#ffd23e'),
    level: int(o.level, 0, 0, MAX_ITEM_LEVEL),
    perk: normalizePerk(o.perk),
  };
}

const RULE_RANGES: Record<keyof UniverseRules, [number, number]> = {
  powerScale: [0.5, 3],
  gravity: [0.2, 2],
  enemyDensity: [0.5, 2],
};

/** Keeps only valid, in-range rule overrides. */
export function normalizePartialRules(raw: unknown): Partial<UniverseRules> {
  const o = obj(raw);
  const out: Partial<UniverseRules> = {};
  for (const key of Object.keys(RULE_RANGES) as (keyof UniverseRules)[]) {
    const [min, max] = RULE_RANGES[key];
    if (typeof o[key] === 'number' && Number.isFinite(o[key])) out[key] = clamp(o[key] as number, min, max);
  }
  return out;
}

export function normalizeLocation(raw: unknown): Location {
  const o = obj(raw);
  return {
    id: id(o.id, 'loc'),
    name: str(o.name, 'Location', MAX_NAME),
    biome: oneOf(o.biome, BIOMES, 'metropolis'),
    description: str(o.description, ''),
    skyColor: color(o.skyColor, '#0a1030'),
    groundColor: color(o.groundColor, '#151a2e'),
    glowColor: color(o.glowColor, '#3ee8ff'),
    density: num(o.density, 0.5, 0, 1),
    rules: normalizePartialRules(o.rules),
  };
}

export function normalizeFaction(raw: unknown): Faction {
  const o = obj(raw);
  return {
    id: id(o.id, 'fac'),
    name: str(o.name, 'Faction', MAX_NAME),
    color: color(o.color, '#888888'),
    alignment: oneOf(o.alignment, ROLES, 'neutral'),
    description: str(o.description, ''),
    // Checked against real character ids once characters are normalized.
    leaderId: typeof o.leaderId === 'string' ? o.leaderId : null,
  };
}

function normalizeDialogue(raw: unknown): DialogueLine[] {
  return list(raw).slice(0, 50).map((line) => {
    const o = obj(line);
    return { speaker: str(o.speaker, '', MAX_NAME), text: str(o.text, '', 600) };
  });
}

const FLAG_RE = /^[\w.:-]{1,64}$/;

function flagName(v: unknown): string {
  return typeof v === 'string' && FLAG_RE.test(v) ? v : '';
}

function normalizeCondition(raw: unknown): ChapterCondition | null {
  if (!isObj(raw)) return null;
  const flag = flagName(raw.flag);
  return flag ? { flag, value: str(raw.value, '', 64) } : null;
}

function normalizeChoice(raw: unknown, characterIds: Set<string>): StoryChoice | null {
  if (!isObj(raw)) return null;
  const flag = flagName(raw.flag);
  const options: ChoiceOption[] = list(raw.options).slice(0, 4).map((x) => {
    const o = obj(x);
    return {
      label: str(o.label, 'Option', MAX_NAME),
      value: str(o.value, '', 64),
      relationshipId: nullableRef(o.relationshipId, characterIds),
      relationshipDelta: int(o.relationshipDelta, 0, -100, 100),
    };
  });
  return flag && options.length ? { prompt: str(raw.prompt, '', 300), flag, options } : null;
}

function normalizeObjective(raw: unknown, characterIds: Set<string>): Objective {
  const o = obj(raw);
  if (o.type === 'boss' && typeof o.characterId === 'string' && characterIds.has(o.characterId)) {
    return { type: 'boss', characterId: o.characterId };
  }
  if (o.type === 'survive') return { type: 'survive', seconds: int(o.seconds, 60, 10, 600) };
  return { type: 'defeat', count: int(o.count, 10, 1, 200) };
}

interface Refs {
  characters: Set<string>;
  locations: Set<string>;
  factions: Set<string>;
  items: Set<string>;
}

function normalizeChapter(raw: unknown, refs: Refs): Chapter {
  const o = obj(raw);
  return {
    id: id(o.id, 'chp'),
    title: str(o.title, 'Chapter', MAX_NAME),
    locationId: typeof o.locationId === 'string' && refs.locations.has(o.locationId) ? o.locationId : '',
    intro: normalizeDialogue(o.intro),
    objective: normalizeObjective(o.objective, refs.characters),
    enemyFactionId: nullableRef(o.enemyFactionId, refs.factions),
    enemyLevel: int(o.enemyLevel, 1, 1, 60),
    outro: normalizeDialogue(o.outro),
    rewardItemId: nullableRef(o.rewardItemId, refs.items),
    requires: normalizeCondition(o.requires),
    choice: normalizeChoice(o.choice, refs.characters),
  };
}

export function normalizeStory(raw: unknown, refs: Refs): Story {
  const o = obj(raw);
  return {
    id: id(o.id, 'sty'),
    title: str(o.title, 'Story', MAX_NAME),
    synopsis: str(o.synopsis, ''),
    protagonistId: nullableRef(o.protagonistId, refs.characters),
    chapters: list(o.chapters).slice(0, 50).map((c) => normalizeChapter(c, refs)),
  };
}

function dedupeIds<T extends { id: string }>(items: T[], prefix: string): T[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) item.id = newId(prefix);
    seen.add(item.id);
  }
  return items;
}

export function normalizeUniverse(raw: unknown): Universe {
  const o = obj(raw);
  const rules = obj(o.rules);

  const factions = dedupeIds(list(o.factions).map(normalizeFaction), 'fac');
  const items = dedupeIds(list(o.items).map(normalizeItem), 'itm');
  const locations = dedupeIds(list(o.locations).map(normalizeLocation), 'loc');
  const factionIds = new Set(factions.map((f) => f.id));
  const itemIds = new Set(items.map((i) => i.id));
  const characters = dedupeIds(list(o.characters).map((c) => normalizeCharacter(c, factionIds, itemIds)), 'chr');
  for (const f of factions) {
    if (!characters.some((c) => c.id === f.leaderId && c.factionId === f.id)) f.leaderId = null;
  }
  const refs: Refs = {
    characters: new Set(characters.map((c) => c.id)),
    locations: new Set(locations.map((l) => l.id)),
    factions: factionIds,
    items: itemIds,
  };
  const now = Date.now();

  return {
    schema: SCHEMA_VERSION,
    id: id(o.id, 'uni'),
    name: str(o.name, 'Untitled Universe', MAX_NAME),
    tagline: str(o.tagline, '', 200),
    description: str(o.description, ''),
    author: str(o.author, '', MAX_NAME),
    seed: int(o.seed, 0, 0, 2 ** 32 - 1),
    accent: color(o.accent, '#3ee8ff'),
    rules: {
      powerScale: num(rules.powerScale, 1, 0.5, 3),
      gravity: num(rules.gravity, 1, 0.2, 2),
      enemyDensity: num(rules.enemyDensity, 1, 0.5, 2),
    },
    factions,
    characters,
    items,
    locations,
    stories: dedupeIds(list(o.stories).map((s) => normalizeStory(s, refs)), 'sty'),
    createdAt: int(o.createdAt, now, 0, Number.MAX_SAFE_INTEGER),
    updatedAt: int(o.updatedAt, now, 0, Number.MAX_SAFE_INTEGER),
  };
}
