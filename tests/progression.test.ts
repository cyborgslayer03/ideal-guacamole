// Mastery trees, gear perks and upgrades, loot drops, the Armory economy, and
// how all of it reaches combat. Plus the audio engine's no-AudioContext path.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createCampaign, dropLoot, loadCampaign, missionBoard, resolveMission, salvageItem, upgradeItem, type Mission } from '../src/core/campaign';
import { generateUniverse } from '../src/core/generator';
import {
  MASTERY_TIERS, boostedPower, loadoutFor, masteryPicks, masteryUnlocked, perkText, perkValue, rollLoot, rollRarity, salvageValue,
  setMastery, unspentMastery, upgradeCost,
} from '../src/core/progression';
import { Rng } from '../src/core/rng';
import { effectiveStats, minionStats, upgradedBonus } from '../src/core/rules';
import type { Character, Item, Power } from '../src/core/types';
import { normalizeItem, normalizeUniverse } from '../src/core/validate';
import { AudioEngine, SFX, musicLayers } from '../src/game/audio';
import { Actor, Combat } from '../src/game/combat';
import { Effects } from '../src/game/effects';

function hero(level = 30): { u: ReturnType<typeof generateUniverse>; c: Character; power: Power } {
  const u = generateUniverse(5);
  const c = u.characters.find((x) => x.role === 'hero')!;
  c.level = level;
  c.powers = [{ id: 'pw1', name: 'Bolt', kind: 'blast', element: 'fire', potency: 8, description: '' }];
  c.itemIds = [];
  return { u, c, power: c.powers[0] };
}

const item = (over: Partial<Item>): Item => ({
  id: `itm_${Math.random().toString(36).slice(2)}`, name: 'Test', slot: 'weapon', rarity: 'epic', description: '', bonuses: { strength: 2 }, color: '#ffffff', level: 0, perk: null, ...over,
});

describe('mastery', () => {
  it('only counts picks for tiers the character has reached', () => {
    const { c, power } = hero(10);
    setMastery(c, power.id, 0, 1);
    setMastery(c, power.id, 1, 2);
    expect(masteryPicks(c, power)).toEqual(['amplify']);
    c.level = 15;
    expect(masteryPicks(c, power)).toEqual(['amplify', 'efficient']);
    expect(unspentMastery(c)).toBe(0);
    c.level = 30;
    expect(unspentMastery(c)).toBe(1);
    expect(masteryUnlocked(4, 30).map((t) => t.level)).toEqual(MASTERY_TIERS.map((t) => t.level));
  });

  it('turns picks into combat modifiers', () => {
    const { u, c, power } = hero();
    c.mastery[power.id] = [2, 1, 1]; // quicken, empower, overload
    const m = loadoutFor(c, u.items).mods[power.id];
    expect(m).toMatchObject({ cooldown: 0.75, potency: 3, overload: true, damage: 1 });
    expect(boostedPower(power, m).potency).toBe(11);
    expect(boostedPower({ ...power, potency: 13 }, m).potency).toBe(14);
  });

  it('survives validation and ignores bad data', () => {
    const { u, c, power } = hero();
    c.mastery = { [power.id]: [1, 2, 1], junk: 'x' as unknown as number[], 'bad key!': [1] };
    const back = normalizeUniverse(JSON.parse(JSON.stringify(u))).characters.find((x) => x.id === c.id)!;
    expect(back.mastery).toEqual({ [power.id]: [1, 2, 1] });
  });
});

describe('gear', () => {
  it('upgrades strengthen stat bonuses and perks', () => {
    const it = item({ bonuses: { strength: 2, speed: -1 }, perk: { type: 'powerDamage', power: 'blast', element: null, value: 20 } });
    expect(upgradedBonus(it, 'strength')).toBe(2);
    it.level = 5;
    expect(upgradedBonus(it, 'strength')).toBe(4);
    expect(upgradedBonus(it, 'speed')).toBe(-2);
    expect(perkValue(it)).toBe(32);
    expect(perkText(it.perk!, perkValue(it))).toBe('+32% Energy Blast damage');
    const { u, c } = hero();
    u.items.push(it);
    c.itemIds = [it.id];
    expect(effectiveStats(c, u.items).strength).toBe(c.stats.strength + 4);
  });

  it('applies perks: power damage, cooldown, potency, element damage, lifesteal, ult charge', () => {
    const { u, c, power } = hero();
    const gear = [
      item({ perk: { type: 'powerDamage', power: 'blast', element: null, value: 20 } }),
      item({ perk: { type: 'powerCooldown', power: 'blast', element: null, value: 20 } }),
      item({ perk: { type: 'elementDamage', power: null, element: 'fire', value: 15 } }),
      item({ perk: { type: 'lifesteal', power: null, element: null, value: 5 } }),
    ];
    u.items.push(...gear);
    c.itemIds = gear.map((g) => g.id);
    const l = loadoutFor(c, u.items);
    expect(l.mods[power.id].damage).toBeCloseTo(1.2);
    expect(l.mods[power.id].cooldown).toBeCloseTo(0.8);
    expect(l.elementDamage.fire).toBeCloseTo(0.15);
    expect(l.lifesteal).toBeCloseTo(0.05);
    // Perks for powers the hero doesn't have do nothing.
    gear[0].perk!.power = 'optic';
    expect(loadoutFor(c, u.items).mods[power.id].damage).toBe(1);
  });

  it('round-trips perks and levels through validation, clamping junk', () => {
    const it = item({ level: 3, perk: { type: 'powerPotency', power: 'web', element: null, value: 2 } });
    expect(normalizeItem(JSON.parse(JSON.stringify(it)))).toEqual(it);
    const bad = normalizeItem({ level: 99, perk: { type: 'lifesteal', value: 500 } });
    expect(bad.level).toBe(5);
    expect(bad.perk).toEqual({ type: 'lifesteal', power: null, element: null, value: 15 });
    expect(normalizeItem({ perk: 'nope' }).perk).toBeNull();
  });
});

describe('loot', () => {
  it('is deterministic and valid', () => {
    const { c } = hero();
    const a = rollLoot(new Rng(9), 'legendary', c);
    const b = rollLoot(new Rng(9), 'legendary', c);
    expect(a).toEqual(b);
    expect(normalizeItem(JSON.parse(JSON.stringify(a)))).toEqual(a);
    expect(Object.keys(a.bonuses).length).toBe(3);
  });

  it('tailors power perks to the hero', () => {
    const { c } = hero();
    for (let seed = 0; seed < 80; seed++) {
      const loot = rollLoot(new Rng(seed), 'mythic', c);
      expect(loot.perk).not.toBeNull();
      if (loot.perk!.power) expect(loot.perk!.power).toBe('blast');
    }
  });

  it('shifts rarity up with luck', () => {
    const score = (luck: number) => {
      const rng = new Rng(3);
      let top = 0;
      for (let i = 0; i < 2000; i++) if (['legendary', 'mythic'].includes(rollRarity(rng, luck))) top++;
      return top;
    };
    expect(score(0.8)).toBeGreaterThan(score(0) * 2);
  });

  it('drops more for raids and S grades', () => {
    const { c } = hero();
    const mission = (kind: Mission['kind']) => ({ kind, difficulty: 3 }) as Mission;
    const base = { victory: true, defeatedBossIds: [], survivingBossIds: [], outcomes: {}, choice: null };
    expect(dropLoot(new Rng(1), mission('raid'), { ...base, grade: 'C' }, c)).toHaveLength(2);
    expect(dropLoot(new Rng(1), mission('raid'), { ...base, grade: 'S' }, c)).toHaveLength(3);
    expect(dropLoot(new Rng(1), mission('story'), { ...base, grade: 'B' }, c)).toHaveLength(1);
  });
});

describe('mission loot', () => {
  it('adds dropped gear to the universe and the chronicle, deterministically', () => {
    const run = () => {
      const u = generateUniverse(21);
      const c = createCampaign(u);
      const hero = u.characters.find((x) => x.role === 'hero')!;
      const m = missionBoard(c, u).find((x) => x.kind === 'raid' || x.kind === 'story' || x.kind === 'hunt')!;
      const before = u.items.length;
      const news = resolveMission(c, u, m, { victory: true, defeatedBossIds: [], survivingBossIds: [], outcomes: {}, choice: null, grade: 'A' }, hero.id);
      const loot = u.items.slice(before);
      return { loot, news: news.filter((n) => n.kind === 'loot') };
    };
    const a = run();
    expect(a.loot.length).toBeGreaterThan(0);
    expect(a.news).toHaveLength(a.loot.length);
    expect(a.news[0].text).toContain(a.loot[0].name);
    expect(run().loot).toEqual(a.loot);
  });
});

describe('armory', () => {
  it('salvages into shards and spends shards on upgrades', () => {
    const u = generateUniverse(8);
    const c = createCampaign(u);
    const junk = item({ rarity: 'rare' });
    const keeper = item({ rarity: 'epic' });
    u.items.push(junk, keeper);
    u.characters[0].itemIds = [junk.id];
    const value = salvageValue(junk);
    expect(salvageItem(c, u, junk.id)).toBe(value);
    expect(u.items).not.toContain(junk);
    expect(u.characters[0].itemIds).not.toContain(junk.id);
    expect(c.shards).toBe(value);

    expect(upgradeItem(c, u, keeper.id)).toBe(false); // can't afford 30
    c.shards = 1000;
    const costs: number[] = [];
    while (upgradeCost(keeper) !== null) {
      costs.push(upgradeCost(keeper)!);
      expect(upgradeItem(c, u, keeper.id)).toBe(true);
    }
    expect(keeper.level).toBe(5);
    expect(costs).toEqual([30, 60, 90, 120, 150]);
    expect(c.shards).toBe(1000 - 450);
    // Salvaging refunds half of what went into upgrades.
    expect(salvageValue(keeper)).toBe(30 + 225);
    expect(loadCampaign(JSON.parse(JSON.stringify(c)), u).shards).toBe(550);
  });
});

describe('loadout in combat', () => {
  const look = { primary: '#ff0000', secondary: '#000000', accent: '#333333', build: 'athletic', height: 1, head: 'helmet', emblem: 'none', cape: false, aura: false, model: null } as const;

  function arena(c: Character, items: Item[]) {
    const scene = new THREE.Scene();
    const combat = new Combat(scene, new Effects(scene), []);
    const a = new Actor(c.alias, 'player', 'hero', effectiveStats(c, items), c.level, look, c.powers, undefined, c, loadoutFor(c, items));
    combat.add(a);
    const e = new Actor('Dummy', 'enemy', 'grunt', minionStats(1, 'grunt'), 1, look, [], 1e6);
    e.pos.set(0, 0, 3);
    combat.add(e);
    return { combat, a, e };
  }

  it('mastery changes cooldown, cost, and adds Overload and Lifeline', () => {
    const { u, c, power } = hero();
    const plain = arena(c, u.items).a.skills[0];
    c.mastery[power.id] = [2, 2, 1];
    const { combat, a, e } = arena(c, u.items);
    expect(a.skills[0].cooldown).toBeLessThan(plain.cooldown);
    expect(a.skills[0].cost).toBe(Math.round(plain.cost / 2));
    combat.castPower(a, 0);
    expect(e.hp).toBeLessThan(e.maxHp); // Overload burst hits the adjacent dummy at once

    c.mastery[power.id] = [1, 1, 2];
    const life = arena(c, u.items);
    life.a.hp = life.a.maxHp / 2;
    life.combat.castPower(life.a, 0);
    expect(life.a.hp).toBeGreaterThan(life.a.maxHp / 2);
  });

  it('lifesteal heals and ultimate charge builds faster', () => {
    const { u, c } = hero();
    const ring = item({ bonuses: {}, perk: { type: 'lifesteal', power: null, element: null, value: 10 } });
    const amp = item({ bonuses: {}, perk: { type: 'ultCharge', power: null, element: null, value: 40 } });
    u.items.push(ring, amp);
    const roll = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const base = arena(c, u.items);
    base.combat.damage(base.e, 200, base.a, null);
    c.itemIds = [ring.id, amp.id];
    const geared = arena(c, u.items);
    geared.a.hp = geared.a.maxHp / 2;
    geared.combat.damage(geared.e, 200, geared.a, null);
    roll.mockRestore();
    expect(geared.a.hp).toBeGreaterThan(geared.a.maxHp / 2);
    expect(geared.a.ultimate).toBeCloseTo(base.a.ultimate * 1.4, 1);
  });
});

describe('audio', () => {
  it('is silent and safe without an AudioContext', () => {
    const engine = new AudioEngine({ master: 1, music: 1, sfx: 1 });
    engine.unlock();
    expect(engine.available).toBe(false);
    for (const s of SFX) engine.play(s, { element: 'fire', pan: 2, gain: 0.5 });
    engine.startMusic();
    engine.setIntensity(2);
    engine.stopMusic();
    expect(engine.played).toBe(0);
  });

  it('layers music by intensity', () => {
    expect(musicLayers(0)).toEqual({ pad: true, bass: false, drums: false, lead: false });
    expect(musicLayers(1)).toMatchObject({ bass: true, drums: true, lead: false });
    expect(musicLayers(2).lead).toBe(true);
  });
});
