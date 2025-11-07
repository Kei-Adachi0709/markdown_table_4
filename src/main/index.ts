import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

let win: BrowserWindow | null = null;

function resolvePreloadPath() {
  // out/ or dist/ 配下のいずれでも動くように拡張子を順に探索
  const candidates = ['../preload/index.cjs', '../preload/index.js', '../preload/index.mjs'];
  for (const rel of candidates) {
    const p = join(__dirname, rel);
    if (existsSync(p)) return p;
  }
  // 最後のフォールバック
  return join(__dirname, '../preload/index.cjs');
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    await win.loadURL(process.env['ELECTRON_RENDERER_URL']);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});