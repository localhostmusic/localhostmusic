// Localhost Music desktop app.
//
// The window shows the same web UI a browser would. It gets it from one of two places:
// a server built into this app that plays a folder on this computer, or a server the
// user already runs somewhere else. The web UI has to be same-origin with its API
// (cookie auth, WebSocket, service worker), so it is always loaded over http from
// that server and never from a bundled file.

const { app, BrowserWindow, Tray, nativeImage, shell, Menu, dialog, ipcMain, session } = require("electron");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const crypto = require("node:crypto");
const path = require("node:path");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");

const ICON = path.join(__dirname, "build", "icon.png");
const TRAY_ICON = path.join(__dirname, "build", "tray.png");
const WELCOME = path.join(__dirname, "welcome.html");
const WELCOME_URL = pathToFileURL(WELCOME).href;
// The built-in server and its own Node binary (see bundle.mjs).
const SERVER_DIR = path.join(__dirname, "server");
const SERVER_NODE = path.join(SERVER_DIR, process.platform === "win32" ? "node.exe" : "node");
const SERVER_ENTRY = path.join(SERVER_DIR, "dist", "index.js");
const SCANNER = path.join(SERVER_DIR, process.platform === "win32" ? "lhm-scan.exe" : "lhm-scan");
// A fixed port keeps the page's origin, and with it saved settings and offline
// downloads, the same between launches.
const DEFAULT_PORT = 47821;

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
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error("Failed to save config:", err);
  }
  return next;
}

let mainWindow = null;
let tray = null;
let appOrigin = null;   // origin of the server the window is showing, null on the welcome screen
let local = null;       // { child, base, cookie } while the built-in server runs
let lastError = "";

// ---------- built-in server ----------

function freePort(preferred) {
  const tryPort = (port) => new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(null));
    probe.listen(port, "127.0.0.1", () => {
      const got = probe.address().port;
      probe.close(() => resolve(got));
    });
  });
  return tryPort(preferred).then((port) => port ?? tryPort(0));
}

function ffmpegPath() {
  try {
    return require("ffmpeg-static") || "";
  } catch {
    return "";
  }
}

function logTail(file) {
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n").slice(-6).join("\n");
  } catch {
    return "";
  }
}

async function startLocal() {
  if (local) return local.base;
  let cfg = loadConfig();
  if (!cfg.password) {
    // The built-in server still has accounts. The app signs in by itself with this one.
    let user = "me";
    try { user = os.userInfo().username.replace(/[^\w.-]/g, "") || "me"; } catch { /* keep default */ }
    cfg = saveConfig({ user, password: crypto.randomBytes(24).toString("base64url") });
  }
  const port = await freePort(cfg.port || DEFAULT_PORT);
  if (!cfg.port) saveConfig({ port });

  const dataDir = path.join(app.getPath("userData"), "library");
  fs.mkdirSync(dataDir, { recursive: true });
  const logFile = path.join(app.getPath("userData"), "server.log");
  const log = fs.openSync(logFile, "w");
  const ffmpeg = ffmpegPath();

  const child = spawn(SERVER_NODE, [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      // Loopback only, unless the user chose to let other devices connect.
      HOST: cfg.lan ? "0.0.0.0" : "127.0.0.1",
      DATA_DIR: dataDir,
      MUSIC_DIR: cfg.musicDir,
      ADMIN_USER: cfg.user,
      ADMIN_PASSWORD: cfg.password,
      COOKIE_SECURE: "0",
      EXIT_WITH_PID: String(process.pid),
      ...(ffmpeg ? { FFMPEG_PATH: ffmpeg } : {}),
      ...(fs.existsSync(SCANNER) ? { LHM_SCANNER_BIN: SCANNER } : {}),
    },
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  fs.closeSync(log);

  const base = `http://127.0.0.1:${port}`;
  let exited = false;
  child.once("exit", () => {
    exited = true;
    if (local && local.child === child) {
      local = null;
      if (!app.isQuitting) {
        lastError = "The music library stopped unexpectedly.\n" + logTail(logFile);
        showWelcome();
      }
    }
  });

  try {
    let up = false;
    for (let i = 0; i < 120 && !exited && !up; i++) {
      up = await fetch(base + "/api/health").then((r) => r.ok, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    if (!up) throw new Error("The music library did not start.\n" + logTail(logFile));

    const res = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: cfg.user, password: cfg.password }),
    });
    const cookie = (res.headers.getSetCookie()[0] || "").split(";")[0];
    if (!res.ok || !cookie.includes("=")) throw new Error("Could not sign in to the music library.");
    const eq = cookie.indexOf("=");
    await session.defaultSession.cookies.set({
      url: base,
      name: cookie.slice(0, eq),
      value: cookie.slice(eq + 1),
      httpOnly: true,
      sameSite: "lax",
      expirationDate: Date.now() / 1000 + 30 * 24 * 3600,
    });
    local = { child, base, cookie };
    return base;
  } catch (err) {
    if (!exited) child.kill();
    throw err;
  }
}

function stopLocal() {
  if (!local) return;
  const { child } = local;
  local = null;
  child.kill();
}

// Stops the library and waits until its port is free again.
function stopLocalAndWait() {
  if (!local) return Promise.resolve();
  const { child } = local;
  const gone = new Promise((resolve) => child.once("exit", resolve));
  stopLocal();
  return Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 5000))]);
}

// This computer's addresses on the home network, for other devices to type in.
function lanAddresses() {
  // Virtual adapters (containers, VPNs, virtual machines) are not how a phone gets here.
  const virtual = /^(docker|br-|veth|virbr|vEthernet|wg|tun|tap|tailscale|zt|vmnet|vboxnet|VirtualBox|VMware)/i;
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (virtual.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const [x, y] = a.address.split(".").map(Number);
      // Private ranges only: 10.x, 172.16-31.x, 192.168.x.
      if (x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)) out.push(a.address);
    }
  }
  // 192.168.x is what home routers hand out. When there is one, the rest is noise.
  const home = out.filter((ip) => ip.startsWith("192.168."));
  return home.length ? home : out;
}

function networkState() {
  const cfg = loadConfig();
  const port = local ? Number(new URL(local.base).port) : cfg.port || DEFAULT_PORT;
  return { enabled: !!cfg.lan, port, addresses: lanAddresses().map((ip) => `http://${ip}:${port}`) };
}

// Points the running library at a folder. The server rescans when it changes.
async function setMusicFolder(dir) {
  const res = await fetch(local.base + "/api/admin/settings", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: local.cookie },
    body: JSON.stringify({ musicDir: dir, background: true }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Could not use that folder.");
  }
}

// ---------- window ----------

function show(base) {
  appOrigin = new URL(base).origin;
  lastError = "";
  if (mainWindow) mainWindow.loadURL(base);
}

function showWelcome() {
  appOrigin = null;
  if (mainWindow) mainWindow.loadFile(WELCOME);
}

async function openSource() {
  const cfg = loadConfig();
  // LHM_URL is for development against a running server.
  if (process.env.LHM_URL) return show(process.env.LHM_URL);
  if (cfg.mode === "remote" && cfg.serverUrl) return show(cfg.serverUrl);
  if (cfg.mode === "local" && cfg.musicDir) {
    try {
      return show(await startLocal());
    } catch (err) {
      lastError = String(err?.message || err);
    }
  }
  showWelcome();
}

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
      preload: path.join(__dirname, "preload.js"),
    },
  });

  openSource();

  const persistBounds = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      saveConfig({ bounds: mainWindow.getBounds() });
    }
  };
  mainWindow.on("resize", persistBounds);
  mainWindow.on("move", persistBounds);

  // Off-origin links open in the system browser, not the app window.
  const isAppOrigin = (target) => {
    if (target.startsWith(WELCOME_URL)) return true;
    try {
      return appOrigin !== null && new URL(target).origin === appOrigin;
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
  // Each page has to ask for the update state again before it is trusted to show it.
  mainWindow.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) uiAttached = false;
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

function changeSource() {
  showWindow();
  showWelcome();
}

// ---------- requests from the page ----------

const fromWelcome = (event) => (event.senderFrame?.url || "").startsWith(WELCOME_URL);
const fromApp = (event) => {
  try {
    return fromWelcome(event) || (appOrigin !== null && new URL(event.senderFrame.url).origin === appOrigin);
  } catch {
    return false;
  }
};

function registerIpc() {
  ipcMain.on("desktop:built-in", (event) => {
    let own = false;
    try { own = !!local && new URL(event.senderFrame.url).origin === new URL(local.base).origin; } catch { /* not ours */ }
    event.returnValue = own;
  });

  // Whether other devices on the network may connect to the built-in library.
  const fromBuiltIn = (event) => {
    try { return !!local && new URL(event.senderFrame.url).origin === new URL(local.base).origin; } catch { return false; }
  };
  ipcMain.handle("desktop:network", (event) => (fromBuiltIn(event) ? networkState() : null));
  ipcMain.handle("desktop:network-set", async (event, enabled) => {
    if (!fromBuiltIn(event)) return null;
    if (!!loadConfig().lan !== !!enabled) {
      saveConfig({ lan: !!enabled });
      // The address the server listens on is fixed when it starts, so start it again.
      await stopLocalAndWait();
      await openSource();
    }
    return networkState();
  });

  ipcMain.handle("desktop:pick-folder", async (event) => {
    if (!fromApp(event)) return null;
    // Start somewhere sensible. The dialog's own default can be a list of unmounted
    // drives, which is a dead end on Linux desktops without a mount prompt.
    const current = loadConfig().musicDir;
    const start = [current, app.getPath("music"), app.getPath("home")].find((d) => d && fs.existsSync(d));
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "Choose your music folder",
      defaultPath: start,
      properties: ["openDirectory"],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle("update:state", (event) => {
    if (!fromApp(event) || fromWelcome(event)) return { status: "idle" };
    uiAttached = true;
    return { ...update, current: app.getVersion() };
  });
  ipcMain.handle("update:download", (event) => { if (fromApp(event)) downloadUpdate(); });
  ipcMain.handle("update:install", (event) => { if (fromApp(event)) installUpdate(); });
  ipcMain.handle("update:check", (event) => { if (fromApp(event)) checkForUpdates(); });

  ipcMain.handle("setup:state", (event) => {
    if (!fromWelcome(event)) return {};
    const { mode, musicDir, serverUrl } = loadConfig();
    return { mode, musicDir, serverUrl, error: lastError };
  });

  ipcMain.handle("setup:local", async (event, dir) => {
    if (!fromWelcome(event)) return { error: "Not allowed." };
    if (typeof dir !== "string") return { error: "That folder does not exist." };
    // Typed paths: allow ~ and stray quotes from a copied path.
    dir = dir.trim().replace(/^["']|["']$/g, "").replace(/^~(?=$|[\\/])/, os.homedir());
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch { /* missing */ }
    if (!isDir) return { error: "That folder does not exist." };
    saveConfig({ mode: "local", musicDir: dir });
    try {
      const base = await startLocal();
      await setMusicFolder(dir);
      show(base);
      return { ok: true };
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  });

  ipcMain.handle("setup:remote", async (event, value) => {
    if (!fromWelcome(event)) return { error: "Not allowed." };
    let url = String(value || "").trim().replace(/\/+$/, "");
    if (!url) return { error: "Enter your server's address." };
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const ok = await fetch(url + "/api/health", { signal: AbortSignal.timeout(8000) })
      .then((r) => r.ok, () => false);
    if (!ok) return { error: `No Localhost Music server answered at ${url}.` };
    saveConfig({ mode: "remote", serverUrl: url });
    stopLocal();
    show(url);
    return { ok: true };
  });
}

// ---------- updates ----------
//
// The web UI shows update prompts when it can (see web/src/ui/desktopUpdate.tsx).
// A page that never asked for the state, such as the welcome screen or an older
// server's UI, gets native dialogs instead.

let updater = null;
let manualCheck = false;
let uiAttached = false;
let update = { status: "idle" };

const plainNotes = (notes) => {
  const text = Array.isArray(notes) ? notes.map((n) => n.note).join("\n\n") : String(notes || "");
  return text.replace(/<li>/g, "- ").replace(/<\/(p|li|h\d)>/g, "\n").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\n{3,}/g, "\n\n").trim();
};

function setUpdate(patch) {
  update = { ...update, ...patch, current: app.getVersion() };
  if (uiAttached && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("update:changed", update);
}

const downloadUpdate = () => {
  if (!updater || update.status !== "available") return;
  setUpdate({ status: "downloading", percent: 0 });
  updater.downloadUpdate().catch(() => {});
};

const installUpdate = () => {
  if (!updater || update.status !== "ready") return;
  app.isQuitting = true;
  updater.quitAndInstall();
};

async function nativePrompt(kind) {
  const ready = kind === "ready";
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "info",
    buttons: [ready ? "Restart now" : "Update", "Later"],
    defaultId: 0,
    cancelId: 1,
    message: ready ? "The update is ready" : `Localhost Music ${update.version} is available`,
    detail: ready ? "Restart Localhost Music to finish installing it." : update.notes || "A new version is ready to download.",
  });
  if (response === 0) (ready ? installUpdate : downloadUpdate)();
}

// Development only (LHM_FAKE_UPDATE=1 npm start): acts out an update so the prompts
// can be worked on without publishing releases.
function fakeUpdater() {
  const fake = new (require("node:events"))();
  fake.checkForUpdates = async () => {
    fake.emit("update-available", { version: "9.9.9", releaseNotes: "<p>Pretend release.</p><ul><li>First change</li><li>Second change</li></ul>" });
  };
  fake.downloadUpdate = async () => {
    for (let percent = 20; percent <= 100; percent += 20) {
      await new Promise((r) => setTimeout(r, 400));
      fake.emit("download-progress", { percent });
    }
    fake.emit("update-downloaded", {});
  };
  fake.quitAndInstall = () => app.quit();
  return fake;
}

function setupUpdates() {
  // Only the installed Windows app and the Linux AppImage can replace themselves.
  if (app.isPackaged) {
    try {
      updater = require("electron-updater").autoUpdater;
    } catch {
      return;
    }
  } else if (process.env.LHM_FAKE_UPDATE) {
    updater = fakeUpdater();
  } else {
    return;
  }
  updater.autoDownload = false;

  updater.on("update-available", (info) => {
    manualCheck = false;
    // A repeat check must not reset a download in progress.
    if (update.status === "downloading" || update.status === "ready") return;
    setUpdate({ status: "available", version: info.version, notes: plainNotes(info.releaseNotes) });
    if (!uiAttached) nativePrompt("available");
  });
  updater.on("update-not-available", () => {
    if (manualCheck) {
      if (uiAttached) {
        setUpdate({ status: "latest" });
        setTimeout(() => { if (update.status === "latest") setUpdate({ status: "idle" }); }, 5000);
      } else {
        dialog.showMessageBox(mainWindow, { type: "info", message: "You're up to date.", detail: `Version ${app.getVersion()}` });
      }
    }
    manualCheck = false;
  });
  updater.on("download-progress", (p) => {
    if (update.status === "downloading") setUpdate({ percent: p.percent });
  });
  updater.on("update-downloaded", () => {
    setUpdate({ status: "ready", percent: 100 });
    if (!uiAttached) nativePrompt("ready");
  });
  updater.on("error", (err) => {
    const message = String(err?.message || err).split("\n")[0];
    if (update.status === "downloading" || manualCheck) {
      if (uiAttached) {
        setUpdate({ status: "error", error: message });
        setTimeout(() => { if (update.status === "error") setUpdate({ status: update.version ? "available" : "idle" }); }, 8000);
      } else {
        dialog.showMessageBox(mainWindow, { type: "warning", message: "The update did not work", detail: message });
        update = { ...update, status: update.version ? "available" : "idle" };
      }
    }
    manualCheck = false;
  });

  const check = () => updater.checkForUpdates().catch(() => {});
  setTimeout(check, 8000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

function checkForUpdates() {
  if (!updater) {
    dialog.showMessageBox(mainWindow, { type: "info", message: "Updates are only available in the installed app." });
    return;
  }
  if (update.status !== "idle") {
    // Already known: bring the prompt back instead of checking again.
    if (uiAttached) setUpdate({ asked: Date.now() });
    else nativePrompt(update.status === "ready" ? "ready" : "available");
    return;
  }
  manualCheck = true;
  updater.checkForUpdates().catch(() => {});
}

// ---------- tray and menu ----------

const quit = () => {
  app.isQuitting = true;
  app.quit();
};

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
      { label: "Change Music Source…", click: changeSource },
      { label: "Check for Updates…", click: checkForUpdates },
      { type: "separator" },
      { label: "Quit Localhost Music", click: quit },
    ]),
  );
  // Left-click the tray icon toggles the window (common on Windows/Linux).
  tray.on("click", showWindow);
}

function buildMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: "Localhost Music",
      submenu: [
        { label: "Change Music Source…", click: changeSource },
        { label: "Check for Updates…", click: checkForUpdates },
        { type: "separator" },
        { label: "Quit", accelerator: "CmdOrCtrl+Q", click: quit },
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
  app.on("second-instance", showWindow);

  app.whenReady().then(() => {
    registerIpc();
    buildMenu();
    createTray();
    createWindow();
    setupUpdates();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  // Session logout and shutdown send SIGTERM. Without this the close-to-tray handler
  // would keep the app alive.
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);

  // Every quit path sets the flag so the close-to-tray handler lets the window close.
  app.on("before-quit", () => {
    app.isQuitting = true;
  });
  app.on("will-quit", stopLocal);

  // No window-all-closed handler: the tray keeps the app alive.
}
