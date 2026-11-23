// Bridge between the page and the desktop shell. main.js checks the caller before
// acting on any of these.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lhmDesktop", {
  pickFolder: () => ipcRenderer.invoke("desktop:pick-folder"),
  state: () => ipcRenderer.invoke("setup:state"),
  useFolder: (dir) => ipcRenderer.invoke("setup:local", dir),
  useServer: (url) => ipcRenderer.invoke("setup:remote", url),
});
