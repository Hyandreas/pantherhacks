const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lumenWindow", {
  close: () => ipcRenderer.send("close-window"),
});

window.addEventListener("DOMContentLoaded", () => {
  document.body.dataset.electron = "true";
});
