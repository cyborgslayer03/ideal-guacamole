// Enemy behaviour per archetype. Brains only set intents and trigger combat
// actions; physics and damage live in Combat.

import * as THREE from 'three';
import { basicDamage } from '../core/rules';
import type { Actor, Combat } from './combat';

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
function useTravel(a: Actor, combat: Combat, dt: number, dist: number, toward: THREE.Vector3): boolean {
  const p = a.travel;
  if (!p || p.kind === 'flight' || a.busy || a.travelRemaining > 0) return false;
  if (cooldown(a, 'travel', dt) > 0) return false;
  const wants = dist > 11 || (p.kind === 'teleport' && a.sinceHit < 0.3 && Math.random() < 0.25);
  if (!wants) return false;
  a.ai.travel = 1.2 + Math.random() * 1.5;
  // Aim the move: out of range, teleport and leap go the way the actor is heading.
  a.faceToward(toward);
  steerToward(a, toward);
  return combat.travel(a);
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
      if (useTravel(e, combat, dt, dist, target.pos)) break;
      if (!e.busy) {
        // Try a power first, then a telegraphed slam, then melee.
        const ready = e.skills.map((_, i) => i).filter((i) => combat.canCast(e, i));
        const wantPower = ready.length > 0 && cooldown(e, 'power', dt) <= 0 && dist < 22;
        if (wantPower) {
          const slot = ready[Math.floor(Math.random() * ready.length)];
          const kind = e.skills[slot].power.kind;
          const useful = kind === 'heal' ? e.hp < e.maxHp * 0.6 : kind === 'nova' || kind === 'dash' ? dist < 9 : true;
          if (useful) {
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

    case 'hero':
    case 'ally':
      break;
  }
}

/** Companion brain: fight nearby enemies with powers and melee, otherwise stay close to the leader. */
export function updateAlly(a: Actor, combat: Combat, dt: number, leader: Actor) {
  a.moveIntent.set(0, 0, 0);
  if (!a.alive) return;
  const target = combat.findTarget(a, 22);
  if (!target) {
    const toLeader = a.pos.distanceTo(leader.pos);
    if (toLeader > 4) steerToward(a, leader.pos);
    if (toLeader > 16) useTravel(a, combat, dt, toLeader, leader.pos);
    return;
  }
  const gap = a.pos.distanceTo(target.pos) - a.radius - target.radius;
  if (useTravel(a, combat, dt, gap, target.pos)) return;
  if (!a.busy) {
    const ready = a.skills.map((_, i) => i).filter((i) => combat.canCast(a, i));
    if (ready.length && cooldown(a, 'power', dt) <= 0) {
      const slot = ready[Math.floor(Math.random() * ready.length)];
      const kind = a.skills[slot].power.kind;
      const useful = kind === 'heal' ? a.hp < a.maxHp * 0.6 : kind === 'nova' || kind === 'dash' ? gap < 6 : kind !== 'shield' || a.sinceHit < 1;
      if (useful && combat.castPower(a, slot)) {
        a.ai.power = 2.5 + Math.random() * 2;
        return;
      }
    }
    if (gap < 1.4 && cooldown(a, 'attack', dt) <= 0) {
      a.faceToward(target.pos);
      combat.basicAttack(a);
      a.ai.attack = 0.35;
      return;
    }
  }
  if (gap > 1.2) steerToward(a, target.pos);
}
