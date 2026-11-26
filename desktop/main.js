// MK Prod for Windows: a thin, locked-down window around the web app. All features live on
// the site (https://mkprod.mk-uz02.workers.dev); this shell adds its own window, Start-menu
// entry, taskbar icon and desktop notifications. It has no access to the file system beyond
// what a browser has: the page runs sandboxed with Node integration off.
const { app, BrowserWindow, shell, Menu, session } = require('electron');
const path = require('path');

const APP_URL = process.env.MKPROD_URL || 'https://mkprod.mk-uz02.workers.dev/';
const ORIGIN = new URL(APP_URL).origin;

app.setAppUserModelId('com.mkoussa.mkprod'); // Windows notifications show "MK Prod", not "electron"

// One window only: a second launch focuses the existing one.
if (!app.requestSingleInstanceLock()) app.quit();

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600,
    title: 'MK Prod',
    backgroundColor: '#eef0f8',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true },
  });
  win.loadURL(APP_URL);

  // Links to other sites (supplier pages, SharePoint…) open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith(ORIGIN)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) { e.preventDefault(); shell.openExternal(url); } });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  // Only the app's own origin may use notifications; everything else is refused.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'notifications' && wc.getURL().startsWith(ORIGIN)));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'MK Prod', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { label: 'Sign-in & team settings', click: () => win?.loadURL(APP_URL + '#/team') }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] },
  ]));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
