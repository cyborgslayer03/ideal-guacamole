// Live 3D character preview for the creator. A single instance is reused so
// switching characters never leaks WebGL contexts.

import * as THREE from 'three';
import type { Appearance } from '../core/types';
import { idleAnim, type HeroModel } from '../game/model';
import { createHeroModel, modelLibrary } from '../game/models';

class CharacterPreview {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  private model: HeroModel | null = null;
  private request = 0;
  /** Called when an imported model finishes loading or fails (for status text). */
  onModelStatus: ((error: string | null) => void) | null = null;
  private readonly pedestal: THREE.Mesh;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private frame = 0;
  private last = 0;
  private spin = 0.6;
  private yaw = 0;
  private dragging = false;
  private lastX = 0;
  private running = false;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'preview-canvas';

    this.scene.add(new THREE.HemisphereLight('#bcd4ff', '#20142a', 1.4));
    const key = new THREE.DirectionalLight('#ffffff', 2.4);
    key.position.set(2, 4, 3);
    const rim = new THREE.DirectionalLight('#3ee8ff', 2);
    rim.position.set(-3, 2, -3);
    this.scene.add(key, rim);

    this.pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 1, 0.12, 48),
      new THREE.MeshStandardMaterial({ color: '#141a2e', metalness: 0.6, roughness: 0.4 }),
    );
    this.pedestal.position.y = -0.06;
    this.ringMat = new THREE.MeshBasicMaterial({ color: '#3ee8ff', transparent: true, opacity: 0.8 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.015, 8, 64), this.ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.01;
    this.scene.add(this.pedestal, ring);

    this.camera.position.set(0, 1.3, 5.2);
    this.camera.lookAt(0, 1, 0);

    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.yaw += (e.clientX - this.lastX) * 0.01;
      this.lastX = e.clientX;
    });
    this.canvas.addEventListener('pointerup', () => (this.dragging = false));
    this.tick = this.tick.bind(this);
  }

  setAppearance(app: Appearance, accent: string) {
    this.ringMat.color.set(accent);
    const req = ++this.request;
    this.show(createHeroModel(app));
    // Imported models load in the background; swap them in when ready.
    if (app.model && !modelLibrary.isReady(app.model)) {
      const snapshot = structuredClone(app);
      void modelLibrary.preload(snapshot).then((err) => {
        if (req !== this.request) return;
        if (!err) this.show(createHeroModel(snapshot));
        this.onModelStatus?.(err);
      });
    } else this.onModelStatus?.(null);
  }

  private show(model: HeroModel) {
    if (this.model) {
      this.scene.remove(this.model.root);
      this.model.dispose();
    }
    this.model = model;
    this.scene.add(model.root);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  private tick(now: number) {
    if (!this.running) return;
    this.frame = requestAnimationFrame(this.tick);
    if (!this.canvas.isConnected) return this.stop();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const w = this.canvas.clientWidth;
    const hgt = this.canvas.clientHeight;
    if (w && hgt && (this.canvas.width !== Math.floor(w * this.renderer.getPixelRatio()) || this.canvas.height !== Math.floor(hgt * this.renderer.getPixelRatio()))) {
      this.renderer.setSize(w, hgt, false);
      this.camera.aspect = w / hgt;
      this.camera.updateProjectionMatrix();
    }
    if (!this.dragging) this.yaw += dt * this.spin;
    if (this.model) {
      this.model.root.rotation.y = this.yaw;
      this.model.update(dt, idleAnim());
    }
    this.renderer.render(this.scene, this.camera);
  }
}

let instance: CharacterPreview | null = null;

export function getPreview(): CharacterPreview {
  instance ??= new CharacterPreview();
  return instance;
}
