import { describe, expect, it } from 'vitest';
import { generateUniverse, randomCharacter } from '../src/core/generator';
import { Rng } from '../src/core/rng';
import {
  combatPower, effectiveStats, EFFECTIVE_STAT_MAX, grantXp, maxHealth, powerDamage, rollDamage, xpForLevel,
} from '../src/core/rules';
import {
  bundleCharacter, bundleStory, bundleUniverse, mergeBundle, parseBundle, universeFromBundle, BundleError,
} from '../src/core/share';
import { MemoryStore, UniverseLibrary } from '../src/core/storage';
import { emptyUniverse } from '../src/core/generator';
import { normalizeUniverse } from '../src/core/validate';

describe('rng', () => {
  it('is deterministic per seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });

  it('generates the same universe from the same seed', () => {
    const a = generateUniverse(1234);
    const b = generateUniverse(1234);
    expect(a.characters.map((c) => c.alias)).toEqual(b.characters.map((c) => c.alias));
    expect(a.locations.map((l) => l.name)).toEqual(b.locations.map((l) => l.name));
  });
});

describe('generator', () => {
  it('builds a complete, playable universe', () => {
    const u = generateUniverse(7);
    expect(u.characters.length).toBeGreaterThanOrEqual(4);
    expect(u.characters.some((c) => c.role === 'villain')).toBe(true);
    expect(u.locations.length).toBeGreaterThan(0);
    expect(u.stories).toHaveLength(1);
    const story = u.stories[0];
    expect(story.chapters.length).toBeGreaterThanOrEqual(2);
    for (const ch of story.chapters) expect(u.locations.some((l) => l.id === ch.locationId)).toBe(true);
    // A generated universe should survive validation untouched.
    expect(normalizeUniverse(JSON.parse(JSON.stringify(u)))).toEqual(u);
  });

  it('gives every character at least one attack power', () => {
    for (let seed = 0; seed < 50; seed++) {
      const c = randomCharacter(new Rng(seed));
      expect(c.powers.some((p) => p.kind === 'blast')).toBe(true);
    }
  });
});

describe('rules', () => {
  const u = generateUniverse(99);
  const hero = structuredClone(u.characters[0]);

  it('applies item bonuses and caps effective stats', () => {
    u.items.push({ id: 'itm_x', name: 'Test', slot: 'artifact', rarity: 'mythic', description: '', bonuses: { strength: 50 }, color: '#ffffff' });
    hero.itemIds = ['itm_x'];
    expect(effectiveStats(hero, u.items).strength).toBe(EFFECTIVE_STAT_MAX);
  });

  it('levels up when XP crosses thresholds', () => {
    const c = structuredClone(u.characters[1]);
    c.level = 1;
    c.xp = 0;
    const gained = grantXp(c, xpForLevel(1) + xpForLevel(2) + 5);
    expect(gained).toBe(2);
    expect(c.level).toBe(3);
    expect(c.xp).toBe(5);
  });

  it('scales health with level and power damage with the universe power scale', () => {
    const stats = effectiveStats(hero, u.items);
    expect(maxHealth(stats, 10)).toBeGreaterThan(maxHealth(stats, 1));
    const power = { id: 'p', name: 'Beam', kind: 'blast' as const, element: 'energy' as const, potency: 5, description: '' };
    expect(powerDamage(power, stats, 1, 2)).toBeCloseTo(powerDamage(power, stats, 1, 1) * 2, -1);
  });

  it('rolls crits and mitigates by durability', () => {
    const s = hero.stats;
    const tank = { ...s, durability: 10 };
    const squishy = { ...s, durability: 1 };
    const noCrit = () => 0.99;
    expect(rollDamage(100, s, tank, noCrit).amount).toBeLessThan(rollDamage(100, s, squishy, noCrit).amount);
    expect(rollDamage(100, s, squishy, () => 0).crit).toBe(true);
  });

  it('rates stronger characters with higher combat power', () => {
    const weak = structuredClone(hero);
    weak.itemIds = [];
    const strong = structuredClone(weak);
    strong.level = 20;
    expect(combatPower(strong, u.items)).toBeGreaterThan(combatPower(weak, u.items));
  });
});

describe('validation', () => {
  it('repairs garbage input into a valid universe', () => {
    const u = normalizeUniverse({
      name: 123,
      rules: { powerScale: 99 },
      characters: [{ alias: 'X', stats: { strength: 500 }, factionId: 'missing', powers: [{ kind: 'laser' }] }],
      stories: [{ chapters: [{ objective: { type: 'boss', characterId: 'nope' } }] }],
    });
    expect(u.name).toBe('Untitled Universe');
    expect(u.rules.powerScale).toBe(3);
    expect(u.characters[0].stats.strength).toBe(10);
    expect(u.characters[0].factionId).toBeNull();
    expect(u.characters[0].powers[0].kind).toBe('blast');
    expect(u.stories[0].chapters[0].objective.type).toBe('defeat');
  });

  it('rejects non-object roots gracefully', () => {
    expect(normalizeUniverse(null).characters).toEqual([]);
    expect(normalizeUniverse('hello').name).toBe('Untitled Universe');
  });
});

describe('sharing', () => {
  it('round-trips a universe bundle with a fresh id', () => {
    const u = generateUniverse(5);
    const parsed = parseBundle(JSON.stringify(bundleUniverse(u)));
    const copy = universeFromBundle(parsed);
    expect(copy.id).not.toBe(u.id);
    expect(copy.characters.map((c) => c.alias)).toEqual(u.characters.map((c) => c.alias));
  });

  it('exports a story with everything it depends on and merges without id collisions', () => {
    const source = generateUniverse(11);
    const story = source.stories[0];
    const bundle = bundleStory(source, story.id)!;
    const target = generateUniverse(22);
    const before = target.characters.length;
    mergeBundle(target, parseBundle(JSON.stringify(bundle)));

    const imported = target.stories[target.stories.length - 1];
    expect(imported.title).toBe(story.title);
    expect(target.characters.length).toBeGreaterThan(before);
    for (const ch of imported.chapters) {
      expect(target.locations.some((l) => l.id === ch.locationId)).toBe(true);
      if (ch.objective.type === 'boss') {
        const bossId = ch.objective.characterId;
        expect(target.characters.some((c) => c.id === bossId)).toBe(true);
      }
    }
    const ids = target.characters.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('merging the same character twice yields two distinct copies', () => {
    const source = generateUniverse(3);
    const bundle = bundleCharacter(source, source.characters[0].id)!;
    const target = emptyUniverse();
    mergeBundle(target, bundle);
    mergeBundle(target, bundle);
    expect(target.characters).toHaveLength(2);
    expect(target.characters[0].id).not.toBe(target.characters[1].id);
  });

  it('rejects files that are not bundles', () => {
    expect(() => parseBundle('not json')).toThrow(BundleError);
    expect(() => parseBundle('{"format":"other"}')).toThrow(BundleError);
    expect(() => parseBundle(JSON.stringify({ format: 'omniverse-forge', schema: 999, kind: 'universe', payload: {} }))).toThrow(/newer/);
  });
});

describe('storage', () => {
  it('saves, lists, loads, and removes universes', () => {
    const lib = new UniverseLibrary(new MemoryStore());
    const u = generateUniverse(8);
    lib.save(u);
    expect(lib.list()).toHaveLength(1);
    expect(lib.list()[0].characterCount).toBe(u.characters.length);
    expect(lib.load(u.id)?.name).toBe(u.name);
    lib.remove(u.id);
    expect(lib.list()).toHaveLength(0);
    expect(lib.load(u.id)).toBeNull();
  });
});
