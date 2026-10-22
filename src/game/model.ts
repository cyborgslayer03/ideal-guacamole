// Procedural stylized hero model built from an Appearance. No external art
// assets: every costume a player designs renders instantly.

import * as THREE from 'three';
import type { Appearance, Emblem } from '../core/types';

const BUILD_WIDTH = { slim: 0.85, athletic: 1, heavy: 1.3 } as const;

export interface AnimState {
  /** 0 = idle, 1 = full run. */
  moveBlend: number;
  airborne: boolean;
  flying: boolean;
  /** 0-1 progress of the current melee swing, or -1 when not attacking. */
  attack: number;
  /** Which arm swings: alternates through a combo. */
  attackArm: 'left' | 'right';
  /** 0-1 progress of a power cast pose, or -1. */
  cast: number;
}

export function idleAnim(): AnimState {
  return { moveBlend: 0, airborne: false, flying: false, attack: -1, attackArm: 'right', cast: -1 };
}

function emblemShape(kind: Emblem): THREE.Shape | null {
  const s = new THREE.Shape();
  switch (kind) {
    case 'star': {
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 1 : 0.42;
        const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
        if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      break;
    }
    case 'bolt':
      s.moveTo(0.2, 1);
      s.lineTo(-0.5, -0.05);
      s.lineTo(-0.02, -0.05);
      s.lineTo(-0.25, -1);
      s.lineTo(0.5, 0.15);
      s.lineTo(0.02, 0.15);
      break;
    case 'circle':
      s.absarc(0, 0, 0.85, 0, Math.PI * 2, false);
      break;
    case 'diamond':
      s.moveTo(0, 1);
      s.lineTo(0.7, 0);
      s.lineTo(0, -1);
      s.lineTo(-0.7, 0);
      break;
    case 'triangle':
      s.moveTo(0, -0.9);
      s.lineTo(0.95, 0.75);
      s.lineTo(-0.95, 0.75);
      break;
    case 'none':
      return null;
  }
  s.closePath();
  return s;
}

export class CharacterModel {
  readonly root = new THREE.Group();
  /** Everything that tilts/bobs; `root` holds position and facing. */
  private readonly body = new THREE.Group();
  private readonly leftArm = new THREE.Group();
  private readonly rightArm = new THREE.Group();
  private readonly leftLeg = new THREE.Group();
  private readonly rightLeg = new THREE.Group();
  private readonly cape: THREE.Group | null = null;
  private readonly aura: THREE.Mesh | null = null;
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private time = Math.random() * 10;
  private phase = 0;
  private flash = 0;
  readonly height: number;

  constructor(app: Appearance) {
    const w = BUILD_WIDTH[app.build];
    this.height = 1.9 * app.height;
    this.root.add(this.body);
    this.body.scale.setScalar(app.height);

    const primary = this.mat(app.primary, 0.45, 0.35);
    const secondary = this.mat(app.secondary, 0.5, 0.3);
    const accent = this.mat(app.accent, 0.3, 0.6);
    const glow = this.mat(app.accent, 0.2, 0.2, 2.2);

    // Torso: chest tapered into waist.
    const chest = this.mesh(new THREE.CylinderGeometry(0.32 * w, 0.24 * w, 0.62, 12), primary);
    chest.position.y = 1.33;
    chest.scale.z = 0.7;
    const abdomen = this.mesh(new THREE.CylinderGeometry(0.24 * w, 0.22 * w, 0.28, 12), secondary);
    abdomen.position.y = 0.92;
    abdomen.scale.z = 0.75;
    const belt = this.mesh(new THREE.TorusGeometry(0.22 * w, 0.035, 6, 16), accent);
    belt.rotation.x = Math.PI / 2;
    belt.scale.y = 0.75;
    belt.position.y = 0.8;
    const shoulders = this.mesh(new THREE.CapsuleGeometry(0.13 * w, 0.5 * w, 4, 8), primary);
    shoulders.rotation.z = Math.PI / 2;
    shoulders.position.y = 1.6;
    this.body.add(chest, abdomen, belt, shoulders);

    // Emblem on the chest.
    const shape = emblemShape(app.emblem);
    if (shape) {
      const emblem = this.mesh(new THREE.ShapeGeometry(shape), glow);
      emblem.scale.setScalar(0.12 * w);
      emblem.position.set(0, 1.42, 0.235 * w);
      this.body.add(emblem);
    }

    this.buildHead(app, primary, secondary, accent, glow);

    // Arms pivot at the shoulder.
    for (const [arm, side] of [[this.leftArm, -1], [this.rightArm, 1]] as const) {
      arm.position.set(side * 0.4 * w, 1.58, 0);
      const upper = this.mesh(new THREE.CapsuleGeometry(0.085 * w, 0.32, 4, 8), primary);
      upper.position.y = -0.22;
      const lower = this.mesh(new THREE.CapsuleGeometry(0.075 * w, 0.28, 4, 8), primary);
      lower.position.y = -0.55;
      const glove = this.mesh(new THREE.SphereGeometry(0.1 * w, 10, 8), accent);
      glove.position.y = -0.76;
      arm.add(upper, lower, glove);
      this.body.add(arm);
    }

    // Legs pivot at the hip.
    for (const [leg, side] of [[this.leftLeg, -1], [this.rightLeg, 1]] as const) {
      leg.position.set(side * 0.13 * w, 0.82, 0);
      const thigh = this.mesh(new THREE.CapsuleGeometry(0.11 * w, 0.32, 4, 8), secondary);
      thigh.position.y = -0.2;
      const boot = this.mesh(new THREE.CapsuleGeometry(0.095 * w, 0.3, 4, 8), accent);
      boot.position.y = -0.58;
      const foot = this.mesh(new THREE.BoxGeometry(0.15 * w, 0.08, 0.26), accent);
      foot.position.set(0, -0.78, 0.05);
      leg.add(thigh, boot, foot);
      this.body.add(leg);
    }

    if (app.cape) {
      const cape = new THREE.Group();
      cape.position.set(0, 1.62, -0.2 * w);
      const capeGeo = new THREE.PlaneGeometry(0.75 * w, 1.35, 1, 6);
      capeGeo.translate(0, -0.675, 0);
      const capeMat = this.mat(app.secondary, 0.7, 0.1);
      capeMat.side = THREE.DoubleSide;
      cape.add(this.mesh(capeGeo, capeMat));
      this.body.add(cape);
      this.cape = cape;
    }

    if (app.aura) {
      const auraMat = new THREE.MeshBasicMaterial({
        color: app.accent,
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const auraGeo = new THREE.SphereGeometry(1, 16, 12);
      this.geometries.push(auraGeo);
      const aura = new THREE.Mesh(auraGeo, auraMat);
      aura.scale.set(0.75 * w, 1.15, 0.75 * w);
      aura.position.y = 1.05;
      this.body.add(aura);
      this.aura = aura;
    }

    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh && o !== this.aura) o.castShadow = true;
    });
  }

  private buildHead(
    app: Appearance,
    primary: THREE.MeshStandardMaterial,
    secondary: THREE.MeshStandardMaterial,
    accent: THREE.MeshStandardMaterial,
    glow: THREE.MeshStandardMaterial,
  ) {
    const head = new THREE.Group();
    head.position.y = 1.86;
    this.body.add(head);
    const neck = this.mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.14, 8), secondary);
    neck.position.y = 1.72;
    this.body.add(neck);

    const skin = this.mat('#d9a27e', 0.7, 0);
    const skull = this.mesh(new THREE.SphereGeometry(0.15, 16, 12), app.head === 'bare' ? skin : primary);
    skull.scale.set(1, 1.15, 1.05);
    head.add(skull);

    const eyes = (mat: THREE.Material, width = 0.2) => {
      const band = this.mesh(new THREE.BoxGeometry(width, 0.035, 0.05), mat);
      band.position.set(0, 0.02, 0.135);
      head.add(band);
    };

    switch (app.head) {
      case 'mask':
        eyes(glow, 0.17);
        break;
      case 'helmet': {
        const shell = this.mesh(new THREE.SphereGeometry(0.175, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), primary);
        shell.scale.set(1, 1.1, 1.08);
        const fin = this.mesh(new THREE.BoxGeometry(0.03, 0.12, 0.26), accent);
        fin.position.set(0, 0.17, -0.02);
        head.add(shell, fin);
        eyes(glow, 0.2);
        break;
      }
      case 'cowl': {
        for (const side of [-1, 1]) {
          const ear = this.mesh(new THREE.ConeGeometry(0.04, 0.16, 6), primary);
          ear.position.set(side * 0.09, 0.2, 0);
          head.add(ear);
        }
        const jaw = this.mesh(new THREE.SphereGeometry(0.1, 10, 8), skin);
        jaw.position.set(0, -0.08, 0.06);
        head.add(jaw);
        eyes(glow, 0.15);
        break;
      }
      case 'visor': {
        const visor = this.mesh(new THREE.BoxGeometry(0.26, 0.07, 0.12), glow);
        visor.position.set(0, 0.03, 0.1);
        head.add(visor);
        break;
      }
      case 'bare': {
        const hair = this.mesh(new THREE.SphereGeometry(0.158, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), secondary);
        hair.scale.set(1, 1.15, 1.08);
        hair.position.y = 0.01;
        head.add(hair);
        eyes(this.mat('#111111', 0.5, 0), 0.12);
        break;
      }
    }
  }

  private mat(color: string, roughness: number, metalness: number, emissive = 0): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    if (emissive > 0) {
      m.emissive.set(color);
      m.emissiveIntensity = emissive;
    }
    m.userData.baseEmissive = m.emissive.clone();
    m.userData.baseIntensity = m.emissiveIntensity;
    this.materials.push(m);
    return m;
  }

  private mesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
    this.geometries.push(geo);
    return new THREE.Mesh(geo, mat);
  }

  /** Briefly flashes the whole model white (hit feedback). */
  hitFlash() {
    this.flash = 1;
  }

  update(dt: number, s: AnimState) {
    this.time += dt;
    const t = this.time;
    this.phase += dt * (4 + s.moveBlend * 8);
    const swing = Math.sin(this.phase) * 0.9 * s.moveBlend;

    // Reset pose.
    this.body.rotation.set(0, 0, 0);
    this.body.position.y = 0;
    this.leftArm.rotation.set(0, 0, 0.08);
    this.rightArm.rotation.set(0, 0, -0.08);

    if (s.flying) {
      this.body.rotation.x = 0.25 + s.moveBlend * 0.9;
      this.body.position.y = Math.sin(t * 2) * 0.08;
      this.leftLeg.rotation.x = 0.15 + Math.sin(t * 3) * 0.05;
      this.rightLeg.rotation.x = 0.25 + Math.sin(t * 3 + 1) * 0.05;
      if (s.moveBlend > 0.3) {
        this.rightArm.rotation.x = -Math.PI * 0.9;
        this.leftArm.rotation.x = 0.3;
      }
    } else if (s.airborne) {
      this.leftLeg.rotation.x = -0.6;
      this.rightLeg.rotation.x = 0.3;
      this.leftArm.rotation.z = 0.6;
      this.rightArm.rotation.z = -0.6;
    } else {
      this.leftLeg.rotation.x = swing;
      this.rightLeg.rotation.x = -swing;
      this.leftArm.rotation.x = -swing * 0.8;
      this.rightArm.rotation.x = swing * 0.8;
      this.body.position.y = Math.abs(Math.sin(this.phase)) * 0.06 * s.moveBlend + Math.sin(t * 2) * 0.01;
      this.body.rotation.x = s.moveBlend * 0.15;
    }

    if (s.attack >= 0) {
      // Wind back then punch forward.
      const arm = s.attackArm === 'right' ? this.rightArm : this.leftArm;
      const p = s.attack;
      // Positive x rotation swings the arm back; negative swings it forward (+Z).
      arm.rotation.x = p < 0.3 ? (p / 0.3) * 0.5 : 0.5 - ((p - 0.3) / 0.7) * 2.1;
      this.body.rotation.y = (s.attackArm === 'right' ? -1 : 1) * Math.sin(p * Math.PI) * 0.35;
    }
    if (s.cast >= 0) {
      const lift = Math.sin(Math.min(1, s.cast * 2) * Math.PI / 2);
      this.rightArm.rotation.x = -Math.PI / 2 * lift;
      this.leftArm.rotation.x = -Math.PI / 2 * lift;
      this.leftArm.rotation.z = 0.25;
      this.rightArm.rotation.z = -0.25;
    }

    if (this.cape) {
      this.cape.rotation.x = 0.1 + s.moveBlend * 0.7 + (s.flying ? 0.6 : 0) + Math.sin(t * 3) * 0.06;
    }
    if (this.aura) {
      const m = this.aura.material as THREE.MeshBasicMaterial;
      m.opacity = 0.1 + Math.sin(t * 4) * 0.04;
      this.aura.rotation.y = t;
    }

    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 6);
      for (const m of this.materials) {
        m.emissive.copy(m.userData.baseEmissive as THREE.Color).lerp(new THREE.Color(1, 1, 1), this.flash);
        m.emissiveIntensity = Math.max(m.userData.baseIntensity as number, this.flash * 1.5);
      }
    }
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    if (this.aura) (this.aura.material as THREE.Material).dispose();
  }
}
