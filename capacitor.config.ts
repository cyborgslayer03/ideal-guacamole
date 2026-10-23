import type { CapacitorConfig } from '@capacitor/cli';

// Native Android app: the built web game (dist/) runs inside a native shell.
// The appId is the app's permanent identity on the Play Store.
const config: CapacitorConfig = {
  appId: 'com.omniverseforge.game',
  appName: 'Omniverse Forge',
  webDir: 'dist',
  android: {
    backgroundColor: '#060914',
  },
};

export default config;
