// Bridge for the server URL prompt. Exposes only submit and cancel.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lhm", {
  submit: (url) => ipcRenderer.send("prompt:submit", url),
  cancel: () => ipcRenderer.send("prompt:cancel"),
});
