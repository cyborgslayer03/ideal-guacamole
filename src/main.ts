import './styles.css';
import { MemoryStore, type KeyValueStore } from './core/storage';
import { App } from './ui/app';

/** Browser storage, or an in-memory fallback when the browser blocks it (private windows, sandboxed embeds). */
function pickStore(): KeyValueStore {
  try {
    const ls = window.localStorage;
    const probe = 'of:probe';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return new MemoryStore();
  }
}

const root = document.getElementById('app');
if (root) new App(root, pickStore()).start();
