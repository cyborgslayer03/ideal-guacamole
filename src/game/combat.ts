// Combat simulation: actors, movement physics, melee, powers, projectiles,
// and elemental status effects. Player, minions, and bosses all share it.

import * as THREE from 'three';
import {
  ELEMENT_COLORS, basicDamage, leapSlamRadius, maxEnergy, maxHealth, moveSpeed, powerCooldown, powerCost, powerDamage,
  rollDamage, energyRegen, speedMultiplier, teleportRange,
} from '../core/rules';
import { isMovement, type Appearance, type Character, type Element, type Power, type Stats } from '../core/types';
import { ARENA_RADIUS, THIN, floorAt, type Obstacle } from './arena';
import type { Effects } from './effects';
import { CharacterModel, idleAnim, type AnimState } from './model';

export type Team = 'player' | 'enemy';
export type Archetype = 'hero' | 'ally' | 'grunt' | 'gunner' | 'brute' | 'boss';
export type SquadRole = 'tank' | 'striker' | 'ranged' | 'support';

/** Seconds a downed hero can wait for a revive. */
export const BLEED_OUT = 25;
/** Seconds a teammate must stay beside a downed hero to revive them. */
export const REVIVE_TIME = 2.5;

export interface SkillSlot {
  power: Power;
  cooldown: number;
  remaining: number;
  cost: number;
}

const COMBO = [1, 1.1, 1.25, 1.9];
const ATTACK_TIME = 0.3;
const COMBO_WINDOW = 0.55;
const DODGE_TIME = 0.22;
const DODGE_COOLDOWN = 0.7;
const GRAVITY = 30;

export class Actor {
  readonly model: CharacterModel;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  /** Desired horizontal movement direction, magnitude 0-1. */
  readonly moveIntent = new THREE.Vector3();
  /** -1 descend, 0 hover, 1 ascend (only while flying). */
  flyIntent = 0;
  facing = 0;
  hp: number;
  maxHp: number;
  energy: number;
  maxEnergy: number;
  readonly speed: number;
  readonly radius: number;
  alive = true;
  grounded = true;
  flying = false;
  readonly canFly: boolean;
  jumps = 0;
  readonly skills: SkillSlot[];
  readonly anim: AnimState = idleAnim();

  attackTimer = 0;
  comboStep = 0;
  comboWindow = 0;
  dodgeTimer = 0;
  dodgeCooldown = 0;
  invuln = 0;
  stagger = 0;
  castTimer = 0;
  dashHits: Set<Actor> | null = null;
  dashDamage = 0;
  dashPower: Power | null = null;

  burn = 0;
  burnDps = 0;
  slow = 0;
  stun = 0;
  shield = 0;
  regen = 0;
  regenPerSec = 0;
  ultimate = 0;
  /** Seconds since this actor last took damage; drives HUD and AI. */
  sinceHit = 99;
  /** Shown before the name on boss bars, e.g. "Nemesis" or "Elite". */
  title = '';
  /** Multiplies all damage this actor deals (threat tiers, elites). */
  damageMult = 1;
  /** Free-form per-archetype AI memory. */
  ai: Record<string, number> = {};
  shieldMesh: THREE.Mesh | null = null;
  /** The movement power on the travel button (flight, teleport, or leap). */
  readonly travel: Power | null;
  readonly travelCooldown: number;
  travelRemaining = 0;
  /** Run-speed multiplier from Super Speed. */
  readonly speedMult: number;
  /** Set while airborne from a Super Leap; the slam lands with it. */
  leap: { damage: number; element: Element; radius: number } | null = null;
  /** Squad play: knocked out but revivable by a nearby teammate. */
  downed = false;
  bleedOut = 0;
  reviveProgress = 0;
  /** Seconds left in which a hit would count as a perfect dodge. */
  perfectWindow = 0;
  /** AI teammates: the role they play and the enemy they're on. */
  squadRole: SquadRole | null = null;
  aiTarget: Actor | null = null;
  private trailTimer = 0;

  constructor(
    readonly name: string,
    readonly team: Team,
    /** Mutable so control can pass between squad members (tag-switching). */
    public archetype: Archetype,
    readonly stats: Stats,
    public level: number,
    appearance: Appearance,
    powers: Power[],
    healthOverride?: number,
    readonly character?: Character,
  ) {
    this.model = new CharacterModel(appearance);
    this.maxHp = this.hp = healthOverride ?? maxHealth(stats, level);
    this.maxEnergy = this.energy = maxEnergy(stats);
    const sizeBonus = archetype === 'brute' ? 1.4 : archetype === 'boss' ? 1.25 : 1;
    this.model.root.scale.setScalar(sizeBonus);
    this.radius = 0.55 * appearance.height * sizeBonus;
    this.speedMult = speedMultiplier(powers);
    this.speed = moveSpeed(stats) * this.speedMult * (archetype === 'brute' ? 0.6 : archetype === 'hero' || archetype === 'ally' ? 1 : 0.7);
    this.canFly = powers.some((p) => p.kind === 'flight');
    this.travel = powers.find((p) => p.kind === 'flight' || p.kind === 'teleport' || p.kind === 'leap') ?? null;
    this.travelCooldown = this.travel ? powerCooldown(this.travel, stats) : 0;
    this.skills = powers
      .filter((p) => !isMovement(p.kind))
      .slice(0, 4)
      .map((p) => ({ power: p, cooldown: powerCooldown(p, stats), remaining: 0, cost: powerCost(p) }));
  }

  /** True once per interval while moving at super speed (drives afterimage trails). */
  speedTrail(dt: number): boolean {
    if (this.speedMult <= 1.2 || Math.hypot(this.vel.x, this.vel.z) < this.speed * 0.6) return false;
    this.trailTimer -= dt;
    if (this.trailTimer > 0) return false;
    this.trailTimer = 0.05;
    return true;
  }

  get busy(): boolean {
    return this.stun > 0 || this.castTimer > 0 || this.dodgeTimer > 0 || this.dashHits !== null;
  }

  get center(): THREE.Vector3 {
    return new THREE.Vector3(this.pos.x, this.pos.y + this.model.height * 0.55 * this.model.root.scale.y, this.pos.z);
  }

  forward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
  }

  faceToward(p: THREE.Vector3) {
    const dx = p.x - this.pos.x;
    const dz = p.z - this.pos.z;
    if (dx * dx + dz * dz > 1e-4) this.facing = Math.atan2(dx, dz);
  }
}

export interface DamageEvent {
  target: Actor;
  source: Actor | null;
  amount: number;
  crit: boolean;
  heal?: boolean;
}

interface Projectile {
  owner: Actor;
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  damage: number;
  element: Element;
  life: number;
  radius: number;
  aoe: number;
}

interface Channel {
  actor: Actor;
  power: Power;
  remaining: number;
  tick: number;
  damage: number;
}

const projectileGeo = new THREE.SphereGeometry(1, 10, 8);
const shieldGeo = new THREE.SphereGeometry(1, 20, 14);

const isSquad = (a: Actor) => a.archetype === 'hero' || a.archetype === 'ally';

export class Combat {
  readonly actors: Actor[] = [];
  private projectiles: Projectile[] = [];
  private channels: Channel[] = [];
  /** Delayed actions in simulation time, so pausing and slow-mo stay in sync. */
  private timers: { at: number; fn: () => void }[] = [];
  private clock = 0;
  gravityScale = 1;
  powerScale = 1;
  onDamage: (e: DamageEvent) => void = () => {};
  onKill: (target: Actor, killer: Actor | null) => void = () => {};
  /** Squad play: heroes go down (revivable) instead of dying outright. */
  downedEnabled = false;
  onDowned: (a: Actor) => void = () => {};
  onRevived: (a: Actor, by: Actor | null) => void = () => {};
  onPerfectDodge: (a: Actor) => void = () => {};

  constructor(
    private readonly scene: THREE.Scene,
    private readonly fx: Effects,
    private readonly obstacles: Obstacle[],
  ) {}

  add(actor: Actor) {
    this.actors.push(actor);
    this.scene.add(actor.model.root);
  }

  remove(actor: Actor) {
    const i = this.actors.indexOf(actor);
    if (i >= 0) this.actors.splice(i, 1);
    this.scene.remove(actor.model.root);
    if (actor.shieldMesh) this.scene.remove(actor.shieldMesh);
    actor.model.dispose();
  }

  enemiesOf(actor: Actor): Actor[] {
    return this.actors.filter((a) => a.alive && a.team !== actor.team);
  }

  /** Nearest enemy within range, preferring ones in front of the actor. */
  findTarget(actor: Actor, range: number): Actor | null {
    const fwd = actor.forward();
    let best: Actor | null = null;
    let bestScore = Infinity;
    for (const other of this.enemiesOf(actor)) {
      const d = other.pos.distanceTo(actor.pos);
      if (d > range) continue;
      const dir = other.pos.clone().sub(actor.pos).setY(0).normalize();
      const score = d * (1.6 - dir.dot(fwd) * 0.6);
      if (score < bestScore) {
        bestScore = score;
        best = other;
      }
    }
    return best;
  }

  schedule(delay: number, fn: () => void) {
    this.timers.push({ at: this.clock + delay, fn });
  }

  // --- Actions -------------------------------------------------------------

  jump(a: Actor): boolean {
    if (a.busy || a.flying || a.jumps >= 2) return false;
    a.vel.y = 12;
    a.grounded = false;
    a.jumps++;
    if (a.jumps === 2) this.fx.burst(a.pos.clone(), a.skills[0] ? ELEMENT_COLORS[a.skills[0].power.element] : '#ffffff', 8, 4);
    return true;
  }

  /** The travel button: toggles flight, blinks a teleporter, or launches a leap. */
  /** `preferred` lets AI aim a teleport or leap at the enemy it chose, not just the nearest. */
  travel(a: Actor, preferred: Actor | null = null): boolean {
    const p = a.travel;
    if (!p || !a.alive || a.stun > 0) return false;
    if (p.kind === 'flight') {
      this.toggleFlight(a);
      return true;
    }
    if (a.travelRemaining > 0 || a.castTimer > 0) return false;
    const ok = p.kind === 'teleport' ? this.teleport(a, p, preferred) : this.superLeap(a, p, preferred);
    if (ok) a.travelRemaining = a.travelCooldown;
    return ok;
  }

  /** Blink toward the target (or the way you're moving) and shock whoever is near the landing spot. */
  private teleport(a: Actor, p: Power, preferred: Actor | null): boolean {
    const color = ELEMENT_COLORS[p.element];
    const range = teleportRange(p);
    // A chosen target out of reach means "blink toward it" (along the steering direction).
    const target = preferred ? (preferred.pos.distanceTo(a.pos) <= range + 6 ? preferred : null) : this.findTarget(a, range + 6);
    const from = a.pos.clone();
    const to = new THREE.Vector3();
    // The player steers a blink with the stick; AI (and an idle player) blink to the target.
    if (target && !a.ai.flee && (a.archetype !== 'hero' || a.moveIntent.lengthSq() < 0.01)) {
      // Appear just beside the target, on the side we came from.
      const away = from.clone().sub(target.pos).setY(0);
      if (away.lengthSq() < 1e-4) away.set(0, 0, 1);
      to.copy(target.pos).addScaledVector(away.normalize(), target.radius + a.radius + 1.2);
      // Targets on a narrow ledge or platform: arrive on the same surface, right next to them.
      to.y = target.pos.y;
      if (target.pos.y > 0.5 && this.floorAt(to.x, to.z, to.y) < target.pos.y - 0.5) {
        to.copy(target.pos).addScaledVector(away, 0.6);
      }
    } else {
      const dir = a.moveIntent.lengthSq() > 0.01 ? a.moveIntent.clone().setY(0).normalize() : a.forward();
      to.copy(from).addScaledVector(dir, range);
      to.y = a.flying ? a.pos.y : this.floorAt(to.x, to.z, a.pos.y);
    }
    this.keepInBounds(to, a.radius);
    this.fx.burst(a.center, color, 18, 6, 0.14);
    this.fx.ring(from, color, 2.5, 0.3);
    a.pos.copy(to);
    a.vel.set(0, 0, 0);
    if (target) a.faceToward(target.pos);
    a.invuln = Math.max(a.invuln, 0.25);
    a.attackTimer = 0;
    this.fx.flare(a.center, color, 2.6, 0.3);
    this.fx.ring(a.pos, color, 3.2, 0.35);
    const dmg = powerDamage(p, a.stats, a.level, this.powerScale) * (a.team === 'enemy' && a.archetype !== 'boss' ? 0.5 : 1);
    for (const e of this.enemiesOf(a)) {
      if (e.pos.distanceTo(a.pos) <= 3 + e.radius) this.damage(e, dmg, a, p.element, 6);
    }
    return true;
  }

  /** A long arcing jump toward the target that slams down on landing. */
  private superLeap(a: Actor, p: Power, preferred: Actor | null): boolean {
    if (!a.grounded || a.flying) return false;
    const target = a.ai.flee ? null : preferred ? (preferred.pos.distanceTo(a.pos) <= 26 ? preferred : null) : this.findTarget(a, 26);
    const flightTime = 0.9;
    const dest = target
      ? target.pos.clone()
      : a.pos.clone().addScaledVector(a.moveIntent.lengthSq() > 0.01 ? a.moveIntent.clone().setY(0).normalize() : a.forward(), 14);
    if (!target) dest.y = this.floorAt(dest.x, dest.z, a.pos.y + 4);
    this.keepInBounds(dest, a.radius);
    a.faceToward(dest);
    // Ballistic arc that lands at the destination's height (a rooftop, the skydeck, or the ground).
    const g = GRAVITY * this.gravityScale;
    a.vel.x = (dest.x - a.pos.x) / flightTime;
    a.vel.z = (dest.z - a.pos.z) / flightTime;
    a.vel.y = (dest.y - a.pos.y + (g * flightTime * flightTime) / 2) / flightTime;
    a.grounded = false;
    a.jumps = 2;
    a.attackTimer = 0;
    a.leap = {
      damage: powerDamage(p, a.stats, a.level, this.powerScale) * (a.team === 'enemy' && a.archetype !== 'boss' ? 0.5 : 1),
      element: p.element,
      radius: leapSlamRadius(p),
    };
    this.fx.ring(a.pos, ELEMENT_COLORS[p.element], 3, 0.35);
    this.fx.burst(a.pos.clone().setY(0.3), '#d8c8b0', 12, 6);
    return true;
  }

  private landLeap(a: Actor) {
    const slam = a.leap;
    a.leap = null;
    if (!slam || !a.alive) return;
    const color = ELEMENT_COLORS[slam.element];
    this.fx.ring(a.pos, color, slam.radius * 1.15, 0.5);
    this.fx.flare(a.pos.clone().setY(0.6), color, slam.radius * 0.6, 0.3);
    this.fx.burst(a.pos.clone().setY(0.4), '#d8c8b0', 22, 10);
    this.fx.shake(a.archetype === 'hero' ? 0.45 : 0.3);
    for (const e of this.enemiesOf(a)) {
      if (e.pos.distanceTo(a.pos) <= slam.radius + e.radius && Math.abs(e.pos.y - a.pos.y) < 2.5) this.damage(e, slam.damage, a, slam.element, 11);
    }
  }

  private keepInBounds(p: THREE.Vector3, radius: number) {
    const r = Math.hypot(p.x, p.z);
    const max = ARENA_RADIUS - radius - 1;
    if (r > max) {
      p.x *= max / r;
      p.z *= max / r;
    }
    for (const o of this.obstacles) {
      if (!this.blocksSideways(o, p.y)) continue;
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const d = Math.hypot(dx, dz);
      const min = o.r + radius + 0.2;
      if (d < min) {
        const nx = d > 1e-4 ? dx / d : 1;
        const nz = d > 1e-4 ? dz / d : 0;
        p.x = o.x + nx * min;
        p.z = o.z + nz * min;
      }
    }
  }

  /** Whether a body standing at height y bumps into the side of this obstacle. */
  private blocksSideways(o: Obstacle, y: number): boolean {
    if (o.top - o.bottom < THIN) return false; // one-way platform
    return y < o.top - 0.3 && y + 1.8 > o.bottom;
  }

  /** The surface something at (x, z), currently at height y, would land on. */
  floorAt(x: number, z: number, y: number): number {
    return floorAt(this.obstacles, x, z, y + 0.3);
  }

  toggleFlight(a: Actor) {
    if (!a.canFly || a.stun > 0) return;
    a.flying = !a.flying;
    if (a.flying) {
      a.vel.y = 6;
      a.grounded = false;
    }
  }

  dodge(a: Actor): boolean {
    if (a.dodgeCooldown > 0 || a.stun > 0 || a.castTimer > 0) return false;
    const dir = a.moveIntent.lengthSq() > 0.01 ? a.moveIntent.clone().normalize() : a.forward();
    a.faceToward(a.pos.clone().add(dir));
    a.vel.x = dir.x * 30;
    a.vel.z = dir.z * 30;
    a.dodgeTimer = DODGE_TIME;
    a.dodgeCooldown = DODGE_COOLDOWN;
    a.perfectWindow = 0.2;
    a.invuln = DODGE_TIME + 0.08;
    a.attackTimer = 0;
    a.comboStep = 0;
    return true;
  }

  basicAttack(a: Actor): boolean {
    if (a.busy || a.attackTimer > 0) return false;
    const step = a.comboWindow > 0 ? a.comboStep : 0;
    const target = this.findTarget(a, 6);
    if (target) {
      a.faceToward(target.pos);
      const gap = target.pos.distanceTo(a.pos) - target.radius - a.radius;
      if (gap > 0.6) {
        // Lunge toward the target, MFR-style soft lock.
        const lunge = Math.min(gap - 0.4, 3.5) / ATTACK_TIME;
        const dir = a.forward();
        a.vel.x = dir.x * lunge;
        a.vel.z = dir.z * lunge;
      }
    }
    a.attackTimer = ATTACK_TIME;
    a.anim.attackArm = step % 2 === 0 ? 'right' : 'left';
    a.comboStep = (step + 1) % COMBO.length;
    a.comboWindow = ATTACK_TIME + COMBO_WINDOW;

    const finisher = step === COMBO.length - 1;
    const raw = basicDamage(a.stats, a.level) * COMBO[step] * (a.archetype === 'hero' ? 1 : a.archetype === 'ally' ? 0.7 : 0.5);
    // Resolve the hit slightly into the swing.
    this.schedule(ATTACK_TIME * 0.4, () => {
      if (!a.alive) return;
      const reach = finisher ? 3.4 : 2.4;
      const origin = a.pos.clone().addScaledVector(a.forward(), 1);
      let hit = false;
      for (const e of this.enemiesOf(a)) {
        const d = e.pos.distanceTo(origin);
        if (d <= reach + e.radius && Math.abs(e.pos.y - a.pos.y) < 2.5) {
          this.damage(e, raw, a, null, finisher ? 9 : 3);
          hit = true;
        }
      }
      const color = a.skills[0] ? ELEMENT_COLORS[a.skills[0].power.element] : '#ffffff';
      if (hit) this.fx.burst(origin.clone().setY(a.pos.y + 1.2), color, finisher ? 18 : 8, finisher ? 10 : 6);
      if (finisher) {
        this.fx.ring(origin, color, reach + 0.5);
        if (hit) this.fx.shake(0.35);
      }
    });
    return true;
  }

  canCast(a: Actor, slot: number): boolean {
    const s = a.skills[slot];
    return !!s && s.remaining <= 0 && a.energy >= s.cost && !a.busy && a.alive;
  }

  castPower(a: Actor, slot: number): boolean {
    if (!this.canCast(a, slot)) return false;
    const s = a.skills[slot];
    s.remaining = s.cooldown;
    a.energy -= s.cost;
    a.attackTimer = 0;
    const p = s.power;
    const color = ELEMENT_COLORS[p.element];
    const dmg = powerDamage(p, a.stats, a.level, this.powerScale) * (a.team === 'enemy' && a.archetype !== 'boss' ? 0.5 : 1);
    const target = this.findTarget(a, 30);
    if (target) a.faceToward(target.pos);
    const fwd = a.forward();

    switch (p.kind) {
      case 'blast': {
        a.castTimer = 0.25;
        const count = 1 + Math.floor(p.potency / 4);
        for (let i = 0; i < count; i++) {
          const spread = (i - (count - 1) / 2) * 0.18;
          const dir = fwd.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), spread);
          if (target) {
            const toT = target.center.sub(a.center).normalize();
            dir.y = toT.y;
          }
          this.fireProjectile(a, dir, dmg, p.element, 26, 0.25 + p.potency * 0.02, 2 + p.potency * 0.2);
        }
        break;
      }
      case 'beam':
        a.castTimer = 1.2;
        this.channels.push({ actor: a, power: p, remaining: 1.2, tick: 0, damage: dmg });
        break;
      case 'nova': {
        a.castTimer = 0.35;
        const radius = 5 + p.potency * 0.5;
        this.fx.flare(a.center, color, radius);
        this.fx.ring(a.pos, color, radius * 1.1);
        this.fx.burst(a.center, color, 30, 14, 0.18);
        this.fx.shake(0.4);
        for (const e of this.enemiesOf(a)) {
          if (e.pos.distanceTo(a.pos) <= radius + e.radius) this.damage(e, dmg, a, p.element, 12);
        }
        break;
      }
      case 'dash':
        a.dashHits = new Set();
        a.dashDamage = dmg;
        a.dashPower = p;
        a.castTimer = 0;
        a.invuln = 0.35;
        a.vel.x = fwd.x * 40;
        a.vel.z = fwd.z * 40;
        a.ai.dashTime = 0.3;
        break;
      case 'shield':
        a.shield = 3 + p.potency * 0.4;
        a.castTimer = 0.2;
        this.fx.ring(a.pos, color, 3);
        break;
      case 'heal': {
        a.castTimer = 0.4;
        // Heals reach every teammate in range, not just the caster.
        for (const ally of this.squadOf(a)) {
          if (ally !== a && ally.pos.distanceTo(a.pos) > 8) continue;
          ally.regen = 4;
          ally.regenPerSec = ally.maxHp * (0.06 + p.potency * 0.012);
          if (ally !== a) this.fx.burst(ally.center, color, 10, 4, 0.12);
        }
        this.fx.burst(a.center, color, 20, 5, 0.15);
        this.fx.ring(a.pos, color, 8);
        break;
      }
      case 'flight':
        break;
    }
    a.anim.cast = a.castTimer > 0 ? 0 : -1;
    return true;
  }

  /** Player-only ultimate: a massive elemental detonation. */
  ultimate(a: Actor): boolean {
    if (a.ultimate < 100 || a.stun > 0 || !a.alive) return false;
    a.castTimer = 0.6;
    a.anim.cast = 0;
    a.invuln = 1;
    const element = a.skills[0]?.power.element ?? 'energy';
    const color = ELEMENT_COLORS[element];
    const best = Math.max(5, ...a.skills.map((s) => s.power.potency));
    const raw = (basicDamage(a.stats, a.level) * 6 + best * 25) * this.powerScale;
    const radius = 14;
    this.fx.flare(a.center, color, radius, 0.6);
    this.fx.flare(a.center, '#ffffff', radius * 0.5, 0.35);
    this.fx.ring(a.pos, color, radius * 1.2, 0.7);
    this.fx.ring(a.pos, '#ffffff', radius * 0.8, 0.5);
    this.fx.burst(a.center, color, 60, 22, 0.25);
    this.fx.shake(1.1);
    for (const e of this.enemiesOf(a)) {
      if (e.pos.distanceTo(a.pos) <= radius + e.radius) this.damage(e, raw, a, element, 18);
    }
    // Reset after the hits so the ultimate can't recharge itself.
    a.ultimate = 0;
    return true;
  }

  fireProjectile(owner: Actor, dir: THREE.Vector3, damage: number, element: Element, speed: number, size: number, aoe = 0) {
    const color = ELEMENT_COLORS[element];
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(projectileGeo, mat);
    mesh.scale.setScalar(size);
    const glow = new THREE.Mesh(projectileGeo, mat.clone());
    (glow.material as THREE.MeshBasicMaterial).opacity = 0.3;
    glow.scale.setScalar(2.2);
    mesh.add(glow);
    mesh.position.copy(owner.center).addScaledVector(owner.forward(), 0.8);
    this.scene.add(mesh);
    this.projectiles.push({
      owner,
      mesh,
      vel: dir.clone().normalize().multiplyScalar(speed),
      damage,
      element,
      life: 2,
      radius: size,
      aoe,
    });
  }

  /** Telegraphed ground slam used by brutes and bosses. */
  slam(a: Actor, radius: number, windup: number, raw: number, element: Element = 'kinetic') {
    a.castTimer = windup;
    a.anim.cast = 0;
    const at = a.pos.clone();
    this.fx.telegraph(at, radius, windup);
    this.schedule(windup, () => {
      if (!a.alive) return;
      this.fx.ring(at, ELEMENT_COLORS[element], radius * 1.1);
      this.fx.burst(at.clone().setY(0.5), '#ffb080', 20, 10);
      this.fx.shake(0.3);
      for (const e of this.enemiesOf(a)) {
        if (e.pos.distanceTo(at) <= radius + e.radius && Math.abs(e.pos.y - at.y) < 2.5) this.damage(e, raw, a, element, 10);
      }
    });
  }

  // --- Damage --------------------------------------------------------------

  damage(target: Actor, raw: number, source: Actor | null, element: Element | null, knockback = 0) {
    if (target.alive && target.invuln > 0 && target.perfectWindow > 0 && source && source.team !== target.team) {
      target.perfectWindow = 0;
      this.onPerfectDodge(target);
    }
    if (!target.alive || target.invuln > 0) return;
    let amount = raw * (source?.damageMult ?? 1);
    if (element === 'cosmic') amount *= 1.25;
    if (element === 'tech') amount *= 1.1;
    const roll = rollDamage(amount, source?.stats ?? target.stats, target.stats);
    let dealt = roll.amount;
    if (target.shield > 0) dealt = Math.round(dealt * 0.3);
    target.hp -= dealt;
    target.sinceHit = 0;
    target.model.hitFlash();
    this.onDamage({ target, source, amount: dealt, crit: roll.crit });

    if (source) {
      if (source.archetype === 'hero') source.ultimate = Math.min(100, source.ultimate + dealt / (basicDamage(source.stats, source.level) * 0.3));
      if (element === 'shadow' || element === 'nature') this.heal(source, dealt * 0.15);
      if (element === 'energy') source.energy = Math.min(source.maxEnergy, source.energy + 4);
    }
    const isBoss = target.archetype === 'boss';
    if (element === 'fire') {
      target.burn = 3;
      target.burnDps = Math.max(target.burnDps, dealt * 0.15);
    }
    if (element === 'ice') target.slow = 2.5;
    if (element === 'lightning' || element === 'psychic') target.stun = Math.max(target.stun, isBoss ? 0.15 : 0.5);
    if (element === 'kinetic') knockback *= 1.6;

    if (knockback > 0 && source && !isBoss && target.archetype !== 'brute') {
      const dir = target.pos.clone().sub(source.pos).setY(0).normalize();
      target.vel.x += dir.x * knockback;
      target.vel.z += dir.z * knockback;
      if (knockback > 8) target.vel.y += 5;
      target.stagger = 0.25;
      target.attackTimer = 0;
    }

    if (target.hp <= 0) this.kill(target, source);
  }

  private kill(target: Actor, source: Actor | null) {
    target.hp = 0;
    target.alive = false;
    this.fx.burst(target.center, '#ffffff', 16, 9);
    // In squad play, heroes go down instead of out, and teammates can revive them.
    if (this.downedEnabled && isSquad(target) && !target.downed) {
      target.downed = true;
      target.bleedOut = BLEED_OUT;
      target.reviveProgress = 0;
      target.burn = target.regen = target.shield = 0;
      this.onDowned(target);
      return;
    }
    this.onKill(target, source);
  }

  /** Living heroes and allies on the actor's team (the actor included). */
  squadOf(a: Actor): Actor[] {
    return this.actors.filter((x) => x.alive && x.team === a.team && isSquad(x));
  }

  private updateDowned(a: Actor, dt: number) {
    a.bleedOut -= dt;
    const helper = this.actors.find((x) => x.alive && x.team === a.team && isSquad(x) && Math.hypot(x.pos.x - a.pos.x, x.pos.z - a.pos.z) < 2.5 && Math.abs(x.pos.y - a.pos.y) < 2);
    a.reviveProgress = helper ? a.reviveProgress + dt : Math.max(0, a.reviveProgress - dt * 0.5);
    if (helper && Math.random() < dt * 6) this.fx.burst(a.center, '#3eff8b', 2, 2, 0.12);
    if (a.reviveProgress >= REVIVE_TIME) {
      a.downed = false;
      a.alive = true;
      a.hp = Math.round(a.maxHp * 0.4);
      a.invuln = 2;
      a.vel.set(0, 0, 0);
      a.model.root.rotation.x = 0;
      this.fx.flare(a.center, '#3eff8b', 3, 0.5);
      this.fx.ring(a.pos, '#3eff8b', 4);
      this.onRevived(a, helper ?? null);
    } else if (a.bleedOut <= 0) {
      a.downed = false;
      this.onKill(a, null);
    }
  }

  /**
   * Team Assault: every squad member unleashes their strongest attack at once.
   * Returns how many heroes took part.
   */
  teamAssault(leader: Actor): number {
    const squad = this.squadOf(leader).filter((m) => m.pos.distanceTo(leader.pos) < 25);
    if (squad.length < 2) return 0;
    for (const m of squad) {
      const best = [...m.skills].sort((x, y) => powerDamage(y.power, m.stats, m.level) - powerDamage(x.power, m.stats, m.level))[0]?.power;
      const element = best?.element ?? 'kinetic';
      const color = ELEMENT_COLORS[element];
      const raw = ((best ? powerDamage(best, m.stats, m.level) : 0) * 2 + basicDamage(m.stats, m.level) * 2) * this.powerScale;
      m.invuln = Math.max(m.invuln, 1.2);
      m.castTimer = 0.5;
      m.anim.cast = 0;
      this.fx.flare(m.center, color, 9, 0.5);
      this.fx.ring(m.pos, color, 11, 0.6);
      this.fx.burst(m.center, color, 30, 16, 0.2);
      for (const e of this.enemiesOf(m)) {
        if (e.pos.distanceTo(m.pos) <= 10 + e.radius) this.damage(e, raw, m, element, 14);
      }
    }
    this.fx.shake(1.2);
    return squad.length;
  }

  heal(a: Actor, amount: number) {
    if (!a.alive || amount <= 0) return;
    const before = a.hp;
    a.hp = Math.min(a.maxHp, a.hp + amount);
    const healed = Math.round(a.hp - before);
    if (healed >= 5) this.onDamage({ target: a, source: a, amount: healed, crit: false, heal: true });
  }

  // --- Simulation ----------------------------------------------------------

  update(dt: number) {
    this.clock += dt;
    const due = this.timers.filter((t) => t.at <= this.clock);
    this.timers = this.timers.filter((t) => t.at > this.clock);
    for (const t of due) t.fn();
    for (const a of this.actors) this.updateActor(a, dt);
    this.separate();
    this.updateProjectiles(dt);
    this.updateChannels(dt);
  }

  private updateActor(a: Actor, dt: number) {
    a.sinceHit += dt;
    a.invuln = Math.max(0, a.invuln - dt);
    a.dodgeCooldown = Math.max(0, a.dodgeCooldown - dt);
    a.perfectWindow = Math.max(0, a.perfectWindow - dt);
    if (a.downed) this.updateDowned(a, dt);
    a.comboWindow = Math.max(0, a.comboWindow - dt);
    a.stagger = Math.max(0, a.stagger - dt);
    a.slow = Math.max(0, a.slow - dt);
    a.stun = Math.max(0, a.stun - dt);
    a.shield = Math.max(0, a.shield - dt);
    for (const s of a.skills) s.remaining = Math.max(0, s.remaining - dt);
    a.travelRemaining = Math.max(0, a.travelRemaining - dt);
    if (a.alive && a.speedTrail(dt)) {
      this.fx.burst(a.center, ELEMENT_COLORS[a.skills[0]?.power.element ?? 'lightning'], 2, 1.5, 0.16);
    }
    if (a.alive) a.energy = Math.min(a.maxEnergy, a.energy + energyRegen(a.stats) * dt);

    if (a.attackTimer > 0) {
      a.attackTimer = Math.max(0, a.attackTimer - dt);
      a.anim.attack = 1 - a.attackTimer / ATTACK_TIME;
    } else a.anim.attack = -1;
    if (a.castTimer > 0) {
      a.castTimer = Math.max(0, a.castTimer - dt);
      a.anim.cast = a.castTimer > 0 ? Math.min(1, (a.anim.cast < 0 ? 0 : a.anim.cast) + dt * 3) : -1;
    }

    if (a.burn > 0 && a.alive) {
      a.burn -= dt;
      a.hp -= a.burnDps * dt;
      if (a.hp <= 0) this.kill(a, null);
      if (a.burn <= 0) a.burnDps = 0;
    }
    if (a.regen > 0 && a.alive) {
      a.regen -= dt;
      this.heal(a, a.regenPerSec * dt);
    }

    this.updateShieldVisual(a);
    this.move(a, dt);
    this.updateDash(a, dt);

    // Model sync.
    a.model.root.position.copy(a.pos);
    const current = a.model.root.rotation.y;
    let delta = a.facing - current;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    a.model.root.rotation.y = current + delta * Math.min(1, dt * 14);
    const horizontal = Math.hypot(a.vel.x, a.vel.z);
    a.anim.moveBlend = Math.min(1, horizontal / Math.max(1, a.speed));
    a.anim.airborne = !a.grounded && !a.flying;
    a.anim.flying = a.flying;
    if (a.alive) a.model.update(dt, a.anim);
  }

  private move(a: Actor, dt: number) {
    const freeToMove = a.alive && a.stun <= 0 && a.stagger <= 0 && a.dodgeTimer <= 0 && !a.dashHits && !a.leap;
    if (a.dodgeTimer > 0) a.dodgeTimer -= dt;

    if (freeToMove) {
      const rooted = a.castTimer > 0 || a.attackTimer > 0;
      const speed = a.speed * (a.slow > 0 ? 0.5 : 1) * (a.flying ? 1.35 : 1) * (rooted ? 0.15 : 1);
      const targetX = a.moveIntent.x * speed;
      const targetZ = a.moveIntent.z * speed;
      const accel = Math.min(1, dt * (a.grounded || a.flying ? 14 : 4));
      if (!(a.attackTimer > 0 && Math.hypot(a.vel.x, a.vel.z) > speed)) {
        a.vel.x += (targetX - a.vel.x) * accel;
        a.vel.z += (targetZ - a.vel.z) * accel;
      }
      if (a.moveIntent.lengthSq() > 0.01 && !rooted) a.facing = Math.atan2(a.moveIntent.x, a.moveIntent.z);
    } else if (a.grounded && a.dodgeTimer <= 0 && !a.dashHits) {
      a.vel.x *= 1 - Math.min(1, dt * 8);
      a.vel.z *= 1 - Math.min(1, dt * 8);
    }

    if (a.flying) {
      a.vel.y += (a.flyIntent * a.speed * 0.8 - a.vel.y) * Math.min(1, dt * 6);
    } else if (!(a.dodgeTimer > 0 && !a.grounded)) {
      a.vel.y -= GRAVITY * this.gravityScale * dt;
    } else {
      a.vel.y = Math.max(a.vel.y, 0);
    }

    const prevY = a.pos.y;
    a.pos.addScaledVector(a.vel, dt);

    // Land on the highest surface we were above last frame (ground, rooftop, platform).
    const floor = this.floorAt(a.pos.x, a.pos.z, Math.max(prevY, a.pos.y));
    if (a.pos.y <= floor && a.vel.y <= 0) {
      a.pos.y = floor;
      if (a.vel.y < 0) a.vel.y = 0;
      a.grounded = true;
      a.jumps = 0;
      if (a.flying && a.flyIntent < 0) a.flying = false;
      if (a.leap) this.landLeap(a);
    } else {
      a.grounded = false;
    }
    if (a.flying) a.pos.y = Math.min(a.pos.y, 40);

    for (const o of this.obstacles) {
      if (!this.blocksSideways(o, a.pos.y)) continue;
      const dx = a.pos.x - o.x;
      const dz = a.pos.z - o.z;
      const d = Math.hypot(dx, dz);
      const min = o.r + a.radius;
      if (d < min && d > 1e-4) {
        a.pos.x = o.x + (dx / d) * min;
        a.pos.z = o.z + (dz / d) * min;
      }
    }
    const r = Math.hypot(a.pos.x, a.pos.z);
    const max = ARENA_RADIUS - a.radius;
    if (r > max) {
      a.pos.x *= max / r;
      a.pos.z *= max / r;
    }
  }

  private updateDash(a: Actor, dt: number) {
    if (!a.dashHits || !a.dashPower) return;
    a.ai.dashTime = (a.ai.dashTime ?? 0) - dt;
    const color = ELEMENT_COLORS[a.dashPower.element];
    this.fx.burst(a.center, color, 2, 2, 0.15);
    for (const e of this.enemiesOf(a)) {
      if (!a.dashHits.has(e) && e.pos.distanceTo(a.pos) < e.radius + a.radius + 1.2) {
        a.dashHits.add(e);
        this.damage(e, a.dashDamage, a, a.dashPower.element, 10);
        this.fx.burst(e.center, color, 10, 8);
      }
    }
    if (a.ai.dashTime <= 0) {
      a.dashHits = null;
      a.dashPower = null;
      a.vel.x *= 0.2;
      a.vel.z *= 0.2;
    }
  }

  private updateShieldVisual(a: Actor) {
    if (a.shield > 0 && !a.shieldMesh) {
      const color = ELEMENT_COLORS[a.skills.find((s) => s.power.kind === 'shield')?.power.element ?? 'energy'];
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false });
      a.shieldMesh = new THREE.Mesh(shieldGeo, mat);
      a.shieldMesh.scale.set(1.2, 1.4, 1.2).multiplyScalar(a.model.root.scale.x);
      this.scene.add(a.shieldMesh);
    }
    if (a.shieldMesh) {
      if (a.shield <= 0 || !a.alive) {
        this.scene.remove(a.shieldMesh);
        (a.shieldMesh.material as THREE.Material).dispose();
        a.shieldMesh = null;
      } else {
        a.shieldMesh.position.copy(a.center);
        (a.shieldMesh.material as THREE.MeshBasicMaterial).opacity = 0.15 + Math.sin(performance.now() / 120) * 0.05 + (a.shield < 1 ? -0.1 : 0);
      }
    }
  }

  /** Keeps actors from overlapping each other. */
  private separate() {
    const list = this.actors.filter((a) => a.alive);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (Math.abs(a.pos.y - b.pos.y) > 1.5) continue;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d = Math.hypot(dx, dz);
        const min = a.radius + b.radius;
        if (d < min && d > 1e-4) {
          const push = (min - d) / 2;
          const nx = dx / d;
          const nz = dz / d;
          a.pos.x -= nx * push;
          a.pos.z -= nz * push;
          b.pos.x += nx * push;
          b.pos.z += nz * push;
        }
      }
    }
  }

  private updateProjectiles(dt: number) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      let hit = false;
      for (const e of this.enemiesOf(p.owner)) {
        if (e.center.distanceTo(p.mesh.position) <= e.radius + p.radius + 0.4) {
          hit = true;
          break;
        }
      }
      const pos = p.mesh.position;
      const blocked = pos.y <= 0 || this.obstacles.some((o) => pos.y < o.top && pos.y > o.bottom && Math.hypot(pos.x - o.x, pos.z - o.z) < o.r);
      if (hit || blocked || p.life <= 0) {
        const color = ELEMENT_COLORS[p.element];
        const radius = Math.max(p.aoe, 1.2);
        for (const e of this.enemiesOf(p.owner)) {
          if (e.center.distanceTo(pos) <= radius + e.radius) this.damage(e, p.damage, p.owner, p.element, 5);
        }
        if (hit || blocked) {
          this.fx.burst(pos.clone(), color, 10, 7);
          if (p.aoe > 0) this.fx.flare(pos.clone(), color, p.aoe, 0.25);
        }
        this.scene.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        ((p.mesh.children[0] as THREE.Mesh).material as THREE.Material).dispose();
        this.projectiles.splice(i, 1);
      }
    }
  }

  private updateChannels(dt: number) {
    for (let i = this.channels.length - 1; i >= 0; i--) {
      const c = this.channels[i];
      c.remaining -= dt;
      c.tick -= dt;
      const a = c.actor;
      if (!a.alive || a.stun > 0) {
        this.channels.splice(i, 1);
        continue;
      }
      const target = this.findTarget(a, 30);
      if (target) a.faceToward(target.pos);
      if (c.tick <= 0) {
        c.tick = 0.15;
        const length = 22;
        const from = a.center.addScaledVector(a.forward(), 0.6);
        const dir = a.forward();
        if (target) dir.y = (target.center.y - from.y) / Math.max(1, target.pos.distanceTo(a.pos));
        dir.normalize();
        const to = from.clone().addScaledVector(dir, length);
        const width = 0.25 + c.power.potency * 0.03;
        this.fx.beam(from, to, ELEMENT_COLORS[c.power.element], width, 0.18);
        const seg = new THREE.Line3(from, to);
        const closest = new THREE.Vector3();
        for (const e of this.enemiesOf(a)) {
          seg.closestPointToPoint(e.center, true, closest);
          if (closest.distanceTo(e.center) <= e.radius + width + 0.5) this.damage(e, c.damage, a, c.power.element, 1);
        }
      }
      if (c.remaining <= 0) this.channels.splice(i, 1);
    }
  }

  clear() {
    for (const p of this.projectiles) {
      this.scene.remove(p.mesh);
      (p.mesh.material as THREE.Material).dispose();
    }
    this.projectiles = [];
    this.channels = [];
    this.timers = [];
    for (const a of [...this.actors]) this.remove(a);
  }
}
