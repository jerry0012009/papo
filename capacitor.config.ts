import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'top.jerrypsy.papo',
  appName: 'Papo',
  webDir: 'dist',
  server: {
    url: 'https://eu.jerrypsy.top/papo',
    cleartext: false,
    androidScheme: 'https'
  }
};

export default config;
