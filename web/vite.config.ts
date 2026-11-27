import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO = 'Mkuz1/MKProd';

/** One version number for every platform: the VERSION file at the repository root. */
const VERSION = readFileSync(resolve(__dirname, '../VERSION'), 'utf8').trim();
/** Identifies this exact build (git commit), so running apps can tell a newer deploy apart. */
const BUILD = (() => {
  try { return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || String(Date.now()); } catch { return String(Date.now()); }
})();

/**
 * Writes dist/apps.json (download links of the native apps; their names are fixed by the
 * release workflows and the version is VERSION, so the links are known at build time and the
 * server never has to ask GitHub) and dist/version.json (what running apps poll for updates).
 */
function appsManifest(): Plugin {
  return {
    name: 'mkprod-apps-manifest',
    generateBundle() {
      const version = VERSION;
      const dl = (tag: string, name: string) => ({ name, url: `https://github.com/${REPO}/releases/download/${tag}/${name}` });
      const apps = [
        { platform: 'mac', version, page: `https://github.com/${REPO}/releases/tag/mac-v${version}`, assets: [dl(`mac-v${version}`, `MK-Prod-${version}-mac.dmg`), dl(`mac-v${version}`, `MK-Prod-${version}-mac.zip`)] },
        { platform: 'windows', version, page: `https://github.com/${REPO}/releases/tag/windows-v${version}`, assets: [dl(`windows-v${version}`, `MK-Prod-${version}-win-x64.exe`), dl(`windows-v${version}`, `MK-Prod-${version}-portable.exe`)] },
        { platform: 'android', version, page: `https://github.com/${REPO}/releases/tag/android-v${version}`, assets: [dl(`android-v${version}`, `MK-Prod-${version}-android.apk`)] },
        { platform: 'ios', version, page: `https://github.com/${REPO}/releases/tag/ios-v${version}`, assets: [dl(`ios-v${version}`, `MK-Prod-${version}-ios-unsigned.ipa`)] },
      ];
      this.emitFile({ type: 'asset', fileName: 'apps.json', source: JSON.stringify({ apps, releases: `https://github.com/${REPO}/releases`, version, build: BUILD }, null, 2) });
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version, build: BUILD, builtAt: new Date().toISOString() }) });
    },
  };
}

export default defineConfig({
  plugins: [react(), appsManifest()],
  define: { __APP_VERSION__: JSON.stringify(VERSION), __APP_BUILD__: JSON.stringify(BUILD) },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
