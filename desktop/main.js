// Localhost Music desktop shell.
//
// The web UI has to be same-origin with its API (relative /api paths, cookie auth,
// WebSocket on location.host, service worker), so the window loads the user's
// server URL instead of a bundled copy. Window, tray and menu are layered on top.

const { app, BrowserWindow, Tray, nativeImage, shell, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const ICON = path.join(__dirname, "build", "icon.png");
const TRAY_ICON = path.join(__dirname, "build", "tray.png");

const configPath = () => path.join(app.getPath("userData"), "config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  } catch (err) {
    console.error("Failed to save config:", err);
  }
  return next;
}

// LHM_URL env wins, then the saved URL. Empty on first run (the user is asked).
function serverUrl() {
  return process.env.LHM_URL || loadConfig().serverUrl || "";
}

let mainWindow = null;
let tray = null;

function createWindow() {
  const { bounds } = loadConfig();
  mainWindow = new BrowserWindow({
    width: bounds?.width ?? 1200,
    height: bounds?.height ?? 800,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 480,
    minHeight: 600,
    icon: ICON,
    backgroundColor: "#0a0a0a", // matches the app's dark shell; avoids white flash
    autoHideMenuBar: true,
    title: "Localhost Music",
    webPreferences: {
      // Keep the default sandbox and don't expose Node to the page.
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (serverUrl()) mainWindow.loadURL(serverUrl());
  else promptServerUrl();

  const persistBounds = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      saveConfig({ bounds: mainWindow.getBounds() });
    }
  };
  mainWindow.on("resize", persistBounds);
  mainWindow.on("move", persistBounds);

  // Off-origin links open in the system browser, not the app window.
  const isAppOrigin = (target) => {
    try {
      return new URL(target).origin === new URL(serverUrl()).origin;
    } catch {
      return false;
    }
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppOrigin(url)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAppOrigin(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Close-to-tray: closing hides the window and playback continues. The quit paths
  // set app.isQuitting so the close goes through.
  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(TRAY_ICON);
    tray = new Tray(img);
  } catch (err) {
    // No system tray host (e.g. bare GNOME). Quit via the menu or Ctrl-Q.
    console.warn("Tray unavailable:", err?.message);
    return;
  }
  tray.setToolTip("Localhost Music");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Localhost Music", click: showWindow },
      { type: "separator" },
      { label: "Change Server…", click: promptServerUrl },
      { type: "separator" },
      {
        label: "Quit Localhost Music",
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  // Left-click the tray icon toggles the window (common on Windows/Linux).
  tray.on("click", showWindow);
}

function promptServerUrl() {
  const current = serverUrl();
  const prompt = new BrowserWindow({
    width: 460,
    height: 190,
    parent: mainWindow ?? undefined,
    modal: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Localhost Music Server",
    backgroundColor: "#111114",
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "prompt-preload.js") },
  });
  prompt.setMenu(null);
  const html = `data:text/html,${encodeURIComponent(`
    <!doctype html><meta charset="utf-8">
    <style>
      body{font:14px system-ui,sans-serif;background:#111114;color:#eee;margin:0;padding:18px;}
      label{display:block;margin-bottom:8px;color:#aaa;}
      input{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:8px;border:1px solid #333;background:#1c1c20;color:#fff;font-size:14px;}
      .row{display:flex;gap:10px;justify-content:flex-end;margin-top:16px;}
      button{padding:8px 16px;border-radius:8px;border:0;font-size:13px;cursor:pointer;}
      .ok{background:#e0245e;color:#fff;} .cancel{background:#2a2a30;color:#ddd;}
    </style>
    <label>Localhost Music server URL</label>
    <input id="u" value="${current.replace(/"/g, "&quot;")}" autofocus>
    <div class="row">
      <button class="cancel" onclick="window.lhm.cancel()">Cancel</button>
      <button class="ok" onclick="save()">Connect</button>
    </div>
    <script>
      const i=document.getElementById('u');
      function save(){ const v=i.value.trim(); if(v) window.lhm.submit(v); }
      i.addEventListener('keydown',e=>{ if(e.key==='Enter')save(); if(e.key==='Escape')window.lhm.cancel(); });
      i.focus(); i.select();
    </script>
  `)}`;
  prompt.loadURL(html);

  const { ipcMain } = require("electron");
  const onSubmit = (_e, value) => {
    let url = value.trim();
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    saveConfig({ serverUrl: url });
    cleanup();
    if (mainWindow) mainWindow.loadURL(url);
  };
  const onCancel = () => cleanup();
  const cleanup = () => {
    ipcMain.removeListener("prompt:submit", onSubmit);
    ipcMain.removeListener("prompt:cancel", onCancel);
    if (!prompt.isDestroyed()) prompt.close();
  };
  ipcMain.on("prompt:submit", onSubmit);
  ipcMain.on("prompt:cancel", onCancel);
  prompt.on("closed", () => {
    ipcMain.removeListener("prompt:submit", onSubmit);
    ipcMain.removeListener("prompt:cancel", onCancel);
  });
}

function buildMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: "Localhost Music",
      submenu: [
        { label: "Change Server…", click: promptServerUrl },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

// Single instance: focus the existing window instead of opening a second one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    createTray();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  // Every quit path sets the flag so the close-to-tray handler lets the window close.
  app.on("before-quit", () => {
    app.isQuitting = true;
  });

  // No window-all-closed handler: the tray keeps the app alive.
}
