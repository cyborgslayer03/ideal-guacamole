// Imported 3D files (models and animation clips) live in IndexedDB: they're
// far too big for localStorage. Tests and browsers without IndexedDB use the
// in-memory store.

import { newId } from '../core/id';

export type AssetExt = 'glb' | 'gltf' | 'fbx';

export interface StoredAsset {
  id: string;
  name: string;
  ext: AssetExt;
  size: number;
  createdAt: number;
}

export interface AssetStore {
  put(name: string, ext: AssetExt, data: ArrayBuffer): Promise<StoredAsset>;
  get(id: string): Promise<{ meta: StoredAsset; data: ArrayBuffer } | null>;
  list(): Promise<StoredAsset[]>;
  remove(id: string): Promise<void>;
}

/** File extension from a name or URL, if it's a format we can load. */
export function assetExt(name: string): AssetExt | null {
  const m = /\.(glb|gltf|fbx)(?:[?#].*)?$/i.exec(name);
  return m ? (m[1].toLowerCase() as AssetExt) : null;
}

export class MemoryAssetStore implements AssetStore {
  private items = new Map<string, { meta: StoredAsset; data: ArrayBuffer }>();

  async put(name: string, ext: AssetExt, data: ArrayBuffer) {
    const meta: StoredAsset = { id: newId('ast'), name, ext, size: data.byteLength, createdAt: Date.now() };
    this.items.set(meta.id, { meta, data });
    return meta;
  }

  async get(id: string) {
    return this.items.get(id) ?? null;
  }

  async list() {
    return [...this.items.values()].map((x) => x.meta).sort((a, b) => b.createdAt - a.createdAt);
  }

  async remove(id: string) {
    this.items.delete(id);
  }
}

const DB_NAME = 'omniverse-forge-assets';
const STORE = 'files';

export class IdbAssetStore implements AssetStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'meta.id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async put(name: string, ext: AssetExt, data: ArrayBuffer) {
    const meta: StoredAsset = { id: newId('ast'), name, ext, size: data.byteLength, createdAt: Date.now() };
    await this.run('readwrite', (s) => s.put({ meta, data }));
    return meta;
  }

  async get(id: string) {
    return ((await this.run('readonly', (s) => s.get(id))) as { meta: StoredAsset; data: ArrayBuffer } | undefined) ?? null;
  }

  async list() {
    const all = (await this.run('readonly', (s) => s.getAll())) as { meta: StoredAsset }[];
    return all.map((x) => x.meta).sort((a, b) => b.createdAt - a.createdAt);
  }

  async remove(id: string) {
    await this.run('readwrite', (s) => s.delete(id));
  }
}

export function defaultAssetStore(): AssetStore {
  try {
    if (typeof indexedDB !== 'undefined') return new IdbAssetStore();
  } catch {
    // Some sandboxed frames throw on access.
  }
  return new MemoryAssetStore();
}
