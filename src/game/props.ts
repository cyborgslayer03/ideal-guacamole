// Destructible scenery: cars, crates, and explosive barrels. Props are neutral
// actors, so every attack and explosion can smash them, but nobody targets
// them on purpose. Telekinetics can hurl them at enemies.

import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { Appearance, Biome, Stats } from '../core/types';
import { ARENA_RADIUS, type Obstacle } from './arena';
import { Actor } from './combat';
import type { AnimState, HeroModel } from './model';
import { EMPTY_LOADOUT } from '../core/progression';

export type PropKind = 'car' | 'crate' | 'barrel';

const PROP_HP: Record<PropKind, number> = { car: 320, crate: 70, barrel: 45 };
/** Sizes: radius drives collisions, height drives the hit center. */
const PROP_SIZE: Record<PropKind, { radius: number; height: number }> = {
  car: { radius: 1.6, height: 1.3 },
  crate: { radius: 0.85, height: 1.2 },
  barrel: { radius: 0.6, height: 1.2 },
};
const PROP_STATS: Stats = { strength: 1, speed: 1, durability: 4, energy: 1, intelligence: 1, combat: 1 };

class PropModel implements HeroModel {
  readonly root = new THREE.Group();
  readonly animatesDeath = true;
  readonly height: number;
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private flash = 0;

  constructor(kind: PropKind, color: string) {
    this.height = PROP_SIZE[kind].height;
    const mat = (c: string, emissive = '#000000', metal = 0.3) => {
      const m = new THREE.MeshStandardMaterial({ color: c, emissive, roughness: 0.6, metalness: metal });
      this.materials.push(m);
      return m;
    };
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
      this.geometries.push(geo);
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      return mesh;
    };
    if (kind === 'car') {
      const body = mat(color, '#000000', 0.6);
      add(new THREE.BoxGeometry(1.9, 0.6, 3.9), body, 0, 0.55, 0);
      add(new THREE.BoxGeometry(1.6, 0.55, 2), mat('#1a2030', '#0a1830', 0.8), 0, 1.1, -0.2);
      const tire = mat('#111111');
      for (const [x, z] of [[-0.95, 1.2], [0.95, 1.2], [-0.95, -1.2], [0.95, -1.2]]) {
        add(new THREE.CylinderGeometry(0.35, 0.35, 0.3, 12), tire, x, 0.35, z).rotation.z = Math.PI / 2;
      }
      add(new THREE.BoxGeometry(1.7, 0.12, 0.08), mat('#ffffff', '#ffffaa'), 0, 0.65, 1.96);
    } else if (kind === 'crate') {
      add(new THREE.BoxGeometry(1.2, 1.2, 1.2), mat('#8a6a3a'), 0, 0.6, 0);
      const band = mat('#4a3a20');
      add(new THREE.BoxGeometry(1.24, 0.12, 1.24), band, 0, 0.25, 0);
      add(new THREE.BoxGeometry(1.24, 0.12, 1.24), band, 0, 0.95, 0);
    } else {
      add(new THREE.CylinderGeometry(0.5, 0.5, 1.2, 16), mat('#c0302a', '#300800'), 0, 0.6, 0);
      add(new THREE.CylinderGeometry(0.52, 0.52, 0.12, 16), mat('#ffd23e', '#403000'), 0, 0.85, 0);
    }
  }

  update(dt: number, _s: AnimState) {
    if (this.flash <= 0) return;
    this.flash = Math.max(0, this.flash - dt * 6);
    for (const m of this.materials) m.emissiveIntensity = 1 + this.flash * 3;
  }

  hitFlash() {
    this.flash = 1;
  }

  setOpacity(alpha: number) {
    for (const m of this.materials) {
      m.transparent = alpha < 1;
      m.opacity = alpha;
    }
  }

  dispose() {
    for (const m of this.materials) m.dispose();
    for (const g of this.geometries) g.dispose();
  }
}

const NAMES: Record<PropKind, string> = { car: 'Car', crate: 'Crate', barrel: 'Fuel Barrel' };
const look = (kind: PropKind): Appearance => ({
  primary: '#888888', secondary: '#444444', accent: '#ffffff', build: 'athletic',
  height: PROP_SIZE[kind].radius / 0.55, head: 'bare', emblem: 'none', cape: false, aura: false, model: null,
});
const CAR_COLORS = ['#c0303a', '#2a5ac0', '#e8e8f0', '#2a2a30', '#d6a31a', '#3a8a4a'];

export function createProp(kind: PropKind, color = CAR_COLORS[0]): Actor {
  const prop = new Actor(NAMES[kind], 'neutral', 'prop', PROP_STATS, 1, look(kind), [], PROP_HP[kind], undefined, EMPTY_LOADOUT, new PropModel(kind, color));
  prop.ai.explosive = kind === 'barrel' ? 1 : 0;
  return prop;
}

/** Scatters props around an arena, away from buildings and the spawn point. Deterministic per seed. */
export function scatterProps(seed: number, biome: Biome, obstacles: readonly Obstacle[], count = 12): Actor[] {
  const rng = new Rng(seed);
  const props: Actor[] = [];
  const kinds: PropKind[] = biome === 'metropolis' ? ['car', 'car', 'crate', 'barrel'] : ['crate', 'crate', 'barrel'];
  for (let tries = 0; props.length < count && tries < count * 20; tries++) {
    const angle = rng.float(0, Math.PI * 2);
    const dist = rng.float(10, ARENA_RADIUS - 6);
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    const kind = rng.pick(kinds);
    const r = PROP_SIZE[kind].radius;
    if (obstacles.some((o) => Math.hypot(x - o.x, z - o.z) < o.r + r + 1.5)) continue;
    if (props.some((p) => Math.hypot(x - p.pos.x, z - p.pos.z) < p.radius + r + 1)) continue;
    const prop = createProp(kind, rng.pick(CAR_COLORS));
    prop.pos.set(x, 0, z);
    prop.facing = rng.float(0, Math.PI * 2);
    prop.model.root.rotation.y = prop.facing;
    props.push(prop);
  }
  return props;
}
