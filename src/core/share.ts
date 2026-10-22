// Export/import of shareable bundles. Every bundle's payload is a (partial)
// universe, so a single validator handles all content types. This is the file
// format the future online hub will upload and download.

import { emptyUniverse } from './generator';
import { newId } from './id';
import { SCHEMA_VERSION, type Character, type Story, type Universe } from './types';
import { normalizeUniverse } from './validate';

export const BUNDLE_FORMAT = 'omniverse-forge';
export type BundleKind = 'universe' | 'character' | 'item' | 'story';

export interface Bundle {
  format: typeof BUNDLE_FORMAT;
  schema: number;
  kind: BundleKind;
  name: string;
  author: string;
  exportedAt: number;
  payload: Universe;
}

function makeBundle(kind: BundleKind, name: string, source: Universe, payload: Universe): Bundle {
  return { format: BUNDLE_FORMAT, schema: SCHEMA_VERSION, kind, name, author: source.author, exportedAt: Date.now(), payload };
}

function partial(source: Universe): Universe {
  const u = emptyUniverse(source.name);
  u.author = source.author;
  return u;
}

/** Adds a character plus the faction and items it references. */
function includeCharacter(target: Universe, source: Universe, character: Character) {
  if (target.characters.some((c) => c.id === character.id)) return;
  target.characters.push(structuredClone(character));
  for (const itemId of character.itemIds) {
    const item = source.items.find((i) => i.id === itemId);
    if (item && !target.items.some((i) => i.id === itemId)) target.items.push(structuredClone(item));
  }
  const faction = source.factions.find((f) => f.id === character.factionId);
  if (faction && !target.factions.some((f) => f.id === faction.id)) target.factions.push(structuredClone(faction));
}

export function bundleUniverse(universe: Universe): Bundle {
  return makeBundle('universe', universe.name, universe, structuredClone(universe));
}

export function bundleCharacter(universe: Universe, characterId: string): Bundle | null {
  const character = universe.characters.find((c) => c.id === characterId);
  if (!character) return null;
  const payload = partial(universe);
  includeCharacter(payload, universe, character);
  return makeBundle('character', character.alias, universe, payload);
}

export function bundleItem(universe: Universe, itemId: string): Bundle | null {
  const item = universe.items.find((i) => i.id === itemId);
  if (!item) return null;
  const payload = partial(universe);
  payload.items.push(structuredClone(item));
  return makeBundle('item', item.name, universe, payload);
}

/** A story travels with every character, location, item, and faction it uses. */
export function bundleStory(universe: Universe, storyId: string): Bundle | null {
  const story = universe.stories.find((s) => s.id === storyId);
  if (!story) return null;
  const payload = partial(universe);
  const characterIds = new Set<string>();
  if (story.protagonistId) characterIds.add(story.protagonistId);
  for (const ch of story.chapters) {
    if (ch.objective.type === 'boss') characterIds.add(ch.objective.characterId);
    const loc = universe.locations.find((l) => l.id === ch.locationId);
    if (loc && !payload.locations.some((l) => l.id === loc.id)) payload.locations.push(structuredClone(loc));
    const item = universe.items.find((i) => i.id === ch.rewardItemId);
    if (item && !payload.items.some((i) => i.id === item.id)) payload.items.push(structuredClone(item));
    const faction = universe.factions.find((f) => f.id === ch.enemyFactionId);
    if (faction && !payload.factions.some((f) => f.id === faction.id)) payload.factions.push(structuredClone(faction));
  }
  for (const cid of characterIds) {
    const c = universe.characters.find((x) => x.id === cid);
    if (c) includeCharacter(payload, universe, c);
  }
  payload.stories.push(structuredClone(story));
  return makeBundle('story', story.title, universe, payload);
}

export class BundleError extends Error {}

export function parseBundle(text: string): Bundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BundleError('That file is not valid JSON.');
  }
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (o.format !== BUNDLE_FORMAT) throw new BundleError('That file is not an Omniverse Forge bundle.');
  if (typeof o.schema !== 'number' || o.schema > SCHEMA_VERSION) {
    throw new BundleError('This bundle was made with a newer version of the game.');
  }
  const kind = o.kind;
  if (kind !== 'universe' && kind !== 'character' && kind !== 'item' && kind !== 'story') {
    throw new BundleError('Unknown bundle type.');
  }
  const payload = normalizeUniverse(o.payload);
  return {
    format: BUNDLE_FORMAT,
    schema: SCHEMA_VERSION,
    kind,
    name: typeof o.name === 'string' ? o.name.slice(0, 80) : payload.name,
    author: typeof o.author === 'string' ? o.author.slice(0, 80) : '',
    exportedAt: typeof o.exportedAt === 'number' ? o.exportedAt : 0,
    payload,
  };
}

/** Turns a universe bundle into a brand-new universe with a fresh id. */
export function universeFromBundle(bundle: Bundle): Universe {
  const u = structuredClone(bundle.payload);
  u.id = newId('uni');
  u.createdAt = u.updatedAt = Date.now();
  return u;
}

/**
 * Copies everything in a bundle's payload into `target`, giving each entity a
 * fresh id so imports never collide with existing content.
 */
export function mergeBundle(target: Universe, bundle: Bundle): void {
  const src = structuredClone(bundle.payload);
  const remap = new Map<string, string>();
  const fresh = (oldId: string, prefix: string) => {
    const nid = newId(prefix);
    remap.set(oldId, nid);
    return nid;
  };
  const ref = (oldId: string | null) => (oldId ? remap.get(oldId) ?? null : null);

  for (const f of src.factions) f.id = fresh(f.id, 'fac');
  for (const i of src.items) i.id = fresh(i.id, 'itm');
  for (const l of src.locations) l.id = fresh(l.id, 'loc');
  for (const c of src.characters) c.id = fresh(c.id, 'chr');
  for (const c of src.characters) {
    c.factionId = ref(c.factionId);
    c.itemIds = c.itemIds.map((x) => remap.get(x)).filter((x): x is string => !!x);
    for (const p of c.powers) p.id = newId('pow');
  }
  for (const s of src.stories) {
    s.id = newId('sty');
    s.protagonistId = ref(s.protagonistId);
    for (const ch of s.chapters) remapChapter(ch, ref);
  }

  target.factions.push(...src.factions);
  target.items.push(...src.items);
  target.locations.push(...src.locations);
  target.characters.push(...src.characters);
  target.stories.push(...src.stories);
}

function remapChapter(ch: Story['chapters'][number], ref: (id: string | null) => string | null) {
  ch.id = newId('chp');
  ch.locationId = ref(ch.locationId) ?? '';
  ch.enemyFactionId = ref(ch.enemyFactionId);
  ch.rewardItemId = ref(ch.rewardItemId);
  if (ch.objective.type === 'boss') {
    const boss = ref(ch.objective.characterId);
    ch.objective = boss ? { type: 'boss', characterId: boss } : { type: 'defeat', count: 10 };
  }
}
