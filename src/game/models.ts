// Imported character models: loading (glTF/GLB and FBX, e.g. Mixamo and
// Quaternius exports), caching, animation-clip matching, retargeting external
// clips onto a rig, and an ImportedModel that plays the right clip for what the
// character is doing.

import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { MODEL_STATES, type Appearance, type ModelRef, type ModelState, type Universe } from '../core/types';
import { assetExt, defaultAssetStore, type AssetExt, type AssetStore } from './assets';
import { CharacterModel, type AnimState, type HeroModel } from './model';

export interface LoadedModel {
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
}

export const BUILTIN_MODELS = [
  { key: 'robot', name: 'Robot (Quaternius, CC0)', url: 'models/robot.glb' },
] as const;

// --- Clip matching -----------------------------------------------------------------

const PATTERNS: Record<ModelState, RegExp> = {
  idle: /idle|stand|breath/i,
  walk: /walk(?!.?jump)/i,
  run: /run|sprint|jog/i,
  jump: /jump|fall|air|leap/i,
  fly: /fly|flying|hover|swim/i,
  attack: /punch|attack|kick|slash|strike|melee|combo/i,
  cast: /cast|spell|magic|shoot|throw|fire|blast/i,
  hurt: /hurt|hit|damage|impact|react/i,
  death: /death|die|dying|dead/i,
};

/** Guesses which clip plays each state from clip names ("Idle", "Running", "mixamo Punch"...). */
export function autoMapClips(names: readonly string[]): Partial<Record<ModelState, string>> {
  const out: Partial<Record<ModelState, string>> = {};
  for (const state of MODEL_STATES) {
    let best: { name: string; score: number } | null = null;
    for (const name of names) {
      if (!PATTERNS[state].test(name)) continue;
      const n = name.toLowerCase();
      const score = n === state ? 3 : n.startsWith(state) ? 2 : 1;
      if (!best || score > best.score) best = { name, score };
    }
    if (best) out[state] = best.name;
  }
  return out;
}

const boneKey = (s: string) => s.toLowerCase().replace(/^.*mixamorig[:_]?/, '').replace(/[^a-z0-9]/g, '');

/**
 * Binds a clip from another file onto this rig. Mixamo files name bones
 * "mixamorig:Hips" or "mixamorigHips" depending on the exporter, so tracks
 * are matched by a normalized bone name. Tracks for unknown bones are dropped,
 * and root motion is removed so animations play in place.
 */
export function retargetClip(clip: THREE.AnimationClip, root: THREE.Object3D, keepRootMotion = false): THREE.AnimationClip {
  const byKey = new Map<string, string>();
  root.traverse((o) => {
    if (o.name) byKey.set(boneKey(o.name), o.name);
  });
  const tracks: THREE.KeyframeTrack[] = [];
  for (const t of clip.tracks) {
    const dot = t.name.lastIndexOf('.');
    const node = t.name.slice(0, dot);
    const prop = t.name.slice(dot + 1);
    const target = root.getObjectByName(node) ? node : byKey.get(boneKey(node));
    if (!target) continue;
    if (!keepRootMotion && prop === 'position' && boneKey(target) === 'hips') continue;
    const copy = t.clone();
    copy.name = `${target}.${prop}`;
    tracks.push(copy);
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

// --- Loading -----------------------------------------------------------------------

function sniffExt(data: ArrayBuffer): AssetExt | null {
  const head = new TextDecoder().decode(new Uint8Array(data, 0, Math.min(20, data.byteLength)));
  if (head.startsWith('glTF')) return 'glb';
  if (head.startsWith('Kaydara FBX')) return 'fbx';
  if (head.trimStart().startsWith('{')) return 'gltf';
  return null;
}

export async function parseModel(data: ArrayBuffer, ext: AssetExt | null): Promise<LoadedModel> {
  const kind = sniffExt(data) ?? ext;
  if (kind === 'fbx') {
    const group = new FBXLoader().parse(data, '');
    return { scene: group, clips: group.animations };
  }
  if (kind === 'glb' || kind === 'gltf') {
    const gltf = await new GLTFLoader().parseAsync(data, '');
    return { scene: gltf.scene, clips: gltf.animations };
  }
  throw new Error('Unsupported file. Use .glb, .gltf (embedded), or .fbx.');
}

export class ModelLibrary {
  private pending = new Map<string, Promise<LoadedModel>>();
  private loaded = new Map<string, LoadedModel>();
  private failed = new Map<string, string>();

  constructor(
    readonly assets: AssetStore,
    /** Fetches URLs (and built-in models); injectable for tests. */
    private readonly fetchBytes: (url: string) => Promise<ArrayBuffer> = async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      return res.arrayBuffer();
    },
  ) {}

  /** Loads (once) and caches a model or animation source. */
  load(src: string): Promise<LoadedModel> {
    let p = this.pending.get(src);
    if (!p) {
      p = this.read(src)
        .then(({ data, ext }) => parseModel(data, ext))
        .then((m) => {
          this.loaded.set(src, m);
          return m;
        })
        .catch((e: unknown) => {
          this.failed.set(src, e instanceof Error ? e.message : String(e));
          this.pending.delete(src);
          throw e;
        });
      this.pending.set(src, p);
    }
    return p;
  }

  private async read(src: string): Promise<{ data: ArrayBuffer; ext: AssetExt | null }> {
    if (src.startsWith('asset:')) {
      const a = await this.assets.get(src.slice(6));
      if (!a) throw new Error('That model file is not in this browser. Import it again on this device.');
      return { data: a.data, ext: a.meta.ext };
    }
    if (src.startsWith('builtin:')) {
      const b = BUILTIN_MODELS.find((m) => `builtin:${m.key}` === src);
      if (!b) throw new Error('Unknown built-in model.');
      return { data: await this.fetchBytes(b.url), ext: assetExt(b.url) };
    }
    return { data: await this.fetchBytes(src), ext: assetExt(src) };
  }

  /** Synchronous access once loaded (actors are built synchronously). */
  ready(src: string): LoadedModel | undefined {
    return this.loaded.get(src);
  }

  error(src: string): string | undefined {
    return this.failed.get(src);
  }

  /** Every source an appearance needs: the model plus external animation files. */
  sources(ref: ModelRef): string[] {
    return [ref.src, ...Object.values(ref.clips).filter((v): v is string => !!v && !v.startsWith('clip:'))];
  }

  isReady(ref: ModelRef): boolean {
    return this.sources(ref).every((s) => this.loaded.has(s));
  }

  /** Loads everything one appearance needs. Resolves to an error message, if any. */
  async preload(app: Appearance): Promise<string | null> {
    if (!app.model) return null;
    const results = await Promise.allSettled(this.sources(app.model).map((s) => this.load(s)));
    const bad = results.find((r) => r.status === 'rejected');
    return bad ? String((bad as PromiseRejectedResult).reason?.message ?? bad) : null;
  }

  /** Loads every model a universe uses; returns the aliases whose models failed. */
  async preloadUniverse(u: Universe): Promise<string[]> {
    const failures: string[] = [];
    await Promise.all(u.characters.filter((c) => c.appearance.model).map(async (c) => {
      if (await this.preload(c.appearance)) failures.push(c.alias);
    }));
    return failures;
  }
}

export const modelLibrary = new ModelLibrary(defaultAssetStore());

// --- The model itself ---------------------------------------------------------------

const LOOPING: ReadonlySet<ModelState> = new Set(['idle', 'walk', 'run', 'fly']);

/** An imported, animated character that stands in for the procedural body. */
export class ImportedModel implements HeroModel {
  readonly root = new THREE.Group();
  readonly height: number;
  readonly animatesDeath: boolean;
  readonly clipNames: Partial<Record<ModelState, string>> = {};
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<ModelState, THREE.AnimationAction>();
  private readonly materials: THREE.Material[] = [];
  private current: ModelState | null = null;
  private flash = 0;
  private hurt = 0;

  constructor(model: LoadedModel, ref: ModelRef, app: Appearance, external: (src: string) => LoadedModel | undefined) {
    const inner = cloneSkinned(model.scene);
    this.height = 1.9 * app.height * ref.scale;

    // Fit to the character's height with feet on the ground, facing +Z.
    inner.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(inner, true);
    const size = box.getSize(new THREE.Vector3());
    const fit = size.y > 1e-6 ? this.height / size.y : 1;
    inner.scale.multiplyScalar(fit);
    inner.position.y -= box.min.y * fit;
    const holder = new THREE.Group();
    holder.rotation.y = THREE.MathUtils.degToRad(ref.yaw);
    holder.add(inner);
    this.root.add(holder);

    const tint = new THREE.Color(app.primary);
    inner.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) mesh.frustumCulled = false;
      const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => {
        const c = m.clone();
        const colored = c as THREE.MeshStandardMaterial;
        if (ref.tint && colored.color) colored.color.lerp(tint, 0.55);
        if (colored.emissive) c.userData.baseEmissive = colored.emissive.clone();
        this.materials.push(c);
        return c;
      });
      mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
    });

    // Resolve clips: explicit overrides first, then name-based guesses.
    this.mixer = new THREE.AnimationMixer(inner);
    const auto = autoMapClips(model.clips.map((c) => c.name));
    for (const state of MODEL_STATES) {
      const override = ref.clips[state];
      let clip: THREE.AnimationClip | undefined;
      if (override?.startsWith('clip:')) clip = model.clips.find((c) => c.name === override.slice(5));
      else if (override) {
        const ext = external(override)?.clips[0];
        if (ext) clip = retargetClip(ext, inner, state === 'death' || state === 'jump');
      }
      clip ??= model.clips.find((c) => c.name === auto[state]);
      if (!clip) continue;
      const action = this.mixer.clipAction(clip);
      if (!LOOPING.has(state)) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(state, action);
      this.clipNames[state] = clip.name;
    }
    this.animatesDeath = this.actions.has('death');
    this.play('idle');
  }

  /** Which clip-backed state is playing (for tests and debugging). */
  get state(): ModelState | null {
    return this.current;
  }

  private pick(s: AnimState): ModelState {
    const has = (x: ModelState) => this.actions.has(x);
    if (s.dead) return 'death';
    if (s.flying) return has('fly') ? 'fly' : has('jump') ? 'jump' : 'idle';
    if (s.attack >= 0) return 'attack';
    if (s.cast >= 0) return has('cast') ? 'cast' : 'attack';
    if (s.airborne) return 'jump';
    if (this.hurt > 0 && has('hurt')) return 'hurt';
    if (s.moveBlend > 0.55) return has('run') ? 'run' : 'walk';
    if (s.moveBlend > 0.08) return has('walk') ? 'walk' : 'run';
    return 'idle';
  }

  private play(state: ModelState) {
    const next = this.actions.get(state) ?? this.actions.get('idle');
    if (!next || state === this.current) return;
    const prev = this.current ? this.actions.get(this.current) : undefined;
    next.reset().setEffectiveWeight(1).fadeIn(0.15).play();
    if (prev && prev !== next) prev.fadeOut(0.15);
    this.current = state;
  }

  update(dt: number, s: AnimState) {
    this.hurt = Math.max(0, this.hurt - dt);
    const state = this.pick(s);
    // One-shot clips (attack, cast) restart for each new swing.
    if (state === this.current && !LOOPING.has(state) && state !== 'death') {
      const a = this.actions.get(state);
      if (a && !a.isRunning() && (s.attack >= 0 ? s.attack < 0.2 : s.cast >= 0 && s.cast < 0.2)) a.reset().play();
    }
    this.play(state);
    const run = this.actions.get('run');
    if (run && this.current === 'run') run.timeScale = 0.8 + s.moveBlend * 0.4;
    this.mixer.update(dt);

    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 6);
      for (const m of this.materials) {
        const e = (m as THREE.MeshStandardMaterial).emissive;
        if (e) e.copy(m.userData.baseEmissive as THREE.Color).lerp(new THREE.Color(1, 1, 1), this.flash);
      }
    }
  }

  hitFlash() {
    this.flash = 1;
    if (this.current !== 'hurt') this.hurt = 0.35;
  }

  setOpacity(alpha: number) {
    for (const m of this.materials) {
      m.transparent = alpha < 1;
      m.opacity = alpha;
      m.depthWrite = alpha >= 1;
    }
  }

  dispose() {
    this.mixer.stopAllAction();
    for (const m of this.materials) m.dispose();
  }
}

/**
 * The model for an appearance: the imported model once it's loaded (see
 * ModelLibrary.preload), otherwise the procedural body.
 */
export function createHeroModel(app: Appearance, lib: ModelLibrary = modelLibrary): HeroModel {
  const ref = app.model;
  const loaded = ref && lib.isReady(ref) ? lib.ready(ref.src) : undefined;
  if (ref && loaded) {
    try {
      return new ImportedModel(loaded, ref, app, (src) => lib.ready(src));
    } catch (e) {
      console.warn('Imported model failed; using the procedural body.', e);
    }
  }
  return new CharacterModel(app);
}
