const { app, BrowserWindow, ipcMain, screen, session } = require("electron");
const path = require("node:path");

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const window = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    frame: false,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    focusable: true,
    hasShadow: false,
    transparent: true,
    backgroundColor: "#00000000",
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.loadFile("index.html");
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(permission === "media");
    },
  );

  createWindow();

  ipcMain.on("close-window", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
