/* Electron shell for the Psomas Photo Log.
   The app itself is the plain web app in ../index.html — this wrapper just
   gives it a window, an icon, and hands mailto:/http(s): links to the OS. */
"use strict";

const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const fs = require("fs");

function openExternally(url) {
  if (/^(mailto:|https?:)/i.test(url)) shell.openExternal(url);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  win.loadFile(path.join(__dirname, "..", "index.html"));

  // feedback form / external links: hand off to the default mail client / browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) {
      e.preventDefault();
      openExternally(url);
    }
  });

  // headless smoke test support: write a marker once the renderer loads, then quit
  if (process.env.PHOTOLOG_SMOKE_FILE) {
    win.webContents.once("did-finish-load", () => {
      try { fs.writeFileSync(process.env.PHOTOLOG_SMOKE_FILE, "ok"); } catch (e) { /* ignore */ }
      app.quit();
    });
  }

  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
