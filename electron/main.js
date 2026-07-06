/* Electron shell for the Psomas Photo Log.
   The app itself is the plain web app in ../index.html — this wrapper just
   gives it a window, an icon, and hands mailto:/http(s): links to the OS. */
"use strict";

const { app, BrowserWindow, dialog, shell } = require("electron");
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

  // The renderer's beforeunload guard silently blocks window close in Electron
  // (no dialog is shown, the X appears dead, and orphan processes pile up).
  // Own the close here instead: ask about unsaved changes with a native dialog,
  // then destroy() — which bypasses beforeunload — so the window always closes.
  let closing = false;
  win.on("close", (e) => {
    if (closing) return;
    e.preventDefault();
    win.webContents
      .executeJavaScript("!!(window.PhotoLog && window.PhotoLog.dirty)", true)
      .catch(() => false)
      .then((dirty) => {
        if (dirty) {
          const choice = dialog.showMessageBoxSync(win, {
            type: "warning",
            buttons: ["Close Without Saving", "Cancel"],
            defaultId: 1,
            cancelId: 1,
            title: "Unsaved changes",
            message: "This photo log has unsaved changes.",
            detail: "Use Save Project in the app to keep them, or close anyway to discard.",
          });
          if (choice !== 0) return;
        }
        closing = true;
        win.destroy();
      });
  });

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
