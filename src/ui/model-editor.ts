// The "3D model" section of the character editor: swap the procedural body for
// an imported Mixamo / Quaternius (or any glTF/FBX) model, and choose which
// animation clip plays for each action.

import { MODEL_STATES, type Character, type ModelRef, type ModelState } from '../core/types';
import { assetExt, type StoredAsset } from '../game/assets';
import { BUILTIN_MODELS, autoMapClips, modelLibrary } from '../game/models';
import type { EditorContext } from './context';
import { h, pickBinaryFile, setChildren, toast } from './dom';
import { checkbox, field, section, select, slider } from './forms';
import { getPreview } from './preview';
import { promptDialog } from './overlay';

const STATE_LABELS: Record<ModelState, string> = {
  idle: 'Idle', walk: 'Walk', run: 'Run', jump: 'Jump', fly: 'Fly', attack: 'Attack', cast: 'Power', hurt: 'Hurt', death: 'Death',
};

const MAX_FILE = 60 * 1024 * 1024;

export function newModelRef(src: string): ModelRef {
  return { src, scale: 1, yaw: 0, tint: false, clips: {} };
}

/** Human label for a model source. */
export function describeSource(src: string, assets: StoredAsset[]): string {
  if (src.startsWith('builtin:')) return BUILTIN_MODELS.find((b) => `builtin:${b.key}` === src)?.name ?? src;
  if (src.startsWith('asset:')) return assets.find((a) => a.id === src.slice(6))?.name ?? 'Imported file (not on this device)';
  return src.replace(/^https:\/\//, '').slice(0, 60);
}

async function importFile(): Promise<StoredAsset | null> {
  const file = await pickBinaryFile('.glb,.gltf,.fbx');
  if (!file) return null;
  const ext = assetExt(file.name);
  if (!ext) {
    toast('Use a .glb, .gltf, or .fbx file.', 'error');
    return null;
  }
  if (file.data.byteLength > MAX_FILE) {
    toast('That file is over 60 MB. Try a lighter export.', 'error');
    return null;
  }
  return modelLibrary.assets.put(file.name, ext, file.data);
}

export function modelSection(ctx: EditorContext, c: Character, appearanceChanged: () => void): HTMLElement {
  const body = h('div');
  const status = h('div', { class: 'model-status' });
  let assets: StoredAsset[] = [];
  let renderedReady: string | null = null;
  const preview = getPreview();
  preview.onModelStatus = (err) => {
    status.className = `model-status${err ? ' error' : ''}`;
    const ref = c.appearance.model;
    if (err) status.textContent = `Couldn't load: ${err} The built-in body is shown instead.`;
    else if (ref && modelLibrary.isReady(ref)) {
      const clips = modelLibrary.ready(ref.src)?.clips.length ?? 0;
      status.textContent = `Loaded · ${clips} animation clip${clips === 1 ? '' : 's'} in the file`;
    } else status.textContent = ref ? 'Loading…' : '';
    // Rebuild only when the clip list becomes available (not on every slider tick).
    if (ref && !err && renderedReady !== ref.src && modelLibrary.isReady(ref)) renderBody();
  };

  const setRef = (ref: ModelRef | null) => {
    c.appearance.model = ref;
    appearanceChanged();
    renderBody();
  };

  const sourcePicker = () => {
    const ref = c.appearance.model;
    const options = [
      { value: '', label: 'Procedural body (costume above)' },
      ...BUILTIN_MODELS.map((b) => ({ value: `builtin:${b.key}`, label: b.name })),
      ...assets.map((a) => ({ value: `asset:${a.id}`, label: `${a.name} (imported)` })),
      ...(ref && !ref.src.startsWith('builtin:') && !ref.src.startsWith('asset:') ? [{ value: ref.src, label: describeSource(ref.src, assets) }] : []),
      ...(ref?.src.startsWith('asset:') && !assets.some((a) => `asset:${a.id}` === ref.src) ? [{ value: ref.src, label: describeSource(ref.src, assets) }] : []),
    ];
    return h('div', { class: 'row' },
      select(options, () => ref?.src ?? '', (v) => setRef(v ? { ...(ref ?? newModelRef(v)), src: v, clips: {} } : null)),
      h('button', {
        class: 'btn small',
        onclick: async () => {
          const a = await importFile().catch(() => (toast('Could not store that file.', 'error'), null));
          if (!a) return;
          assets = await modelLibrary.assets.list();
          setRef({ ...newModelRef(`asset:${a.id}`), tint: false });
          toast(`Imported ${a.name}`);
        },
      }, '⬆ Import .glb / .fbx'),
      h('button', {
        class: 'btn small',
        onclick: async () => {
          const url = await promptDialog('Model from a link', 'Link to a .glb, .gltf, or .fbx file. It must start with https:// and the server must allow cross-origin downloads.', 'https://…/hero.glb', 'Use model');
          if (!url) return;
          if (!/^https:\/\/\S+$/.test(url.trim())) return toast('Links must start with https://', 'error');
          setRef(newModelRef(url.trim()));
        },
      }, '🔗 From link'),
    );
  };

  const clipEditor = (ref: ModelRef) => {
    const loaded = modelLibrary.ready(ref.src);
    if (!loaded) return h('p', { class: 'muted small' }, 'Animation choices appear once the model loads.');
    const names = loaded.clips.map((x) => x.name);
    const auto = autoMapClips(names);
    const external = assets.map((a) => ({ value: `asset:${a.id}`, label: `File: ${a.name}` }));
    return h('div', { class: 'clip-grid' }, ...MODEL_STATES.map((state) => {
      const current = ref.clips[state] ?? '';
      const opts = [
        { value: '', label: auto[state] ? `Auto: ${auto[state]}` : 'Auto: none' },
        ...names.map((n) => ({ value: `clip:${n}`, label: n })),
        ...external,
        ...(current && !current.startsWith('clip:') && !external.some((e) => e.value === current) ? [{ value: current, label: describeSource(current, assets) }] : []),
      ];
      return h('div', { class: 'clip-row' },
        h('span', null, STATE_LABELS[state]),
        select(opts, () => current, (v) => {
          if (v) ref.clips[state] = v;
          else delete ref.clips[state];
          appearanceChanged();
        }),
        h('button', {
          class: 'icon-btn',
          title: `Import an animation file for ${STATE_LABELS[state]} (e.g. a Mixamo FBX exported "without skin")`,
          onclick: async () => {
            const a = await importFile();
            if (!a) return;
            assets = await modelLibrary.assets.list();
            ref.clips[state] = `asset:${a.id}`;
            appearanceChanged();
            renderBody();
          },
        }, '⬆'),
      );
    }));
  };

  const renderBody = () => {
    const ref = c.appearance.model;
    renderedReady = ref && modelLibrary.isReady(ref) ? ref.src : null;
    setChildren(body,
      sourcePicker(),
      status,
      ref && h('div', { class: 'grid-3' },
        field('Size', slider(() => ref.scale, (v) => ((ref.scale = v), appearanceChanged()), 0.3, 3, 0.05, (v) => `${Math.round(v * 100)}%`)),
        field('Facing', slider(() => ref.yaw, (v) => ((ref.yaw = v), appearanceChanged()), -180, 180, 15, (v) => `${v}°`), 'Turn it if the model faces sideways or backwards.'),
        field('Colors', checkbox(() => ref.tint, (v) => ((ref.tint = v), appearanceChanged()), 'Tint with costume primary')),
      ),
      ref && field('Animations', clipEditor(ref)),
      ref?.src.startsWith('asset:') && h('p', { class: 'warn small' }, 'Imported files stay in this browser. Shared or exported copies of this character use the built-in body unless they also have the file; use a built-in model or a link to share the look.'),
      !ctx.quick && h('details', { class: 'help' },
        h('summary', null, 'Where to get models'),
        h('p', null, h('b', null, 'Quaternius'), ' (quaternius.com) makes free CC0 characters that already include Idle / Walk / Run / Punch / Death clips. Download the glTF or FBX version and import the .glb or .fbx; the animations are matched automatically.'),
        h('p', null, h('b', null, 'Mixamo'), ' (mixamo.com, free with an Adobe account):'),
        h('ol', null,
          h('li', null, 'Pick or upload a character and download it as FBX "With Skin" (any pose). Import that file here.'),
          h('li', null, 'For each animation you want (Idle, Running, Punching, Flying, Dying...), download FBX "Without Skin" with "In Place" checked.'),
          h('li', null, 'Import each one with the ⬆ button next to the action it should play. Mixamo bone names are matched for you.'),
        ),
        h('p', null, 'Any rigged .glb / .gltf (embedded) / .fbx works. Keep files under 60 MB; lighter models run better on phones.'),
      ),
    );
  };

  renderBody();
  void modelLibrary.assets.list().then((list) => {
    assets = list;
    renderBody();
  });
  return section('3D model', body);
}
