# Psomas Photo Log

A clean, single-page photo log builder for environmental consulting field reports.
Everything runs locally; photos never leave your machine.

Two ways to run it:

- **`Psomas Photo Log.exe`** — portable single-file app, no install, no admin rights. **Download the latest version from the [Releases page](https://github.com/david-elias96/psomas-photo-log/releases/latest).**
- **`index.html`** — the same app opened directly in a browser (Chrome/Edge). No internet required.

The app checks GitHub once at launch and shows a banner when a newer version is available (dismissible; silent when offline). Updating = downloading the new exe from the banner link and replacing the old file.

## Publishing an update (maintainer)

1. Make changes; bump the version in `package.json`, `APP_VERSION` in `app.js`, and the `?v=` query strings in `index.html`.
2. `powershell -ExecutionPolicy Bypass -File .\build-exe.ps1`
3. Commit and push, then publish the release (this is what makes users' apps show the update banner):
   ```powershell
   git add -A; git commit -m "v1.x.y - what changed"; git push
   gh release create v1.x.y ".\dist\Psomas Photo Log.exe" --title "v1.x.y" --notes "What changed"
   ```

## Quick start

1. Open `index.html` (Chrome or Edge).
2. Click **+ Import Photos** (or drag photos onto the page). Photos are auto-numbered in import order; EXIF capture date and GPS are read automatically.
3. Fill in **Project Information** in the left sidebar (appears in export headers/footers).
4. Caption photos — either inline on each card, or click **Caption Editor** to step through photos quickly (`Ctrl+Enter` advances to the next photo; click a template chip to insert it).
5. Click **QC** to review missing/short/duplicate captions and missing EXIF data before exporting.
6. Pick **1 / 2 / 4 photos per page** and click **Export PDF** (final deliverable) or **Export DOCX** (editable, for report appendices).
7. Click **Save Project** to download a `.photolog` file. **Open…** reopens it later with all photos, captions, and annotations intact (annotations stay editable).

## Features

- **Bulk import with auto-numbering** — multi-select or drag-and-drop; numbered in order; *Sort by Date* reorders by EXIF capture time.
- **Dynamic renumbering** — drag a photo's thumbnail onto another card to reorder, use ↑/↓, or delete; numbers update everywhere automatically.
- **Fast caption editor with templates** — step through photos, insert reusable caption templates with tokens `{n}`, `{direction}`, `{date}`, `{file}`. Templates are editable in the sidebar and remembered between sessions.
- **PDF export** — 1-, 2-, or 4-photos-per-page letter layout with project header, footer text, and page numbering.
- **DOCX export** — same layouts as bordered tables with real Word headers/footers and page-number fields, ready to drop into a report appendix and edit.
- **EXIF preservation** — capture date/time and GPS coordinates are extracted on import, shown on each card, and printed under each photo in exports (toggle date / GPS / facing / filename in the Export panel).
- **QC panel** — flags missing captions, very short captions, duplicate captions, and missing EXIF date/GPS; click an item to jump straight to that photo in the Caption Editor.
- **Annotation & redaction** — arrows, boxes, circles, freehand, text labels, and solid-black redaction boxes. Annotations stay editable in the project and are flattened onto the image only in exports.
- **Project files** — `.photolog` files are self-contained (images embedded), so you can save, move to another machine, and resume.

## AI captions (optional)

The **AI Captions** panel in the sidebar uses Claude (Anthropic's vision model) to draft captions automatically — per photo (✨ on each card or in the Caption Editor) or in bulk ("Draft captions for all uncaptioned"). Drafts are written in environmental-consulting photo-log style ("View facing NW of soil stockpile…"), use the photo's direction/date/project context, and match the style of captions you've already written. **Drafts always land in the caption box for review — nothing is exported unreviewed.**

Setup: paste an Anthropic API key (from [platform.claude.com](https://platform.claude.com) → API keys) into the sidebar once. The key is stored only on that computer.

- **Cost**: roughly 1–2¢ per photo on Claude Opus 4.8 (best quality), or ~0.2¢ per photo on Claude Haiku 4.5 — a 100-photo log costs about $1–2 or ~$0.30 respectively.
- **Privacy**: photos are sent over HTTPS to the Anthropic API (standard 30-day retention; not used for training). For sensitive sites, skip AI captions or confirm with the client first.
- Requires internet; everything else in the app still works fully offline.

## Feedback workflow

The **Feedback** button (top right) opens a short form (type, severity, summary, steps, optional diagnostics). Submitting opens a **pre-filled GitHub issue** on this repository — the user signs in to GitHub (free account) and clicks *Submit new issue*. All reports land under [Issues](https://github.com/david-elias96/psomas-photo-log/issues), where they can be labeled, discussed, and closed when fixed in a release. GitHub emails the maintainer automatically (repo → Watch → All activity to be sure).

Because the repository is public, reports are publicly visible — the form reminds users not to include client names or confidential project details, and diagnostics deliberately exclude the project name.

## Building / updating the exe

Requires Node.js. From this folder, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-exe.ps1
```

The script stages the app to `%LOCALAPPDATA%\PhotoLogBuild` (keeps node_modules out of OneDrive), builds with electron-builder, and drops the result at `dist\Psomas Photo Log.exe`. After changing `app.js`/`styles.css`, bump the `?v=` query in `index.html` and the version in `package.json`/`app.js`, then rebuild and redistribute the exe.

## Notes & limits

- Photos are downscaled to 1700 px (JPEG) on import — plenty for letter-size reports, and it keeps project files and exports manageable. Originals on disk are never modified.
- `.photolog` files embed the images, so expect roughly 0.3–0.5 MB per photo.
- HEIC/HEIF (iPhone) files aren't supported by browsers directly — convert to JPEG first (Windows Photos app can do this), or set the phone camera to "Most Compatible".
- Unsaved changes are guarded by a browser warning on close; `Ctrl+S` saves the project.

## Files

| File | Purpose |
|---|---|
| `dist\Psomas Photo Log.exe` | Portable app — share this org-wide |
| `index.html` | The same app, openable directly in a browser |
| `app.js`, `styles.css` | Application code |
| `lib/` | Bundled libraries (exifr, jsPDF, docx) so it works offline |
| `electron/`, `package.json`, `build/` | Executable wrapper + icon |
| `build-exe.ps1` | Rebuilds the exe |
