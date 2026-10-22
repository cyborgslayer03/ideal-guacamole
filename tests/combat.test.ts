// Runs the real combat simulation headlessly (no renderer) to check that
// fights actually resolve: enemies chase and hit, the hero can win.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { generateUniverse } from '../src/core/generator';
import { findLegend, legendCharacter } from '../src/core/roster';
import { effectiveStats, minionHealth, minionStats } from '../src/core/rules';
import type { Appearance, Character } from '../src/core/types';
import { updateAlly, updateEnemy } from '../src/game/ai';
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

  it('an AI companion fights alongside an idle hero', () => {
    const u = generateUniverse(8);
    const { combat, player, kills } = setup(u.characters[0], u.items);
    const friend = u.characters[1];
    const ally = new Actor(friend.alias, 'player', 'ally', effectiveStats(friend, u.items), 5, friend.appearance, friend.powers, undefined, friend);
    ally.pos.set(2, 0, 0);
    combat.add(ally);
    addGrunt(combat, 12, 0);
    addGrunt(combat, -12, 0);
    run(combat, 30, () => updateAlly(ally, combat, DT, player));
    expect(kills.length).toBeGreaterThan(0);
  });

  describe('movement powers', () => {
    const legend = (key: string) => legendCharacter(findLegend(key)!);

    it('teleport blinks next to the target and shocks it', () => {
      const { combat, player } = setup(legend('nightveil'));
      const e = addGrunt(combat, 14, 0);
      player.faceToward(e.pos);
      expect(combat.travel(player)).toBe(true);
      expect(player.pos.distanceTo(e.pos)).toBeLessThan(4);
      expect(e.hp).toBeLessThan(e.maxHp);
      expect(combat.travel(player)).toBe(false); // on cooldown
      expect(player.travelRemaining).toBeGreaterThan(0);
    });

    it('super leap arcs onto the target and slams on landing', () => {
      const { combat, player } = setup(legend('aegis'));
      const e = addGrunt(combat, 15, 0);
      e.ai.spawn = 99; // keep it still
      expect(combat.travel(player)).toBe(true);
      expect(player.grounded).toBe(false);
      const spot = e.pos.clone();
      run(combat, 1.5, () => {});
      expect(player.grounded).toBe(true);
      // Lands where the target stood (the slam knocks the target away).
      expect(player.pos.distanceTo(spot)).toBeLessThan(3);
      expect(e.hp).toBeLessThan(e.maxHp);
    });

    it('super speed makes a speedster outrun everyone', () => {
      const speedster = setup(legend('voltstream')).player;
      const tank = setup(legend('aegis')).player;
      expect(speedster.speed).toBeGreaterThan(tank.speed * 1.5);
      expect(speedster.travel).toBeNull(); // passive, nothing on V
    });

    it('flight toggles on the travel button', () => {
      const { combat, player } = setup(legend('seraph'));
      combat.travel(player);
      expect(player.flying).toBe(true);
      combat.travel(player);
      expect(player.flying).toBe(false);
    });

    it('a teleporting boss closes the distance on its own', () => {
      const u = generateUniverse(5);
      const { combat, player } = setup(u.characters[0], u.items);
      const hex = legend('hexmother');
      const boss = new Actor(hex.alias, 'enemy', 'boss', hex.stats, 5, hex.appearance, hex.powers, 5000, hex);
      boss.pos.set(0, 0, 30);
      combat.add(boss);
      let blinked = false;
      run(combat, 3, () => {
        if (boss.travelRemaining > 0) blinked = true;
      });
      expect(blinked).toBe(true);
      expect(boss.pos.distanceTo(player.pos)).toBeLessThan(15);
    });
  });
});
