// Bridge between the page and the desktop shell. main.js checks the caller before
// acting on any of these.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lhmDesktop", {
  pickFolder: () => ipcRenderer.invoke("desktop:pick-folder"),
  state: () => ipcRenderer.invoke("setup:state"),
  useFolder: (dir) => ipcRenderer.invoke("setup:local", dir),
  useServer: (url) => ipcRenderer.invoke("setup:remote", url),
  update: {
    state: () => ipcRenderer.invoke("update:state"),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
    check: () => ipcRenderer.invoke("update:check"),
    onChange: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("update:changed", handler);
      return () => ipcRenderer.removeListener("update:changed", handler);
    },
  },
});
