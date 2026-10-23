import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { randomAppearance } from '../src/core/generator';
import { Rng } from '../src/core/rng';
import { normalizeUniverse } from '../src/core/validate';
import { MemoryAssetStore, assetExt } from '../src/game/assets';
import { idleAnim } from '../src/game/model';
import { CharacterModel } from '../src/game/model';
import { ImportedModel, ModelLibrary, autoMapClips, createHeroModel, retargetClip } from '../src/game/models';

const robot = readFileSync('public/models/robot.glb');
const bytes = () => robot.buffer.slice(robot.byteOffset, robot.byteOffset + robot.byteLength) as ArrayBuffer;
const library = () => new ModelLibrary(new MemoryAssetStore(), async (url) => {
  if (url === 'models/robot.glb' || url === 'https://example.com/robot.glb') return bytes();
  throw new Error('404');
});
const look = (src: string) => ({ ...randomAppearance(new Rng(1)), model: { src, scale: 1, yaw: 0, tint: true, clips: {} } });

describe('clip matching', () => {
  it('maps Quaternius and Mixamo style names to actions', () => {
    const m = autoMapClips(['Dance', 'Death', 'Idle', 'Jump', 'Punch', 'Running', 'Walking', 'WalkJump', 'Wave']);
    expect(m).toMatchObject({ idle: 'Idle', walk: 'Walking', run: 'Running', jump: 'Jump', attack: 'Punch', death: 'Death' });
    expect(m.fly).toBeUndefined();
    expect(autoMapClips(['mixamo.com|Flying', 'Standing Idle', 'Fast Run']).fly).toBe('mixamo.com|Flying');
  });

  it('retargets Mixamo bone names and strips root motion', () => {
    const rig = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'mixamorigHips';
    const arm = new THREE.Bone();
    arm.name = 'mixamorigLeftArm';
    rig.add(hips);
    hips.add(arm);
    const clip = new THREE.AnimationClip('Run', 1, [
      new THREE.VectorKeyframeTrack('mixamorig:Hips.position', [0, 1], [0, 0, 0, 0, 0, 5]),
      new THREE.QuaternionKeyframeTrack('mixamorig:Hips.quaternion', [0], [0, 0, 0, 1]),
      new THREE.QuaternionKeyframeTrack('mixamorig:LeftArm.quaternion', [0], [0, 0, 0, 1]),
      new THREE.QuaternionKeyframeTrack('Tail.quaternion', [0], [0, 0, 0, 1]),
    ]);
    const out = retargetClip(clip, rig);
    expect(out.tracks.map((t) => t.name).sort()).toEqual(['mixamorigHips.quaternion', 'mixamorigLeftArm.quaternion']);
    expect(retargetClip(clip, rig, true).tracks.some((t) => t.name === 'mixamorigHips.position')).toBe(true);
  });

  it('knows which files it can load', () => {
    expect(assetExt('Hero.FBX')).toBe('fbx');
    expect(assetExt('https://x.dev/a.glb?v=2')).toBe('glb');
    expect(assetExt('notes.txt')).toBeNull();
  });
});

describe('model library', () => {
  it('loads the built-in Quaternius robot and plays the right clips', async () => {
    const lib = library();
    const app = look('builtin:robot');
    expect(await lib.preload(app)).toBeNull();
    const model = createHeroModel(app, lib);
    expect(model).toBeInstanceOf(ImportedModel);
    const m = model as ImportedModel;
    expect(m.animatesDeath).toBe(true);
    expect(m.clipNames).toMatchObject({ idle: 'Idle', run: 'Running', attack: 'Punch', death: 'Death' });

    // Fitted to the character's height with feet on the ground.
    const box = new THREE.Box3().setFromObject(m.root, true);
    expect(box.min.y).toBeCloseTo(0, 1);
    expect(box.max.y - box.min.y).toBeCloseTo(m.height, 0);

    const s = idleAnim();
    m.update(0.1, s);
    expect(m.state).toBe('idle');
    m.update(0.1, { ...s, moveBlend: 1 });
    expect(m.state).toBe('run');
    m.update(0.1, { ...s, attack: 0.1 });
    expect(m.state).toBe('attack');
    m.update(0.1, { ...s, flying: true });
    expect(m.state).toBe('jump'); // no fly clip: falls back to the jump pose
    m.update(0.1, { ...s, dead: true });
    expect(m.state).toBe('death');
    m.setOpacity(0.4);
    m.hitFlash();
    m.update(0.1, s);
    m.dispose();
  });

  it('loads imported assets and links, and honors clip overrides', async () => {
    const lib = library();
    const asset = await lib.assets.put('robot.glb', 'glb', bytes());
    const app = look(`asset:${asset.id}`);
    app.model.clips = { idle: 'clip:Dance', attack: `asset:${asset.id}` };
    expect(await lib.preload(app)).toBeNull();
    const m = createHeroModel(app, lib) as ImportedModel;
    expect(m.clipNames.idle).toBe('Dance');
    expect(m.clipNames.attack).toBeDefined(); // first clip of the external file, retargeted
    expect(await lib.preload(look('https://example.com/robot.glb'))).toBeNull();
  });

  it('falls back to the procedural body when a model is missing or broken', async () => {
    const lib = library();
    const missing = look('asset:nope');
    expect(await lib.preload(missing)).toMatch(/not in this browser/);
    expect(createHeroModel(missing, lib)).toBeInstanceOf(CharacterModel);
    expect(await lib.preload(look('https://example.com/gone.glb'))).toMatch(/404/);
    await lib.assets.put('junk.glb', 'glb', new TextEncoder().encode('garbage').buffer as ArrayBuffer);
    const junk = (await lib.assets.list())[0];
    expect(await lib.preload(look(`asset:${junk.id}`))).toBeTruthy();
    // Not loaded yet: procedural until preload finishes.
    expect(createHeroModel(look('builtin:robot'), lib)).toBeInstanceOf(CharacterModel);
  });

  it('reports which characters failed when preloading a universe', async () => {
    const u = normalizeUniverse({ characters: [
      { alias: 'Bot', appearance: look('builtin:robot') },
      { alias: 'Ghost', appearance: look('asset:missing') },
      { alias: 'Plain' },
    ] });
    expect(await library().preloadUniverse(u)).toEqual(['Ghost']);
  });
});

describe('model validation', () => {
  it('keeps safe model references and drops anything else', () => {
    const u = normalizeUniverse({ characters: [
      { appearance: { model: { src: 'builtin:robot', scale: 99, yaw: 720, tint: 1, clips: { idle: 'clip:Idle', bogus: 'x', run: 'javascript:alert(1)' } } } },
      { appearance: { model: { src: 'http://insecure.dev/a.glb' } } },
      { appearance: { model: 'nope' } },
    ] });
    const ref = u.characters[0].appearance.model!;
    expect(ref.src).toBe('builtin:robot');
    expect(ref.scale).toBe(3);
    expect(Math.abs(ref.yaw)).toBeLessThanOrEqual(180);
    expect(ref.clips).toEqual({ idle: 'clip:Idle' });
    expect(u.characters[1].appearance.model).toBeNull();
    expect(u.characters[2].appearance.model).toBeNull();
  });
});
