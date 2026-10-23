// Background life: cars driving the city's ring road (they brake and honk when
// a fight or a hero blocks the street), and fliers overhead: shuttles in
// space, drones over the city, birds over jungles and ice, bats in the underworld.

import * as THREE from 'three';
import type { Rng } from '../core/rng';
import type { Biome } from '../core/types';

export interface TrafficEvent {
  kind: 'honk';
  pos: THREE.Vector3;
}

interface Car {
  angle: number;
  /** +1 counterclockwise lane, -1 clockwise lane. */
  dir: 1 | -1;
  radius: number;
  speed: number;
  maxSpeed: number;
  blockedFor: number;
  honkCooldown: number;
  group: THREE.Group;
}

interface Flier {
  cx: number;
  cz: number;
  radius: number;
  height: number;
  speed: number;
  phase: number;
  group: THREE.Group;
  wings: THREE.Object3D[];
}

type FlierKind = 'shuttle' | 'drone' | 'bird' | 'bat';

const CAR_COLORS = ['#c0303a', '#2a5ac0', '#e8e8f0', '#2a2a30', '#d6a31a', '#3a8a4a', '#e07a2a'];

export class Traffic {
  readonly group = new THREE.Group();
  private readonly cars: Car[] = [];
  private readonly fliers: Flier[] = [];
  private readonly disposables: { dispose(): void }[] = [];

  constructor(scene: THREE.Scene, biome: Biome, rng: Rng, road: { radius: number; width: number } | null) {
    scene.add(this.group);
    if (road) this.buildCars(rng, road);
    const fliers: Partial<Record<Biome, [FlierKind, number]>> = {
      cosmic: ['shuttle', 6], metropolis: ['drone', 4], jungle: ['bird', 12], frozen: ['bird', 8], underworld: ['bat', 14], wasteland: ['bird', 5],
    };
    const f = fliers[biome];
    if (f) for (let i = 0; i < f[1]; i++) this.fliers.push(this.buildFlier(rng, f[0]));
  }

  private track<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  private buildCars(rng: Rng, road: { radius: number; width: number }) {
    const body = this.track(new THREE.BoxGeometry(1.8, 0.6, 3.8));
    const cabin = this.track(new THREE.BoxGeometry(1.55, 0.5, 1.9));
    const wheel = this.track(new THREE.CylinderGeometry(0.33, 0.33, 0.3, 10));
    const light = this.track(new THREE.BoxGeometry(1.5, 0.12, 0.06));
    const glass = this.track(new THREE.MeshStandardMaterial({ color: '#16203a', metalness: 0.8, roughness: 0.2 }));
    const tire = this.track(new THREE.MeshStandardMaterial({ color: '#0e0e10' }));
    const head = this.track(new THREE.MeshBasicMaterial({ color: '#fff6d0' }));
    const tail = this.track(new THREE.MeshBasicMaterial({ color: '#ff2a2a' }));
    for (let lane = 0; lane < 2; lane++) {
      const dir: 1 | -1 = lane === 0 ? 1 : -1;
      const radius = road.radius + (lane === 0 ? 1.7 : -1.7);
      const count = 5;
      for (let i = 0; i < count; i++) {
        const g = new THREE.Group();
        const paint = this.track(new THREE.MeshStandardMaterial({ color: rng.pick(CAR_COLORS), metalness: 0.6, roughness: 0.35 }));
        const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
          const mesh = new THREE.Mesh(geo, m);
          mesh.position.set(x, y, z);
          mesh.castShadow = true;
          g.add(mesh);
          return mesh;
        };
        add(body, paint, 0, 0.55, 0);
        add(cabin, glass, 0, 1.05, -0.2);
        for (const [x, z] of [[-0.92, 1.2], [0.92, 1.2], [-0.92, -1.2], [0.92, -1.2]]) add(wheel, tire, x, 0.33, z).rotation.z = Math.PI / 2;
        add(light, head, 0, 0.62, 1.92);
        add(light, tail, 0, 0.62, -1.92);
        this.group.add(g);
        const maxSpeed = rng.float(7, 11);
        this.cars.push({ angle: (i / count) * Math.PI * 2 + rng.float(0, 0.4), dir, radius, speed: maxSpeed, maxSpeed, blockedFor: 0, honkCooldown: 0, group: g });
      }
    }
  }

  private buildFlier(rng: Rng, kind: FlierKind): Flier {
    const g = new THREE.Group();
    const wings: THREE.Object3D[] = [];
    const m = (color: string, glow = false) => this.track(new THREE.MeshStandardMaterial({ color, emissive: glow ? color : '#000000', emissiveIntensity: glow ? 1.5 : 0, metalness: 0.4, roughness: 0.5 }));
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
      const o = new THREE.Mesh(this.track(geo), mat);
      o.position.set(x, y, z);
      g.add(o);
      return o;
    };
    if (kind === 'shuttle') {
      mesh(new THREE.ConeGeometry(0.9, 4, 8), m(rng.pick(['#d0d8e8', '#8a8ab0', '#c0a060'])), 0, 0, 0).rotation.x = Math.PI / 2;
      mesh(new THREE.BoxGeometry(4, 0.15, 1.2), m('#5a5a7a'), 0, 0, -0.6);
      mesh(new THREE.SphereGeometry(0.4, 8, 6), m(rng.pick(['#3ee8ff', '#ff4fd8', '#b06bff']), true), 0, 0, -2.1);
    } else if (kind === 'drone') {
      mesh(new THREE.BoxGeometry(0.9, 0.3, 0.9), m('#2a3040'));
      mesh(new THREE.SphereGeometry(0.12, 6, 5), m('#ff2a2a', true), 0, -0.2, 0.4);
      for (const [x, z] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) wings.push(mesh(new THREE.BoxGeometry(0.7, 0.03, 0.1), m('#8a9ab0'), x, 0.2, z));
    } else {
      // Birds and bats: a body and two flapping wings.
      const color = kind === 'bat' ? '#1a0a10' : rng.pick(['#2a2a2a', '#e8e8f0', '#6a4a2a']);
      mesh(new THREE.SphereGeometry(0.18, 6, 5), m(color)).scale.set(1, 0.8, 1.8);
      for (const side of [-1, 1]) {
        const pivot = new THREE.Group();
        const wing = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.9, 0.03, 0.4)), m(color));
        wing.position.x = side * 0.45;
        pivot.add(wing);
        pivot.userData.side = side;
        g.add(pivot);
        wings.push(pivot);
      }
      if (kind === 'bat') mesh(new THREE.SphereGeometry(0.04, 4, 4), m('#ff3a1a', true), 0, 0.06, 0.28);
    }
    this.group.add(g);
    const high = kind === 'shuttle' ? [20, 34] : kind === 'drone' ? [12, 20] : [14, 28];
    return {
      cx: rng.float(-25, 25), cz: rng.float(-25, 25),
      radius: rng.float(12, kind === 'shuttle' ? 60 : 35),
      height: rng.float(high[0], high[1]),
      speed: (kind === 'shuttle' ? rng.float(8, 14) : rng.float(4, 8)) * (rng.chance(0.5) ? 1 : -1),
      phase: rng.float(0, Math.PI * 2),
      group: g,
      wings,
    };
  }

  /** `blockers`: positions that stop cars (fights, heroes on the road). */
  update(dt: number, time: number, blockers: readonly THREE.Vector3[], danger: readonly THREE.Vector3[]): TrafficEvent[] {
    const events: TrafficEvent[] = [];
    for (const car of this.cars) {
      const ahead = car.angle + car.dir * (6 / car.radius);
      const ax = Math.cos(ahead) * car.radius;
      const az = Math.sin(ahead) * car.radius;
      const blocked = blockers.some((b) => Math.hypot(b.x - ax, b.z - az) < 3.5)
        || this.cars.some((o) => o !== car && o.dir === car.dir && angularGap(car, o) * car.radius < 8);
      // Danger nearby: floor it (or slam the brakes if it's right ahead).
      const scared = danger.some((d) => Math.hypot(d.x - car.group.position.x, d.z - car.group.position.z) < 14);
      const target = blocked ? 0 : scared ? car.maxSpeed * 1.6 : car.maxSpeed;
      car.speed += (target - car.speed) * Math.min(1, dt * (blocked ? 5 : 1.5));
      car.angle += car.dir * (car.speed / car.radius) * dt;
      car.blockedFor = blocked ? car.blockedFor + dt : 0;
      car.honkCooldown -= dt;
      if (car.blockedFor > 1.2 && car.honkCooldown <= 0 && blockers.some((b) => Math.hypot(b.x - ax, b.z - az) < 3.5)) {
        car.honkCooldown = 3 + Math.random() * 3;
        events.push({ kind: 'honk', pos: car.group.position.clone() });
      }
      car.group.position.set(Math.cos(car.angle) * car.radius, 0, Math.sin(car.angle) * car.radius);
      // Face along the road.
      car.group.rotation.y = Math.atan2(-Math.sin(car.angle) * car.dir, Math.cos(car.angle) * car.dir);
    }
    for (const f of this.fliers) {
      const a = f.phase + (time * f.speed) / f.radius;
      f.group.position.set(f.cx + Math.cos(a) * f.radius, f.height + Math.sin(time * 0.7 + f.phase) * 1.5, f.cz + Math.sin(a) * f.radius);
      const s = Math.sign(f.speed);
      f.group.rotation.y = Math.atan2(-Math.sin(a) * s, Math.cos(a) * s);
      for (const w of f.wings) {
        if (w.userData.side) w.rotation.z = w.userData.side * Math.sin(time * 12 + f.phase) * 0.7;
        else w.rotation.y += dt * 40; // drone rotors
      }
    }
    return events;
  }

  get carCount(): number {
    return this.cars.length;
  }

  /** Car positions (for tests and debugging). */
  carPositions(): THREE.Vector3[] {
    return this.cars.map((c) => c.group.position.clone());
  }

  dispose() {
    this.group.removeFromParent();
    this.disposables.forEach((d) => d.dispose());
  }
}

/** How far ahead `other` is of `car` along the lane, in radians (0 if behind). */
function angularGap(car: Car, other: Car): number {
  let d = (other.angle - car.angle) * car.dir;
  d = ((d % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return d === 0 ? 0 : d > Math.PI ? Infinity : d;
}
