import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { generateUniverse } from '../src/core/generator';
import { createCampaign, missionBoard, planMission, resolveMission } from '../src/core/campaign';
import { RULE_KEYS, THREAT_TIERS, resolveRules } from '../src/core/rules';
import { normalizeLocation } from '../src/core/validate';
import { AmbientDirector, type AmbientHost, type AmbientKind } from '../src/game/ambient';
import type { Actor } from '../src/game/combat';

/** A stand-in actor: only what the director reads. */
const fake = (x = 0, z = 0) => ({ alive: true, pos: new THREE.Vector3(x, 0, z) }) as unknown as Actor;

function setup(opts: Partial<AmbientHost> = {}) {
  const u = generateUniverse(3);
  const player = fake();
  const spawned: Actor[] = [];
  const log = { rewards: [] as string[], dismissed: [] as Actor[], restored: 0, banners: [] as string[] };
  const host: AmbientHost = {
    player: () => player,
    spawnMinion: (_t, around) => {
      const a = fake(around.x, around.z);
      spawned.push(a);
      return a;
    },
    spawnFugitive: (_c, at) => {
      const a = fake(at.x, at.z);
      spawned.push(a);
      return a;
    },
    spawnHelper: (_c, at) => fake(at.x, at.z),
    dismiss: (a) => log.dismissed.push(a),
    perchNear: () => new THREE.Vector3(30, 8, 0),
    floorAt: () => 0,
    reward: (_xp, note) => log.rewards.push(note),
    restore: () => log.restored++,
    banner: (t) => log.banners.push(t),
    villains: u.characters.filter((c) => c.role === 'villain'),
    allies: u.characters.filter((c) => c.role === 'hero'),
    ...opts,
  };
  const dir = new AmbientDirector(host, new THREE.Scene(), () => 0.5);
  return { dir, player, spawned, log };
}

/** Teleports the player onto the first active event. */
function goTo(player: Actor, dir: AmbientDirector) {
  const target = (dir as unknown as { events: { pos: THREE.Vector3 }[] }).events[0].pos;
  player.pos.set(target.x, target.y, target.z);
}

function run(kind: AmbientKind, setupOpts: Partial<AmbientHost> = {}) {
  const t = setup(setupOpts);
  t.dir.trigger(kind);
  return t;
}

describe('ambient events', () => {
  it('schedules events over time, at most two at once', () => {
    const { dir } = setup();
    for (let i = 0; i < 60 * 120; i++) dir.update(1 / 60);
    expect(dir.feed().length).toBeLessThanOrEqual(2);
  });

  it('street crime spawns its gang only when the player arrives, and pays out when cleared', () => {
    const { dir, player, spawned, log } = run('mugging');
    dir.update(0.1);
    expect(spawned).toHaveLength(0);
    goTo(player, dir);
    dir.update(0.1);
    expect(spawned.length).toBe(3);
    for (const a of spawned) a.alive = false;
    dir.update(0.1);
    expect(log.rewards).toHaveLength(1);
    expect(dir.results.completed).toBe(1);
    expect(dir.feed()).toHaveLength(0);
  });

  it('snipers set up on a rooftop perch', () => {
    const { dir, player, spawned } = run('sniper');
    goTo(player, dir);
    dir.update(0.1);
    expect(spawned.every((a) => a.pos.y === 8)).toBe(true);
  });

  it('supply drops restore the hero when reached', () => {
    const { dir, player, log } = run('supply');
    goTo(player, dir);
    dir.update(0.1);
    expect(log.restored).toBe(1);
  });

  it('a fugitive escapes if not caught in time', () => {
    const { dir, player, log } = run('fugitive');
    goTo(player, dir);
    for (let i = 0; i < 60 * 40; i++) dir.update(1 / 60);
    expect(log.dismissed).toHaveLength(1);
    expect(dir.results.completed).toBe(0);
  });

  it('answering a distress call records the rescued ally', () => {
    const { dir, player, spawned } = run('distress');
    goTo(player, dir);
    dir.update(0.1);
    for (const a of spawned) a.alive = false;
    dir.update(0.1);
    expect(dir.results.helpedAllyIds).toHaveLength(1);
  });

  it('rifts are sealed by holding the zone', () => {
    const { dir, player } = run('rift');
    goTo(player, dir);
    for (let i = 0; i < 60 * 16; i++) dir.update(1 / 60);
    expect(dir.results.completed).toBe(1);
  });

  it('ignored events expire', () => {
    const { dir } = run('mugging');
    for (let i = 0; i < 60 * 55; i++) dir.update(1 / 60);
    expect(dir.results.completed).toBe(0);
  });

  it('skips fugitives and distress calls when nobody can play those parts', () => {
    const { dir } = setup({ villains: [], allies: [] });
    for (let i = 0; i < 20; i++) dir.trigger();
    const labels = dir.feed().map((f) => f.label);
    expect(labels.some((l) => l.startsWith('Villain on the run') || l.startsWith('Ally in distress'))).toBe(false);
  });
});

describe('patrol ambient in the campaign', () => {
  it('casts villains and allies who are not otherwise busy', () => {
    const u = generateUniverse(42);
    const c = createCampaign(u);
    const hero = u.characters.find((x) => x.role === 'hero')!;
    const patrol = missionBoard(c, u).find((m) => m.kind === 'patrol')!;
    const plan = planMission(c, u, patrol, hero.id);
    expect(plan.ambient).not.toBeNull();
    expect(plan.ambient!.allyIds).not.toContain(hero.id);
    for (const id of patrol.targetIds) expect(plan.ambient!.villainIds).not.toContain(id);
  });

  it('rescued allies remember it and like you more', () => {
    const u = generateUniverse(42);
    const c = createCampaign(u);
    const hero = u.characters.find((x) => x.role === 'hero')!;
    const friend = u.characters.find((x) => x.role === 'hero' && x.id !== hero.id)!;
    const before = c.relations[friend.id].score;
    const patrol = missionBoard(c, u).find((m) => m.kind === 'patrol')!;
    const news = resolveMission(c, u, patrol, {
      victory: true, defeatedBossIds: [], survivingBossIds: [], outcomes: {}, choice: null,
      ambient: { completed: 3, helpedAllyIds: [friend.id] },
    }, hero.id);
    expect(c.relations[friend.id].score).toBeGreaterThan(before);
    expect(c.relations[friend.id].memories.at(-1)?.text).toContain('rescued');
    expect(news.some((n) => n.text.includes('3 incidents'))).toBe(true);
  });
});

describe('layers of control', () => {
  it('stacks universe, location, and session rules, latest wins', () => {
    const base = { powerScale: 1, gravity: 1, enemyDensity: 1 };
    const { rules, source } = resolveRules(base, [
      { label: 'Moon Base', rules: { gravity: 0.35 } },
      { label: 'Session', rules: { powerScale: 2.5, gravity: 1.5 } },
    ]);
    expect(rules).toEqual({ powerScale: 2.5, gravity: 1.5, enemyDensity: 1 });
    expect(source).toEqual({ powerScale: 'Session', gravity: 'Session', enemyDensity: 'Universe' });
    expect(resolveRules(base, [{ label: 'Moon Base', rules: { gravity: 0.35 } }]).source.gravity).toBe('Moon Base');
    expect(RULE_KEYS).toHaveLength(3);
  });

  it('validates local laws on locations', () => {
    const loc = normalizeLocation({ name: 'X', rules: { gravity: 99, powerScale: 'lots', bogus: 1 } });
    expect(loc.rules).toEqual({ gravity: 2 });
  });

  it('has threat tiers that only get harder', () => {
    for (let i = 1; i < THREAT_TIERS.length; i++) {
      const [a, b] = [THREAT_TIERS[i - 1], THREAT_TIERS[i]];
      expect(b.levelBonus).toBeGreaterThan(a.levelBonus);
      expect(b.health).toBeGreaterThan(a.health);
      expect(b.damage).toBeGreaterThan(a.damage);
      expect(b.xp).toBeGreaterThan(a.xp);
    }
  });
});
