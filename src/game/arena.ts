// Builds a combat arena from a Location: sky, lighting, glowing ground grid,
// and biome-specific structures that double as collision obstacles.

import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { Location } from '../core/types';

export const ARENA_RADIUS = 75;

/** City arenas have a ring road for traffic at this radius. */
export const ROAD_RADIUS = 46;
export const ROAD_WIDTH = 7;

/**
 * A vertical cylinder of solid space. Columns rise from the ground (bottom 0);
 * thin floating platforms are one-way: you can jump up through them and land
 * on top. Walkable tops can be stood on.
 */
export interface Obstacle {
  x: number;
  z: number;
  r: number;
  bottom: number;
  top: number;
  walkable: boolean;
}

/** Platforms thinner than this are one-way (no side collision). */
export const THIN = 1.2;

/** A ground area that hurts whoever stands in it (Underworld lava). */
export interface Hazard {
  x: number;
  z: number;
  r: number;
  /** Damage per second, as a fraction of max health. */
  dps: number;
}

export interface Arena {
  group: THREE.Group;
  obstacles: Obstacle[];
  /** Raised walkable spots (rooftops, ledges, the skydeck) for spawning. */
  perches: THREE.Vector3[];
  hazards: Hazard[];
  /** Ring road for traffic (cities only). */
  road: { radius: number; width: number } | null;
  update(t: number): void;
  dispose(): void;
}

/** Height of the highest walkable surface under (x, z) that is not above `maxY`. */
export function floorAt(obstacles: readonly Obstacle[], x: number, z: number, maxY: number): number {
  let floor = 0;
  for (const o of obstacles) {
    if (!o.walkable || o.top > maxY || o.top <= floor) continue;
    if (Math.hypot(x - o.x, z - o.z) <= o.r) floor = o.top;
  }
  return floor;
}

export interface AimResult {
  point: THREE.Vector3;
  /** True if the aim was beyond range and pulled back. */
  clamped: boolean;
}

/**
 * Where a free-aimed movement power would land: the first ground, rooftop, or
 * platform the aim ray hits (a wall stops it just in front), pulled back to the
 * power's range and kept inside the arena.
 */
export function aimPoint(obstacles: readonly Obstacle[], origin: THREE.Vector3, ray: THREE.Ray, range: number): AimResult {
  let best = Infinity;
  let hit: THREE.Vector3 | null = null;
  const consider = (t: number, p: THREE.Vector3) => {
    if (t > 0.01 && t < best) {
      best = t;
      hit = p;
    }
  };
  const { origin: o, direction: d } = ray;
  // Ground.
  if (d.y < -1e-4) consider(-o.y / d.y, o.clone().addScaledVector(d, -o.y / d.y));
  for (const ob of obstacles) {
    // Tops you can stand on (approached from above).
    if (ob.walkable && d.y < -1e-4 && o.y > ob.top) {
      const t = (ob.top - o.y) / d.y;
      const p = o.clone().addScaledVector(d, t);
      if (Math.hypot(p.x - ob.x, p.z - ob.z) <= ob.r) consider(t, p);
    }
    // Sides of solid columns: land at their foot, just in front of the wall.
    if (ob.top - ob.bottom < THIN) continue;
    const fx = o.x - ob.x;
    const fz = o.z - ob.z;
    const a = d.x * d.x + d.z * d.z;
    const b = 2 * (fx * d.x + fz * d.z);
    const c = fx * fx + fz * fz - ob.r * ob.r;
    const disc = b * b - 4 * a * c;
    if (a < 1e-6 || disc < 0 || c < 0) continue;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    const p = o.clone().addScaledVector(d, t);
    if (p.y < ob.bottom || p.y > ob.top) continue;
    const out = new THREE.Vector3(p.x - ob.x, 0, p.z - ob.z).normalize();
    const foot = new THREE.Vector3(ob.x + out.x * (ob.r + 1), 0, ob.z + out.z * (ob.r + 1));
    foot.y = floorAt(obstacles, foot.x, foot.z, p.y);
    consider(t, foot);
  }
  let point: THREE.Vector3 = hit ?? origin.clone().add(new THREE.Vector3(d.x, 0, d.z).normalize().multiplyScalar(range));
  let clamped = !hit;
  const flat = Math.hypot(point.x - origin.x, point.z - origin.z);
  if (flat > range) {
    const k = range / flat;
    point = new THREE.Vector3(origin.x + (point.x - origin.x) * k, 0, origin.z + (point.z - origin.z) * k);
    point.y = floorAt(obstacles, point.x, point.z, Math.max(origin.y, (hit as THREE.Vector3 | null)?.y ?? 0) + 2);
    clamped = true;
  }
  const r = Math.hypot(point.x, point.z);
  const max = ARENA_RADIUS - 2;
  if (r > max) {
    point.x *= max / r;
    point.z *= max / r;
    point.y = floorAt(obstacles, point.x, point.z, point.y + 0.5);
    clamped = true;
  }
  return { point, clamped };
}

/** Spire, skybridge, and skydeck: a climbable route to the arena's upper levels. */
function buildLevels(rng: Rng, obstacles: Obstacle[], perches: THREE.Vector3[], group: THREE.Group, mat: THREE.Material, glowMat: THREE.Material, track: <T extends { dispose(): void }>(x: T) => T) {
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(track(geo), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const rim = (x: number, y: number, z: number, r: number) => {
    const ring = add(new THREE.TorusGeometry(r, 0.08, 6, 40), glowMat, x, y, z);
    ring.rotation.x = Math.PI / 2;
  };

  // The spire: six stepping pillars spiralling up, each a double-jump above the last.
  const angle = rng.float(0, Math.PI * 2);
  const cx = Math.cos(angle) * 26;
  const cz = Math.sin(angle) * 26;
  const toOrigin = Math.atan2(-cz, -cx);
  add(new THREE.CylinderGeometry(1, 1.2, 17, 10), mat, cx, 8.5, cz);
  obstacles.push({ x: cx, z: cz, r: 1.1, bottom: 0, top: 17, walkable: false });
  let last = { x: cx, z: cz };
  for (let k = 0; k < 6; k++) {
    const top = 2.4 * (k + 1);
    const theta = toOrigin + (k - 5) * 1.05;
    const x = cx + Math.cos(theta) * 6;
    const z = cz + Math.sin(theta) * 6;
    add(new THREE.CylinderGeometry(2.2, 2.4, top, 16), mat, x, top / 2, z);
    rim(x, top + 0.02, z, 2.2);
    obstacles.push({ x, z, r: 2.2, bottom: 0, top, walkable: true });
    perches.push(new THREE.Vector3(x, top, z));
    last = { x, z };
  }

  // Skybridge: floating stepping platforms from the spire's top to the skydeck.
  const deckTop = 14.4;
  const lastDist = Math.hypot(last.x, last.z);
  const ux = last.x / lastDist;
  const uz = last.z / lastDist;
  for (const d of [lastDist - 5, lastDist - 9.5]) {
    add(new THREE.CylinderGeometry(2.4, 2.4, 0.5, 20), mat, ux * d, deckTop - 0.25, uz * d);
    rim(ux * d, deckTop + 0.02, uz * d, 2.4);
    obstacles.push({ x: ux * d, z: uz * d, r: 2.4, bottom: deckTop - 0.5, top: deckTop, walkable: true });
  }

  // Skydeck: a wide floating arena above the center, the top level.
  const deck = add(new THREE.CylinderGeometry(7, 6.4, 0.6, 40), mat, 0, deckTop - 0.3, 0);
  deck.receiveShadow = true;
  rim(0, deckTop + 0.02, 0, 7);
  rim(0, deckTop - 0.6, 0, 6.4);
  obstacles.push({ x: 0, z: 0, r: 7, bottom: deckTop - 0.6, top: deckTop, walkable: true });
  perches.push(new THREE.Vector3(0, deckTop, 0), new THREE.Vector3(4, deckTop, 0), new THREE.Vector3(-3, deckTop, 3));
}

/** Flat-topped outcrops so every biome has rooftop-height ledges. */
function buildOutcrops(rng: Rng, obstacles: Obstacle[], perches: THREE.Vector3[], group: THREE.Group, mat: THREE.Material, glowMat: THREE.Material, track: <T extends { dispose(): void }>(x: T) => T, place: (minR: number, maxR: number, r: number) => { x: number; z: number } | null) {
  for (let i = 0; i < 4; i++) {
    const r = rng.float(3, 4.2);
    const spot = place(18, ARENA_RADIUS - 8, r);
    if (!spot) continue;
    const top = rng.float(4, 9);
    const mesh = new THREE.Mesh(track(new THREE.CylinderGeometry(r, r * 1.15, top, 7)), mat);
    mesh.position.set(spot.x, top / 2, spot.z);
    mesh.castShadow = mesh.receiveShadow = true;
    const rimMesh = new THREE.Mesh(track(new THREE.TorusGeometry(r * 0.98, 0.08, 6, 7)), glowMat);
    rimMesh.rotation.x = Math.PI / 2;
    rimMesh.position.set(spot.x, top + 0.02, spot.z);
    group.add(mesh, rimMesh);
    obstacles.push({ ...spot, r, bottom: 0, top, walkable: true });
    perches.push(new THREE.Vector3(spot.x, top, spot.z));
  }
}

export function buildArena(location: Location, seed: number): Arena {
  const rng = new Rng(seed);
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);
  const obstacles: Obstacle[] = [];
  const perches: THREE.Vector3[] = [];
  const glow = new THREE.Color(location.glowColor);
  const animated: ((t: number) => void)[] = [];

  // Lighting.
  const hemi = new THREE.HemisphereLight(new THREE.Color(location.skyColor).lerp(new THREE.Color('#ffffff'), 0.5), location.groundColor, 0.9);
  const sun = new THREE.DirectionalLight('#ffffff', 1.8);
  sun.position.set(30, 50, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const cam = sun.shadow.camera;
  cam.left = cam.bottom = -ARENA_RADIUS - 5;
  cam.right = cam.top = ARENA_RADIUS + 5;
  cam.far = 170;
  const rim = new THREE.DirectionalLight(glow, 1.4);
  rim.position.set(-30, 20, -40);
  group.add(hemi, sun, rim);

  // Ground with a glowing tech grid.
  const ground = new THREE.Mesh(
    track(new THREE.CircleGeometry(ARENA_RADIUS + 40, 64)),
    track(new THREE.MeshStandardMaterial({ color: location.groundColor, roughness: 0.85, metalness: 0.15 })),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  const grid = new THREE.GridHelper(ARENA_RADIUS * 2, 60, glow, glow);
  const gridMat = grid.material as THREE.Material;
  gridMat.transparent = true;
  gridMat.opacity = location.biome === 'frozen' ? 0.25 : 0.12;
  grid.position.y = 0.02;
  track(grid.geometry);
  track(gridMat);
  group.add(grid);

  // Boundary ring: the edge of the playable zone.
  const ringMat = track(new THREE.MeshBasicMaterial({ color: glow, transparent: true, opacity: 0.5, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
  const ring = new THREE.Mesh(track(new THREE.CylinderGeometry(ARENA_RADIUS, ARENA_RADIUS, 3, 64, 1, true)), ringMat);
  ring.position.y = 1.5;
  group.add(ring);
  animated.push((t) => (ringMat.opacity = 0.18 + Math.sin(t * 1.5) * 0.06));

  // Biome structures. Kept out of the central spawn area.
  // The bigger arena gets proportionally more structures.
  const count = Math.round((10 + location.density * 30) * 1.7);
  const road = location.biome === 'metropolis' ? { radius: ROAD_RADIUS, width: ROAD_WIDTH } : null;
  const hazards: Hazard[] = [];
  const placeObstacle = (minR: number, maxR: number, radius: number): { x: number; z: number } | null => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const a = rng.float(0, Math.PI * 2);
      const d = rng.float(minR, maxR);
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (road && Math.abs(d - road.radius) < road.width / 2 + radius + 1.5) continue;
      if (hazards.some((h) => Math.hypot(h.x - x, h.z - z) < h.r + radius + 2)) continue;
      if (obstacles.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + radius + 3)) return { x, z };
    }
    return null;
  };
  if (road) buildRoad(group, track, road.radius, road.width, animated);

  const structureMat = track(new THREE.MeshStandardMaterial({ color: new THREE.Color(location.groundColor).offsetHSL(0, 0, 0.08), roughness: 0.6, metalness: 0.4 }));
  const glowMat = track(new THREE.MeshStandardMaterial({ color: glow, emissive: glow, emissiveIntensity: 1.4 }));

  buildLevels(rng, obstacles, perches, group, structureMat, glowMat, track);
  buildOutcrops(rng, obstacles, perches, group, structureMat, glowMat, track, placeObstacle);
  if (location.biome === 'underworld') buildLava(rng, group, track, hazards, obstacles, animated);

  // City blocks have flat roofs you can stand on; other biomes' shapes are too jagged.
  const flatRoofs = location.biome === 'metropolis';
  for (let i = 0; i < count; i++) {
    const r = rng.float(1.5, 3.5);
    const spot = placeObstacle(14, ARENA_RADIUS - 5, r);
    if (!spot) continue;
    const h = buildStructure(location, rng, r, structureMat, glowMat, track, group, spot, animated);
    obstacles.push({ ...spot, r, bottom: 0, top: h, walkable: flatRoofs });
    if (flatRoofs) perches.push(new THREE.Vector3(spot.x, h, spot.z));
  }

  // Distant skyline/backdrop beyond the arena edge for a sense of scale.
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2 + rng.float(-0.05, 0.05);
    const d = rng.float(ARENA_RADIUS + 15, ARENA_RADIUS + 35);
    const r = rng.float(3, 7);
    buildStructure(location, rng, r, structureMat, glowMat, track, group, { x: Math.cos(a) * d, z: Math.sin(a) * d }, animated, 2.2);
  }

  buildWeather(location, rng, group, track, glow, animated);

  return {
    group,
    obstacles,
    perches,
    hazards,
    road,
    update: (t) => animated.forEach((f) => f(t)),
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

function buildStructure(
  location: Location,
  rng: Rng,
  r: number,
  mat: THREE.Material,
  glowMat: THREE.Material,
  track: <T extends { dispose(): void }>(x: T) => T,
  group: THREE.Group,
  at: { x: number; z: number },
  animated: ((t: number) => void)[],
  scale = 1,
): number {
  const g = new THREE.Group();
  g.position.set(at.x, 0, at.z);
  let height = 0;
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, y: number) => {
    const mesh = new THREE.Mesh(track(geo), m);
    mesh.position.y = y;
    mesh.castShadow = scale === 1;
    mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };

  switch (location.biome) {
    case 'metropolis': {
      height = rng.float(6, 22) * scale;
      add(new THREE.BoxGeometry(r * 1.6, height, r * 1.6), mat, height / 2);
      // Glowing window strips.
      for (let y = 2; y < height - 1; y += rng.float(2.5, 4)) {
        add(new THREE.BoxGeometry(r * 1.65, 0.15, r * 1.65), glowMat, y);
      }
      add(new THREE.BoxGeometry(r * 0.3, 2, r * 0.3), glowMat, height + 1);
      break;
    }
    case 'cosmic':
    case 'mystic': {
      height = rng.float(3, 10) * scale;
      const crystal = add(new THREE.OctahedronGeometry(r, 0), location.biome === 'cosmic' ? glowMat : mat, height);
      crystal.scale.y = 2;
      add(new THREE.CylinderGeometry(r * 0.8, r, 1, 6), mat, 0.5);
      const phase = rng.float(0, 10);
      animated.push((t) => {
        crystal.rotation.y = t * 0.3 + phase;
        crystal.position.y = height + Math.sin(t + phase) * 0.6;
      });
      break;
    }
    case 'wasteland': {
      height = rng.float(2, 7) * scale;
      const rock = add(new THREE.DodecahedronGeometry(r, 0), mat, height * 0.4);
      rock.scale.y = height / r * 0.6;
      rock.rotation.set(rng.float(0, 1), rng.float(0, 3), 0);
      if (rng.chance(0.3)) add(new THREE.CylinderGeometry(0.15, 0.15, height * 1.5, 6), glowMat, height * 0.75);
      break;
    }
    case 'frozen': {
      height = rng.float(4, 12) * scale;
      add(new THREE.ConeGeometry(r, height, 5), mat, height / 2);
      add(new THREE.ConeGeometry(r * 0.4, height * 0.6, 5), glowMat, height * 0.3).position.x = r * 0.6;
      break;
    }
    case 'underworld': {
      // Obsidian spires with molten veins, and the odd bone arch.
      height = rng.float(5, 16) * scale;
      const spire = add(new THREE.ConeGeometry(r, height, 6), mat, height / 2);
      spire.rotation.y = rng.float(0, 3);
      add(new THREE.ConeGeometry(r * 0.35, height * 0.75, 4), glowMat, height * 0.38).position.x = r * 0.45;
      if (rng.chance(0.35)) {
        const arch = add(new THREE.TorusGeometry(r * 1.4, r * 0.18, 6, 12, Math.PI), mat, 0);
        arch.position.x = r * 1.6;
        arch.rotation.y = Math.PI / 2;
      }
      break;
    }
    case 'jungle': {
      height = rng.float(6, 14) * scale;
      add(new THREE.CylinderGeometry(r * 0.25, r * 0.35, height, 7), mat, height / 2);
      add(new THREE.SphereGeometry(r * 1.2, 8, 6), glowMat, height).scale.y = 0.6;
      break;
    }
  }
  group.add(g);
  return height;
}

/** A dark ring road with dashed lane lines (traffic drives on it). */
function buildRoad(group: THREE.Group, track: <T extends { dispose(): void }>(x: T) => T, radius: number, width: number, animated: ((t: number) => void)[]) {
  const asphalt = new THREE.Mesh(track(new THREE.RingGeometry(radius - width / 2, radius + width / 2, 96)),
    track(new THREE.MeshStandardMaterial({ color: '#0d0f16', roughness: 0.9, metalness: 0.1 })));
  asphalt.rotation.x = -Math.PI / 2;
  asphalt.position.y = 0.03;
  asphalt.receiveShadow = true;
  group.add(asphalt);
  const dashMat = track(new THREE.MeshBasicMaterial({ color: '#ffd23e' }));
  const dashGeo = track(new THREE.PlaneGeometry(0.25, 1.8));
  const dashes = 64;
  for (let i = 0; i < dashes; i++) {
    const a = (i / dashes) * Math.PI * 2;
    const d = new THREE.Mesh(dashGeo, dashMat);
    d.rotation.x = -Math.PI / 2;
    d.rotation.z = -a;
    d.position.set(Math.cos(a) * radius, 0.05, Math.sin(a) * radius);
    group.add(d);
  }
  // Street lights along the outer edge.
  const poleMat = track(new THREE.MeshStandardMaterial({ color: '#2a3040', metalness: 0.6, roughness: 0.4 }));
  const lampMat = track(new THREE.MeshStandardMaterial({ color: '#fff2c0', emissive: '#ffe08a', emissiveIntensity: 1.6 }));
  const pole = track(new THREE.CylinderGeometry(0.08, 0.1, 4.5, 6));
  const lamp = track(new THREE.SphereGeometry(0.25, 8, 6));
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2 + 0.07;
    const r = radius + width / 2 + 0.8;
    const p = new THREE.Mesh(pole, poleMat);
    p.position.set(Math.cos(a) * r, 2.25, Math.sin(a) * r);
    const l = new THREE.Mesh(lamp, lampMat);
    l.position.set(Math.cos(a) * r, 4.6, Math.sin(a) * r);
    group.add(p, l);
  }
  void animated;
}

/** Glowing lava pools that scorch anyone standing in them. */
function buildLava(rng: Rng, group: THREE.Group, track: <T extends { dispose(): void }>(x: T) => T, hazards: Hazard[], obstacles: readonly Obstacle[], animated: ((t: number) => void)[]) {
  const mat = track(new THREE.MeshStandardMaterial({ color: '#ff5a1a', emissive: '#ff3a0a', emissiveIntensity: 1.8, roughness: 0.4 }));
  const crust = track(new THREE.MeshStandardMaterial({ color: '#1a0805', roughness: 1 }));
  const pools = rng.int(5, 8);
  for (let i = 0; i < pools * 4 && hazards.length < pools; i++) {
    const a = rng.float(0, Math.PI * 2);
    const d = rng.float(16, ARENA_RADIUS - 10);
    const r = rng.float(3, 6);
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (hazards.some((h) => Math.hypot(h.x - x, h.z - z) < h.r + r + 4)) continue;
    if (obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + r + 1.5)) continue;
    const rim = new THREE.Mesh(track(new THREE.CircleGeometry(r + 0.8, 24)), crust);
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(x, 0.035, z);
    const pool = new THREE.Mesh(track(new THREE.CircleGeometry(r, 24)), mat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(x, 0.05, z);
    group.add(rim, pool);
    hazards.push({ x, z, r, dps: 0.06 });
  }
  animated.push((t) => (mat.emissiveIntensity = 1.5 + Math.sin(t * 2.2) * 0.4));
}

type WeatherKind = 'rain' | 'snow' | 'embers' | 'dust' | 'spores' | 'stardust' | 'motes';

function weatherFor(location: Location, rng: Rng): WeatherKind {
  switch (location.biome) {
    case 'metropolis': return rng.chance(0.5) ? 'rain' : 'motes';
    case 'frozen': return 'snow';
    case 'underworld': return 'embers';
    case 'wasteland': return 'dust';
    case 'jungle': return 'spores';
    case 'cosmic': return 'stardust';
    default: return 'motes';
  }
}

/** Biome weather: rain streaks, snowfall, rising embers, drifting dust, fireflies, or star dust. */
function buildWeather(location: Location, rng: Rng, group: THREE.Group, track: <T extends { dispose(): void }>(x: T) => T, glow: THREE.Color, animated: ((t: number) => void)[]) {
  const kind = weatherFor(location, rng);
  const span = ARENA_RADIUS * 0.9;
  const top = 28;
  const count = kind === 'rain' ? 1400 : kind === 'snow' ? 900 : 500;
  const pos = new Float32Array(count * 3);
  const speed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rng.float(-span, span);
    pos[i * 3 + 1] = rng.float(0, top);
    pos[i * 3 + 2] = rng.float(-span, span);
    speed[i] = rng.float(0.6, 1.4);
  }
  const geo = track(new THREE.BufferGeometry());
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const look: Record<WeatherKind, { color: THREE.ColorRepresentation; size: number; opacity: number; additive: boolean }> = {
    rain: { color: '#9ab8e8', size: 0.12, opacity: 0.55, additive: false },
    snow: { color: '#ffffff', size: 0.22, opacity: 0.9, additive: false },
    embers: { color: '#ff7a2a', size: 0.2, opacity: 0.95, additive: true },
    dust: { color: '#c8a070', size: 0.18, opacity: 0.45, additive: false },
    spores: { color: '#b8ff6a', size: 0.18, opacity: 0.85, additive: true },
    stardust: { color: '#d8c8ff', size: 0.14, opacity: 0.9, additive: true },
    motes: { color: glow, size: 0.15, opacity: 0.7, additive: true },
  };
  const l = look[kind];
  const points = new THREE.Points(geo, track(new THREE.PointsMaterial({
    color: l.color, size: l.size, transparent: true, opacity: l.opacity, depthWrite: false,
    blending: l.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  })));
  group.add(points);
  // Rain also gets streaks: a second set of short vertical lines.
  let streaks: THREE.LineSegments | null = null;
  if (kind === 'rain') {
    const lines = new Float32Array(count * 6);
    const lg = track(new THREE.BufferGeometry());
    lg.setAttribute('position', new THREE.BufferAttribute(lines, 3));
    streaks = new THREE.LineSegments(lg, track(new THREE.LineBasicMaterial({ color: '#8aa8d8', transparent: true, opacity: 0.35 })));
    group.add(streaks);
  }
  let last = 0;
  animated.push((t) => {
    const dt = Math.min(0.1, Math.max(0, t - last));
    last = t;
    for (let i = 0; i < count; i++) {
      const k = i * 3;
      const s = speed[i];
      switch (kind) {
        case 'rain': pos[k + 1] -= 28 * s * dt; break;
        case 'snow':
          pos[k + 1] -= 2.2 * s * dt;
          pos[k] += Math.sin(t * 0.8 + i) * 0.6 * dt;
          break;
        case 'embers':
          pos[k + 1] += 2.5 * s * dt;
          pos[k] += Math.sin(t * 1.5 + i) * 0.8 * dt;
          break;
        case 'dust':
          pos[k] += 4 * s * dt;
          pos[k + 1] += Math.sin(t + i) * 0.3 * dt;
          break;
        default:
          pos[k + 1] += Math.sin(t * 0.7 + i) * 0.4 * dt;
          pos[k] += Math.cos(t * 0.5 + i * 1.3) * 0.3 * dt;
      }
      if (pos[k + 1] < 0) pos[k + 1] += top;
      if (pos[k + 1] > top) pos[k + 1] -= top;
      if (pos[k] > span) pos[k] -= span * 2;
      if (pos[k] < -span) pos[k] += span * 2;
    }
    geo.attributes.position.needsUpdate = true;
    if (streaks) {
      const a = (streaks.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
      for (let i = 0; i < count; i++) {
        a[i * 6] = a[i * 6 + 3] = pos[i * 3];
        a[i * 6 + 1] = pos[i * 3 + 1];
        a[i * 6 + 4] = pos[i * 3 + 1] + 0.7;
        a[i * 6 + 2] = a[i * 6 + 5] = pos[i * 3 + 2];
      }
      streaks.geometry.attributes.position.needsUpdate = true;
    }
    if (kind === 'spores' || kind === 'stardust') (points.material as THREE.PointsMaterial).opacity = l.opacity * (0.75 + Math.sin(t * 3) * 0.25);
  });
}
