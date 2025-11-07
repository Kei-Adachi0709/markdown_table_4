import { app, BrowserWindow } from 'electron';
import { join } from 'path';

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

let win: BrowserWindow | null = null;

async function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    // electron-vite dev server
    await win.loadURL(process.env['ELECTRON_RENDERER_URL']);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // production build
    await win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // macOS以外はウィンドウ全閉で終了
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  // macOS: Dockからの再アクティブでウィンドウが無ければ作る
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});