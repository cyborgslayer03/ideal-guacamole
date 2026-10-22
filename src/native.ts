// Bridges to the Android app shell (Capacitor). In a browser every function
// here is a no-op or falls back to web behavior.

import { Capacitor } from '@capacitor/core';

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * The Multiverse Hub address for builds that aren't served by the hub itself
 * (the Android app). Set VITE_HUB_URL at build time, e.g.
 * VITE_HUB_URL=https://omniverse-forge.onrender.com/api npm run build
 */
export const BUILT_IN_HUB_URL: string = (import.meta.env.VITE_HUB_URL as string | undefined) ?? '';

/**
 * Routes the Android back button. `onBack` returns true if it handled the
 * press (closed a dialog, paused, went up a screen); otherwise the app exits.
 */
export async function setupBackButton(onBack: () => boolean): Promise<void> {
  if (!isNative()) return;
  const { App } = await import('@capacitor/app');
  await App.addListener('backButton', () => {
    if (!onBack()) void App.exitApp();
  });
}

/** Saves a generated file on Android: writes it to the cache and opens the share sheet (Save to Files, Drive, Photos...). */
export async function shareFile(filename: string, data: Blob | string): Promise<void> {
  const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
  const written = typeof data === 'string'
    ? await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache, encoding: Encoding.UTF8 })
    : await Filesystem.writeFile({ path: filename, data: await toBase64(data), directory: Directory.Cache });
  await Share.share({ title: filename, files: [written.uri] });
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
