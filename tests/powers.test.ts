// The wider power set (web, optic, telekinesis, reality, mind control, and the
// rest), checked headlessly against the real combat simulation.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { generateUniverse, randomPowerSet } from '../src/core/generator';
import { Rng } from '../src/core/rng';
import { POWER_INFO, POWER_LABELS, minionHealth, minionStats, powerCooldown, powerCost } from '../src/core/rules';
import { POWER_KINDS, takesSkillSlot, type Appearance, type Element, type PowerKind, type Stats } from '../src/core/types';
import { normalizeUniverse } from '../src/core/validate';
import { powerUseful, updateEnemy } from '../src/game/ai';
import { Actor, Combat } from '../src/game/combat';
import { Effects } from '../src/game/effects';

const DT = 1 / 60;
const look: Appearance = { primary: '#ff0000', secondary: '#000000', accent: '#333333', build: 'athletic', height: 1, head: 'helmet', emblem: 'none', cape: false, aura: false, model: null };
const stats: Stats = { strength: 6, speed: 6, durability: 6, energy: 8, intelligence: 6, combat: 6 };

function fight(kind: PowerKind, potency = 8, element: Element = 'kinetic') {
  const scene = new THREE.Scene();
  const combat = new Combat(scene, new Effects(scene), []);
  const hero = new Actor('Hero', 'player', 'hero', stats, 10, look, [{ id: 'p', name: kind, kind, element, potency, description: '' }]);
  combat.add(hero);
  const kills: Actor[] = [];
  combat.onKill = (t) => kills.push(t);
  return { combat, hero, kills };
}

function foe(combat: Combat, x: number, z = 0, type: 'grunt' | 'gunner' | 'brute' | 'boss' = 'grunt', hp = 50000) {
  const st = minionStats(1, type === 'boss' ? 'brute' : type);
  const e = new Actor(type, 'enemy', type, st, 1, look, [], hp ?? minionHealth(st, 1, type === 'boss' ? 'brute' : type));
  e.pos.set(x, 0, z);
  combat.add(e);
  return e;
}

function step(combat: Combat, seconds: number, ai = false) {
  for (let t = 0; t < seconds; t += DT) {
    if (ai) for (const a of combat.actors) if (a.archetype !== 'hero') updateEnemy(a, combat, DT);
    combat.update(DT);
  }
}

const cast = (combat: Combat, a: Actor) => {
  a.energy = a.maxEnergy;
  a.skills[0].remaining = 0;
  return combat.castPower(a, 0);
};

describe('power catalog', () => {
  it('has a name, description, and numbers for every power type', () => {
    for (const k of POWER_KINDS) {
      expect(POWER_LABELS[k]).toBeTruthy();
      expect(POWER_INFO[k]).toBeTruthy();
      const p = { id: 'p', name: k, kind: k, element: 'energy' as const, potency: 5, description: '' };
      expect(Number.isFinite(powerCooldown(p, stats))).toBe(true);
      expect(powerCost(p) > 0).toBe(takesSkillSlot(k));
    }
  });

  it('generates varied power sets that survive validation', () => {
    const seen = new Set<PowerKind>();
    for (let seed = 0; seed < 300; seed++) for (const p of randomPowerSet(new Rng(seed))) seen.add(p.kind);
    expect(seen.size).toBeGreaterThan(20);
    const u = generateUniverse(42);
    expect(normalizeUniverse(JSON.parse(JSON.stringify(u)))).toEqual(u);
  });

  it('keeps passives and movement off the skill bar', () => {
    const { hero } = fight('regeneration');
    expect(hero.skills).toHaveLength(0);
    expect(hero.regenFactor).toBeGreaterThan(0);
    expect(fight('swing').hero.travel?.kind).toBe('swing');
  });
});

describe('powers in combat', () => {
  it('optic blast pierces a whole line of enemies', () => {
    const { combat, hero } = fight('optic');
    const line = [foe(combat, 0, 5), foe(combat, 0, 10), foe(combat, 0, 15)];
    const off = foe(combat, 8, 8);
    cast(combat, hero);
    for (const e of line) expect(e.hp).toBeLessThan(e.maxHp);
    expect(off.hp).toBe(off.maxHp);
  });

  it('web shots root their target', () => {
    const { combat, hero } = fight('web');
    const e = foe(combat, 0, 8);
    cast(combat, hero);
    step(combat, 0.5);
    expect(e.root).toBeGreaterThan(1);
    e.moveIntent.set(1, 0, 0);
    const x = e.pos.x;
    step(combat, 0.3);
    expect(Math.abs(e.pos.x - x)).toBeLessThan(0.2);
  });

  it('telekinesis lifts a minion and slams it down, but only crushes a boss', () => {
    const { combat, hero } = fight('telekinesis');
    const e = foe(combat, 0, 8);
    cast(combat, hero);
    step(combat, 0.6);
    expect(e.pos.y).toBeGreaterThan(1.5);
    step(combat, 1);
    expect(e.pos.y).toBeLessThan(0.5);
    expect(e.hp).toBeLessThan(e.maxHp);

    const b = fight('telekinesis');
    const boss = foe(b.combat, 0, 8, 'boss');
    cast(b.combat, b.hero);
    step(b.combat, 0.5);
    expect(boss.pos.y).toBeLessThan(0.1);
    expect(boss.hp).toBeLessThan(boss.maxHp);
  });

  it('mind control turns a minion against its friends, then wears off', () => {
    const { combat, hero } = fight('mindcontrol', 4);
    const thrall = foe(combat, 0, 6);
    const other = foe(combat, 3, 9);
    cast(combat, hero);
    expect(thrall.team).toBe('player');
    expect(thrall.homeTeam).toBe('enemy');
    expect(combat.enemiesOf(thrall)).toContain(other);
    expect(combat.enemiesOf(other)).toContain(thrall);
    step(combat, 4, true);
    expect(other.hp).toBeLessThan(other.maxHp);
    step(combat, 6);
    expect(thrall.team).toBe('enemy');
  });

  it('mind control only stuns bosses', () => {
    const { combat, hero } = fight('mindcontrol');
    const boss = foe(combat, 0, 6, 'boss');
    cast(combat, hero);
    expect(boss.team).toBe('enemy');
    expect(boss.stun).toBeGreaterThan(0.5);
  });

  it('reality warp shrinks or converts its target', () => {
    let shrunk = 0;
    let turned = 0;
    for (let i = 0; i < 30; i++) {
      const { combat, hero } = fight('reality', 5);
      const e = foe(combat, 0, 6);
      cast(combat, hero);
      if (e.team === 'player') turned++;
      else if (e.shrink > 0) shrunk++;
    }
    expect(shrunk + turned).toBe(30);
    expect(shrunk).toBeGreaterThan(0);
    expect(turned).toBeGreaterThan(0);
  });

  it('shrunken foes deal half damage', () => {
    const { combat, hero } = fight('blast');
    const e = foe(combat, 0, 2);
    hero.hp = hero.maxHp = 1e6;
    const before = hero.hp;
    e.shrink = 10;
    for (let i = 0; i < 20; i++) combat.damage(hero, 100, e, null);
    const shrunkDamage = before - hero.hp;
    hero.hp = before;
    e.shrink = 0;
    for (let i = 0; i < 20; i++) combat.damage(hero, 100, e, null);
    expect(shrunkDamage).toBeLessThan((before - hero.hp) * 0.7);
  });

  it('summoned echoes fight, then fade without counting as kills', () => {
    const { combat, hero, kills } = fight('summon', 8);
    const e = foe(combat, 0, 10);
    cast(combat, hero);
    const echoes = combat.actors.filter((a) => a.summoned);
    expect(echoes.length).toBe(3);
    expect(echoes.every((x) => x.team === 'player')).toBe(true);
    step(combat, 5, true);
    expect(e.hp).toBeLessThan(e.maxHp);
    step(combat, 10, true);
    expect(combat.actors.some((a) => a.summoned)).toBe(false);
    expect(kills).toHaveLength(0);
  });

  it('life drain heals the caster', () => {
    const { combat, hero } = fight('drain');
    const e = foe(combat, 0, 5);
    hero.hp = hero.maxHp * 0.3;
    hero.sinceHit = 0;
    const hp = hero.hp;
    cast(combat, hero);
    step(combat, 1.6);
    expect(e.hp).toBeLessThan(e.maxHp);
    expect(hero.hp).toBeGreaterThan(hp);
  });

  it('a gravity well drags enemies in and damages them', () => {
    const { combat, hero } = fight('gravity');
    const center = foe(combat, 0, 9);
    const edge = foe(combat, 5, 9);
    cast(combat, hero);
    const d0 = edge.pos.distanceTo(center.pos);
    step(combat, 1.5);
    expect(edge.pos.distanceTo(new THREE.Vector3(0, 0, 9))).toBeLessThan(d0 - 1);
    expect(edge.hp).toBeLessThan(edge.maxHp);
  });

  it('storm call strikes nearby enemies', () => {
    const { combat, hero } = fight('storm', 8, 'lightning');
    const foes = [foe(combat, 6, 0), foe(combat, -6, 4)];
    cast(combat, hero);
    step(combat, 2.5);
    expect(foes.some((e) => e.hp < e.maxHp)).toBe(true);
  });

  it('time stop freezes enemies in place, bosses only briefly', () => {
    const { combat, hero } = fight('timestop');
    const e = foe(combat, 4, 0);
    const boss = foe(combat, -4, 0, 'boss');
    cast(combat, hero);
    expect(e.frozen).toBeGreaterThan(boss.frozen);
    const at = e.pos.clone();
    step(combat, 1, true);
    expect(e.pos.distanceTo(at)).toBeLessThan(0.01);
    expect(e.busy).toBe(true);
  });

  it('phasing makes the caster untouchable', () => {
    const { combat, hero } = fight('phase');
    const e = foe(combat, 2, 0);
    cast(combat, hero);
    step(combat, 0.2);
    expect(combat.damage(hero, 500, e, null)).toBe(0);
    expect(hero.hp).toBe(hero.maxHp);
  });

  it('sonic scream only hits the cone in front, stunning and pushing', () => {
    const { combat, hero } = fight('sonic');
    const front = foe(combat, 0, 5);
    const behind = foe(combat, 0, -5);
    hero.facing = 0;
    cast(combat, hero);
    expect(front.stun).toBeGreaterThan(0.5);
    expect(behind.hp).toBe(behind.maxHp);
    step(combat, 0.3);
    expect(front.pos.z).toBeGreaterThan(5.5);
  });

  it('giant growth hits harder, takes less, and ignores knockback', () => {
    const { combat, hero } = fight('grow');
    const e = foe(combat, 2, 0);
    cast(combat, hero);
    step(combat, 1);
    expect(hero.model.root.scale.x).toBeGreaterThan(1.4);
    hero.hp = hero.maxHp = 1e6;
    let taken = 0;
    for (let i = 0; i < 20; i++) taken += combat.damage(hero, 100, e, null, 20);
    expect(Math.hypot(hero.vel.x, hero.vel.z)).toBeLessThan(1);
    expect(taken / 20).toBeLessThan(100);
  });

  it('stealth hides the caster and the ambush lands double', () => {
    const { combat, hero } = fight('stealth');
    const e = foe(combat, 2, 0);
    cast(combat, hero);
    expect(combat.enemiesOf(e)).not.toContain(hero);
    expect(combat.findTarget(e, 50)).toBeNull();
    let normal = 0;
    for (let i = 0; i < 10; i++) normal += combat.damage(foe(combat, 5 + i, 5), 100, { ...hero, stealth: 0 } as Actor, null);
    const ambush = combat.damage(e, 100, hero, null);
    expect(hero.stealth).toBe(0);
    expect(ambush).toBeGreaterThan((normal / 10) * 1.5);
  });

  it('stretch yanks a minion in and pulls the caster to a boss', () => {
    const { combat, hero } = fight('stretch');
    const e = foe(combat, 0, 10);
    cast(combat, hero);
    step(combat, 0.4);
    expect(e.pos.distanceTo(hero.pos)).toBeLessThan(3.5);

    const b = fight('stretch');
    const boss = foe(b.combat, 0, 10, 'boss');
    cast(b.combat, b.hero);
    step(b.combat, 0.4);
    expect(b.hero.pos.distanceTo(boss.pos)).toBeLessThan(4);
    expect(boss.pos.z).toBeCloseTo(10, 0);
  });

  it('healing factor regenerates out of danger only', () => {
    const { combat, hero } = fight('regeneration', 8);
    hero.hp = hero.maxHp * 0.5;
    hero.sinceHit = 0;
    step(combat, 2);
    expect(hero.hp).toBe(hero.maxHp * 0.5);
    step(combat, 3);
    expect(hero.hp).toBeGreaterThan(hero.maxHp * 0.5);
  });

  it('web swing travels in an arc and can chain mid-air', () => {
    const { combat, hero } = fight('swing');
    hero.facing = 0;
    expect(combat.travel(hero)).toBe(true);
    step(combat, 0.4);
    expect(hero.pos.y).toBeGreaterThan(1);
    hero.travelRemaining = 0;
    expect(combat.travel(hero)).toBe(true);
    step(combat, 1.2);
    expect(hero.grounded).toBe(true);
    expect(hero.pos.z).toBeGreaterThan(20);
  });

  it('AI only fires powers when they make sense', () => {
    const { hero } = fight('nova');
    expect(powerUseful(hero, 'nova', 3)).toBe(true);
    expect(powerUseful(hero, 'nova', 15)).toBe(false);
    expect(powerUseful(hero, 'stretch', 1)).toBe(false);
    expect(powerUseful(hero, 'storm', 10)).toBe(true);
  });
});
