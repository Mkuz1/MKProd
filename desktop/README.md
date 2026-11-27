# MK Prod for Windows (desktop shell)

A small Electron window around the web app. Every feature comes from the site, so there is
nothing to keep in step: the `.exe` always shows the current deployment.

## Get the .exe

GitHub builds it automatically on Windows machines whenever this folder changes:
**github.com/Mkuz1/MKProd → Releases → "MK Prod for Windows"**.

- `MK-Prod-<version>-win-x64.exe`: one-click setup for the current user (no admin rights),
  Start-menu and desktop shortcuts.
- `MK-Prod-<version>-portable.exe`: no installation, runs from anywhere.

Windows SmartScreen warns about unsigned downloads the first time ("More info → Run anyway").
A code-signing certificate (≈ $200–400/year from DigiCert, Sectigo…) removes that warning;
add it as the `CSC_LINK`/`CSC_KEY_PASSWORD` secrets and the workflow signs automatically.

## Build locally (on a Windows PC)

```bash
cd desktop
npm install
npm run build:win        # dist/MK-Prod-<version>-win-x64.exe and -portable.exe
```

`npm start` runs it unpackaged. `MKPROD_URL=http://127.0.0.1:8787/ npm start` points it at a
local server.

## Releasing a new version

Bump `version` in `package.json` and push; the workflow publishes a new release.
