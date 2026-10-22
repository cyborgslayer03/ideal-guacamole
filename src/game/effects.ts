// Short-lived visual effects: particle bursts, shockwave rings, beams,
// attack telegraphs, and camera shake.

import * as THREE from 'three';

interface Transient {
  obj: THREE.Object3D;
  mat: THREE.Material & { opacity: number };
  age: number;
  life: number;
  tick(p: number, dt: number): void;
}

const sphereGeo = new THREE.SphereGeometry(1, 8, 6);
const ringGeo = new THREE.RingGeometry(0.85, 1, 48);
const discGeo = new THREE.CircleGeometry(1, 40);
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
beamGeo.rotateX(Math.PI / 2);
beamGeo.translate(0, 0, 0.5);

function additive(color: THREE.ColorRepresentation, opacity = 1, side: THREE.Side = THREE.DoubleSide) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side,
  });
}

export class Effects {
  private items: Transient[] = [];
  private shakeAmount = 0;

  constructor(private readonly scene: THREE.Scene) {}

  private add(obj: THREE.Object3D, mat: Transient['mat'], life: number, tick: Transient['tick']) {
    this.scene.add(obj);
    this.items.push({ obj, mat, age: 0, life, tick });
  }

  burst(pos: THREE.Vector3, color: THREE.ColorRepresentation, count = 12, speed = 8, size = 0.12) {
    for (let i = 0; i < count; i++) {
      const mat = additive(color);
      const m = new THREE.Mesh(sphereGeo, mat);
      m.position.copy(pos);
      m.scale.setScalar(size * (0.6 + Math.random() * 0.8));
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.6));
      const life = 0.3 + Math.random() * 0.3;
      this.add(m, mat, life, (p, dt) => {
        m.position.addScaledVector(v, dt);
        v.multiplyScalar(1 - dt * 4);
        mat.opacity = 1 - p;
      });
    }
  }

  /** Expanding ground shockwave. */
  ring(pos: THREE.Vector3, color: THREE.ColorRepresentation, radius: number, life = 0.45) {
    const mat = additive(color, 0.9);
    const m = new THREE.Mesh(ringGeo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(pos.x, 0.08, pos.z);
    this.add(m, mat, life, (p) => {
      m.scale.setScalar(0.2 + radius * Math.sqrt(p));
      mat.opacity = 0.9 * (1 - p);
    });
  }

  /** Bright expanding sphere, used for explosions and novas. */
  flare(pos: THREE.Vector3, color: THREE.ColorRepresentation, radius: number, life = 0.3) {
    // Front faces only: a camera inside a big flare would otherwise see a white screen.
    const mat = additive(color, 0.45, THREE.FrontSide);
    const m = new THREE.Mesh(sphereGeo, mat);
    m.position.copy(pos);
    this.add(m, mat, life, (p) => {
      m.scale.setScalar(radius * (0.3 + 0.7 * p));
      mat.opacity = 0.45 * (1 - p);
    });
  }

  beam(from: THREE.Vector3, to: THREE.Vector3, color: THREE.ColorRepresentation, width: number, life: number) {
    const mat = additive(color, 0.9);
    const m = new THREE.Mesh(beamGeo, mat);
    m.position.copy(from);
    m.lookAt(to);
    const len = from.distanceTo(to);
    this.add(m, mat, life, (p) => {
      const w = width * (1 - p * 0.6) * (0.85 + Math.random() * 0.3);
      m.scale.set(w, w, len);
      mat.opacity = 0.9 * (1 - p * p);
    });
  }

  /** Red ground marker warning of an incoming enemy attack. */
  telegraph(pos: THREE.Vector3, radius: number, life: number, color: THREE.ColorRepresentation = '#ff2a3a') {
    const mat = additive(color, 0.25);
    const m = new THREE.Mesh(discGeo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(pos.x, 0.06, pos.z);
    m.scale.setScalar(radius);
    const edgeMat = additive(color, 0.8);
    const edge = new THREE.Mesh(ringGeo, edgeMat);
    m.add(edge);
    edge.position.z = 0.01;
    this.add(m, mat, life, (p) => {
      edge.scale.setScalar(Math.max(0.01, p));
      mat.opacity = 0.15 + p * 0.25;
      if (p >= 1) edgeMat.dispose();
    });
  }

  shake(amount: number) {
    this.shakeAmount = Math.min(1.2, this.shakeAmount + amount);
  }

  /** Returns the current camera shake offset. */
  update(dt: number): THREE.Vector3 {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.age += dt;
      const p = Math.min(1, it.age / it.life);
      it.tick(p, dt);
      if (p >= 1) {
        this.scene.remove(it.obj);
        it.mat.dispose();
        this.items.splice(i, 1);
      }
    }
    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 3);
    const s = this.shakeAmount * this.shakeAmount;
    return new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
  }

  clear() {
    for (const it of this.items) {
      this.scene.remove(it.obj);
      it.mat.dispose();
    }
    this.items = [];
  }
}
