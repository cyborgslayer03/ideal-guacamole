// Civilians: the people (or aliens, or demons) who live in each world. They
// wander, flee and scream when a fight comes near, cower from explosions,
// cheer the hero once it's safe, and sneak photos of their favorite heroes.
//
// CrowdSim is pure simulation (testable without a renderer); CrowdView draws it.

import * as THREE from 'three';
import type { Biome } from '../core/types';
import { ARENA_RADIUS, THIN, type Hazard, type Obstacle } from './arena';

export type Species = 'human' | 'parka' | 'scavenger' | 'villager' | 'alien' | 'demon' | 'spirit';

/** Who lives where: humans on Earth, aliens in space, demons in the underworld... */
export function speciesFor(biome: Biome): Species {
  switch (biome) {
    case 'metropolis': return 'human';
    case 'frozen': return 'parka';
    case 'wasteland': return 'scavenger';
    case 'jungle': return 'villager';
    case 'cosmic': return 'alien';
    case 'underworld': return 'demon';
    case 'mystic': return 'spirit';
  }
}

export type CivState = 'wander' | 'idle' | 'flee' | 'cower' | 'cheer' | 'photo';

export interface Civilian {
  id: number;
  species: Species;
  /** Picks a look (colors, size) within the species. */
  variant: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: THREE.Vector3;
  state: CivState;
  timer: number;
  facing: number;
  /** 1 right after a scare, fading to 0. Scared civilians cheer once it's over. */
  fear: number;
  /** True once a scare is over and they haven't thanked the hero yet. */
  relieved: boolean;
  /** Walk-cycle phase, for animation. */
  stride: number;
}

/** Something to run from: an enemy, a fight, or an explosion (power 2+). */
export interface Threat {
  pos: THREE.Vector3;
  radius: number;
  power: number;
}

export interface CrowdEvent {
  kind: 'scream' | 'cheer' | 'photo' | 'gasp';
  pos: THREE.Vector3;
  species: Species;
}

const SPEED: Record<Species, number> = { human: 1.4, parka: 1.1, scavenger: 1.5, villager: 1.3, alien: 1.6, demon: 1.5, spirit: 1.0 };
const FLEE_SPEED = 6.5;

export class CrowdSim {
  readonly civilians: Civilian[] = [];
  private nextId = 1;
  private calm = 0;

  constructor(
    private readonly obstacles: readonly Obstacle[],
    private readonly hazards: readonly Hazard[] = [],
    private readonly random: () => number = Math.random,
    private readonly bounds = ARENA_RADIUS - 4,
  ) {}

  /** Adds civilians: spread around the world, or clustered around `center`. */
  spawn(count: number, species: Species, center?: THREE.Vector3, spread = 4, state: CivState = 'wander'): Civilian[] {
    const added: Civilian[] = [];
    for (let i = 0; i < count; i++) {
      const pos = center ? this.freeSpot(center, spread) : this.freeSpot(null, 0);
      const c: Civilian = {
        id: this.nextId++,
        species,
        variant: Math.floor(this.random() * 1000),
        pos,
        vel: new THREE.Vector3(),
        target: pos.clone(),
        state,
        timer: state === 'cower' ? 9999 : this.random() * 3,
        facing: this.random() * Math.PI * 2,
        fear: state === 'cower' ? 1 : 0,
        relieved: false,
        stride: this.random() * 10,
      };
      this.civilians.push(c);
      added.push(c);
    }
    return added;
  }

  /** Releases civilians held in place (rescued hostages): they'll cheer if the hero is near. */
  release(center: THREE.Vector3, radius: number) {
    for (const c of this.civilians) {
      if (c.pos.distanceTo(center) > radius) continue;
      if (c.state === 'cower') c.timer = 0;
      c.fear = Math.max(c.fear, 0.5);
    }
  }

  /** A random walkable spot: inside the world, off buildings and out of lava. */
  private freeSpot(center: THREE.Vector3 | null, spread: number): THREE.Vector3 {
    for (let tries = 0; tries < 30; tries++) {
      const a = this.random() * Math.PI * 2;
      const d = center ? this.random() * spread : 8 + this.random() * (this.bounds - 8);
      const p = new THREE.Vector3((center?.x ?? 0) + Math.cos(a) * d, 0, (center?.z ?? 0) + Math.sin(a) * d);
      if (Math.hypot(p.x, p.z) > this.bounds) continue;
      if (this.blocked(p, 0.8)) continue;
      return p;
    }
    return center ? center.clone().setY(0) : new THREE.Vector3(10, 0, 10);
  }

  private blocked(p: THREE.Vector3, margin: number): boolean {
    return this.obstacles.some((o) => o.bottom < 1.8 && o.top - o.bottom >= THIN && Math.hypot(p.x - o.x, p.z - o.z) < o.r + margin)
      || this.hazards.some((h) => Math.hypot(p.x - h.x, p.z - h.z) < h.r + margin);
  }

  /**
   * Advances everyone. `hero` is the controlled hero's position (people step
   * aside, cheer, and take photos). Returns what happened, for sound and effects.
   */
  update(dt: number, threats: readonly Threat[], hero: THREE.Vector3 | null): CrowdEvent[] {
    const events: CrowdEvent[] = [];
    this.calm = threats.length ? 0 : this.calm + dt;
    for (const c of this.civilians) {
      c.timer -= dt;
      c.fear = Math.max(0, c.fear - dt * 0.25);

      // 1. Danger: cower from blasts, run from everything else.
      // The most urgent threat in reach: closer and more powerful wins.
      let worst: Threat | null = null;
      let worstD = Infinity;
      let urgency = 0;
      for (const t of threats) {
        const d = Math.hypot(c.pos.x - t.pos.x, c.pos.z - t.pos.z);
        const u = t.power * (1 - d / (t.radius * 1.6));
        if (u > urgency) {
          urgency = u;
          worst = t;
          worstD = d;
        }
      }
      if (worst && c.state !== 'cower') {
        const wasCalm = c.fear < 0.3;
        c.fear = 1;
        c.relieved = false;
        if (worst.power >= 2 && worstD < worst.radius) {
          c.state = 'cower';
          c.timer = 1.5 + this.random();
          if (wasCalm || this.random() < 0.3) events.push({ kind: this.random() < 0.5 ? 'gasp' : 'scream', pos: c.pos.clone(), species: c.species });
        } else {
          const away = new THREE.Vector3(c.pos.x - worst.pos.x, 0, c.pos.z - worst.pos.z);
          if (away.lengthSq() < 1e-4) away.set(this.random() - 0.5, 0, this.random() - 0.5);
          away.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), (this.random() - 0.5) * 0.8);
          c.target.copy(c.pos).addScaledVector(away, 14);
          this.clampTarget(c.target);
          if (c.state !== 'flee' && wasCalm && this.random() < 0.6) events.push({ kind: 'scream', pos: c.pos.clone(), species: c.species });
          c.state = 'flee';
          c.timer = 2.5 + this.random();
        }
      }

      // 2. Calm behavior.
      if (!worst) {
        if ((c.state === 'flee' || c.state === 'cower') && c.timer <= 0) {
          c.state = 'idle';
          c.timer = 1 + this.random() * 2;
          if (c.fear > 0) c.relieved = true;
        }
        const heroNear = hero && c.pos.distanceTo(hero) < 18;
        if (c.relieved && this.calm > 1.5 && heroNear && (c.state === 'idle' || c.state === 'wander')) {
          c.relieved = false;
          c.state = 'cheer';
          c.timer = 2.5 + this.random();
          if (this.random() < 0.5) events.push({ kind: 'cheer', pos: c.pos.clone(), species: c.species });
        } else if (c.state === 'wander' && hero && c.pos.distanceTo(hero) < 10 && this.calm > 3 && this.random() < dt * 0.04) {
          c.state = 'photo';
          c.timer = 1.6;
          events.push({ kind: 'photo', pos: c.pos.clone().setY(1.6), species: c.species });
        } else if ((c.state === 'cheer' || c.state === 'photo' || c.state === 'idle') && c.timer <= 0) {
          c.state = 'wander';
          c.target.copy(this.freeSpot(c.pos, 18));
        } else if (c.state === 'wander' && Math.hypot(c.target.x - c.pos.x, c.target.z - c.pos.z) < 0.6) {
          c.state = 'idle';
          c.timer = 1 + this.random() * 4;
        }
      }

      // 3. Move.
      const speed = c.state === 'flee' ? FLEE_SPEED : c.state === 'wander' ? SPEED[c.species] : 0;
      const want = new THREE.Vector3(c.target.x - c.pos.x, 0, c.target.z - c.pos.z);
      if (speed > 0 && want.lengthSq() > 0.04) want.normalize().multiplyScalar(speed);
      else want.set(0, 0, 0);
      // Step aside for the hero.
      if (hero) {
        const off = new THREE.Vector3(c.pos.x - hero.x, 0, c.pos.z - hero.z);
        const d = off.length();
        if (d < 1.6 && d > 1e-3) want.addScaledVector(off.normalize(), 3);
      }
      c.vel.lerp(want, Math.min(1, dt * 6));
      c.pos.addScaledVector(c.vel, dt);
      this.collide(c);
      const moving = c.vel.lengthSq() > 0.05;
      if (moving) c.facing = Math.atan2(c.vel.x, c.vel.z);
      else if (hero && (c.state === 'cheer' || c.state === 'photo')) c.facing = Math.atan2(hero.x - c.pos.x, hero.z - c.pos.z);
      c.stride += dt * (moving ? c.vel.length() * 2.2 : 0);
    }
    return events;
  }

  private clampTarget(p: THREE.Vector3) {
    const r = Math.hypot(p.x, p.z);
    if (r > this.bounds) {
      p.x *= this.bounds / r;
      p.z *= this.bounds / r;
    }
  }

  private collide(c: Civilian) {
    for (const o of this.obstacles) {
      if (o.bottom >= 1.8 || o.top - o.bottom < THIN) continue;
      const dx = c.pos.x - o.x;
      const dz = c.pos.z - o.z;
      const d = Math.hypot(dx, dz);
      const min = o.r + 0.4;
      if (d < min && d > 1e-4) {
        c.pos.x = o.x + (dx / d) * min;
        c.pos.z = o.z + (dz / d) * min;
        // Blocked: pick a way around.
        if (c.state === 'wander') c.target.copy(this.freeSpot(c.pos, 12));
      }
    }
    for (const h of this.hazards) {
      const dx = c.pos.x - h.x;
      const dz = c.pos.z - h.z;
      const d = Math.hypot(dx, dz);
      if (d < h.r + 0.5 && d > 1e-4) {
        c.pos.x = h.x + (dx / d) * (h.r + 0.5);
        c.pos.z = h.z + (dz / d) * (h.r + 0.5);
      }
    }
    this.clampTarget(c.pos);
  }
}

// --- Rendering ----------------------------------------------------------------

const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#5c3a21'];
const CLOTHES = ['#c0303a', '#2a5ac0', '#e8e8f0', '#30343c', '#d6a31a', '#3a8a4a', '#8a3ac0', '#e07a2a', '#1aa0a0'];
const ALIEN_SKIN = ['#6adf6a', '#8a6aff', '#4ad0ff', '#ff6ad0', '#c0ff4a'];
const DEMON_SKIN = ['#b0201a', '#7a1010', '#4a1a2a', '#c04a1a'];

interface Body {
  root: THREE.Group;
  legs: [THREE.Object3D, THREE.Object3D] | null;
  arms: [THREE.Object3D, THREE.Object3D];
  phone: THREE.Object3D;
  tail: THREE.Object3D | null;
}

/** Draws civilians with simple, shared geometry; one small group per person. */
export class CrowdView {
  readonly group = new THREE.Group();
  private readonly bodies = new Map<number, Body>();
  private readonly geos = {
    box: new THREE.BoxGeometry(1, 1, 1),
    sphere: new THREE.SphereGeometry(1, 10, 8),
    cone: new THREE.ConeGeometry(1, 1, 8),
    cyl: new THREE.CylinderGeometry(1, 1, 1, 8),
  };
  private readonly mats = new Map<string, THREE.Material>();

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  private mat(color: string, glow = false, opacity = 1): THREE.Material {
    const key = `${color}|${glow}|${opacity}`;
    let m = this.mats.get(key);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color, emissive: glow ? color : '#000000', emissiveIntensity: glow ? 1.2 : 0, transparent: opacity < 1, opacity });
      this.mats.set(key, m);
    }
    return m;
  }

  private part(parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number) {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private build(c: Civilian): Body {
    const v = c.variant;
    const pick = <T,>(list: readonly T[], salt: number) => list[(v * 7 + salt * 13) % list.length];
    const root = new THREE.Group();
    const g = this.geos;
    let legs: Body['legs'] = null;
    let tail: THREE.Object3D | null = null;
    const limb = (x: number, y: number, len: number, m: THREE.Material) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      this.part(pivot, g.box, m, 0, -len / 2, 0, 0.14, len, 0.14);
      root.add(pivot);
      return pivot;
    };
    const s = c.species;
    const scale = s === 'alien' ? 1.1 : s === 'demon' ? (v % 3 === 0 ? 0.75 : 1.05) : 0.92 + (v % 5) * 0.03;
    let skinMat: THREE.Material;
    let shirt: THREE.Material;
    if (s === 'spirit') {
      // A floating robed figure with a glowing face: no legs.
      const robe = this.mat(pick(['#3a2a6a', '#2a4a6a', '#5a2a5a'], 1), false, 0.85);
      this.part(root, g.cone, robe, 0, 0.9, 0, 0.42, 1.5, 0.42);
      this.part(root, g.sphere, this.mat(pick(['#ffd28a', '#8ad8ff', '#d8a8ff'], 2), true), 0, 1.75, 0, 0.2, 0.22, 0.2);
      skinMat = robe;
      shirt = robe;
    } else {
      skinMat = this.mat(s === 'alien' ? pick(ALIEN_SKIN, 1) : s === 'demon' ? pick(DEMON_SKIN, 1) : pick(SKIN, 1));
      shirt = this.mat(s === 'parka' ? pick(['#d04a2a', '#2a6ad0', '#e0c02a', '#3aa060'], 2)
        : s === 'scavenger' ? pick(['#6a5a40', '#4a4030', '#7a6a50'], 2)
        : s === 'villager' ? pick(['#5a7a3a', '#8a6a3a', '#a04a2a'], 2)
        : s === 'demon' ? pick(['#1a0a0a', '#2a1010', '#3a1a10'], 2)
        : s === 'alien' ? pick(['#d0d8e8', '#3a3a5a', '#e8c04a'], 2)
        : pick(CLOTHES, 2));
      const pants = this.mat(s === 'demon' ? '#1a0808' : pick(['#1a2240', '#30343c', '#4a3a2a', '#2a2a2a'], 3));
      legs = [limb(-0.12, 0.8, 0.78, pants), limb(0.12, 0.8, 0.78, pants)];
      const torsoW = s === 'parka' ? 0.55 : s === 'alien' ? 0.34 : 0.42;
      this.part(root, s === 'parka' ? g.sphere : g.box, shirt, 0, 1.12, 0, torsoW, s === 'parka' ? 0.42 : 0.62, s === 'parka' ? 0.36 : 0.26);
      if (s === 'alien') {
        // Big head, black eyes, and antennae with glowing tips.
        this.part(root, g.sphere, skinMat, 0, 1.72, 0, 0.26, 0.32, 0.26);
        const eye = this.mat('#05050a');
        this.part(root, g.sphere, eye, -0.1, 1.74, 0.2, 0.07, 0.1, 0.05);
        this.part(root, g.sphere, eye, 0.1, 1.74, 0.2, 0.07, 0.1, 0.05);
        for (const x of [-0.1, 0.1]) {
          this.part(root, g.cyl, skinMat, x, 2.08, 0, 0.015, 0.3, 0.015);
          this.part(root, g.sphere, this.mat(pick(['#ffe93e', '#3ee8ff', '#ff4fd8'], 4), true), x, 2.24, 0, 0.05, 0.05, 0.05);
        }
      } else {
        this.part(root, g.sphere, skinMat, 0, 1.62, 0, 0.17, 0.2, 0.17);
        if (s === 'demon') {
          const horn = this.mat('#e8d8c0');
          this.part(root, g.cone, horn, -0.1, 1.85, 0, 0.05, 0.22, 0.05).rotation.z = 0.4;
          this.part(root, g.cone, horn, 0.1, 1.85, 0, 0.05, 0.22, 0.05).rotation.z = -0.4;
          const eyes = this.mat('#ffd23e', true);
          this.part(root, g.sphere, eyes, -0.06, 1.64, 0.15, 0.03, 0.02, 0.02);
          this.part(root, g.sphere, eyes, 0.06, 1.64, 0.15, 0.03, 0.02, 0.02);
          tail = new THREE.Group();
          tail.position.set(0, 0.85, -0.15);
          this.part(tail, g.cyl, skinMat, 0, -0.3, -0.15, 0.03, 0.7, 0.03).rotation.x = 0.7;
          this.part(tail, g.cone, skinMat, 0, -0.55, -0.42, 0.06, 0.14, 0.06).rotation.x = 2.2;
          root.add(tail);
        } else if (s === 'parka') {
          this.part(root, g.sphere, shirt, 0, 1.66, -0.03, 0.22, 0.24, 0.22);
        } else if (s === 'villager' && v % 2 === 0) {
          this.part(root, g.cone, this.mat('#d8c070'), 0, 1.84, 0, 0.32, 0.16, 0.32);
        } else if (s === 'scavenger') {
          this.part(root, g.box, this.mat('#2a2a2a'), 0, 1.65, 0.13, 0.26, 0.07, 0.08);
        } else {
          this.part(root, g.sphere, this.mat(pick(['#1a1008', '#4a2a10', '#d8b060', '#8a2a10', '#101010'], 5)), 0, 1.72, -0.02, 0.18, 0.12, 0.18);
        }
      }
    }
    const arms: Body['arms'] = [limb(-0.3, 1.38, 0.6, shirt), limb(0.3, 1.38, 0.6, shirt)];
    const phone = this.part(arms[1], g.box, this.mat('#101820', true), 0, -0.62, 0.08, 0.1, 0.16, 0.02);
    phone.visible = false;
    root.scale.setScalar(scale);
    this.group.add(root);
    return { root, legs, arms, phone, tail };
  }

  update(sim: CrowdSim, time: number) {
    const seen = new Set<number>();
    for (const c of sim.civilians) {
      seen.add(c.id);
      let b = this.bodies.get(c.id);
      if (!b) {
        b = this.build(c);
        this.bodies.set(c.id, b);
      }
      b.root.position.copy(c.pos);
      b.root.rotation.y = c.facing;
      const swing = Math.sin(c.stride * 3) * (c.state === 'flee' ? 0.9 : 0.5);
      const crouch = c.state === 'cower' ? 0.65 : 1;
      b.root.scale.y = b.root.scale.x * crouch;
      if (b.legs) {
        b.legs[0].rotation.x = swing;
        b.legs[1].rotation.x = -swing;
      } else {
        b.root.position.y = 0.25 + Math.sin(time * 2 + c.id) * 0.12; // spirits float
      }
      const [l, r] = b.arms;
      b.phone.visible = c.state === 'photo';
      if (c.state === 'flee') {
        // Arms flailing overhead.
        l.rotation.set(Math.PI * 0.9 + Math.sin(time * 14 + c.id) * 0.3, 0, 0.3);
        r.rotation.set(Math.PI * 0.9 + Math.cos(time * 14 + c.id) * 0.3, 0, -0.3);
      } else if (c.state === 'cower') {
        l.rotation.set(Math.PI * 0.8, 0, 0.9);
        r.rotation.set(Math.PI * 0.8, 0, -0.9);
      } else if (c.state === 'cheer') {
        const wave = Math.sin(time * 10 + c.id) * 0.4;
        l.rotation.set(Math.PI, 0, 0.4 + wave);
        r.rotation.set(Math.PI, 0, -0.4 - wave);
        b.root.position.y = Math.abs(Math.sin(time * 8 + c.id)) * 0.25;
      } else if (c.state === 'photo') {
        l.rotation.set(-swing * 0.3, 0, 0);
        r.rotation.set(-1.4, 0, 0);
      } else {
        l.rotation.set(-swing * 0.8, 0, 0);
        r.rotation.set(swing * 0.8, 0, 0);
      }
      if (b.tail) b.tail.rotation.y = Math.sin(time * 3 + c.id) * 0.5;
    }
    for (const [id, b] of this.bodies) {
      if (seen.has(id)) continue;
      this.group.remove(b.root);
      this.bodies.delete(id);
    }
  }

  dispose() {
    this.group.removeFromParent();
    Object.values(this.geos).forEach((g) => g.dispose());
    this.mats.forEach((m) => m.dispose());
  }
}
