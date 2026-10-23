// Free-aimed traversal, portals, destructible scenery, squad banter, and the
// daily challenge.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { banterLine, moodOf } from '../src/core/banter';
import { DAILY_MODIFIERS, dailyChallenge, dailyStreak, todayKey } from '../src/core/daily';
import { minionStats, travelRange } from '../src/core/rules';
import type { Appearance, Element, PowerKind, Stats } from '../src/core/types';
import { normalizeUniverse } from '../src/core/validate';
import { updateEnemy } from '../src/game/ai';
import { ARENA_RADIUS, aimPoint, type Obstacle } from '../src/game/arena';
import { Actor, Combat } from '../src/game/combat';
import { Effects } from '../src/game/effects';
import { createProp, scatterProps } from '../src/game/props';

const DT = 1 / 60;
const look: Appearance = { primary: '#ff0000', secondary: '#000000', accent: '#333333', build: 'athletic', height: 1, head: 'helmet', emblem: 'none', cape: false, aura: false, model: null };
const stats: Stats = { strength: 6, speed: 6, durability: 6, energy: 8, intelligence: 6, combat: 6 };
const pw = (kind: PowerKind, element: Element = 'kinetic', potency = 6) => ({ id: `p_${kind}`, name: kind, kind, element, potency, description: '' });

function arena(obstacles: Obstacle[] = []) {
  const scene = new THREE.Scene();
  return new Combat(scene, new Effects(scene), obstacles);
}
function hero(combat: Combat, kind: PowerKind, element: Element = 'kinetic') {
  const a = new Actor('Hero', 'player', 'hero', stats, 10, look, [pw(kind, element)]);
  combat.add(a);
  return a;
}
function grunt(combat: Combat, x: number, z: number) {
  const e = new Actor('Grunt', 'enemy', 'grunt', minionStats(1, 'grunt'), 1, look, [], 1e6);
  e.pos.set(x, 0, z);
  combat.add(e);
  return e;
}
const step = (combat: Combat, seconds: number, each?: () => void) => {
  for (let t = 0; t < seconds; t += DT) {
    each?.();
    combat.update(DT);
  }
};
const rayFrom = (from: THREE.Vector3, to: THREE.Vector3) => new THREE.Ray(from, to.clone().sub(from).normalize());

describe('free aim', () => {
  const roof: Obstacle = { x: 10, z: 0, r: 4, bottom: 0, top: 8, walkable: true };

  it('lands on the ground, on rooftops, and in front of walls', () => {
    const origin = new THREE.Vector3(0, 0, 0);
    const eye = new THREE.Vector3(0, 12, -6);
    const ground = aimPoint([roof], origin, rayFrom(eye, new THREE.Vector3(-5, 0, 10)), 30);
    expect(ground.point.y).toBeCloseTo(0);
    expect(ground.clamped).toBe(false);
    const top = aimPoint([roof], origin, rayFrom(eye, new THREE.Vector3(10, 8, 0)), 30);
    expect(top.point.y).toBe(8);
    // Aiming straight at the wall from ground level lands at its foot.
    const wall = aimPoint([roof], origin, rayFrom(new THREE.Vector3(0, 2, 0), new THREE.Vector3(10, 2, 0)), 30);
    expect(wall.point.x).toBeLessThan(6);
    expect(wall.point.y).toBe(0);
  });

  it('pulls far aims back to the power range and inside the arena', () => {
    const origin = new THREE.Vector3(0, 0, 0);
    const far = aimPoint([], origin, rayFrom(new THREE.Vector3(0, 3, 0), new THREE.Vector3(0, 0, 200)), 20);
    expect(far.clamped).toBe(true);
    expect(Math.hypot(far.point.x, far.point.z)).toBeCloseTo(20, 0);
    const edge = aimPoint([], new THREE.Vector3(0, 0, ARENA_RADIUS - 5), rayFrom(new THREE.Vector3(0, 3, ARENA_RADIUS - 5), new THREE.Vector3(0, 0, ARENA_RADIUS + 20)), 30);
    expect(Math.hypot(edge.point.x, edge.point.z)).toBeLessThanOrEqual(ARENA_RADIUS - 2 + 1e-6);
    // Up into the sky: fall back to straight ahead at full range.
    const sky = aimPoint([], origin, new THREE.Ray(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 1, 1).normalize()), 15);
    expect(sky.clamped).toBe(true);
    expect(sky.point.z).toBeCloseTo(15, 0);
  });

  it('sends teleport, leap and swing exactly where aimed, even with an enemy nearby', () => {
    for (const kind of ['teleport', 'leap', 'swing'] as const) {
      const roof: Obstacle = { x: 0, z: 14, r: 4, bottom: 0, top: 6, walkable: true };
      const combat = arena([roof]);
      const h = hero(combat, kind);
      grunt(combat, 6, 0);
      const aim = new THREE.Vector3(0, 6, 14);
      expect(combat.travel(h, null, aim)).toBe(true);
      step(combat, 1.5);
      expect(Math.hypot(h.pos.x - aim.x, h.pos.z - aim.z), kind).toBeLessThan(1.5);
      expect(h.pos.y, kind).toBeCloseTo(6, 0);
    }
  });
});

describe('portals', () => {
  it('opens a pair, moves the caster, and carries anyone who steps in', () => {
    const combat = arena();
    const h = hero(combat, 'portal', 'cosmic');
    const ally = new Actor('Ally', 'player', 'ally', stats, 10, look, []);
    ally.pos.set(0, 0, -3);
    combat.add(ally);
    const e = grunt(combat, 20, 20);
    expect(travelRange(h.travel!)).toBeGreaterThan(24);
    expect(combat.travel(h, null, new THREE.Vector3(0, 0, 20))).toBe(true);
    expect(h.pos.z).toBeGreaterThan(20);
    // The ally walks into the entrance (at the hero's old spot) and comes out the far end.
    step(combat, 1, () => ally.moveIntent.set(0, 0, 1));
    expect(ally.pos.z).toBeGreaterThan(15);
    // Enemies can use it too, from the far side back.
    e.pos.set(0, 0, 20.3);
    step(combat, 0.1);
    expect(e.pos.z).toBeLessThan(5);
  });

  it('closes after a while', () => {
    const combat = arena();
    const h = hero(combat, 'portal');
    combat.travel(h, null, new THREE.Vector3(0, 0, 15));
    step(combat, 12);
    const walker = grunt(combat, 0, 0.5);
    step(combat, 0.2);
    expect(walker.pos.z).toBeLessThan(5);
  });

  it('AI can open portals toward its target', () => {
    const combat = arena();
    const boss = new Actor('Gatekeeper', 'enemy', 'boss', stats, 10, look, [pw('portal', 'cosmic')], 5000);
    combat.add(boss);
    const h = hero(combat, 'blast');
    h.pos.set(0, 0, 25);
    let moved = false;
    for (let t = 0; t < 6 && !moved; t += DT) {
      updateEnemy(boss, combat, DT);
      combat.update(DT);
      moved = boss.pos.distanceTo(h.pos) < 8;
    }
    expect(moved).toBe(true);
  });
});

describe('destructible scenery', () => {
  it('is smashed by attacks but never targeted', () => {
    const combat = arena();
    const h = hero(combat, 'nova');
    const crate = createProp('crate');
    crate.pos.set(2, 0, 0);
    combat.add(crate);
    const kills: Actor[] = [];
    combat.onKill = (t) => kills.push(t);
    let broken = 0;
    combat.onPropBroken = () => broken++;
    expect(combat.findTarget(h, 50)).toBeNull();
    const g = grunt(combat, 15, 0);
    for (let t = 0; t < 3; t += DT) {
      updateEnemy(g, combat, DT);
      combat.update(DT);
    }
    expect(g.pos.distanceTo(h.pos)).toBeLessThan(g.pos.distanceTo(new THREE.Vector3(15, 0, 0)));
    h.energy = h.maxEnergy;
    combat.castPower(h, 0);
    step(combat, 0.2);
    expect(broken).toBe(1);
    expect(kills).toHaveLength(0);
    expect(combat.actors).not.toContain(crate);
  });

  it('fuel barrels explode on the smasher\'s enemies', () => {
    const combat = arena();
    const h = hero(combat, 'blast');
    const barrel = createProp('barrel');
    barrel.pos.set(10, 0, 0);
    combat.add(barrel);
    const g = grunt(combat, 12, 0);
    combat.damage(barrel, 9999, h, null);
    step(combat, 0.1);
    expect(g.hp).toBeLessThan(g.maxHp);
    expect(h.hp).toBe(h.maxHp);
  });

  it('telekinesis hurls nearby scenery at the target', () => {
    const combat = arena();
    const h = hero(combat, 'telekinesis', 'psychic');
    const car = createProp('car');
    car.pos.set(-4, 0, 0);
    combat.add(car);
    const g = grunt(combat, 0, 12);
    combat.castPower(h, 0);
    step(combat, 1.2);
    expect(combat.actors).not.toContain(car);
    expect(g.hp).toBeLessThan(g.maxHp);
  });

  it('scatters props deterministically, clear of buildings', () => {
    const obstacles: Obstacle[] = [{ x: 20, z: 0, r: 6, bottom: 0, top: 20, walkable: true }];
    const a = scatterProps(7, 'metropolis', obstacles);
    const b = scatterProps(7, 'metropolis', obstacles);
    expect(a.length).toBeGreaterThan(5);
    expect(a.map((p) => [p.name, p.pos.x])).toEqual(b.map((p) => [p.name, p.pos.x]));
    for (const p of a) expect(Math.hypot(p.pos.x - 20, p.pos.z)).toBeGreaterThan(6 + p.radius);
    expect(a.some((p) => p.name === 'Car')).toBe(true);
    expect(scatterProps(7, 'frozen', obstacles).some((p) => p.name === 'Car')).toBe(false);
  });
});

describe('banter', () => {
  it('matches tone to the relationship and fills in names', () => {
    expect(moodOf(80)).toBe('warm');
    expect(moodOf(10)).toBe('neutral');
    expect(moodOf(-30)).toBe('prickly');
    for (const roll of [0, 0.5, 0.99]) {
      const line = banterLine('revive', -50, 'Aegis', roll);
      expect(line).not.toContain('{name}');
    }
    expect(banterLine('combo', 90, 'Silkstrider', 0)).toBe('Nice combo, Silkstrider!');
  });
});

describe('daily challenge', () => {
  it('is the same for a given date and different across days', () => {
    const a = dailyChallenge('2026-10-22');
    const b = dailyChallenge('2026-10-22');
    expect(a.universe.characters.map((c) => c.alias)).toEqual(b.universe.characters.map((c) => c.alias));
    expect(a.modifiers).toEqual(b.modifiers);
    // Ids are fresh each time; everything you play against is the same.
    const shape = (d: typeof a) => ({ ...d.plan, allyIds: d.plan.allyIds.length, factionId: null, locationId: null, bossPower: null,
      phases: d.plan.phases.map((p) => (p.kind === 'bosses' ? d.universe.characters.find((c) => c.id === p.bossIds[0])?.alias : p.kind)),
      hero: d.universe.characters.find((c) => c.id === d.heroId)?.alias });
    expect(shape(a)).toEqual(shape(b));
    expect(dailyChallenge('2026-10-23').seed).not.toBe(a.seed);
  });

  it('builds a valid, playable mission with its modifiers applied', () => {
    for (const date of ['2026-01-01', '2026-06-15', '2026-12-31']) {
      const d = dailyChallenge(date);
      expect(d.modifiers.length).toBeGreaterThanOrEqual(1);
      for (const m of d.modifiers) expect(DAILY_MODIFIERS).toContain(m);
      const valid = normalizeUniverse(JSON.parse(JSON.stringify(d.universe)));
      expect(valid.rules).toEqual(d.universe.rules);
      expect(d.universe.characters.some((c) => c.id === d.heroId)).toBe(true);
      const bosses = d.plan.phases.find((p) => p.kind === 'bosses');
      expect(bosses?.kind === 'bosses' && d.universe.characters.some((c) => c.id === bosses.bossIds[0])).toBe(true);
      expect(d.universe.locations.some((l) => l.id === d.plan.locationId)).toBe(true);
    }
  });

  it('counts streaks of consecutive days', () => {
    const rec = { score: 80, grade: 'A' };
    expect(dailyStreak({}, '2026-10-22')).toBe(0);
    expect(dailyStreak({ '2026-10-22': rec, '2026-10-21': rec, '2026-10-19': rec }, '2026-10-22')).toBe(2);
    // Not played yet today: yesterday's streak still counts.
    expect(dailyStreak({ '2026-10-21': rec, '2026-10-20': rec }, '2026-10-22')).toBe(2);
    expect(dailyStreak({ '2026-02-28': rec, '2026-03-01': rec }, '2026-03-01')).toBe(2);
    expect(todayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});
