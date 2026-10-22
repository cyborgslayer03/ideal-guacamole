// Builds a combat arena from a Location: sky, lighting, glowing ground grid,
// and biome-specific structures that double as collision obstacles.

import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { Location } from '../core/types';

export const ARENA_RADIUS = 55;

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

export interface Arena {
  group: THREE.Group;
  obstacles: Obstacle[];
  /** Raised walkable spots (rooftops, ledges, the skydeck) for spawning. */
  perches: THREE.Vector3[];
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
  cam.left = cam.bottom = -60;
  cam.right = cam.top = 60;
  cam.far = 150;
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

  const grid = new THREE.GridHelper(ARENA_RADIUS * 2, 44, glow, glow);
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
  const count = Math.round(10 + location.density * 30);
  const placeObstacle = (minR: number, maxR: number, radius: number): { x: number; z: number } | null => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const a = rng.float(0, Math.PI * 2);
      const d = rng.float(minR, maxR);
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (obstacles.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + radius + 3)) return { x, z };
    }
    return null;
  };

  const structureMat = track(new THREE.MeshStandardMaterial({ color: new THREE.Color(location.groundColor).offsetHSL(0, 0, 0.08), roughness: 0.6, metalness: 0.4 }));
  const glowMat = track(new THREE.MeshStandardMaterial({ color: glow, emissive: glow, emissiveIntensity: 1.4 }));

  buildLevels(rng, obstacles, perches, group, structureMat, glowMat, track);
  buildOutcrops(rng, obstacles, perches, group, structureMat, glowMat, track, placeObstacle);

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

  // Ambient floating particles.
  const particleCount = 400;
  const positions = new Float32Array(particleCount * 3);
  for (let i = 0; i < particleCount; i++) {
    positions[i * 3] = rng.float(-ARENA_RADIUS, ARENA_RADIUS);
    positions[i * 3 + 1] = rng.float(0.5, 25);
    positions[i * 3 + 2] = rng.float(-ARENA_RADIUS, ARENA_RADIUS);
  }
  const pGeo = track(new THREE.BufferGeometry());
  pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const particles = new THREE.Points(pGeo, track(new THREE.PointsMaterial({ color: glow, size: 0.15, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false })));
  group.add(particles);
  animated.push((t) => {
    particles.rotation.y = t * 0.01;
    particles.position.y = Math.sin(t * 0.3) * 0.5;
  });

  return {
    group,
    obstacles,
    perches,
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
