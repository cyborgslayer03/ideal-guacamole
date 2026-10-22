// Enemy behaviour per archetype. Brains only set intents and trigger combat
// actions; physics and damage live in Combat.

import * as THREE from 'three';
import { basicDamage } from '../core/rules';
import type { PowerKind } from '../core/types';
import type { Actor, Combat, SquadRole } from './combat';

/** Whether casting a power of this kind makes sense right now. */
export function powerUseful(a: Actor, kind: PowerKind, gap: number): boolean {
  switch (kind) {
    case 'heal':
      return a.hp < a.maxHp * 0.6;
    case 'nova': case 'dash': case 'sonic': case 'timestop':
      return gap < 7;
    case 'shield': case 'phase':
      return a.sinceHit < 1;
    case 'grow': case 'stealth': case 'summon':
      return gap < 12;
    case 'drain':
      return gap < 10 && a.hp < a.maxHp * 0.9;
    case 'stretch':
      return gap > 2.5 && gap < 13;
    case 'telekinesis': case 'reality': case 'mindcontrol': case 'web':
      return gap < 20;
    case 'storm': case 'gravity':
      return gap < 16;
    default:
      return true;
  }
}

function cooldown(e: Actor, key: string, dt: number): number {
  e.ai[key] = (e.ai[key] ?? 0) - dt;
  return e.ai[key];
}

function steerToward(e: Actor, target: THREE.Vector3, scale = 1) {
  e.moveIntent.set(target.x - e.pos.x, 0, target.z - e.pos.z);
  if (e.moveIntent.lengthSq() > 1e-4) e.moveIntent.normalize().multiplyScalar(scale);
}

/**
 * Movement powers in AI hands: teleporters and leapers close distance (and
 * teleporters sometimes blink in right after taking a hit). Flight stays a
 * player-only toggle.
 */
function useTravel(a: Actor, combat: Combat, dt: number, dist: number, toward: THREE.Vector3, target: Actor | null = null): boolean {
  const p = a.travel;
  if (!p || p.kind === 'flight' || a.busy || a.travelRemaining > 0) return false;
  if (cooldown(a, 'travel', dt) > 0) return false;
  const wants = dist > 11 || (p.kind === 'teleport' && a.sinceHit < 0.3 && Math.random() < 0.25);
  if (!wants) return false;
  a.ai.travel = 1.2 + Math.random() * 1.5;
  // Aim the move: out of range, teleport and leap go the way the actor is heading.
  a.faceToward(toward);
  steerToward(a, toward);
  return combat.travel(a, target);
}

/** Minions can't fly, but they'll jump and double-jump onto ledges near a target above them. */
function climbToward(e: Actor, combat: Combat, target: Actor) {
  const rise = target.pos.y - e.pos.y;
  if (rise < 1 || rise > 5.5 || e.busy) return;
  const flat = Math.hypot(target.pos.x - e.pos.x, target.pos.z - e.pos.z);
  if (flat > 9) return;
  if (e.grounded) combat.jump(e);
  else if (e.jumps === 1 && e.vel.y < 2) combat.jump(e);
}

/** Fugitives run, use movement powers to break away, and only fight when cornered. */
function flee(e: Actor, combat: Combat, dt: number, target: Actor, dist: number) {
  if (dist > 24) return;
  const away = e.pos.clone().multiplyScalar(2).sub(target.pos);
  steerToward(e, away, 0.85);
  if (dist < 9 && e.travel && e.travel.kind !== 'flight' && e.travelRemaining <= 0 && cooldown(e, 'travel', dt) <= 0) {
    e.ai.travel = 2;
    e.faceToward(away);
    combat.travel(e);
  } else if (dist < 3 && !e.busy && cooldown(e, 'attack', dt) <= 0) {
    e.faceToward(target.pos);
    combat.basicAttack(e);
    e.ai.attack = 1.2;
  }
}

export function updateEnemy(e: Actor, combat: Combat, dt: number) {
  e.moveIntent.set(0, 0, 0);
  if (!e.alive) return;
  const target = combat.enemiesOf(e).sort((a, b) => a.pos.distanceTo(e.pos) - b.pos.distanceTo(e.pos))[0];
  if (!target) return;
  const dist = Math.hypot(target.pos.x - e.pos.x, target.pos.z - e.pos.z);
  const gap = dist - e.radius - target.radius;
  const attackReady = cooldown(e, 'attack', dt) <= 0;

  // A short spawn-in delay so new waves don't hit instantly.
  if (cooldown(e, 'spawn', dt) > 0) return;

  switch (e.archetype) {
    case 'grunt':
      climbToward(e, combat, target);
      if (gap > 1.2) steerToward(e, target.pos);
      else if (attackReady && !e.busy) {
        e.faceToward(target.pos);
        combat.basicAttack(e);
        e.ai.attack = 1.3 + Math.random() * 0.8;
      }
      break;

    case 'gunner': {
      const strafe = (e.ai.strafe ??= Math.random() < 0.5 ? -1 : 1);
      if (dist > 15) steerToward(e, target.pos);
      else if (dist < 8) steerToward(e, e.pos.clone().multiplyScalar(2).sub(target.pos));
      else {
        const side = new THREE.Vector3(target.pos.z - e.pos.z, 0, -(target.pos.x - e.pos.x)).normalize();
        e.moveIntent.copy(side).multiplyScalar(0.5 * strafe);
      }
      if (attackReady && !e.busy && dist < 20) {
        e.faceToward(target.pos);
        e.castTimer = 0.35;
        e.anim.cast = 0;
        combat.schedule(0.35, () => {
          if (!e.alive) return;
          e.faceToward(target.pos);
          const dir = target.center.sub(e.center).normalize();
          combat.fireProjectile(e, dir, basicDamage(e.stats, e.level) * 0.6, 'energy', 18, 0.22);
        });
        e.ai.attack = 2 + Math.random() * 1.2;
        if (Math.random() < 0.3) e.ai.strafe = -strafe;
      }
      break;
    }

    case 'brute':
      if (attackReady && !e.busy && gap < 3.5) {
        e.faceToward(target.pos);
        combat.slam(e, 4.2, 1, basicDamage(e.stats, e.level) * 1.3);
        e.ai.attack = 3.5 + Math.random() * 1.5;
      } else if (gap > 1) steerToward(e, target.pos);
      break;

    case 'boss': {
      if (e.ai.flee) {
        flee(e, combat, dt, target, dist);
        break;
      }
      if (useTravel(e, combat, dt, dist, target.pos, target)) break;
      if (!e.busy) {
        // Try a power first, then a telegraphed slam, then melee.
        const ready = e.skills.map((_, i) => i).filter((i) => combat.canCast(e, i));
        const wantPower = ready.length > 0 && cooldown(e, 'power', dt) <= 0 && dist < 22;
        if (wantPower) {
          const slot = ready[Math.floor(Math.random() * ready.length)];
          if (powerUseful(e, e.skills[slot].power.kind, gap)) {
            combat.castPower(e, slot);
            e.ai.power = 1.8 + Math.random() * 1.5;
            break;
          }
        }
        if (cooldown(e, 'slam', dt) <= 0 && gap < 6) {
          combat.slam(e, 6, 1.1, basicDamage(e.stats, e.level) * 1.6, e.skills[0]?.power.element ?? 'kinetic');
          e.ai.slam = 7 + Math.random() * 3;
          break;
        }
        if (gap < 1.5 && attackReady) {
          e.faceToward(target.pos);
          combat.basicAttack(e);
          e.ai.attack = 0.6 + Math.random() * 0.5;
          break;
        }
      }
      if (gap > 1.2) steerToward(e, target.pos, 0.9);
      break;
    }

    case 'summon':
      // Echoes harry the nearest enemy with melee and their copied blast.
      climbToward(e, combat, target);
      if (!e.busy && attackReady) {
        if (dist > 5 && dist < 18 && combat.canCast(e, 0)) {
          combat.castPower(e, 0);
          e.ai.attack = 1.6 + Math.random();
          break;
        }
        if (gap < 1.4) {
          e.faceToward(target.pos);
          combat.basicAttack(e);
          e.ai.attack = 0.5 + Math.random() * 0.4;
          break;
        }
      }
      if (gap > 1.2) steerToward(e, target.pos);
      break;

    case 'hero':
    case 'ally':
      break;
  }
}

export type SquadOrder = 'free' | 'focus' | 'follow' | 'hold';

export interface SquadContext {
  order: SquadOrder;
  /** The leader's current target (Focus order). */
  focus: Actor | null;
  /** Where to stand on Hold. */
  holdAt: THREE.Vector3 | null;
}

const FREE: SquadContext = { order: 'free', focus: null, holdAt: null };

const RANGED_KINDS: ReadonlySet<PowerKind> = new Set(['blast', 'beam', 'optic', 'web', 'telekinesis', 'reality', 'mindcontrol', 'storm', 'gravity', 'drain']);

/** Reads a teammate's kit and stats to decide how they fight. */
export function squadRole(a: Actor): SquadRole {
  const kinds = a.skills.map((s) => s.power.kind);
  const st = a.stats;
  if (kinds.includes('heal') && st.energy + st.intelligence >= 13) return 'support';
  if (st.durability >= 8 || (kinds.includes('shield') && st.durability >= 7)) return 'tank';
  if (kinds.filter((k) => RANGED_KINDS.has(k)).length >= 2 && st.energy >= st.strength) return 'ranged';
  return 'striker';
}

/** Picks an enemy, spreading the squad out (except on bosses, which everyone may pile onto). */
function chooseTarget(a: Actor, combat: Combat, role: SquadRole, ctx: SquadContext, leader: Actor): Actor | null {
  if (ctx.order === 'focus' && ctx.focus?.alive) return ctx.focus;
  const anchor = ctx.order === 'hold' && ctx.holdAt ? ctx.holdAt : ctx.order === 'follow' ? leader.pos : a.pos;
  const reach = ctx.order === 'follow' ? 6 : ctx.order === 'hold' ? 12 : 28;
  const squad = combat.squadOf(a);
  const enemies = combat.enemiesOf(a).filter((e) => e.pos.distanceTo(anchor) <= reach);
  if (!enemies.length) return null;
  const score = (e: Actor) => {
    let s = e.pos.distanceTo(a.pos);
    const crowd = squad.filter((m) => m !== a && m.aiTarget === e).length;
    if (e.archetype !== 'boss') s += crowd * 8;
    if (role === 'tank' && (e.archetype === 'boss' || e.archetype === 'brute')) s -= 15;
    if (role === 'ranged' && e.archetype === 'gunner') s -= 6;
    // Peel enemies off the leader.
    if (e.pos.distanceTo(leader.pos) < 4) s -= 5;
    return s;
  };
  return enemies.sort((x, y) => score(x) - score(y))[0];
}

/**
 * AI teammate. Autonomous by default: revives downed squadmates, heals,
 * and fights by role (tanks take bosses, ranged keep distance, strikers dive,
 * supports stay near whoever is hurt). Squad orders narrow what they do.
 */
export function updateAlly(a: Actor, combat: Combat, dt: number, leader: Actor, ctx: SquadContext = FREE) {
  a.moveIntent.set(0, 0, 0);
  if (!a.alive) return;
  const role = (a.squadRole ??= squadRole(a));
  const squad = combat.squadOf(a);
  const threatNear = combat.enemiesOf(a).some((e) => e.pos.distanceTo(a.pos) < 3.5);

  // 1. Revive anyone down nearby (the leader first).
  const downed = combat.actors
    .filter((x) => x.downed && x.team === a.team && x.pos.distanceTo(a.pos) < 30)
    .sort((x, y) => (x === leader ? -1 : y === leader ? 1 : x.pos.distanceTo(a.pos) - y.pos.distanceTo(a.pos)))[0];
  if (downed && !threatNear) {
    if (Math.hypot(downed.pos.x - a.pos.x, downed.pos.z - a.pos.z) > 1.6) {
      steerToward(a, downed.pos);
      if (downed.pos.distanceTo(a.pos) > 14) useTravel(a, combat, dt, 99, downed.pos);
    }
    return;
  }

  // 2. Supports heal the team when someone is hurting.
  if (!a.busy) {
    const hurt = squad.some((m) => m.hp < m.maxHp * 0.55 && m.pos.distanceTo(a.pos) < 8);
    const healSlot = a.skills.findIndex((s) => s.power.kind === 'heal');
    if (hurt && healSlot >= 0 && combat.canCast(a, healSlot)) {
      combat.castPower(a, healSlot);
      return;
    }
    const shieldSlot = a.skills.findIndex((s) => s.power.kind === 'shield');
    if (role === 'tank' && shieldSlot >= 0 && a.hp < a.maxHp * 0.7 && a.sinceHit < 1 && combat.canCast(a, shieldSlot)) {
      combat.castPower(a, shieldSlot);
      return;
    }
  }

  const target = chooseTarget(a, combat, role, ctx, leader);
  a.aiTarget = target;

  // 3. Nothing to fight: regroup.
  if (!target) {
    const home = ctx.order === 'hold' && ctx.holdAt ? ctx.holdAt : role === 'support'
      ? (squad.filter((m) => m !== a).sort((x, y) => x.hp / x.maxHp - y.hp / y.maxHp)[0]?.pos ?? leader.pos)
      : leader.pos;
    const dist = a.pos.distanceTo(home);
    if (dist > 4) steerToward(a, home);
    if (dist > 16) useTravel(a, combat, dt, dist, home);
    return;
  }

  const gap = a.pos.distanceTo(target.pos) - a.radius - target.radius;
  if (role !== 'ranged' && useTravel(a, combat, dt, gap, target.pos, target)) return;
  if (!a.busy) {
    const ready = a.skills.map((_, i) => i).filter((i) => combat.canCast(a, i));
    if (ready.length && cooldown(a, 'power', dt) <= 0) {
      const slot = ready[Math.floor(Math.random() * ready.length)];
      if (powerUseful(a, a.skills[slot].power.kind, gap)) {
        a.faceToward(target.pos);
        if (combat.castPower(a, slot)) {
          a.ai.power = (role === 'ranged' ? 1.5 : 2.5) + Math.random() * 1.5;
          return;
        }
      }
    }
    if (gap < 1.4 && cooldown(a, 'attack', dt) <= 0) {
      a.faceToward(target.pos);
      combat.basicAttack(a);
      a.ai.attack = 0.35;
      return;
    }
  }

  // 4. Positioning by role.
  if (role === 'ranged') {
    if (gap < 6) steerToward(a, a.pos.clone().multiplyScalar(2).sub(target.pos));
    else if (gap > 14) steerToward(a, target.pos);
    else {
      const side = new THREE.Vector3(target.pos.z - a.pos.z, 0, -(target.pos.x - a.pos.x)).normalize();
      a.moveIntent.copy(side).multiplyScalar(0.4);
      a.faceToward(target.pos);
    }
  } else if (gap > 1.2) steerToward(a, target.pos);
}
