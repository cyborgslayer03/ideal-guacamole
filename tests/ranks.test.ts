// Character ranks (stars) and biometrics, and the Danger Room.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createCampaign, loadCampaign, missionBoard, rankUp, resolveDangerRoom, resolveMission } from '../src/core/campaign';
import { DANGER_WAVES, dangerRoomPlan } from '../src/core/danger';
import { generateUniverse } from '../src/core/generator';
import { rankUpCost } from '../src/core/progression';
import { MAX_STARS, combatPower, rankBonus } from '../src/core/rules';
import { normalizeUniverse } from '../src/core/validate';
import { Actor, Combat } from '../src/game/combat';
import { Effects } from '../src/game/effects';

describe('ranks', () => {
  it('stars add health and damage, and raise combat power', () => {
    expect(rankBonus(1)).toEqual({ health: 1, damage: 1 });
    expect(rankBonus(6).health).toBeCloseTo(1.5);
    expect(rankBonus(99)).toEqual(rankBonus(MAX_STARS));
    const u = generateUniverse(3);
    const c = structuredClone(u.characters[0]);
    const base = combatPower(c, u.items);
    c.stars = 4;
    expect(combatPower(c, u.items)).toBeGreaterThan(base);
  });

  it('applies the rank in combat', () => {
    const u = generateUniverse(4);
    const ch = structuredClone(u.characters[0]);
    const scene = new THREE.Scene();
    const combat = new Combat(scene, new Effects(scene), []);
    const one = new Actor(ch.alias, 'player', 'hero', ch.stats, ch.level, ch.appearance, ch.powers, undefined, ch);
    ch.stars = 6;
    const six = new Actor(ch.alias, 'player', 'hero', ch.stats, ch.level, ch.appearance, ch.powers, undefined, ch);
    combat.add(one);
    combat.add(six);
    expect(six.maxHp).toBe(Math.round(one.maxHp * 1.5));
    expect(six.damageMult).toBeCloseTo(1.4);
  });

  it('missions earn biometrics; ranking up spends them', () => {
    const u = generateUniverse(5);
    const c = createCampaign(u);
    const hero = u.characters.find((x) => x.role === 'hero')!;
    const mate = u.characters.find((x) => x.role === 'hero' && x !== hero)!;
    const m = missionBoard(c, u)[0];
    resolveMission(c, u, m, { victory: true, defeatedBossIds: [], survivingBossIds: [], outcomes: {}, choice: null, grade: 'S', squadIds: [mate.id] }, hero.id);
    expect(c.biometrics[hero.id]).toBe(6);
    expect(c.biometrics[mate.id]).toBe(2);
    expect(rankUp(c, u, hero.id)).toBe(false); // needs 10
    c.biometrics[hero.id] = 1000;
    let spent = 0;
    while (rankUpCost(hero.stars) !== null) {
      spent += rankUpCost(hero.stars)!;
      expect(rankUp(c, u, hero.id)).toBe(true);
    }
    expect(hero.stars).toBe(MAX_STARS);
    expect(c.biometrics[hero.id]).toBe(1000 - spent);
    expect(rankUp(c, u, hero.id)).toBe(false);
    const back = loadCampaign(JSON.parse(JSON.stringify(c)), u);
    expect(back.biometrics).toEqual(c.biometrics);
    expect(normalizeUniverse(JSON.parse(JSON.stringify(u))).characters.find((x) => x.id === hero.id)!.stars).toBe(6);
  });
});

describe('Danger Room', () => {
  it('escalates forever, with a villain every fifth wave', () => {
    const u = generateUniverse(6);
    const plan = dangerRoomPlan(u, 10, []);
    expect(plan.phases).toHaveLength(DANGER_WAVES);
    const levels = plan.phases.map((p) => (p.kind === 'patrol' ? 0 : p.level ?? 0));
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1]);
    plan.phases.forEach((p, i) => {
      if ((i + 1) % 5 === 0) {
        expect(p.kind).toBe('bosses');
        if (p.kind === 'bosses') expect(u.characters.find((c) => c.id === p.bossIds[0])?.role).not.toBe('hero');
      } else expect(p.kind).toBe('defeat');
    });
    const counts = plan.phases.filter((p) => p.kind === 'defeat').map((p) => (p.kind === 'defeat' ? p.count : 0));
    expect(counts[counts.length - 1]).toBeGreaterThan(counts[0]);
    expect(plan.decideBosses).toBe(false);
  });

  it('pays out by waves cleared and keeps the best run', () => {
    const u = generateUniverse(7);
    const c = createCampaign(u);
    const hero = u.characters.find((x) => x.role === 'hero')!;
    resolveDangerRoom(c, u, hero.id, [], 7);
    expect(c.dangerBest).toBe(7);
    expect(c.shards).toBe(42);
    expect(c.biometrics[hero.id]).toBe(11);
    const news = resolveDangerRoom(c, u, hero.id, [], 3);
    expect(c.dangerBest).toBe(7);
    expect(news[0].text).not.toContain('record');
    expect(resolveDangerRoom(c, u, hero.id, [], 9)[0].text).toContain('new record');
    expect(loadCampaign(JSON.parse(JSON.stringify(c)), u).dangerBest).toBe(9);
  });
});
