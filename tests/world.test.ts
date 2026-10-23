// The living world: civilians, traffic, lava, and biome-appropriate populations.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { minionStats } from '../src/core/rules';
import { BIOMES, type Appearance } from '../src/core/types';
import { ARENA_RADIUS, ROAD_RADIUS, type Hazard, type Obstacle } from '../src/game/arena';
import { Actor, Combat } from '../src/game/combat';
import { CrowdSim, CrowdView, speciesFor, type Threat } from '../src/game/crowd';
import { Effects } from '../src/game/effects';
import { Traffic } from '../src/game/traffic';

const DT = 1 / 30;
const seeded = (seed = 1) => {
  const r = new Rng(seed);
  return () => r.next();
};

describe('civilians', () => {
  it('fit their world: humans on Earth, aliens in space, demons below', () => {
    expect(speciesFor('metropolis')).toBe('human');
    expect(speciesFor('cosmic')).toBe('alien');
    expect(speciesFor('underworld')).toBe('demon');
    for (const b of BIOMES) expect(speciesFor(b)).toBeTruthy();
  });

  it('wander without walking into buildings or lava', () => {
    const tower: Obstacle = { x: 10, z: 0, r: 4, bottom: 0, top: 20, walkable: false };
    const lava: Hazard = { x: -10, z: 0, r: 4, dps: 0.1 };
    const sim = new CrowdSim([tower], [lava], seeded());
    sim.spawn(30, 'human');
    for (let t = 0; t < 30; t += DT) sim.update(DT, [], null);
    for (const c of sim.civilians) {
      expect(Math.hypot(c.pos.x - 10, c.pos.z)).toBeGreaterThan(4.2);
      expect(Math.hypot(c.pos.x + 10, c.pos.z)).toBeGreaterThan(4.3);
      expect(Math.hypot(c.pos.x, c.pos.z)).toBeLessThanOrEqual(ARENA_RADIUS);
    }
    expect(sim.civilians.some((c) => c.stride > 1)).toBe(true);
  });

  it('flee and scream when enemies come close, cower from explosions', () => {
    const sim = new CrowdSim([], [], seeded(2));
    const [a, b] = sim.spawn(2, 'human', new THREE.Vector3(20, 0, 0), 0.1);
    b.pos.set(-20, 0, 0);
    const enemy: Threat = { pos: new THREE.Vector3(17, 0, 0), radius: 12, power: 1 };
    const events = sim.update(DT, [enemy], null);
    expect(a.state).toBe('flee');
    expect(b.state).not.toBe('flee');
    expect(events.every((e) => e.kind === 'scream' || e.kind === 'gasp')).toBe(true);
    const start = a.pos.distanceTo(enemy.pos);
    for (let t = 0; t < 1.5; t += DT) sim.update(DT, [enemy], null);
    expect(a.pos.distanceTo(enemy.pos)).toBeGreaterThan(start + 4);
    const blast: Threat = { pos: b.pos.clone().add(new THREE.Vector3(2, 0, 0)), radius: 9, power: 2 };
    sim.update(DT, [blast], null);
    expect(b.state).toBe('cower');
  });

  it('cheer for the hero once the danger has passed', () => {
    const sim = new CrowdSim([], [], seeded(3));
    const [c] = sim.spawn(1, 'alien', new THREE.Vector3(5, 0, 0), 0.1);
    const hero = new THREE.Vector3(0, 0, 0);
    sim.update(DT, [{ pos: new THREE.Vector3(8, 0, 0), radius: 12, power: 1 }], hero);
    expect(c.fear).toBeGreaterThan(0.5);
    const kinds = new Set<string>();
    let cheered = false;
    for (let t = 0; t < 10 && !cheered; t += DT) {
      for (const e of sim.update(DT, [], hero)) kinds.add(e.kind);
      cheered = c.state === 'cheer';
    }
    expect(cheered).toBe(true);
  });

  it('cowering hostages stay put until released', () => {
    const sim = new CrowdSim([], [], seeded(4));
    const spot = new THREE.Vector3(15, 0, 15);
    const hostages = sim.spawn(5, 'demon', spot, 3, 'cower');
    for (let t = 0; t < 5; t += DT) sim.update(DT, [], null);
    expect(hostages.every((h) => h.state === 'cower')).toBe(true);
    sim.release(spot, 6);
    for (let t = 0; t < 1; t += DT) sim.update(DT, [], null);
    expect(hostages.every((h) => h.state !== 'cower')).toBe(true);
  });

  it('builds a body for every species', () => {
    const scene = new THREE.Scene();
    const view = new CrowdView(scene);
    const sim = new CrowdSim([], [], seeded(5));
    for (const b of BIOMES) sim.spawn(2, speciesFor(b));
    view.update(sim, 0);
    expect(view.group.children.length).toBe(BIOMES.length * 2);
    sim.civilians.splice(0, 4);
    view.update(sim, 1);
    expect(view.group.children.length).toBe(BIOMES.length * 2 - 4);
    view.dispose();
  });
});

describe('traffic', () => {
  const road = { radius: ROAD_RADIUS, width: 7 };

  it('drives the ring road and brakes and honks for someone in the way', () => {
    const scene = new THREE.Scene();
    const traffic = new Traffic(scene, 'metropolis', new Rng(1), road);
    expect(traffic.carCount).toBe(10);
    traffic.update(DT, 0, [], []);
    const before = traffic.carPositions();
    for (const p of before) expect(Math.abs(Math.hypot(p.x, p.z) - ROAD_RADIUS)).toBeLessThan(2.5);
    for (let t = 0; t < 1; t += DT) traffic.update(DT, t, [], []);
    const moved = traffic.carPositions();
    expect(moved.every((p, i) => p.distanceTo(before[i]) > 3)).toBe(true);

    // A hero stands in front of the first car.
    const car = moved[0];
    const blocker = car.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -5 / ROAD_RADIUS);
    let honks = 0;
    for (let t = 0; t < 4; t += DT) honks += traffic.update(DT, t, [blocker, car.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 5 / ROAD_RADIUS)], []).length;
    const after = traffic.carPositions()[0];
    expect(after.distanceTo(car)).toBeLessThan(5);
    expect(honks).toBeGreaterThan(0);
    traffic.dispose();
  });

  it('only cities have cars; skies have their own fliers', () => {
    const scene = new THREE.Scene();
    const space = new Traffic(scene, 'cosmic', new Rng(2), null);
    expect(space.carCount).toBe(0);
    expect(space.group.children.length).toBeGreaterThan(0);
    space.dispose();
  });
});

describe('lava', () => {
  it('burns whoever stands in it', () => {
    const scene = new THREE.Scene();
    const combat = new Combat(scene, new Effects(scene), []);
    combat.hazards = [{ x: 0, z: 0, r: 4, dps: 0.1 }];
    const look: Appearance = { primary: '#f00', secondary: '#000', accent: '#333', build: 'athletic', height: 1, head: 'helmet', emblem: 'none', cape: false, aura: false, model: null };
    const inLava = new Actor('Grunt', 'enemy', 'grunt', minionStats(1, 'grunt'), 1, look, [], 1000);
    const safe = new Actor('Grunt', 'enemy', 'grunt', minionStats(1, 'grunt'), 1, look, [], 1000);
    safe.pos.set(10, 0, 0);
    combat.add(inLava);
    combat.add(safe);
    for (let t = 0; t < 2; t += DT) combat.update(DT);
    expect(inLava.hp).toBeLessThan(850);
    expect(safe.hp).toBe(1000);
  });
});
