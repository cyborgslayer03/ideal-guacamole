// Builds a combat arena from a Location: sky, lighting, glowing ground grid,
// and biome-specific structures that double as collision obstacles.

import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { Location } from '../core/types';

export const ARENA_RADIUS = 55;

/** Axis-aligned circle obstacle on the ground plane. */
export interface Obstacle {
  x: number;
  z: number;
  r: number;
  height: number;
}

export interface Arena {
  group: THREE.Group;
  obstacles: Obstacle[];
  update(t: number): void;
  dispose(): void;
}

export function buildArena(location: Location, seed: number): Arena {
  const rng = new Rng(seed);
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);
  const obstacles: Obstacle[] = [];
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

  for (let i = 0; i < count; i++) {
    const r = rng.float(1.5, 3.5);
    const spot = placeObstacle(14, ARENA_RADIUS - 5, r);
    if (!spot) continue;
    const h = buildStructure(location, rng, r, structureMat, glowMat, track, group, spot, animated);
    obstacles.push({ ...spot, r, height: h });
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
