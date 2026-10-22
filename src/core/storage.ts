// Local persistence. The `KeyValueStore` seam lets tests use memory and lets a
// future cloud sync layer sit behind the same API.

import { loadCampaign, type Campaign } from './campaign';
import type { Universe } from './types';
import { normalizeUniverse } from './validate';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface UniverseSummary {
  id: string;
  name: string;
  tagline: string;
  accent: string;
  characterCount: number;
  storyCount: number;
  updatedAt: number;
}

const INDEX_KEY = 'of:index';
const universeKey = (id: string) => `of:universe:${id}`;
const campaignKey = (id: string) => `of:campaign:${id}`;

export class UniverseLibrary {
  constructor(private readonly kv: KeyValueStore) {}

  list(): UniverseSummary[] {
    try {
      const parsed: unknown = JSON.parse(this.kv.getItem(INDEX_KEY) ?? '[]');
      return Array.isArray(parsed) ? (parsed as UniverseSummary[]).sort((a, b) => b.updatedAt - a.updatedAt) : [];
    } catch {
      return [];
    }
  }

  load(id: string): Universe | null {
    const raw = this.kv.getItem(universeKey(id));
    if (!raw) return null;
    try {
      return normalizeUniverse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  save(universe: Universe): void {
    universe.updatedAt = Date.now();
    this.kv.setItem(universeKey(universe.id), JSON.stringify(universe));
    const index = this.list().filter((s) => s.id !== universe.id);
    index.push(summarize(universe));
    this.kv.setItem(INDEX_KEY, JSON.stringify(index));
  }

  /** The universe's campaign, created fresh if none is saved yet. */
  loadCampaign(universe: Universe): Campaign {
    let raw: unknown = null;
    try {
      raw = JSON.parse(this.kv.getItem(campaignKey(universe.id)) ?? 'null');
    } catch {
      raw = null;
    }
    return loadCampaign(raw, universe);
  }

  saveCampaign(campaign: Campaign): void {
    this.kv.setItem(campaignKey(campaign.universeId), JSON.stringify(campaign));
  }

  removeCampaign(universeId: string): void {
    this.kv.removeItem(campaignKey(universeId));
  }

  remove(id: string): void {
    this.kv.removeItem(universeKey(id));
    this.kv.removeItem(campaignKey(id));
    this.kv.setItem(INDEX_KEY, JSON.stringify(this.list().filter((s) => s.id !== id)));
  }
}

function summarize(u: Universe): UniverseSummary {
  return {
    id: u.id,
    name: u.name,
    tagline: u.tagline,
    accent: u.accent,
    characterCount: u.characters.length,
    storyCount: u.stories.length,
    updatedAt: u.updatedAt,
  };
}

export class MemoryStore implements KeyValueStore {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

/** Player preferences, kept separate from universe data. */
export interface Settings {
  detail: 'quick' | 'full';
  bloom: boolean;
  author: string;
  /** Multiverse Hub API root; empty means this site's own /api. */
  hubUrl: string;
  /** Signed-in hub session. */
  hubToken: string;
  hubHandle: string;
}

const SETTINGS_KEY = 'of:settings';
const DEFAULT_SETTINGS: Settings = { detail: 'quick', bloom: true, author: '', hubUrl: '', hubToken: '', hubHandle: '' };

export function loadSettings(kv: KeyValueStore): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(kv.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(kv: KeyValueStore, settings: Settings): void {
  kv.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
