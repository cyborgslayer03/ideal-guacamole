// Vertical levels: rooftops, one-way platforms, the spire and skydeck, and
// how movement powers and AI deal with height.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { generateUniverse, randomLocation } from '../src/core/generator';
import { Rng } from '../src/core/rng';
import { findLegend, legendCharacter } from '../src/core/roster';
import { minionHealth, minionStats } from '../src/core/rules';
import type { Appearance, Character } from '../src/core/types';
import { updateEnemy } from '../src/game/ai';
import { buildArena, floorAt, type Obstacle } from '../src/game/arena';
import { Actor, Combat } from '../src/game/combat';
import { Effects } from '../src/game/effects';

const DT = 1 / 60;
const look: Appearance = { primary: '#ff0000', secondary: '#000000', accent: '#333333', build: 'athletic', height: 1, head: 'helmet', emblem: 'none', cape: false, aura: false, model: null };

function world(obstacles: Obstacle[]) {
  const scene = new THREE.Scene();
  return new Combat(scene, new Effects(scene), obstacles);
}

function hero(combat: Combat, c: Character = generateUniverse(1).characters[0]) {
  const a = new Actor(c.alias, 'player', 'hero', c.stats, c.level, c.appearance, c.powers, undefined, c);
  combat.add(a);
  return a;
}

function grunt(combat: Combat, x: number, y: number, z: number) {
  const stats = minionStats(1, 'grunt');
  const e = new Actor('Grunt', 'enemy', 'grunt', stats, 1, look, [], minionHealth(stats, 1, 'grunt'));
  e.pos.set(x, y, z);
  combat.add(e);
  return e;
}

function step(combat: Combat, seconds: number, each: () => void = () => {}) {
  for (let t = 0; t < seconds; t += DT) {
    each();
    combat.update(DT);
  }
}

const roof: Obstacle = { x: 0, z: 0, r: 3, bottom: 0, top: 6, walkable: true };

describe('vertical physics', () => {
  it('lands on rooftops and falls off the edge', () => {
    const c = world([roof]);
    const a = hero(c);
    a.pos.set(0, 10, 0);
    step(c, 1.5);
    expect(a.pos.y).toBeCloseTo(6, 1);
    expect(a.grounded).toBe(true);
    a.pos.x = 4.5; // step off the edge
    step(c, 1.5);
    expect(a.pos.y).toBe(0);
  });

  it('blocks walking into a building from street level', () => {
    const c = world([roof]);
    const a = hero(c);
    a.pos.set(8, 0, 0);
    step(c, 2, () => a.moveIntent.set(-1, 0, 0));
    expect(Math.hypot(a.pos.x, a.pos.z)).toBeGreaterThanOrEqual(3);
  });

  it('jumps up through thin platforms and lands on top of them', () => {
    const platform: Obstacle = { x: 0, z: 0, r: 3, bottom: 2, top: 2.5, walkable: true };
    const c = world([platform]);
    const a = hero(c);
    expect(c.jump(a)).toBe(true);
    step(c, 2);
    expect(a.pos.y).toBeCloseTo(2.5, 1);
  });

  it('a super leap carries a hero onto a rooftop target', () => {
    const c = world([{ x: 15, z: 0, r: 3, bottom: 0, top: 8, walkable: true }]);
    const a = hero(c, legendCharacter(findLegend('aegis')!));
    const e = grunt(c, 15, 8, 0);
    e.ai.spawn = 99;
    step(c, 0.1);
    expect(c.travel(a)).toBe(true);
    step(c, 1.5);
    expect(a.pos.y).toBeCloseTo(8, 0);
  });

  it('a teleport arrives on the same rooftop as its target', () => {
    const c = world([{ x: 10, z: 0, r: 3, bottom: 0, top: 9, walkable: true }]);
    const a = hero(c, legendCharacter(findLegend('nightveil')!));
    grunt(c, 10, 9, 0);
    step(c, 0.1);
    c.travel(a);
    expect(a.pos.y).toBeCloseTo(9, 0);
    step(c, 0.5);
    expect(a.pos.y).toBeCloseTo(9, 0);
  });

  it('minions jump up onto ledges to reach a hero above them', () => {
    const c = world([{ x: 0, z: 0, r: 3, bottom: 0, top: 2.4, walkable: true }]);
    const a = hero(c);
    a.pos.set(0, 2.4, 0);
    const e = grunt(c, 6, 0, 0);
    e.ai.spawn = 0;
    step(c, 4, () => updateEnemy(e, c, DT));
    expect(e.pos.y).toBeCloseTo(2.4, 1);
  });
});

describe('arena levels', () => {
  const arena = buildArena(randomLocation(new Rng(4), 'metropolis'), 99);

  it('has a skydeck and climbable spire steps', () => {
    expect(floorAt(arena.obstacles, 0, 0, 100)).toBeCloseTo(14.4);
    const steps = arena.obstacles.filter((o) => o.walkable && o.bottom === 0 && [2.4, 4.8, 7.2, 9.6, 12, 14.4].some((h) => Math.abs(o.top - h) < 0.01));
    expect(steps.length).toBeGreaterThanOrEqual(6);
  });

  it('offers raised perches for snipers and supply drops', () => {
    expect(arena.perches.filter((p) => p.y > 2).length).toBeGreaterThan(5);
  });

  it('lets a hero climb the spire with ordinary double jumps', () => {
    const c = new Combat(new THREE.Scene(), new Effects(new THREE.Scene()), arena.obstacles);
    const a = hero(c);
    const steps = [2.4, 4.8, 7.2, 9.6, 12, 14.4].map((h) => arena.obstacles.find((o) => o.walkable && o.bottom === 0 && Math.abs(o.top - h) < 0.01)!);
    a.pos.set(steps[0].x, steps[0].top, steps[0].z);
    for (const next of steps.slice(1)) {
      c.jump(a);
      let doubled = false;
      step(c, 1.6, () => {
        a.moveIntent.set(next.x - a.pos.x, 0, next.z - a.pos.z);
        if (a.moveIntent.length() > 0.4) a.moveIntent.normalize();
        else a.moveIntent.set(0, 0, 0);
        if (!doubled && a.vel.y < 1 && !a.grounded) {
          c.jump(a);
          doubled = true;
        }
      });
      expect(a.pos.y, `reach ${next.top}`).toBeCloseTo(next.top, 1);
    }
  });
});
