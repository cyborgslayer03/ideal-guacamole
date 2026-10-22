// Runs the real combat simulation headlessly (no renderer) to check that
// fights actually resolve: enemies chase and hit, the hero can win.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { generateUniverse } from '../src/core/generator';
import { effectiveStats, minionHealth, minionStats } from '../src/core/rules';
import type { Appearance, Character } from '../src/core/types';
import { updateEnemy } from '../src/game/ai';
import { Actor, Combat } from '../src/game/combat';
import { Effects } from '../src/game/effects';

const DT = 1 / 60;
const grunt: Appearance = { primary: '#ff0000', secondary: '#000000', accent: '#333333', build: 'athletic', height: 1, head: 'helmet', emblem: 'none', cape: false, aura: false };

function setup(hero: Character, items = generateUniverse(1).items) {
  const scene = new THREE.Scene();
  const combat = new Combat(scene, new Effects(scene), []);
  const player = new Actor(hero.alias, 'player', 'hero', effectiveStats(hero, items), hero.level, hero.appearance, hero.powers, undefined, hero);
  combat.add(player);
  const kills: Actor[] = [];
  combat.onKill = (t) => kills.push(t);
  return { combat, player, kills };
}

function addGrunt(combat: Combat, x: number, z: number, type: 'grunt' | 'gunner' | 'brute' = 'grunt') {
  const stats = minionStats(1, type);
  const e = new Actor('Grunt', 'enemy', type, stats, 1, grunt, [], minionHealth(stats, 1, type));
  e.pos.set(x, 0, z);
  combat.add(e);
  return e;
}

/** A simple autopilot: chase the nearest enemy, combo, and fire powers. */
function autopilot(combat: Combat, p: Actor) {
  const target = combat.findTarget(p, 100);
  p.moveIntent.set(0, 0, 0);
  if (!target) return;
  const d = target.pos.distanceTo(p.pos);
  if (d > 2.5) p.moveIntent.copy(target.pos).sub(p.pos).setY(0).normalize();
  else combat.basicAttack(p);
  for (let i = 0; i < p.skills.length; i++) combat.castPower(p, i);
}

function run(combat: Combat, seconds: number, each: () => void) {
  for (let t = 0; t < seconds; t += DT) {
    each();
    for (const a of combat.actors) if (a.team === 'enemy') updateEnemy(a, combat, DT);
    combat.update(DT);
  }
}

describe('combat simulation', () => {
  it('enemies close the distance and damage an idle hero', () => {
    const hero = generateUniverse(2).characters[0];
    const { combat, player } = setup(hero);
    const e = addGrunt(combat, 20, 0);
    run(combat, 8, () => {});
    expect(e.pos.distanceTo(player.pos)).toBeLessThan(4);
    expect(player.hp).toBeLessThan(player.maxHp);
  });

  it('a hero defeats a squad of minions and charges their ultimate', () => {
    const hero = generateUniverse(3).characters[0];
    const { combat, player, kills } = setup(hero);
    addGrunt(combat, 8, 0);
    addGrunt(combat, -8, 3);
    addGrunt(combat, 0, 10, 'gunner');
    run(combat, 30, () => autopilot(combat, player));
    expect(kills).toHaveLength(3);
    expect(player.alive).toBe(true);
    expect(player.ultimate).toBeGreaterThan(0);
  });

  it('the ultimate hits every enemy in range', () => {
    const hero = generateUniverse(4).characters[0];
    const { combat, player } = setup(hero);
    const near = [addGrunt(combat, 4, 0), addGrunt(combat, -4, 0)];
    const far = addGrunt(combat, 40, 0);
    player.ultimate = 100;
    expect(combat.ultimate(player)).toBe(true);
    for (const e of near) expect(e.hp).toBeLessThan(e.maxHp);
    expect(far.hp).toBe(far.maxHp);
    expect(combat.ultimate(player)).toBe(false);
  });

  it('a boss uses its powers against the player', () => {
    const u = generateUniverse(6);
    const villain = u.characters.find((c) => c.role === 'villain')!;
    const hero = u.characters[0];
    const { combat, player } = setup(hero, u.items);
    const boss = new Actor(villain.alias, 'enemy', 'boss', effectiveStats(villain, u.items), 5, villain.appearance, villain.powers, 5000, villain);
    boss.pos.set(6, 0, 0);
    combat.add(boss);
    let casts = 0;
    const cast = combat.castPower.bind(combat);
    combat.castPower = (a, slot) => {
      const ok = cast(a, slot);
      if (ok && a === boss) casts++;
      return ok;
    };
    run(combat, 12, () => {});
    expect(casts).toBeGreaterThan(0);
    expect(player.hp).toBeLessThan(player.maxHp);
  });

  it('dodging grants brief invulnerability', () => {
    const hero = generateUniverse(7).characters[0];
    const { combat, player } = setup(hero);
    const e = addGrunt(combat, 1.5, 0);
    expect(combat.dodge(player)).toBe(true);
    combat.damage(player, 100, e, null);
    expect(player.hp).toBe(player.maxHp);
  });
});
