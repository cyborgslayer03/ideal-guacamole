// Core data model. Everything a player creates lives inside a Universe, which
// is plain JSON so it can be saved, exported, and (later) shared online.

export const SCHEMA_VERSION = 1;

export const STAT_KEYS = ['strength', 'speed', 'durability', 'energy', 'intelligence', 'combat'] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export type Stats = Record<StatKey, number>;

export const ROLES = ['hero', 'villain', 'antihero', 'neutral'] as const;
export type Role = (typeof ROLES)[number];

export const ELEMENTS = [
  'kinetic', 'energy', 'fire', 'ice', 'lightning', 'cosmic', 'shadow', 'psychic', 'nature', 'tech',
] as const;
export type Element = (typeof ELEMENTS)[number];

export const POWER_KINDS = ['blast', 'beam', 'nova', 'dash', 'shield', 'heal', 'flight', 'teleport', 'superspeed', 'leap'] as const;
export type PowerKind = (typeof POWER_KINDS)[number];

/** Movement powers: used on the travel button (or passive), never on Q/E/R/F. */
export const MOVEMENT_KINDS = ['flight', 'teleport', 'superspeed', 'leap'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export function isMovement(kind: PowerKind): kind is MovementKind {
  return (MOVEMENT_KINDS as readonly string[]).includes(kind);
}

export interface Power {
  id: string;
  name: string;
  kind: PowerKind;
  element: Element;
  /** 1-10: how strong this power is. */
  potency: number;
  description: string;
}

export const BUILDS = ['slim', 'athletic', 'heavy'] as const;
export type Build = (typeof BUILDS)[number];

export const HEAD_STYLES = ['mask', 'helmet', 'cowl', 'visor', 'bare'] as const;
export type HeadStyle = (typeof HEAD_STYLES)[number];

export const EMBLEMS = ['none', 'star', 'bolt', 'circle', 'diamond', 'triangle'] as const;
export type Emblem = (typeof EMBLEMS)[number];

export interface Appearance {
  primary: string;
  secondary: string;
  accent: string;
  build: Build;
  /** Scale multiplier, 0.8-1.3. */
  height: number;
  head: HeadStyle;
  emblem: Emblem;
  cape: boolean;
  aura: boolean;
}

export interface Character {
  id: string;
  name: string;
  alias: string;
  role: Role;
  factionId: string | null;
  origin: string;
  bio: string;
  /** Each stat is 1-10. */
  stats: Stats;
  powers: Power[];
  appearance: Appearance;
  itemIds: string[];
  level: number;
  xp: number;
}

export const ITEM_SLOTS = ['weapon', 'armor', 'artifact', 'gadget'] as const;
export type ItemSlot = (typeof ITEM_SLOTS)[number];

export const RARITIES = ['common', 'rare', 'epic', 'legendary', 'mythic'] as const;
export type Rarity = (typeof RARITIES)[number];

export interface Item {
  id: string;
  name: string;
  slot: ItemSlot;
  rarity: Rarity;
  description: string;
  bonuses: Partial<Stats>;
  color: string;
}

export const BIOMES = ['metropolis', 'cosmic', 'mystic', 'wasteland', 'frozen', 'jungle'] as const;
export type Biome = (typeof BIOMES)[number];

export interface Location {
  id: string;
  name: string;
  biome: Biome;
  description: string;
  skyColor: string;
  groundColor: string;
  glowColor: string;
  /** 0-1: how crowded the arena is with structures. */
  density: number;
}

export interface Faction {
  id: string;
  name: string;
  color: string;
  alignment: Role;
  description: string;
  /** Starting leader for campaigns; null lets the strongest member lead. */
  leaderId: string | null;
}

export type Objective =
  | { type: 'defeat'; count: number }
  | { type: 'boss'; characterId: string }
  | { type: 'survive'; seconds: number };

export interface DialogueLine {
  speaker: string;
  text: string;
}

/** A chapter only plays if a story flag has a specific value. */
export interface ChapterCondition {
  flag: string;
  value: string;
}

export interface ChoiceOption {
  label: string;
  /** Value written to the choice's flag when picked. */
  value: string;
  /** Optional character whose relationship with the player shifts. */
  relationshipId: string | null;
  relationshipDelta: number;
}

/** A decision shown after a chapter's outro; it sets a flag later chapters can require. */
export interface StoryChoice {
  prompt: string;
  flag: string;
  options: ChoiceOption[];
}

export interface Chapter {
  id: string;
  title: string;
  locationId: string;
  intro: DialogueLine[];
  objective: Objective;
  enemyFactionId: string | null;
  enemyLevel: number;
  outro: DialogueLine[];
  rewardItemId: string | null;
  requires: ChapterCondition | null;
  choice: StoryChoice | null;
}

export interface Story {
  id: string;
  title: string;
  synopsis: string;
  protagonistId: string | null;
  chapters: Chapter[];
}

export interface UniverseRules {
  /** Multiplies all power damage, 0.5-3. */
  powerScale: number;
  /** Multiplies gravity, 0.2-2. */
  gravity: number;
  /** Multiplies enemy counts, 0.5-2. */
  enemyDensity: number;
}

export interface Universe {
  schema: number;
  id: string;
  name: string;
  tagline: string;
  description: string;
  author: string;
  seed: number;
  accent: string;
  rules: UniverseRules;
  factions: Faction[];
  characters: Character[];
  items: Item[];
  locations: Location[];
  stories: Story[];
  createdAt: number;
  updatedAt: number;
}
