// Combat simulation: actors, movement physics, melee, powers, projectiles,
// and elemental status effects. Player, minions, and bosses all share it.

import * as THREE from 'three';
import {
  ELEMENT_COLORS, basicDamage, leapSlamRadius, maxEnergy, maxHealth, moveSpeed, powerCooldown, powerCost, powerDamage,
  portalLife, rankBonus, regenRate, rollDamage, energyRegen, speedMultiplier, teleportRange, travelRange,
} from '../core/rules';
import { EMPTY_LOADOUT, NO_MODS, boostedPower, type Loadout, type PowerMods } from '../core/progression';
import { isTravel, takesSkillSlot, type Appearance, type Character, type Element, type Power, type Stats } from '../core/types';
import { ARENA_RADIUS, THIN, floorAt, type Hazard, type Obstacle } from './arena';
import type { Effects } from './effects';
import { idleAnim, type AnimState, type HeroModel } from './model';
import { createHeroModel } from './models';
import type { Sfx } from './audio';
import { COMBO_COOLDOWN, COMBO_WINDOW as TEAM_COMBO_WINDOW, findCombo, type ComboRecipe } from './combos';

/** 'neutral' is scenery: everyone can smash it, nobody fights it. */
export type Team = 'player' | 'enemy' | 'neutral';
export type Archetype = 'hero' | 'ally' | 'grunt' | 'gunner' | 'brute' | 'boss' | 'summon' | 'prop';
export type SquadRole = 'tank' | 'striker' | 'ranged' | 'support';

/** Seconds a downed hero can wait for a revive. */
export const BLEED_OUT = 25;
/** Seconds a teammate must stay beside a downed hero to revive them. */
export const REVIVE_TIME = 2.5;

export interface SkillSlot {
  /** The power as cast: potency already raised by mastery and gear. */
  power: Power;
  mods: PowerMods;
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
  readonly model: HeroModel;
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

  // Status effects from the wider power set (seconds remaining).
  /** Webbed: can act but not move. */
  root = 0;
  /** Time-stopped: completely frozen in place. */
  frozen = 0;
  /** Held in the air by telekinesis. */
  lift = 0;
  liftHeight = 0;
  /** Mind-controlled: fighting for the other team until it wears off. */
  charm = 0;
  /** Reality-warped: shrunken, dealing half damage and taking more. */
  shrink = 0;
  /** Giant Growth: bigger, hits harder, shrugs off knockback. */
  growth = 0;
  /** Phasing: intangible. */
  phase = 0;
  /** Invisible: enemies can't target it; the next hit lands double. */
  stealth = 0;
  /** Team combos: the last power that hit this actor, waiting for a teammate's follow-up. */
  mark: { power: Power; by: Actor; at: number } | null = null;
  comboCooldown = 0;
  /** Summoned echoes fade away when this runs out. */
  summoned = false;
  life = 0;
  /** Healing Factor: fraction of max health regained per second out of danger. */
  readonly regenFactor: number;
  /** The team this actor started on (mind control can change `team`). */
  readonly homeTeam: Team;
  readonly baseScale: number;
  private opacity = 1;
  private trailTimer = 0;

  constructor(
    readonly name: string,
    /** Mutable for mind control; see homeTeam. */
    public team: Team,
    /** Mutable so control can pass between squad members (tag-switching). */
    public archetype: Archetype,
    readonly stats: Stats,
    public level: number,
    readonly appearance: Appearance,
    powers: Power[],
    healthOverride?: number,
    readonly character?: Character,
    /** Mastery and gear perks. */
    readonly loadout: Loadout = EMPTY_LOADOUT,
    /** A custom body (scenery props). */
    model?: HeroModel,
  ) {
    this.model = model ?? createHeroModel(appearance);
    // Star rank: every star adds health and damage.
    const rank = rankBonus(character?.stars ?? 1);
    this.maxHp = this.hp = Math.round((healthOverride ?? maxHealth(stats, level)) * rank.health);
    this.damageMult = rank.damage;
    this.maxEnergy = this.energy = maxEnergy(stats);
    const sizeBonus = archetype === 'brute' ? 1.4 : archetype === 'boss' ? 1.25 : 1;
    this.model.root.scale.setScalar(sizeBonus);
    this.baseScale = sizeBonus;
    this.homeTeam = team;
    this.regenFactor = regenRate(powers);
    this.radius = 0.55 * appearance.height * sizeBonus;
    this.speedMult = speedMultiplier(powers);
    this.speed = moveSpeed(stats) * this.speedMult * (archetype === 'brute' ? 0.6 : archetype === 'hero' || archetype === 'ally' ? 1 : 0.7);
    this.canFly = powers.some((p) => p.kind === 'flight');
    this.travel = powers.find((p) => isTravel(p.kind)) ?? null;
    this.travelCooldown = this.travel ? powerCooldown(this.travel, stats) : 0;
    this.skills = powers
      .filter((p) => takesSkillSlot(p.kind))
      .slice(0, 4)
      .map((p) => {
        const mods = loadout.mods[p.id] ?? NO_MODS;
        const power = boostedPower(p, mods);
        return { power, mods, cooldown: Math.round(powerCooldown(power, stats) * mods.cooldown * 10) / 10, remaining: 0, cost: Math.round(powerCost(power) * mods.cost) };
      });
  }

  /** True once per interval while moving at super speed (drives afterimage trails). */
  speedTrail(dt: number): boolean {
    if (this.speedMult <= 1.2 || Math.hypot(this.vel.x, this.vel.z) < this.speed * 0.6) return false;
    this.trailTimer -= dt;
    if (this.trailTimer > 0) return false;
    this.trailTimer = 0.05;
    return true;
  }

  /** Sets model transparency only when it changes (materials are shared per model). */
  setOpacity(alpha: number) {
    if (Math.abs(alpha - this.opacity) < 0.01) return;
    this.opacity = alpha;
    this.model.setOpacity(alpha);
  }

  get busy(): boolean {
    return this.stun > 0 || this.frozen > 0 || this.castTimer > 0 || this.dodgeTimer > 0 || this.dashHits !== null;
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
  /** Web shots root whatever they hit. */
  web?: number;
  /** The power that fired it (for team combos). */
  power?: Power;
}

interface Channel {
  actor: Actor;
  power: Power;
  remaining: number;
  tick: number;
  damage: number;
  /** Life Drain: short range, heals the caster. */
  drain?: boolean;
}

/** A linked pair of portals: step into either end to come out of the other. */
interface PortalPair {
  ends: [THREE.Vector3, THREE.Vector3];
  life: number;
  group: THREE.Group;
  /** Per-actor re-entry cooldown, so nobody bounces back and forth. */
  cooldown: Map<Actor, number>;
}

const portalRing = new THREE.TorusGeometry(1.3, 0.12, 8, 40);
const portalDisc = new THREE.CircleGeometry(1.25, 32);

/** A lingering area effect (Gravity Well). */
interface Zone {
  owner: Actor;
  pos: THREE.Vector3;
  radius: number;
  life: number;
  tick: number;
  damage: number;
  element: Element;
  power: Power;
}

const projectileGeo = new THREE.SphereGeometry(1, 10, 8);
const shieldGeo = new THREE.SphereGeometry(1, 20, 14);

/** Signature sounds for power types; everything else uses its element's cast voice. */
const CAST_SOUND: Partial<Record<Power['kind'], Sfx>> = {
  nova: 'explosion', beam: 'beam', optic: 'beam', drain: 'beam', heal: 'heal', shield: 'shield', phase: 'shield',
  timestop: 'freeze', summon: 'summon', sonic: 'sonic', web: 'webline', stretch: 'webline', grow: 'leap', gravity: 'explosion',
};

const isSquad = (a: Actor) => a.archetype === 'hero' || a.archetype === 'ally';

export class Combat {
  readonly actors: Actor[] = [];
  private projectiles: Projectile[] = [];
  private channels: Channel[] = [];
  private zones: Zone[] = [];
  private portals: PortalPair[] = [];
  /** Delayed actions in simulation time, so pausing and slow-mo stay in sync. */
  private timers: { at: number; fn: () => void }[] = [];
  private clock = 0;
  gravityScale = 1;
  powerScale = 1;
  /** Lava and other ground hazards (knock enemies in!). */
  hazards: Hazard[] = [];
  onDamage: (e: DamageEvent) => void = () => {};
  onKill: (target: Actor, killer: Actor | null) => void = () => {};
  /** Squad play: heroes go down (revivable) instead of dying outright. */
  downedEnabled = false;
  onDowned: (a: Actor) => void = () => {};
  onRevived: (a: Actor, by: Actor | null) => void = () => {};
  onPerfectDodge: (a: Actor) => void = () => {};
  /** Sound cues; the session turns them into audio positioned around the camera. */
  onSound: (name: Sfx, pos: THREE.Vector3, element?: Element) => void = () => {};
  onPropBroken: (prop: Actor, by: Actor | null) => void = () => {};
  /** A team combo went off: `first` set it up, `second` finished it. */
  onCombo: (recipe: ComboRecipe, first: Actor, second: Actor, at: THREE.Vector3) => void = () => {};

  constructor(
    private readonly scene: THREE.Scene,
    private readonly fx: Effects,
    private readonly obstacles: Obstacle[],
  ) {}

  private sound(name: Sfx, pos: THREE.Vector3, element?: Element) {
    this.onSound(name, pos, element);
  }

  /** For systems layered on combat (boss phases). */
  emitSound(name: Sfx, pos: THREE.Vector3, element?: Element) {
    this.sound(name, pos, element);
  }

  get effects(): Effects {
    return this.fx;
  }

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

  /** Living actors on the other team. Stealthed actors can't be seen, so they're left out. */
  enemiesOf(actor: Actor): Actor[] {
    return this.actors.filter((a) => a.alive && a.team !== actor.team && a.stealth <= 0);
  }

  /** Enemies worth fighting: everything hittable except scenery. */
  foesOf(actor: Actor): Actor[] {
    return this.enemiesOf(actor).filter((a) => a.archetype !== 'prop');
  }

  /** Nearest enemy within range, preferring ones in front of the actor. */
  findTarget(actor: Actor, range: number): Actor | null {
    const fwd = actor.forward();
    let best: Actor | null = null;
    let bestScore = Infinity;
    for (const other of this.foesOf(actor)) {
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

  /** Simulation time in seconds. */
  get time(): number {
    return this.clock;
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
    this.sound('jump', a.pos);
    if (a.jumps === 2) this.fx.burst(a.pos.clone(), a.skills[0] ? ELEMENT_COLORS[a.skills[0].power.element] : '#ffffff', 8, 4);
    return true;
  }

  /**
   * The travel button: toggles flight, blinks a teleporter, launches a leap or
   * swing, or opens a portal. `preferred` lets AI aim at the enemy it chose;
   * `aim` is a spot the player picked by hand (hold V to aim).
   */
  travel(a: Actor, preferred: Actor | null = null, aim: THREE.Vector3 | null = null): boolean {
    const p = a.travel;
    if (!p || !a.alive || a.stun > 0) return false;
    if (p.kind === 'flight') {
      this.toggleFlight(a);
      return true;
    }
    if (a.travelRemaining > 0 || a.castTimer > 0 || a.root > 0) return false;
    const ok = p.kind === 'teleport' ? this.teleport(a, p, preferred, aim)
      : p.kind === 'swing' ? this.swing(a, p, preferred, aim)
      : p.kind === 'portal' ? this.openPortal(a, p, preferred, aim)
      : this.superLeap(a, p, preferred, aim);
    if (ok) a.travelRemaining = a.travelCooldown;
    return ok;
  }

  /** Blink toward the target (or the way you're moving) and shock whoever is near the landing spot. */
  private teleport(a: Actor, p: Power, preferred: Actor | null, aim: THREE.Vector3 | null = null): boolean {
    const color = ELEMENT_COLORS[p.element];
    const range = teleportRange(p);
    // A chosen target out of reach means "blink toward it" (along the steering direction).
    const target = aim ? null : preferred ? (preferred.pos.distanceTo(a.pos) <= range + 6 ? preferred : null) : this.findTarget(a, range + 6);
    const from = a.pos.clone();
    const to = new THREE.Vector3();
    if (aim) {
      to.copy(aim);
      a.faceToward(aim);
    } else if (target && !a.ai.flee && (a.archetype !== 'hero' || a.moveIntent.lengthSq() < 0.01)) {
      // The player steers a blink with the stick; AI (and an idle player) blink to the target.
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
    this.sound('teleport', from, p.element);
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
  private superLeap(a: Actor, p: Power, preferred: Actor | null, aim: THREE.Vector3 | null = null): boolean {
    if (!a.grounded || a.flying) return false;
    const target = aim || a.ai.flee ? null : preferred ? (preferred.pos.distanceTo(a.pos) <= 26 ? preferred : null) : this.findTarget(a, 26);
    const flightTime = 0.9;
    const dest = aim ? aim.clone() : target
      ? target.pos.clone()
      : a.pos.clone().addScaledVector(a.moveIntent.lengthSq() > 0.01 ? a.moveIntent.clone().setY(0).normalize() : a.forward(), 14);
    if (!target && !aim) dest.y = this.floorAt(dest.x, dest.z, a.pos.y + 4);
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
    this.sound('leap', a.pos, p.element);
    return true;
  }

  /**
   * Web Swing: shoot a line to an anchor high above and swing in an arc toward
   * the target (or the way you're heading). Works mid-air, so swings chain.
   */
  private swing(a: Actor, p: Power, preferred: Actor | null, aim: THREE.Vector3 | null = null): boolean {
    if (a.flying) return false;
    const target = aim || a.ai.flee ? null : preferred ? (preferred.pos.distanceTo(a.pos) <= 28 ? preferred : null) : this.findTarget(a, 28);
    const dir = a.moveIntent.lengthSq() > 0.01 && (a.archetype === 'hero' || !target) ? a.moveIntent.clone().setY(0).normalize() : a.forward();
    const dest = aim ? aim.clone() : target
      ? target.pos.clone().addScaledVector(a.pos.clone().sub(target.pos).setY(0).normalize(), target.radius + a.radius + 1.5)
      : a.pos.clone().addScaledVector(dir, 18);
    // Prefer landing up on rooftops and platforms along the way (an aimed spot is exact).
    if (!aim) dest.y = this.floorAt(dest.x, dest.z, Math.max(a.pos.y, dest.y) + 6);
    this.keepInBounds(dest, a.radius);
    a.faceToward(dest);
    const anchor = a.pos.clone().lerp(dest, 0.55).setY(Math.max(a.pos.y, dest.y) + 12);
    const g = GRAVITY * this.gravityScale;
    const t = 0.85;
    a.vel.x = (dest.x - a.pos.x) / t;
    a.vel.z = (dest.z - a.pos.z) / t;
    a.vel.y = (dest.y - a.pos.y + (g * t * t) / 2) / t;
    a.grounded = false;
    a.jumps = 1; // a double jump is still available after a swing
    a.attackTimer = 0;
    a.leap = { damage: 0, element: p.element, radius: 0 };
    const color = ELEMENT_COLORS[p.element];
    for (let i = 0; i < 4; i++) this.schedule(i * 0.12, () => a.alive && this.fx.beam(a.center, anchor, '#f4f4ff', 0.04, 0.14));
    this.fx.burst(anchor, color, 6, 2, 0.1);
    this.sound('webline', a.pos, p.element);
    return true;
  }

  /** Opens a portal at your feet and another at the destination, and steps through. */
  private openPortal(a: Actor, p: Power, preferred: Actor | null, aim: THREE.Vector3 | null): boolean {
    const range = travelRange(p);
    let to: THREE.Vector3;
    if (aim) to = aim.clone();
    else {
      const target = a.ai.flee ? null : preferred ? (preferred.pos.distanceTo(a.pos) <= range ? preferred : null) : this.findTarget(a, range);
      if (target) {
        const away = a.pos.clone().sub(target.pos).setY(0).normalize();
        to = target.pos.clone().addScaledVector(away, target.radius + a.radius + 2);
      } else {
        const dir = a.moveIntent.lengthSq() > 0.01 ? a.moveIntent.clone().setY(0).normalize() : a.forward();
        to = a.pos.clone().addScaledVector(dir, range * 0.7);
        to.y = this.floorAt(to.x, to.z, a.pos.y + 4);
      }
    }
    this.keepInBounds(to, a.radius);
    const from = a.pos.clone();
    if (from.distanceTo(to) < 3) return false;
    const color = ELEMENT_COLORS[p.element];
    const group = new THREE.Group();
    const facing = Math.atan2(to.x - from.x, to.z - from.z);
    for (const end of [from, to]) {
      const ring = new THREE.Mesh(portalRing, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
      const disc = new THREE.Mesh(portalDisc, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
      for (const m of [ring, disc]) {
        m.position.set(end.x, end.y + 1.4, end.z);
        m.rotation.y = facing;
        group.add(m);
      }
    }
    this.scene.add(group);
    const pair: PortalPair = { ends: [from, to], life: portalLife(p), group, cooldown: new Map([[a, 1.2]]) };
    this.portals.push(pair);
    this.fx.flare(from.clone().setY(from.y + 1.4), color, 2, 0.35);
    this.fx.flare(to.clone().setY(to.y + 1.4), color, 2, 0.35);
    this.sound('teleport', from, p.element);
    a.pos.copy(to).addScaledVector(new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing)), 1.4);
    a.vel.set(0, 0, 0);
    a.facing = facing;
    a.invuln = Math.max(a.invuln, 0.3);
    return true;
  }

  private updatePortals(dt: number) {
    for (let i = this.portals.length - 1; i >= 0; i--) {
      const pair = this.portals[i];
      pair.life -= dt;
      const fade = Math.min(1, pair.life / 0.6);
      pair.group.children.forEach((m, k) => {
        if (k % 2 === 0) m.rotation.z += dt * 2;
        const mat = (m as THREE.Mesh).material as THREE.MeshBasicMaterial;
        mat.opacity = (k % 2 === 0 ? 0.95 : 0.28) * fade;
      });
      for (const [who, t] of pair.cooldown) pair.cooldown.set(who, t - dt);
      for (const a of this.actors) {
        if (!a.alive || a.archetype === 'prop' || (pair.cooldown.get(a) ?? 0) > 0) continue;
        for (let e = 0; e < 2; e++) {
          const end = pair.ends[e];
          if (Math.hypot(a.pos.x - end.x, a.pos.z - end.z) > 1.3 || Math.abs(a.pos.y - end.y) > 2) continue;
          const exit = pair.ends[1 - e];
          const out = exit.clone().sub(end).setY(0).normalize();
          a.pos.copy(exit).addScaledVector(out, 1.4);
          a.vel.set(0, Math.max(0, a.vel.y), 0);
          a.faceToward(a.pos.clone().add(out));
          pair.cooldown.set(a, 1.5);
          this.fx.burst(a.center, '#ffffff', 10, 4, 0.12);
          this.sound('teleport', a.pos);
          break;
        }
      }
      if (pair.life <= 0) {
        this.scene.remove(pair.group);
        pair.group.children.forEach((m) => ((m as THREE.Mesh).material as THREE.Material).dispose());
        this.portals.splice(i, 1);
      }
    }
  }

  private landLeap(a: Actor) {
    const slam = a.leap;
    a.leap = null;
    if (!slam || !a.alive || slam.damage <= 0) return;
    const color = ELEMENT_COLORS[slam.element];
    this.fx.ring(a.pos, color, slam.radius * 1.15, 0.5);
    this.fx.flare(a.pos.clone().setY(0.6), color, slam.radius * 0.6, 0.3);
    this.fx.burst(a.pos.clone().setY(0.4), '#d8c8b0', 22, 10);
    this.fx.shake(a.archetype === 'hero' ? 0.45 : 0.3);
    this.sound('explosion', a.pos, slam.element);
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
    this.sound('jump', a.pos);
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
    this.sound('dodge', a.pos);
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
        // Lunge toward the target, action-RPG soft lock.
        const lunge = Math.min(gap - 0.4, 3.5) / ATTACK_TIME;
        const dir = a.forward();
        a.vel.x = dir.x * lunge;
        a.vel.z = dir.z * lunge;
      }
    }
    a.attackTimer = ATTACK_TIME;
    this.sound('swing', a.pos);
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
    const dmg = powerDamage(p, a.stats, a.level, this.powerScale) * (a.team === 'enemy' && a.archetype !== 'boss' ? 0.5 : 1) * s.mods.damage;
    const target = this.findTarget(a, 30);
    if (target) a.faceToward(target.pos);
    const fwd = a.forward();
    this.sound(CAST_SOUND[p.kind] ?? 'cast', a.pos, p.element);

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
          this.fireProjectile(a, dir, dmg, p.element, 26, 0.25 + p.potency * 0.02, 2 + p.potency * 0.2, 0, p);
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
          if (e.pos.distanceTo(a.pos) <= radius + e.radius) this.damage(e, dmg, a, p.element, 12, p);
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
          ally.regenPerSec = ally.maxHp * (0.06 + p.potency * 0.012) * s.mods.damage;
          if (ally !== a) this.fx.burst(ally.center, color, 10, 4, 0.12);
        }
        this.fx.burst(a.center, color, 20, 5, 0.15);
        this.fx.ring(a.pos, color, 8);
        break;
      }
      default:
        this.castExotic(a, p, dmg, target, fwd);
    }
    this.masteryEffects(a, s, dmg);
    a.anim.cast = a.castTimer > 0 ? 0 : -1;
    return true;
  }

  /** Tier-3 mastery: Overload bursts around the caster, Lifeline heals them. */
  private masteryEffects(a: Actor, s: SkillSlot, dmg: number) {
    const color = ELEMENT_COLORS[s.power.element];
    if (s.mods.overload) {
      const raw = Math.max(dmg, basicDamage(a.stats, a.level)) * 0.4;
      this.fx.ring(a.pos, color, 4.5, 0.4);
      this.fx.burst(a.center, color, 16, 9, 0.14);
      this.sound('explosion', a.pos, s.power.element);
      for (const e of this.enemiesOf(a)) {
        if (e.pos.distanceTo(a.pos) <= 4 + e.radius) this.damage(e, raw, a, s.power.element, 6);
      }
    }
    if (s.mods.lifeline) {
      this.heal(a, a.maxHp * 0.06);
      this.fx.burst(a.center, '#3eff8b', 8, 3, 0.12);
    }
  }

  /** The wider power set: web, optic, telekinesis, reality, mind control, and the rest. */
  private castExotic(a: Actor, p: Power, dmg: number, target: Actor | null, fwd: THREE.Vector3) {
    const color = ELEMENT_COLORS[p.element];
    const inRange = (r: number) => (target && target.pos.distanceTo(a.pos) <= r ? target : null);
    const boss = (t: Actor) => t.archetype === 'boss';
    switch (p.kind) {
      case 'optic': {
        // Instant piercing twin beams from the eyes.
        a.castTimer = 0.3;
        const from = a.center.add(new THREE.Vector3(0, 0.45 * a.model.root.scale.y, 0)).addScaledVector(fwd, 0.4);
        const dir = fwd.clone();
        if (target) dir.y = (target.center.y - from.y) / Math.max(1, target.pos.distanceTo(a.pos));
        dir.normalize();
        const to = from.clone().addScaledVector(dir, 28);
        const side = new THREE.Vector3(fwd.z, 0, -fwd.x).multiplyScalar(0.09);
        this.fx.beam(from.clone().add(side), to.clone().add(side), color, 0.12, 0.25);
        this.fx.beam(from.clone().sub(side), to.clone().sub(side), color, 0.12, 0.25);
        const seg = new THREE.Line3(from, to);
        const closest = new THREE.Vector3();
        for (const e of this.enemiesOf(a)) {
          seg.closestPointToPoint(e.center, true, closest);
          if (closest.distanceTo(e.center) <= e.radius + 0.5) {
            this.damage(e, dmg, a, p.element, 9, p);
            this.fx.burst(e.center, color, 8, 6);
          }
        }
        break;
      }
      case 'web': {
        a.castTimer = 0.25;
        const dir = fwd.clone();
        if (target) dir.y = target.center.sub(a.center).normalize().y;
        this.fireProjectile(a, dir, dmg, p.element, 30, 0.3, 1.5, 2 + p.potency * 0.2, p);
        break;
      }
      case 'telekinesis': {
        const t = inRange(24);
        a.castTimer = 0.5;
        if (!t) break;
        // Scenery nearby? Throw it at them instead.
        const prop = this.actors.find((x) => x.alive && x.archetype === 'prop' && x.pos.distanceTo(a.pos) < 14);
        if (prop) {
          this.hurl(a, prop, t, dmg * 1.8, p);
          break;
        }
        this.fx.beam(a.center, t.center, color, 0.08, 0.5);
        if (boss(t) || t.archetype === 'brute') {
          // Too heavy to lift: crush in place.
          t.stun = Math.max(t.stun, 0.4);
          this.damage(t, dmg, a, p.element, 0, p);
          this.fx.ring(t.pos, color, 2.5);
          break;
        }
        t.lift = 1;
        t.liftHeight = t.pos.y + 3.5;
        t.stun = Math.max(t.stun, 1.6);
        this.fx.ring(t.pos, color, 2);
        this.schedule(1, () => {
          t.lift = 0;
          t.vel.set(0, -32, 0);
          this.schedule(0.15, () => {
            this.damage(t, dmg, a, p.element, 4, p);
            this.fx.ring(t.pos, color, 3);
            this.fx.burst(t.pos.clone().setY(t.pos.y + 0.3), '#d8c8b0', 14, 8);
            this.sound('explosion', t.pos, p.element);
            this.fx.shake(0.25);
          });
        });
        break;
      }
      case 'reality': {
        const t = inRange(24);
        a.castTimer = 0.45;
        if (!t) break;
        this.fx.flare(t.center, color, 2.5, 0.4);
        this.fx.ring(t.pos, '#ffffff', 3, 0.5);
        this.fx.burst(t.center, color, 24, 8, 0.16);
        this.damage(t, dmg, a, p.element, 0, p);
        if (!t.alive) break;
        // Minions sometimes get rewritten onto your side; everyone else shrinks.
        if (!boss(t) && t.archetype !== 'summon' && Math.random() < 0.3 + p.potency * 0.03) this.charm(t, a, 5 + p.potency * 0.4);
        else t.shrink = boss(t) ? 3 + p.potency * 0.2 : 6 + p.potency * 0.4;
        break;
      }
      case 'mindcontrol': {
        const t = inRange(22);
        a.castTimer = 0.5;
        if (!t) break;
        this.fx.beam(a.center.add(new THREE.Vector3(0, 0.4, 0)), t.center, color, 0.06, 0.6);
        this.damage(t, dmg, a, p.element, 0, p);
        if (!t.alive) break;
        // Bosses and heroes resist: they're only stunned.
        if (boss(t) || t.archetype === 'hero' || t.archetype === 'ally') t.stun = Math.max(t.stun, boss(t) ? 1 : 1.2);
        else this.charm(t, a, 6 + p.potency * 0.6);
        break;
      }
      case 'summon': {
        a.castTimer = 0.5;
        const count = Math.min(3, 1 + Math.floor(p.potency / 4));
        this.fx.flare(a.center, color, 3, 0.4);
        for (let i = 0; i < count; i++) {
          const angle = a.facing + Math.PI + (i - (count - 1) / 2) * 1.1;
          const at = a.pos.clone().add(new THREE.Vector3(Math.sin(angle) * 2.2, 0, Math.cos(angle) * 2.2));
          this.keepInBounds(at, a.radius);
          this.summon(a, at, 8 + p.potency * 0.6);
        }
        break;
      }
      case 'drain':
        a.castTimer = 1.5;
        this.channels.push({ actor: a, power: p, remaining: 1.5, tick: 0, damage: dmg, drain: true });
        break;
      case 'gravity': {
        a.castTimer = 0.4;
        const at = target && target.pos.distanceTo(a.pos) < 22 ? target.pos.clone() : a.pos.clone().addScaledVector(fwd, 9);
        at.y = this.floorAt(at.x, at.z, at.y + 1);
        this.zones.push({ owner: a, pos: at, radius: 4 + p.potency * 0.35, life: 3, tick: 0, damage: dmg, element: p.element, power: p });
        this.fx.flare(at.clone().setY(at.y + 1), '#120a24', 2, 0.5);
        break;
      }
      case 'storm': {
        a.castTimer = 0.5;
        const strikes = 3 + Math.floor(p.potency / 3);
        this.fx.flare(a.center.add(new THREE.Vector3(0, 2, 0)), color, 2, 0.4);
        for (let i = 0; i < strikes; i++) {
          this.schedule(0.2 + i * 0.3, () => {
            if (!a.alive) return;
            const foes = this.foesOf(a).filter((e) => e.pos.distanceTo(a.pos) < 22);
            const victim = foes[Math.floor(Math.random() * foes.length)];
            const at = victim ? victim.pos.clone() : a.pos.clone().add(new THREE.Vector3(Math.random() * 16 - 8, 0, Math.random() * 16 - 8));
            this.fx.beam(at.clone().setY(at.y + 22), at, color, 0.25, 0.2);
            this.sound('thunder', at, p.element);
            this.fx.flare(at.clone().setY(at.y + 0.5), color, 2.2, 0.2);
            this.fx.ring(at, color, 2.6, 0.3);
            for (const e of this.enemiesOf(a)) {
              if (e.pos.distanceTo(at) <= 2.4 + e.radius) this.damage(e, dmg, a, p.element, 3, p);
            }
          });
        }
        break;
      }
      case 'timestop': {
        a.castTimer = 0.4;
        const radius = 10 + p.potency * 0.5;
        this.fx.flare(a.center, '#dff4ff', radius * 0.5, 0.5);
        this.fx.ring(a.pos, color, radius, 0.7);
        this.fx.ring(a.pos, '#ffffff', radius * 0.6, 0.5);
        for (const e of this.enemiesOf(a)) {
          if (e.pos.distanceTo(a.pos) > radius + e.radius) continue;
          const time = boss(e) ? 0.8 + p.potency * 0.05 : 2 + p.potency * 0.2;
          e.frozen = Math.max(e.frozen, time);
          e.stun = Math.max(e.stun, time);
          this.damage(e, dmg, a, p.element, 0, p);
        }
        break;
      }
      case 'phase':
        a.castTimer = 0.15;
        a.phase = 2 + p.potency * 0.25;
        a.invuln = Math.max(a.invuln, a.phase);
        this.fx.burst(a.center, color, 14, 4, 0.12);
        break;
      case 'sonic': {
        a.castTimer = 0.4;
        const range = 9 + p.potency * 0.3;
        for (let i = 1; i <= 3; i++) {
          this.schedule(i * 0.06, () => this.fx.ring(a.pos.clone().addScaledVector(a.forward(), i * range * 0.28).setY(a.pos.y + 1.2), color, 1 + i * 0.9, 0.3));
        }
        for (const e of this.enemiesOf(a)) {
          const to = e.pos.clone().sub(a.pos).setY(0);
          const d = to.length();
          if (d > range + e.radius || (d > 1 && to.normalize().dot(fwd) < 0.5)) continue;
          e.stun = Math.max(e.stun, boss(e) ? 0.2 : 0.8);
          this.damage(e, dmg, a, p.element, 14, p);
        }
        this.fx.shake(0.2);
        break;
      }
      case 'grow':
        a.castTimer = 0.5;
        a.growth = 8 + p.potency * 0.5;
        this.fx.ring(a.pos, color, 4, 0.6);
        this.fx.burst(a.center, color, 20, 6);
        this.fx.shake(0.3);
        break;
      case 'stealth':
        a.castTimer = 0.15;
        a.stealth = 5 + p.potency * 0.4;
        for (const e of this.actors) if (e.aiTarget === a) e.aiTarget = null;
        this.fx.burst(a.center, '#1a1a2a', 16, 4, 0.16);
        break;
      case 'stretch': {
        const t = inRange(15);
        a.castTimer = 0.35;
        if (!t) break;
        this.fx.beam(a.center, t.center, a.appearance.primary, 0.14, 0.35);
        if (boss(t) || t.archetype === 'brute') {
          // Too big to pull: yank yourself in instead.
          const dir = t.pos.clone().sub(a.pos).setY(0);
          const gap = Math.max(0, dir.length() - t.radius - a.radius - 0.6);
          dir.normalize();
          a.vel.x = dir.x * gap / 0.25;
          a.vel.z = dir.z * gap / 0.25;
          a.ai.dashTime = 0.25;
          a.dashHits = new Set();
          a.dashDamage = dmg;
          a.dashPower = p;
          a.invuln = Math.max(a.invuln, 0.3);
          break;
        }
        const dir = a.pos.clone().sub(t.pos).setY(0);
        const gap = Math.max(0, dir.length() - t.radius - a.radius - 0.4);
        dir.normalize();
        t.vel.x = dir.x * gap / 0.25;
        t.vel.z = dir.z * gap / 0.25;
        // A forced slide, like a dodge: no ground friction until it lands in front of us.
        t.dodgeTimer = 0.25;
        t.stun = Math.max(t.stun, 0.7);
        this.schedule(0.25, () => {
          t.vel.x *= 0.1;
          t.vel.z *= 0.1;
          this.damage(t, dmg, a, p.element, 0, p);
        });
        break;
      }
      default:
        break;
    }
  }

  /** Telekinetic throw: a prop rises, then flies at the target and shatters. */
  private hurl(a: Actor, prop: Actor, target: Actor, raw: number, p: Power) {
    const color = ELEMENT_COLORS[p.element];
    this.fx.beam(a.center, prop.center, color, 0.08, 0.5);
    prop.lift = 0.45;
    prop.liftHeight = prop.pos.y + 2.5;
    this.schedule(0.45, () => {
      if (!prop.alive) return;
      const from = prop.center;
      const aimAt = target.alive ? target.center : from.clone().addScaledVector(a.forward(), 10);
      const dir = aimAt.sub(from).normalize();
      this.fireProjectile(a, dir, raw, p.element, 30, 0.7, 3.5, 0, p, from);
      prop.hp = 0;
      prop.alive = false;
      this.fx.burst(from, '#c8b090', 12, 5);
      this.schedule(0.05, () => this.remove(prop));
    });
  }

  /** Mind control: the target fights for the caster's team for a while. */
  charm(t: Actor, by: Actor, seconds: number) {
    t.team = by.team;
    t.charm = seconds;
    t.aiTarget = null;
    for (const e of this.actors) if (e.aiTarget === t) e.aiTarget = null;
    this.fx.ring(t.pos, ELEMENT_COLORS.psychic, 2.2, 0.6);
    this.sound('charm', t.pos, 'psychic');
  }

  /** A short-lived ghostly duplicate of the caster that fights on its own. */
  summon(caster: Actor, at: THREE.Vector3, seconds: number): Actor {
    const best = caster.skills.find((s) => s.power.kind === 'blast' || s.power.kind === 'optic')?.power;
    const echo = new Actor(`${caster.name} Echo`, caster.team, 'summon', caster.stats, caster.level, caster.appearance,
      best ? [{ ...best, kind: 'blast' }] : [], Math.round(caster.maxHp * 0.25), caster.character);
    echo.summoned = true;
    echo.life = seconds;
    echo.damageMult = 0.4 * caster.damageMult;
    echo.pos.copy(at);
    echo.facing = caster.facing;
    echo.ai.spawn = 0.3;
    echo.setOpacity(0.55);
    this.add(echo);
    this.fx.flare(echo.center, ELEMENT_COLORS[best?.element ?? 'energy'], 1.6, 0.35);
    return echo;
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
    this.sound('ultimate', a.pos, element);
    for (const e of this.enemiesOf(a)) {
      if (e.pos.distanceTo(a.pos) <= radius + e.radius) this.damage(e, raw, a, element, 18);
    }
    // Reset after the hits so the ultimate can't recharge itself.
    a.ultimate = 0;
    return true;
  }

  fireProjectile(owner: Actor, dir: THREE.Vector3, damage: number, element: Element, speed: number, size: number, aoe = 0, web = 0, power?: Power, origin?: THREE.Vector3) {
    const color = ELEMENT_COLORS[element];
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(projectileGeo, mat);
    mesh.scale.setScalar(size);
    const glow = new THREE.Mesh(projectileGeo, mat.clone());
    (glow.material as THREE.MeshBasicMaterial).opacity = 0.3;
    glow.scale.setScalar(2.2);
    mesh.add(glow);
    if (origin) mesh.position.copy(origin);
    else mesh.position.copy(owner.center).addScaledVector(owner.forward(), 0.8);
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
      web,
      power,
    });
    if (web) mat.color.set('#f4f4ff');
  }

  /** Telegraphed ground slam used by brutes and bosses. */
  slam(a: Actor, radius: number, windup: number, raw: number, element: Element = 'kinetic') {
    a.castTimer = windup;
    a.anim.cast = 0;
    this.strike(a, a.pos.clone(), radius, windup, raw, element);
  }

  /** A telegraphed area attack at any spot: a warning circle, then the hit. */
  strike(a: Actor, at: THREE.Vector3, radius: number, windup: number, raw: number, element: Element = 'kinetic') {
    this.fx.telegraph(at, radius, windup);
    this.schedule(windup, () => {
      if (!a.alive) return;
      this.fx.ring(at, ELEMENT_COLORS[element], radius * 1.1);
      this.fx.burst(at.clone().setY(0.5), '#ffb080', 20, 10);
      this.sound('explosion', at, element);
      this.fx.shake(0.3);
      for (const e of this.enemiesOf(a)) {
        if (e.pos.distanceTo(at) <= radius + e.radius && Math.abs(e.pos.y - at.y) < 2.5) this.damage(e, raw, a, element, 10);
      }
    });
  }

  // --- Damage --------------------------------------------------------------

  /**
   * Applies a hit and returns the damage dealt (0 if it was avoided). `via` is
   * the power that landed it, which marks the target for team combos.
   */
  damage(target: Actor, raw: number, source: Actor | null, element: Element | null, knockback = 0, via?: Power): number {
    if (target.alive && target.invuln > 0 && target.perfectWindow > 0 && source && source.team !== target.team) {
      target.perfectWindow = 0;
      this.onPerfectDodge(target);
    }
    if (!target.alive || target.invuln > 0) return 0;
    let amount = raw * (source?.damageMult ?? 1);
    if (source) {
      if (source.growth > 0) amount *= 1.5;
      if (source.shrink > 0) amount *= 0.5;
      if (source.stealth > 0) {
        // Ambush from the shadows.
        amount *= 2;
        source.stealth = 0;
        this.fx.burst(target.center, '#ffffff', 14, 8);
      }
    }
    if (element && source) amount *= 1 + (source.loadout.elementDamage[element] ?? 0);
    if (target.growth > 0) amount *= 0.75;
    if (target.shrink > 0) amount *= 1.3;
    if (element === 'cosmic') amount *= 1.25;
    if (element === 'tech') amount *= 1.1;
    const roll = rollDamage(amount, source?.stats ?? target.stats, target.stats);
    let dealt = roll.amount;
    if (target.shield > 0) dealt = Math.round(dealt * 0.3);
    target.hp -= dealt;
    target.sinceHit = 0;
    target.model.hitFlash();
    this.sound(roll.crit ? 'crit' : 'hit', target.pos);
    this.onDamage({ target, source, amount: dealt, crit: roll.crit });

    if (source) {
      if (source.archetype === 'hero') source.ultimate = Math.min(100, source.ultimate + (dealt * source.loadout.ultCharge) / (basicDamage(source.stats, source.level) * 0.3));
      if (source.loadout.lifesteal > 0 && source !== target && target.archetype !== 'prop') this.heal(source, dealt * source.loadout.lifesteal);
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

    if (target.archetype === 'prop') knockback *= target.radius > 1.2 ? 0.3 : 0.8;
    if (knockback > 0 && source && !isBoss && target.archetype !== 'brute' && target.growth <= 0 && target.frozen <= 0) {
      const dir = target.pos.clone().sub(source.pos).setY(0).normalize();
      target.vel.x += dir.x * knockback;
      target.vel.z += dir.z * knockback;
      if (knockback > 8) target.vel.y += 5;
      target.stagger = 0.25;
      target.attackTimer = 0;
    }

    if (via && source && target.hp > 0 && target.archetype !== 'prop') this.comboCheck(target, source, via);
    if (target.hp <= 0) this.kill(target, source);
    return dealt;
  }

  /** Marks the target, or detonates a combo if a teammate's mark is waiting. */
  private comboCheck(target: Actor, source: Actor, via: Power) {
    const m = target.mark;
    if (m && m.by !== source && m.by.team === source.team && m.by.alive && this.clock - m.at <= TEAM_COMBO_WINDOW && target.comboCooldown <= 0) {
      const recipe = findCombo(m.power, via);
      if (recipe) {
        target.mark = null;
        target.comboCooldown = COMBO_COOLDOWN;
        this.detonate(recipe, target, m.by, source, via.element);
        return;
      }
    }
    target.mark = { power: via, by: source, at: this.clock };
  }

  private detonate(recipe: ComboRecipe, target: Actor, first: Actor, second: Actor, element: Element) {
    const at = target.pos.clone();
    const raw = basicDamage(second.stats, second.level) * 2 * recipe.mult * this.powerScale;
    if (recipe.delay) this.fx.telegraph(at, recipe.radius, recipe.delay, recipe.color);
    this.schedule(recipe.delay, () => {
      const center = target.alive ? target.pos.clone() : at;
      this.fx.flare(center.clone().setY(center.y + 1), recipe.color, recipe.radius * 0.6, 0.45);
      this.fx.ring(center, recipe.color, recipe.radius * 1.15, 0.6);
      this.fx.ring(center, '#ffffff', recipe.radius * 0.6, 0.4);
      this.fx.burst(center.clone().setY(center.y + 1), recipe.color, 40, 14, 0.2);
      this.fx.shake(0.6);
      this.sound('explosion', center, element);
      this.sound('perfect', center);
      for (const e of this.enemiesOf(second)) {
        if (e.pos.distanceTo(center) > recipe.radius + e.radius) continue;
        if (recipe.stun) e.stun = Math.max(e.stun, e.archetype === 'boss' ? recipe.stun * 0.3 : recipe.stun);
        this.damage(e, raw, second, element, 10);
      }
    });
    this.onCombo(recipe, first, second, at);
  }

  private kill(target: Actor, source: Actor | null) {
    target.hp = 0;
    target.alive = false;
    this.fx.burst(target.center, '#ffffff', 16, 9);
    this.sound(this.downedEnabled && isSquad(target) && !target.downed ? 'down' : 'death', target.pos);
    if (target.charm > 0) {
      target.charm = 0;
      target.team = target.homeTeam;
    }
    if (target.archetype === 'prop') {
      this.smash(target, source);
      return;
    }
    // Echoes just fade; they never count as kills or losses.
    if (target.summoned) {
      this.schedule(0.5, () => this.remove(target));
      return;
    }
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

  /** Scenery breaks apart; fuel barrels explode, hurting the smasher's enemies. */
  private smash(prop: Actor, source: Actor | null) {
    this.fx.burst(prop.center, '#c8b090', 26, 9, 0.18);
    this.sound(prop.ai.explosive ? 'explosion' : 'smash', prop.pos);
    if (prop.ai.explosive) {
      this.fx.flare(prop.center, '#ff6a1f', 4, 0.5);
      this.fx.ring(prop.pos, '#ff6a1f', 5.5, 0.5);
      this.fx.shake(0.5);
      const raw = 260 * this.powerScale;
      for (const e of this.actors) {
        if (!e.alive || e === prop || (source && e.team === source.team) || e.pos.distanceTo(prop.pos) > 5 + e.radius) continue;
        this.damage(e, raw, source, 'fire', 12);
      }
    }
    this.onPropBroken(prop, source);
    this.schedule(0.05, () => this.remove(prop));
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
      this.sound('revive', a.pos);
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
    this.sound('ultimate', leader.pos);
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
    this.updateZones(dt);
    this.updatePortals(dt);
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
    this.updateStatuses(a, dt);
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
    if (a.alive && a.grounded && a.pos.y < 0.3 && a.archetype !== 'prop' && this.hazards.length) {
      const lava = this.hazards.find((h) => Math.hypot(a.pos.x - h.x, a.pos.z - h.z) < h.r);
      if (lava) {
        a.hp -= a.maxHp * lava.dps * (a.archetype === 'boss' ? 0.3 : 1) * dt;
        a.sinceHit = 0;
        if (Math.random() < dt * 8) this.fx.burst(a.pos.clone().setY(0.3), '#ff6a1f', 3, 3, 0.12);
        if (a.hp <= 0) this.kill(a, null);
      }
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
    a.anim.dead = !a.alive;
    // Time-stopped actors hold their pose.
    if ((a.alive && a.frozen <= 0) || (!a.alive && a.model.animatesDeath)) a.model.update(dt, a.anim);
  }

  private updateStatuses(a: Actor, dt: number) {
    a.comboCooldown = Math.max(0, a.comboCooldown - dt);
    if (a.mark) {
      if (this.clock - a.mark.at > TEAM_COMBO_WINDOW || !a.alive) a.mark = null;
      // A flickering marker shows teammates the target is primed.
      else if (Math.random() < dt * 5) this.fx.burst(a.center.add(new THREE.Vector3(0, 1.1 * a.model.root.scale.y, 0)), ELEMENT_COLORS[a.mark.power.element], 2, 1.2, 0.1);
    }
    a.root = Math.max(0, a.root - dt);
    a.frozen = Math.max(0, a.frozen - dt);
    a.shrink = Math.max(0, a.shrink - dt);
    a.growth = Math.max(0, a.growth - dt);
    a.phase = Math.max(0, a.phase - dt);
    a.stealth = Math.max(0, a.stealth - dt);
    if (a.charm > 0) {
      a.charm -= dt;
      if (Math.random() < dt * 4) this.fx.burst(a.center.add(new THREE.Vector3(0, 0.9, 0)), ELEMENT_COLORS.psychic, 2, 1.5, 0.1);
      if (a.charm <= 0) {
        a.charm = 0;
        a.team = a.homeTeam;
        a.aiTarget = null;
      }
    }
    if (a.summoned && a.alive) {
      a.life -= dt;
      if (a.life <= 0) this.kill(a, null);
    }
    if (a.alive && a.regenFactor > 0 && a.sinceHit > 2.5 && a.hp < a.maxHp) this.heal(a, a.maxHp * a.regenFactor * dt);

    // Size: growth and shrinking ease in and out.
    const size = a.baseScale * (a.growth > 0 ? 1.6 : a.shrink > 0 ? 0.6 : 1);
    const cur = a.model.root.scale.x;
    if (Math.abs(cur - size) > 0.001) a.model.root.scale.setScalar(cur + (size - cur) * Math.min(1, dt * 8));
    a.setOpacity(a.stealth > 0 ? 0.18 : a.phase > 0 ? 0.4 : a.summoned ? 0.55 : 1);
  }

  private move(a: Actor, dt: number) {
    if (a.alive && a.frozen > 0) {
      a.vel.set(0, 0, 0);
      return;
    }
    if (a.alive && a.lift > 0) {
      a.vel.set(0, (a.liftHeight - a.pos.y) * 5, 0);
      a.pos.addScaledVector(a.vel, dt);
      a.grounded = false;
      return;
    }
    const freeToMove = a.alive && a.stun <= 0 && a.stagger <= 0 && a.dodgeTimer <= 0 && !a.dashHits && !a.leap && a.root <= 0;
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
        this.damage(e, a.dashDamage, a, a.dashPower.element, 10, a.dashPower);
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
          // Scenery doesn't get shoved around by bodies; it shoves back.
          const wa = a.archetype === 'prop' ? 0 : b.archetype === 'prop' ? 1 : 0.5;
          const push = min - d;
          const nx = dx / d;
          const nz = dz / d;
          a.pos.x -= nx * push * wa;
          a.pos.z -= nz * push * wa;
          b.pos.x += nx * push * (1 - wa);
          b.pos.z += nz * push * (1 - wa);
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
          if (e.center.distanceTo(pos) > radius + e.radius) continue;
          this.damage(e, p.damage, p.owner, p.element, p.web ? 0 : 5, p.power);
          if (p.web) {
            e.root = Math.max(e.root, e.archetype === 'boss' ? p.web * 0.35 : p.web);
            e.slow = Math.max(e.slow, p.web + 1);
            this.fx.ring(e.pos.clone().setY(e.pos.y + 0.1), '#f4f4ff', 1.4, 0.4);
          }
        }
        if (hit || blocked) {
          this.sound('impact', pos, p.element);
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
      if (c.drain) {
        if (c.tick <= 0) {
          c.tick = 0.2;
          const t = target && target.pos.distanceTo(a.pos) <= 12 ? target : null;
          if (t) {
            this.fx.beam(t.center, a.center, ELEMENT_COLORS[c.power.element], 0.1, 0.2);
            this.fx.burst(a.center, ELEMENT_COLORS[c.power.element], 2, 2, 0.1);
            const dealt = this.damage(t, c.damage, a, c.power.element, 0, c.power);
            this.heal(a, dealt * 0.6);
          }
        }
        if (c.remaining <= 0) this.channels.splice(i, 1);
        continue;
      }
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
          if (closest.distanceTo(e.center) <= e.radius + width + 0.5) this.damage(e, c.damage, a, c.power.element, 1, c.power);
        }
      }
      if (c.remaining <= 0) this.channels.splice(i, 1);
    }
  }

  private updateZones(dt: number) {
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i];
      z.life -= dt;
      z.tick -= dt;
      for (const e of this.enemiesOf(z.owner)) {
        const to = z.pos.clone().sub(e.pos).setY(0);
        const d = to.length();
        if (d > z.radius * 1.6 + e.radius || e.archetype === 'boss') continue;
        // Drag everything toward the center.
        if (d > 0.5) e.pos.addScaledVector(to.normalize(), Math.min(d, 5 * dt));
      }
      if (z.tick <= 0) {
        z.tick = 0.5;
        const color = ELEMENT_COLORS[z.element];
        this.fx.ring(z.pos, color, z.radius, 0.5);
        this.fx.ring(z.pos, '#120a24', z.radius * 0.5, 0.4);
        for (const e of this.enemiesOf(z.owner)) {
          if (e.pos.distanceTo(z.pos) <= z.radius + e.radius) this.damage(e, z.damage, z.owner, z.element, 0, z.power);
        }
      }
      if (z.life <= 0 || !z.owner.alive) this.zones.splice(i, 1);
    }
  }

  clear() {
    this.zones = [];
    for (const pair of this.portals) this.scene.remove(pair.group);
    this.portals = [];
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
