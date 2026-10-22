// Team-ups: autonomous AI squads, downed/revive, Team Assault, orders,
// perfect dodges, grades, and campaign team-up missions and contracts.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { activeContracts, createCampaign, missionBoard, planMission, resolveMission, teamRoster, type Mission } from '../src/core/campaign';
import { gradeRun, type MissionResult } from '../src/core/missions';
import { findLegend, legendCharacter, legendsUniverse } from '../src/core/roster';
import { minionHealth, minionStats } from '../src/core/rules';
import type { Appearance } from '../src/core/types';
import { squadRole, updateAlly, updateEnemy, type SquadContext } from '../src/game/ai';
import { Actor, BLEED_OUT, Combat } from '../src/game/combat';
import { Effects } from '../src/game/effects';

const DT = 1 / 60;
const look: Appearance = { primary: '#ff0000', secondary: '#000000', accent: '#333333', build: 'athletic', height: 1, head: 'helmet', emblem: 'none', cape: false, aura: false, model: null };

function arena() {
  const scene = new THREE.Scene();
  return new Combat(scene, new Effects(scene), []);
}

function legend(combat: Combat, key: string, archetype: 'hero' | 'ally', x = 0, z = 0) {
  const c = legendCharacter(findLegend(key)!);
  const a = new Actor(c.alias, 'player', archetype, c.stats, 5, c.appearance, c.powers, undefined, c);
  a.pos.set(x, 0, z);
  combat.add(a);
  return a;
}

function grunt(combat: Combat, x: number, z: number, type: 'grunt' | 'gunner' | 'brute' = 'grunt') {
  const stats = minionStats(3, type);
  const e = new Actor('Grunt', 'enemy', type, stats, 3, look, [], minionHealth(stats, 3, type));
  e.pos.set(x, 0, z);
  combat.add(e);
  return e;
}

function run(combat: Combat, seconds: number, leader: Actor, ctx?: SquadContext, each: () => void = () => {}) {
  for (let t = 0; t < seconds; t += DT) {
    each();
    for (const a of combat.actors) {
      if (a.team === 'enemy') updateEnemy(a, combat, DT);
      else if (a.archetype === 'ally') updateAlly(a, combat, DT, leader, ctx);
    }
    combat.update(DT);
  }
}

describe('autonomous squad', () => {
  it('reads each teammate’s role from their kit', () => {
    const c = arena();
    expect(squadRole(legend(c, 'aegis', 'ally'))).toBe('tank');
    expect(squadRole(legend(c, 'seraph', 'ally'))).toBe('support');
    expect(squadRole(legend(c, 'mindwarden', 'ally'))).toBe('ranged');
    expect(squadRole(legend(c, 'nightveil', 'ally'))).toBe('striker');
  });

  it('a squad clears a wave on its own while the player stands still', () => {
    const c = arena();
    const leader = legend(c, 'voltstream', 'hero');
    legend(c, 'aegis', 'ally', 2, 2);
    legend(c, 'seraph', 'ally', -2, 2);
    legend(c, 'nightveil', 'ally', 0, 3);
    c.downedEnabled = true;
    const enemies = [grunt(c, 15, 0), grunt(c, -15, 4), grunt(c, 0, 18, 'gunner'), grunt(c, 10, 10, 'brute')];
    run(c, 45, leader);
    expect(enemies.every((e) => !e.alive)).toBe(true);
  });

  it('spreads out over several targets instead of piling on one', () => {
    const c = arena();
    const leader = legend(c, 'voltstream', 'hero');
    const squad = [legend(c, 'aegis', 'ally', 2, 0), legend(c, 'nightveil', 'ally', -2, 0), legend(c, 'mindwarden', 'ally', 0, 2)];
    for (const e of [grunt(c, 10, 0), grunt(c, -10, 0), grunt(c, 0, 10)]) e.hp = e.maxHp = 1e6;
    run(c, DT, leader);
    expect(new Set(squad.map((a) => a.aiTarget)).size).toBeGreaterThan(1);
  });

  it('obeys Focus and Follow orders', () => {
    const c = arena();
    const leader = legend(c, 'voltstream', 'hero');
    const ally = legend(c, 'nightveil', 'ally', 2, 0);
    const near = grunt(c, 4, 0);
    const far = grunt(c, -20, 0);
    for (const e of [near, far]) e.hp = e.maxHp = 1e6; // keep both alive for the check
    run(c, 0.2, leader, { order: 'focus', focus: far, holdAt: null });
    expect(ally.aiTarget).toBe(far);
    // Focused striker blinks straight to the far target, not the nearer one.
    expect(ally.pos.distanceTo(far.pos)).toBeLessThan(ally.pos.distanceTo(near.pos));
    run(c, 0.2, leader, { order: 'follow', focus: null, holdAt: null });
    expect(ally.aiTarget).toBe(near);
  });
});

describe('downed and revive', () => {
  it('a downed hero is revived by a teammate standing next to them', () => {
    const c = arena();
    c.downedEnabled = true;
    const leader = legend(c, 'voltstream', 'hero');
    const ally = legend(c, 'aegis', 'ally', 6, 0);
    let downed = 0;
    let revived = 0;
    c.onDowned = () => downed++;
    c.onRevived = () => revived++;
    c.damage(leader, 1e7, null, null);
    expect(leader.alive).toBe(false);
    expect(leader.downed).toBe(true);
    run(c, 6, leader);
    expect(downed).toBe(1);
    expect(revived).toBe(1);
    expect(leader.alive).toBe(true);
    expect(leader.hp).toBeCloseTo(leader.maxHp * 0.4, -1);
    expect(ally.pos.distanceTo(leader.pos)).toBeLessThan(3);
  });

  it('bleeds out if nobody comes', () => {
    const c = arena();
    c.downedEnabled = true;
    const leader = legend(c, 'voltstream', 'hero');
    let killed = 0;
    c.onKill = () => killed++;
    c.damage(leader, 1e7, null, null);
    for (let t = 0; t < BLEED_OUT + 1; t += DT) c.update(DT);
    expect(killed).toBe(1);
    expect(leader.downed).toBe(false);
  });
});

describe('team powers', () => {
  it('heals reach nearby teammates', () => {
    const c = arena();
    const seraph = legend(c, 'seraph', 'hero');
    const mate = legend(c, 'aegis', 'ally', 3, 0);
    mate.hp = mate.maxHp * 0.3;
    const slot = seraph.skills.findIndex((s) => s.power.kind === 'heal');
    expect(c.castPower(seraph, slot)).toBe(true);
    for (let t = 0; t < 4; t += DT) c.update(DT);
    expect(mate.hp).toBeGreaterThan(mate.maxHp * 0.5);
  });

  it('Team Assault needs two heroes and hits around each of them', () => {
    const c = arena();
    const leader = legend(c, 'voltstream', 'hero');
    const solo = grunt(c, 3, 0);
    expect(c.teamAssault(leader)).toBe(0);
    legend(c, 'aegis', 'ally', 12, 0);
    const byAlly = grunt(c, 15, 0);
    expect(c.teamAssault(leader)).toBe(2);
    expect(solo.hp).toBeLessThan(solo.maxHp);
    expect(byAlly.hp).toBeLessThan(byAlly.maxHp);
  });

  it('a perfectly timed dodge triggers the perfect-dodge reward', () => {
    const c = arena();
    const leader = legend(c, 'voltstream', 'hero');
    const e = grunt(c, 2, 0);
    let perfect = 0;
    c.onPerfectDodge = () => perfect++;
    c.dodge(leader);
    c.damage(leader, 50, e, null);
    expect(perfect).toBe(1);
    expect(leader.hp).toBe(leader.maxHp);
  });
});

describe('mission grades', () => {
  it('rewards fast, clean runs', () => {
    expect(gradeRun({ seconds: 60, parSeconds: 90, damageTakenRatio: 0.05, maxCombo: 40, downs: 0 }).grade).toBe('S');
    expect(gradeRun({ seconds: 200, parSeconds: 90, damageTakenRatio: 0.9, maxCombo: 3, downs: 2 }).grade).toBe('C');
    expect(gradeRun({ seconds: 60, parSeconds: 90, damageTakenRatio: 0.05, maxCombo: 40, downs: 0 }).xpBonus).toBeGreaterThan(0);
  });
});

describe('team-up missions', () => {
  it('assembles a hero team against a villain faction', () => {
    const u = legendsUniverse();
    const c = createCampaign(u);
    const hero = u.characters.find((x) => x.alias === 'Aegis Prime')!;
    const teamup = missionBoard(c, u).find((m) => m.kind === 'teamup');
    expect(teamup).toBeDefined();
    const plan = planMission(c, u, teamup!, hero.id);
    expect(plan.allyIds).toHaveLength(3);
    expect(plan.allyIds).not.toContain(hero.id);
    const team = new Set(teamRoster(c, u, teamup!.teamId!).map((x) => x.id));
    for (const id of plan.allyIds) expect(team.has(id)).toBe(true);
    expect(plan.teamName).toBe('The Vanguard');
    expect(plan.phases.at(-1)?.kind).toBe('bosses');
  });

  it('players can bring up to three allies on any mission', () => {
    const u = legendsUniverse();
    const c = createCampaign(u);
    const hero = u.characters.find((x) => x.alias === 'Aegis Prime')!;
    const picks = u.characters.filter((x) => x.role === 'hero' && x.id !== hero.id).slice(0, 5).map((x) => x.id);
    const hunt = missionBoard(c, u).find((m) => m.kind === 'hunt')!;
    expect(planMission(c, u, hunt, hero.id, picks).allyIds).toEqual(picks.slice(0, 3));
  });

  it('fighting together builds bonds, and contracts pay out once', () => {
    const u = legendsUniverse();
    const c = createCampaign(u);
    const hero = u.characters.find((x) => x.alias === 'Aegis Prime')!;
    const mate = u.characters.find((x) => x.alias === 'Seraph')!;
    const before = c.relations[mate.id].score;
    const board = missionBoard(c, u);
    // Build a mission + result that satisfies whichever contract is first.
    const contract = activeContracts(c)[0];
    const kindFor: Record<string, Mission['kind']> = { teamup: 'teamup', raid: 'raid', patrol: 'patrol' };
    const m = board.find((x) => x.kind === (kindFor[contract.kind] ?? 'hunt')) ?? board[0];
    const result: MissionResult = {
      victory: true, defeatedBossIds: [], survivingBossIds: [], choice: null,
      outcomes: contract.kind === 'arrest' || contract.kind === 'spare' ? { [m.targetIds[0] ?? 'x']: contract.kind } : {},
      grade: 'S',
      squadIds: [mate.id, u.characters[2].id],
      ambient: { completed: 3, helpedAllyIds: [mate.id] },
    };
    if (result.outcomes.x) result.outcomes = {};
    const news = resolveMission(c, u, m, result, hero.id);
    expect(c.relations[mate.id].score).toBeGreaterThan(before);
    if (Object.keys(result.outcomes).length || !['arrest', 'spare'].includes(contract.kind)) {
      expect(news.some((n) => n.kind === 'contract')).toBe(true);
      const again = resolveMission(c, u, m, result, hero.id).filter((n) => n.kind === 'contract' && n.text.includes(contract.title));
      expect(again).toHaveLength(0);
    }
  });
});
