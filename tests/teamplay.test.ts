// Team combos, villain schemes, and boss phases.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  SCHEME_META, createCampaign, loadCampaign, missionBoard, passTime, planMission, resolveMission, type Campaign,
} from '../src/core/campaign';
import { generateUniverse } from '../src/core/generator';
import { minionStats } from '../src/core/rules';
import type { Appearance, Element, PowerKind, Stats, Universe } from '../src/core/types';
import { comboReady } from '../src/game/ai';
import { BOSS_PHASES, BossDirector, setPieceFor } from '../src/game/bossphase';
import { Actor, Combat } from '../src/game/combat';
import { COMBOS, CROSSFIRE, findCombo } from '../src/game/combos';
import { Effects } from '../src/game/effects';

const DT = 1 / 60;
const look: Appearance = { primary: '#ff0000', secondary: '#000000', accent: '#333333', build: 'athletic', height: 1, head: 'helmet', emblem: 'none', cape: false, aura: false, model: null };
const stats: Stats = { strength: 6, speed: 6, durability: 6, energy: 8, intelligence: 6, combat: 6 };
const pw = (kind: PowerKind, element: Element = 'kinetic') => ({ id: `p_${kind}_${element}`, name: kind, kind, element, potency: 6, description: '' });

function arena() {
  const scene = new THREE.Scene();
  return new Combat(scene, new Effects(scene), []);
}
function hero(combat: Combat, name: string, kind: PowerKind, element: Element = 'kinetic', archetype: 'hero' | 'ally' = 'hero') {
  const a = new Actor(name, 'player', archetype, stats, 10, look, [pw(kind, element)]);
  combat.add(a);
  return a;
}
function dummy(combat: Combat, z = 6, type: 'grunt' | 'boss' = 'grunt', hp = 1e6) {
  const e = new Actor('Dummy', 'enemy', type, minionStats(1, type === 'boss' ? 'brute' : 'grunt'), 5, look, [], hp);
  e.pos.set(0, 0, z);
  combat.add(e);
  return e;
}
const step = (combat: Combat, seconds: number) => { for (let t = 0; t < seconds; t += DT) combat.update(DT); };

describe('team combos', () => {
  it('matches recipes in either order and falls back to Crossfire', () => {
    expect(findCombo(pw('web'), pw('telekinesis'))?.name).toBe('Cocoon Hurl');
    expect(findCombo(pw('telekinesis'), pw('web'))?.name).toBe('Cocoon Hurl');
    expect(findCombo(pw('timestop'), pw('blast', 'fire'))?.name).toBe('Time Bomb');
    expect(findCombo(pw('blast', 'ice'), pw('beam', 'kinetic'))?.name).toBe('Shatter');
    expect(findCombo(pw('blast', 'tech'), pw('blast', 'nature'))).toBe(CROSSFIRE);
    expect(findCombo(pw('blast', 'tech'), pw('beam', 'tech'))).toBeNull();
    for (const c of COMBOS) expect(c.mult).toBeGreaterThan(CROSSFIRE.mult);
  });

  it('detonates when a teammate follows up on a marked enemy', () => {
    const combat = arena();
    const a = hero(combat, 'Silk', 'web');
    const b = hero(combat, 'Mind', 'telekinesis', 'psychic', 'ally');
    const e = dummy(combat);
    const fired: string[] = [];
    combat.onCombo = (r, first, second) => fired.push(`${r.name}:${first.name}>${second.name}`);
    combat.damage(e, 10, a, 'kinetic', 0, a.skills[0].power);
    expect(e.mark?.by).toBe(a);
    expect(comboReady(b, e, combat)).toBe(true);
    expect(comboReady(a, e, combat)).toBe(false);
    const before = e.hp;
    combat.damage(e, 10, b, 'psychic', 0, b.skills[0].power);
    step(combat, 0.1);
    expect(fired).toEqual(['Cocoon Hurl:Silk>Mind']);
    expect(before - e.hp).toBeGreaterThan(300);
    expect(e.stun).toBeGreaterThan(1);
    expect(e.mark).toBeNull();
    // On cooldown: an immediate repeat just marks.
    combat.damage(e, 10, a, 'kinetic', 0, a.skills[0].power);
    combat.damage(e, 10, b, 'psychic', 0, b.skills[0].power);
    expect(fired).toHaveLength(1);
  });

  it('needs two different heroes inside the window', () => {
    const combat = arena();
    const a = hero(combat, 'A', 'web');
    const b = hero(combat, 'B', 'telekinesis', 'psychic', 'ally');
    const e = dummy(combat);
    let combos = 0;
    combat.onCombo = () => combos++;
    combat.damage(e, 10, a, 'kinetic', 0, a.skills[0].power);
    combat.damage(e, 10, a, 'kinetic', 0, pw('telekinesis', 'psychic'));
    expect(combos).toBe(0);
    step(combat, 3.5);
    combat.damage(e, 10, b, 'psychic', 0, b.skills[0].power);
    expect(combos).toBe(0);
    // Plain melee (no power) never sets anything off.
    combat.damage(e, 10, a, null, 0);
    expect(combos).toBe(0);
  });

  it('Time Bomb waits before going off', () => {
    const combat = arena();
    const a = hero(combat, 'A', 'timestop', 'energy');
    const b = hero(combat, 'B', 'blast', 'fire', 'ally');
    const e = dummy(combat);
    combat.damage(e, 1, a, 'energy', 0, a.skills[0].power);
    combat.damage(e, 1, b, 'fire', 0, b.skills[0].power);
    const hp = e.hp;
    step(combat, 0.5);
    expect(hp - e.hp).toBeLessThan(100);
    step(combat, 0.7);
    expect(hp - e.hp).toBeGreaterThan(300);
  });

  it('powers cast in real combat mark targets', () => {
    const combat = arena();
    const a = hero(combat, 'A', 'optic', 'energy');
    const e = dummy(combat, 6);
    combat.castPower(a, 0);
    expect(e.mark?.power.kind).toBe('optic');
  });
});

describe('boss phases', () => {
  function bossFight(kind: PowerKind = 'blast') {
    const combat = arena();
    const h = hero(combat, 'Hero', 'blast');
    const boss = new Actor('Overlord', 'enemy', 'boss', stats, 10, look, [pw(kind, 'ice')], 10000);
    boss.pos.set(0, 0, 10);
    combat.add(boss);
    const events: string[] = [];
    let minions = 0;
    const director = new BossDirector(combat, {
      spawnMinions: (n) => (minions += n),
      announce: (_b, phase, piece) => events.push(`${phase.title}:${piece}`),
    });
    return { combat, h, boss, director, events, minions: () => minions };
  }

  it('enrages at 60% and makes a last stand at 25%', () => {
    const f = bossFight();
    const cd = f.boss.skills[0].cooldown;
    f.director.update(DT);
    expect(f.events).toEqual([]);
    f.boss.hp = f.boss.maxHp * 0.55;
    f.director.update(DT);
    expect(f.events).toEqual(['Enraged:reinforcements']);
    expect(f.boss.title).toBe('Enraged');
    expect(f.boss.damageMult).toBeCloseTo(BOSS_PHASES[0].damage);
    expect(f.boss.skills[0].cooldown).toBeLessThan(cd);
    expect(f.boss.invuln).toBeGreaterThan(0);
    expect(f.minions()).toBe(3);
    f.director.update(DT);
    expect(f.events).toHaveLength(1);
    f.boss.hp = f.boss.maxHp * 0.2;
    f.director.update(DT);
    expect(f.events[1]).toBe('Last Stand:shield');
    expect(f.boss.shield).toBeGreaterThan(0);
  });

  it('picks set pieces from the kit', () => {
    expect(setPieceFor(bossFight('summon').boss, 0)).toBe('echoes');
    expect(setPieceFor(bossFight('grow').boss, 0)).toBe('giant');
    const f = bossFight('summon');
    f.boss.hp = f.boss.maxHp * 0.5;
    f.director.update(DT);
    expect(f.combat.actors.filter((a) => a.summoned && a.team === 'enemy')).toHaveLength(2);
  });

  it('calls down telegraphed hazards on the heroes once enraged', () => {
    const f = bossFight();
    f.boss.hp = f.boss.maxHp * 0.5;
    f.director.update(DT);
    f.h.hp = f.h.maxHp = 1e6;
    // Stand still: the strikes land on you.
    for (let t = 0; t < 8; t += DT) {
      f.director.update(DT);
      f.combat.update(DT);
    }
    expect(f.h.hp).toBeLessThan(f.h.maxHp);
  });
});

describe('villain schemes', () => {
  function campaignWithScheme(seed = 3): { u: Universe; c: Campaign } {
    const u = generateUniverse(seed);
    const c = createCampaign(u);
    for (let i = 0; i < 40 && !c.schemes.length; i++) passTime(c, u);
    if (!c.schemes.length) throw new Error('no scheme started');
    return { u, c };
  }

  it('villains start schemes that show up as urgent missions', () => {
    const { u, c } = campaignWithScheme();
    const sc = c.schemes[0];
    expect(SCHEME_META[sc.kind]).toBeDefined();
    expect(c.news.some((n) => n.kind === 'scheme')).toBe(true);
    const m = missionBoard(c, u).find((x) => x.schemeId === sc.id)!;
    expect(m.kind).toBe('scheme');
    expect(m.targetIds).toEqual([sc.villainId]);
    expect(m.brief).toContain(`${sc.left}`);
    const plan = planMission(c, u, m, u.characters.find((x) => x.role === 'hero')!.id);
    expect(plan.phases.map((p) => p.kind)).toEqual(['defeat', 'survive', 'bosses']);
  });

  it('foiling a scheme removes it; failing speeds it up', () => {
    const { u, c } = campaignWithScheme();
    const sc = c.schemes[0];
    const heroId = u.characters.find((x) => x.role === 'hero' && c.relations[x.id].state === 'free')!.id;
    const m = missionBoard(c, u).find((x) => x.schemeId === sc.id)!;
    if (sc.left > 2) {
      const left = sc.left;
      resolveMission(c, u, m, { victory: false, defeatedBossIds: [], survivingBossIds: [], outcomes: {}, choice: null }, heroId);
      const after = c.schemes.find((x) => x.id === sc.id);
      // Down one for the setback and one for the turn.
      if (after) expect(after.left).toBe(left - 2);
    }
    const again = missionBoard(c, u).find((x) => x.schemeId === sc.id);
    if (!again) return;
    const news = resolveMission(c, u, again, { victory: true, defeatedBossIds: [], survivingBossIds: [], outcomes: {}, choice: null }, heroId);
    expect(c.schemes.some((x) => x.id === sc.id)).toBe(false);
    expect(news.some((n) => n.kind === 'scheme' && n.text.includes('foiled'))).toBe(true);
  });

  it('schemes left alone succeed with real consequences, deterministically', () => {
    const run = () => {
      const { u, c } = campaignWithScheme(11);
      const sc = { ...c.schemes[0] };
      const before = { chars: u.characters.length, level: u.characters.find((x) => x.id === sc.villainId)!.level, power: sc.factionId ? c.factions[sc.factionId]?.power : 0 };
      for (let i = 0; i < sc.left + 1; i++) passTime(c, u);
      const done = c.news.find((n) => n.kind === 'scheme' && n.text.startsWith('💥'));
      return { sc, before, done: done?.text, chars: u.characters.length, level: u.characters.find((x) => x.id === sc.villainId)!.level, power: sc.factionId ? c.factions[sc.factionId]?.power : 0 };
    };
    const r = run();
    expect(r.done).toBeTruthy();
    if (r.sc.kind === 'army') expect(r.chars).toBe(r.before.chars + 2);
    if (r.sc.kind === 'doomsday') expect(r.level).toBe(r.before.level + 3);
    if (r.sc.kind === 'takeover') expect(r.power).toBe(100);
    expect(run().done).toBe(r.done);
  });

  it('runs every kind of scheme to completion without breaking the world', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 25; seed++) {
      const u = generateUniverse(seed);
      const c = createCampaign(u);
      for (let i = 0; i < 30; i++) {
        passTime(c, u);
        for (const sc of c.schemes) seen.add(sc.kind);
        for (const fs of Object.values(c.factions)) {
          if (fs.leaderId) expect(fs.lieutenantIds).not.toContain(fs.leaderId);
          expect(new Set(fs.lieutenantIds).size).toBe(fs.lieutenantIds.length);
        }
        expect(c.schemes.length).toBeLessThanOrEqual(2);
      }
      const back = loadCampaign(JSON.parse(JSON.stringify(c)), u);
      expect(back.schemes).toEqual(c.schemes);
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });
});
