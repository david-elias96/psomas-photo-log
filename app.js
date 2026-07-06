/* ============================================================
   Photo Log — single-file photo log builder for field reports
   All client-side: import, caption, annotate, QC, PDF/DOCX export.
   ============================================================ */
"use strict";

/* ---------------- state ---------------- */

const APP_VERSION = "1.3.1";
const UPDATE_REPO = "david-elias96/psomas-photo-log"; // owner/repo on GitHub — update checker + feedback issues

const DEFAULT_TEMPLATES = [
  "View facing {direction} of ",
  "Overview of site conditions, facing {direction}.",
  "Pre-construction site conditions at ",
  "Soil stockpile located at ",
  "Groundwater monitoring well ",
  "Soil boring / sample location ",
  "Excavation activities at ",
  "Equipment and materials staging area.",
  "Erosion and sediment control measures along ",
  "Stormwater BMP installation at ",
];

const MAX_DIM = 1700;          // working image max dimension (px)
const JPEG_Q = 0.85;
const THUMB_DIM = 440;

function blankState() {
  return {
    meta: {
      projectName: "", projectNumber: "", client: "", site: "",
      photographer: "", dateRange: "", footerText: "",
    },
    settings: { layout: 2, incDate: true, incGps: true, incDir: true, incFile: false },
    templates: loadStoredTemplates(),
    photos: [],   // {id, fileName, dataURL, thumbURL, w, h, caption, direction, exifDate, lat, lon, annotations[], annotatedDataURL, annotatedThumbURL}
  };
}

let state = blankState();
let dirty = false;

function markDirty() { dirty = true; }

function loadStoredTemplates() {
  try {
    const t = JSON.parse(localStorage.getItem("photolog.templates"));
    if (Array.isArray(t) && t.length) return t;
  } catch (e) { /* ignore */ }
  return DEFAULT_TEMPLATES.slice();
}
function storeTemplates() {
  try { localStorage.setItem("photolog.templates", JSON.stringify(state.templates)); } catch (e) { /* ignore */ }
}

/* ---------------- dom helpers ---------------- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

function busy(msg) {
  $("#busyText").textContent = msg;
  $("#busy").hidden = false;
}
function busyDone() { $("#busy").hidden = true; }

function saveBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

/* ---------------- formatting ---------------- */

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const mm = d.getMonth() + 1, dd = d.getDate(), yy = d.getFullYear();
  let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${mm}/${dd}/${yy} ${h}:${m} ${ap}`;
}

function fmtGps(lat, lon) {
  if (lat == null || lon == null) return "";
  const f = (v, pos, neg) => `${Math.abs(v).toFixed(5)}°${v >= 0 ? pos : neg}`;
  return `${f(lat, "N", "S")}, ${f(lon, "E", "W")}`;
}

function metaLine(p) {
  const s = state.settings, parts = [];
  if (s.incDate && p.exifDate) parts.push(fmtDate(p.exifDate));
  if (s.incDir && p.direction) parts.push(`Facing ${p.direction}`);
  if (s.incGps && p.lat != null) parts.push(fmtGps(p.lat, p.lon));
  if (s.incFile && p.fileName) parts.push(p.fileName);
  return parts.join("  |  ");
}

function resolveTokens(text, p, idx) {
  return text
    .replace(/\{n\}/g, String(idx + 1))
    .replace(/\{direction\}/g, p.direction || "[direction]")
    .replace(/\{date\}/g, p.exifDate ? fmtDate(p.exifDate).split(" ")[0] : "[date]")
    .replace(/\{file\}/g, p.fileName || "");
}

/* ---------------- images ---------------- */

function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("Could not load image"));
    im.src = url;
  });
}

function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

function scaleToCanvas(img, maxDim) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const sc = Math.min(1, maxDim / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * sc));
  c.height = Math.max(1, Math.round(h * sc));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function dataURLtoU8(dataURL) {
  const b64 = dataURL.slice(dataURL.indexOf(",") + 1);
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function exportImage(p) { return p.annotatedDataURL || p.dataURL; }
function displayThumb(p) { return p.annotatedThumbURL || p.thumbURL || p.dataURL; }

/* ---------------- import ---------------- */

let uidCounter = 0;
const uid = () => `p${Date.now().toString(36)}_${(uidCounter++).toString(36)}`;

async function importFiles(fileList) {
  const files = Array.from(fileList).filter((f) => /^image\//.test(f.type));
  if (!files.length) { toast("No image files found in selection."); return; }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  let added = 0, failed = 0;
  for (let i = 0; i < files.length; i++) {
    busy(`Importing photo ${i + 1} of ${files.length}…`);
    const file = files[i];
    try {
      let exif = null;
      try { exif = await exifr.parse(file); } catch (e) { /* no EXIF — fine */ }
      const url = await readFileAsDataURL(file);
      const img = await loadImage(url);
      const c = scaleToCanvas(img, MAX_DIM);
      const tc = scaleToCanvas(img, THUMB_DIM);
      const d = exif && (exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate);
      state.photos.push({
        id: uid(),
        fileName: file.name,
        dataURL: c.toDataURL("image/jpeg", JPEG_Q),
        thumbURL: tc.toDataURL("image/jpeg", 0.75),
        w: c.width, h: c.height,
        caption: "", direction: "",
        exifDate: d instanceof Date && !isNaN(d) ? d.toISOString() : null,
        lat: exif && typeof exif.latitude === "number" ? exif.latitude : null,
        lon: exif && typeof exif.longitude === "number" ? exif.longitude : null,
        annotations: [],
        annotatedDataURL: null, annotatedThumbURL: null,
      });
      added++;
    } catch (e) {
      console.error("Import failed:", file.name, e);
      failed++;
    }
  }
  busyDone();
  if (added) markDirty();
  refresh();
  toast(`Imported ${added} photo${added === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""}.`);
}

/* ---------------- grid rendering ---------------- */

function refresh() {
  renderGrid();
  renderStats();
  renderQC();
  renderTemplates();
  const name = state.meta.projectName || state.meta.projectNumber;
  $("#projectTitle").textContent = name || "Untitled project";
  document.title = (name ? name + " — " : "") + "Photo Log";
}

function renderGrid() {
  const grid = $("#grid");
  $("#empty").style.display = state.photos.length ? "none" : "";
  grid.innerHTML = "";
  state.photos.forEach((p, i) => grid.appendChild(buildCard(p, i)));
}

function buildCard(p, i) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.id = p.id;
  if (!p.caption.trim()) card.classList.add("qc-error");

  const exifBits = [];
  if (p.exifDate) exifBits.push(fmtDate(p.exifDate));
  if (p.lat != null) exifBits.push("GPS ✓");

  card.innerHTML = `
    <div class="thumbwrap" draggable="true" title="Drag to reorder">
      <img alt="Photo ${i + 1}">
      <span class="num">${i + 1}</span>
      <button class="del-x" title="Delete photo">&#10005;</button>
      ${p.annotations.length ? '<span class="flag-anno">annotated</span>' : ""}
    </div>
    <div class="body">
      <div class="exif"><span class="fname" title="${esc(p.fileName)}">${esc(p.fileName)}</span><span>${esc(exifBits.join(" · "))}</span></div>
      <textarea class="cap ${p.caption.trim() ? "" : "missing"}" placeholder="Caption…" rows="2">${esc(p.caption)}</textarea>
      <div class="dir-row">
        <label>Facing</label><input class="dir" type="text" value="${esc(p.direction)}" placeholder="NW">
        <div class="actions" style="flex:1;justify-content:flex-end">
          <button class="ghost act-ai" title="AI-draft caption from photo">&#10024;</button>
          <button class="ghost act-anno" title="Annotate / redact">&#9998;</button>
          <button class="ghost act-cap" title="Open in Caption Editor">&#128221;</button>
          <button class="ghost act-up" title="Move earlier">&#8593;</button>
          <button class="ghost act-down" title="Move later">&#8595;</button>
          <button class="ghost danger act-del" title="Delete photo">&#128465;</button>
        </div>
      </div>
    </div>`;

  card.querySelector("img").src = displayThumb(p);

  const ta = card.querySelector("textarea.cap");
  ta.addEventListener("input", () => {
    p.caption = ta.value;
    ta.classList.toggle("missing", !p.caption.trim());
    card.classList.toggle("qc-error", !p.caption.trim());
    markDirty(); renderStats(); renderQC();
  });
  card.querySelector("input.dir").addEventListener("input", (e) => {
    p.direction = e.target.value; markDirty();
  });

  card.querySelector(".act-ai").addEventListener("click", () => aiCaptionOne(p.id));
  card.querySelector(".act-anno").addEventListener("click", () => openAnnotator(p.id));
  card.querySelector(".act-cap").addEventListener("click", () => openCaptionEditor(indexOf(p.id)));
  card.querySelector(".act-up").addEventListener("click", () => movePhoto(p.id, -1));
  card.querySelector(".act-down").addEventListener("click", () => movePhoto(p.id, +1));
  card.querySelector(".act-del").addEventListener("click", () => deletePhoto(p.id));
  card.querySelector(".del-x").addEventListener("click", (e) => {
    e.stopPropagation();
    deletePhoto(p.id);
  });

  // drag & drop reorder
  const handle = card.querySelector(".thumbwrap");
  handle.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/photo-id", p.id);
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("drag-src");
  });
  handle.addEventListener("dragend", () => card.classList.remove("drag-src"));
  card.addEventListener("dragover", (e) => {
    if (e.dataTransfer.types.includes("text/photo-id")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      card.classList.add("drag-over");
    }
  });
  card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
  card.addEventListener("drop", (e) => {
    const srcId = e.dataTransfer.getData("text/photo-id");
    if (!srcId) return;
    e.preventDefault(); e.stopPropagation();
    card.classList.remove("drag-over");
    const from = indexOf(srcId), to = indexOf(p.id);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = state.photos.splice(from, 1);
    state.photos.splice(to, 0, moved);
    markDirty(); refresh();
  });

  return card;
}

function indexOf(id) { return state.photos.findIndex((p) => p.id === id); }

function deletePhoto(id) {
  const i = indexOf(id);
  if (i < 0) return;
  const p = state.photos[i];
  if (confirm(`Delete Photo ${i + 1} (${p.fileName})? Remaining photos renumber automatically.`)) {
    state.photos.splice(indexOf(id), 1);
    markDirty(); refresh();
  }
}

function movePhoto(id, delta) {
  const i = indexOf(id), j = i + delta;
  if (i < 0 || j < 0 || j >= state.photos.length) return;
  const [m] = state.photos.splice(i, 1);
  state.photos.splice(j, 0, m);
  markDirty(); refresh();
}

function renderStats() {
  const n = state.photos.length;
  const missing = state.photos.filter((p) => !p.caption.trim()).length;
  const anno = state.photos.filter((p) => p.annotations.length).length;
  const gps = state.photos.filter((p) => p.lat != null).length;
  $("#stats").innerHTML =
    `${n} photo${n === 1 ? "" : "s"} · ${n - missing} captioned · ${anno} annotated<br>` +
    `${gps} with GPS · ${state.photos.filter((p) => p.exifDate).length} with capture date`;
}

/* ---------------- QC ---------------- */

function qcIssues() {
  const issues = []; // {idx, items:[{sev, msg}]}
  const capMap = new Map();
  state.photos.forEach((p, i) => {
    const c = p.caption.trim().toLowerCase();
    if (c) {
      if (!capMap.has(c)) capMap.set(c, []);
      capMap.get(c).push(i);
    }
  });
  state.photos.forEach((p, i) => {
    const items = [];
    const cap = p.caption.trim();
    if (!cap) items.push({ sev: "err", msg: "Missing caption" });
    else if (cap.length < 12) items.push({ sev: "warn", msg: "Very short caption" });
    if (cap && capMap.get(cap.toLowerCase()).length > 1) {
      const others = capMap.get(cap.toLowerCase()).filter((j) => j !== i).map((j) => j + 1);
      items.push({ sev: "warn", msg: `Duplicate caption (also Photo ${others.join(", ")})` });
    }
    if (!p.exifDate) items.push({ sev: "warn", msg: "No capture date in EXIF" });
    if (p.lat == null) items.push({ sev: "info", msg: "No GPS data" });
    if (items.length) issues.push({ idx: i, items });
  });
  return issues;
}

function renderQC() {
  const issues = qcIssues();
  const errCount = issues.reduce((a, it) => a + it.items.filter((x) => x.sev === "err").length, 0);
  const badge = $("#qcBadge");
  badge.textContent = String(errCount || issues.length);
  badge.classList.toggle("ok", errCount === 0);

  const list = $("#qcList");
  if (!state.photos.length) {
    list.innerHTML = '<div class="hint">Import photos to run QC.</div>';
    return;
  }
  if (!issues.length) {
    list.innerHTML = '<div class="qc-clean">✓ All photos pass QC</div>';
    return;
  }
  list.innerHTML = "";
  issues.forEach(({ idx, items }) => {
    const p = state.photos[idx];
    const div = document.createElement("div");
    div.className = "qc-item";
    div.innerHTML = `<div class="who">Photo ${idx + 1} <span style="font-weight:400;color:var(--muted)">${esc(p.fileName)}</span></div>
      <ul>${items.map((it) => `<li class="${it.sev}">${esc(it.msg)}</li>`).join("")}</ul>`;
    div.addEventListener("click", () => openCaptionEditor(idx));
    list.appendChild(div);
  });
}

/* ---------------- templates ---------------- */

function renderTemplates() {
  const wrap = $("#templateList");
  wrap.innerHTML = "";
  state.templates.forEach((t, i) => {
    const div = document.createElement("div");
    div.className = "tpl";
    div.innerHTML = `<span title="${esc(t)}">${esc(t)}</span><button title="Remove template">&#10005;</button>`;
    div.querySelector("button").addEventListener("click", () => {
      state.templates.splice(i, 1);
      storeTemplates(); markDirty(); renderTemplates(); renderCapChips();
    });
    wrap.appendChild(div);
  });
}

/* ---------------- caption editor modal ---------------- */

let capIdx = -1;

function openCaptionEditor(idx = 0) {
  if (!state.photos.length) { toast("Import photos first."); return; }
  capIdx = Math.min(Math.max(idx, 0), state.photos.length - 1);
  $("#capModal").hidden = false;
  renderCapEditor();
  $("#capText").focus();
}

function renderCapEditor() {
  const p = state.photos[capIdx];
  if (!p) { closeCaptionEditor(); return; }
  $("#capImg").src = exportImage(p);
  $("#capLabel").textContent = `Photo ${capIdx + 1} — ${p.fileName}`;
  const bits = [];
  if (p.exifDate) bits.push(fmtDate(p.exifDate));
  if (p.lat != null) bits.push(fmtGps(p.lat, p.lon));
  $("#capExif").textContent = bits.join("  ·  ") || "No EXIF date / GPS";
  $("#capText").value = p.caption;
  $("#capDir").value = p.direction;
  $("#capPos").textContent = `${capIdx + 1} of ${state.photos.length}`;
  $("#capPrev").disabled = capIdx === 0;
  $("#capNext").textContent = capIdx === state.photos.length - 1 ? "Done ✓" : "Next ▶";
  renderCapChips();
}

function renderCapChips() {
  const wrap = $("#capChips");
  wrap.innerHTML = "";
  const p = state.photos[capIdx];
  if (!p) return;
  state.templates.forEach((t) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.type = "button";
    b.textContent = t;
    b.addEventListener("click", () => {
      const ta = $("#capText");
      const text = resolveTokens(t, p, capIdx);
      const start = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, start) + text + ta.value.slice(ta.selectionEnd ?? start);
      p.caption = ta.value;
      markDirty();
      ta.focus();
      const pos = start + text.length;
      ta.setSelectionRange(pos, pos);
    });
    wrap.appendChild(b);
  });
}

function capStep(delta) {
  const next = capIdx + delta;
  if (next < 0) return;
  if (next >= state.photos.length) { closeCaptionEditor(); return; }
  capIdx = next;
  renderCapEditor();
  $("#capText").focus();
}

function closeCaptionEditor() {
  $("#capModal").hidden = true;
  capIdx = -1;
  refresh();
}

/* ---------------- annotation editor ---------------- */

const SIZES = { S: { w: 0.0028, f: 0.03 }, M: { w: 0.005, f: 0.045 }, L: { w: 0.009, f: 0.065 } };

const anno = {
  photoId: null,
  ops: [],
  tool: "arrow",
  color: "#e02b2b",
  size: "M",
  img: null,
  drawing: false,
  cur: null,
};

function drawOp(ctx, op, W, H) {
  ctx.save();
  const lw = (op.w || 0.005) * W;
  ctx.strokeStyle = op.color || "#e02b2b";
  ctx.fillStyle = op.color || "#e02b2b";
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const X = (v) => v * W, Y = (v) => v * H;
  switch (op.tool) {
    case "draw": {
      if (op.pts.length < 2) break;
      ctx.beginPath();
      op.pts.forEach((pt, i) => (i ? ctx.lineTo(X(pt[0]), Y(pt[1])) : ctx.moveTo(X(pt[0]), Y(pt[1]))));
      ctx.stroke();
      break;
    }
    case "arrow": {
      const x1 = X(op.x1), y1 = Y(op.y1), x2 = X(op.x2), y2 = Y(op.y2);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const len = Math.max(8, lw * 3.5);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - len * Math.cos(ang - 0.45), y2 - len * Math.sin(ang - 0.45));
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - len * Math.cos(ang + 0.45), y2 - len * Math.sin(ang + 0.45));
      ctx.stroke();
      break;
    }
    case "rect":
      ctx.strokeRect(X(op.x1), Y(op.y1), X(op.x2) - X(op.x1), Y(op.y2) - Y(op.y1));
      break;
    case "ellipse": {
      ctx.beginPath();
      ctx.ellipse((X(op.x1) + X(op.x2)) / 2, (Y(op.y1) + Y(op.y2)) / 2,
        Math.abs(X(op.x2) - X(op.x1)) / 2, Math.abs(Y(op.y2) - Y(op.y1)) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "redact":
      ctx.fillStyle = "#000";
      ctx.fillRect(X(op.x1), Y(op.y1), X(op.x2) - X(op.x1), Y(op.y2) - Y(op.y1));
      break;
    case "text": {
      const fs = Math.max(10, (op.size || 0.045) * W);
      ctx.font = `bold ${fs}px Arial, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.lineWidth = Math.max(2, fs * 0.14);
      ctx.strokeStyle = op.color === "#000000" ? "rgba(255,255,255,.85)" : "rgba(0,0,0,.75)";
      ctx.strokeText(op.text, X(op.x), Y(op.y));
      ctx.fillText(op.text, X(op.x), Y(op.y));
      break;
    }
  }
  ctx.restore();
}

function annoRedraw() {
  const c = $("#annoCanvas"), ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  if (anno.img) ctx.drawImage(anno.img, 0, 0, c.width, c.height);
  for (const op of anno.ops) drawOp(ctx, op, c.width, c.height);
  if (anno.cur) drawOp(ctx, anno.cur, c.width, c.height);
}

async function openAnnotator(photoId) {
  const p = state.photos.find((x) => x.id === photoId);
  if (!p) return;
  anno.photoId = photoId;
  anno.ops = JSON.parse(JSON.stringify(p.annotations || []));
  anno.cur = null;
  $("#annoTitle").textContent = `Annotate — Photo ${indexOf(photoId) + 1} (${p.fileName})`;
  $("#annoModal").hidden = false;

  busy("Loading image…");
  try {
    anno.img = await loadImage(p.dataURL);
  } catch (e) {
    busyDone(); toast("Could not load image."); $("#annoModal").hidden = true; return;
  }
  busyDone();

  // fit canvas to wrapper
  const wrap = $("#annoCanvasWrap");
  const maxW = wrap.clientWidth - 24, maxH = wrap.clientHeight - 24;
  const sc = Math.min(maxW / p.w, maxH / p.h, 1.5);
  const c = $("#annoCanvas");
  c.width = Math.max(50, Math.round(p.w * sc));
  c.height = Math.max(50, Math.round(p.h * sc));
  annoRedraw();
}

function annoPos(e) {
  const c = $("#annoCanvas"), r = c.getBoundingClientRect();
  return [
    Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  ];
}

function setupAnnotator() {
  const c = $("#annoCanvas");

  c.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const [x, y] = annoPos(e);
    const sz = SIZES[anno.size];
    if (anno.tool === "text") {
      const txt = prompt("Label text:");
      if (txt && txt.trim()) {
        anno.ops.push({ tool: "text", x, y, text: txt.trim(), color: anno.color, size: sz.f });
        annoRedraw();
      }
      return;
    }
    anno.drawing = true;
    c.setPointerCapture(e.pointerId);
    if (anno.tool === "draw") {
      anno.cur = { tool: "draw", pts: [[x, y]], color: anno.color, w: sz.w };
    } else {
      anno.cur = { tool: anno.tool, x1: x, y1: y, x2: x, y2: y, color: anno.color, w: sz.w };
    }
  });

  c.addEventListener("pointermove", (e) => {
    if (!anno.drawing || !anno.cur) return;
    const [x, y] = annoPos(e);
    if (anno.cur.tool === "draw") anno.cur.pts.push([x, y]);
    else { anno.cur.x2 = x; anno.cur.y2 = y; }
    annoRedraw();
  });

  const finish = () => {
    if (!anno.drawing) return;
    anno.drawing = false;
    if (anno.cur) {
      const o = anno.cur;
      const moved = o.tool === "draw"
        ? o.pts.length > 2
        : Math.abs(o.x2 - o.x1) > 0.004 || Math.abs(o.y2 - o.y1) > 0.004;
      if (moved) anno.ops.push(o);
      anno.cur = null;
      annoRedraw();
    }
  };
  c.addEventListener("pointerup", finish);
  c.addEventListener("pointercancel", finish);

  $$("#annoTools .tool").forEach((b) => {
    b.addEventListener("click", () => {
      $$("#annoTools .tool").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      anno.tool = b.dataset.tool;
    });
  });
  $("#annoTools .tool").classList.add("active");

  $$("#annoColors .swatch").forEach((b) => {
    b.addEventListener("click", () => {
      $$("#annoColors .swatch").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      anno.color = b.dataset.color;
    });
  });

  $("#annoSize").addEventListener("change", (e) => { anno.size = e.target.value; });
  $("#annoUndo").addEventListener("click", () => { anno.ops.pop(); annoRedraw(); });
  $("#annoClear").addEventListener("click", () => {
    if (anno.ops.length && confirm("Remove all annotations from this photo?")) { anno.ops = []; annoRedraw(); }
  });

  const close = () => { $("#annoModal").hidden = true; anno.img = null; };
  $("#annoClose").addEventListener("click", close);
  $("#annoCancel").addEventListener("click", close);

  $("#annoSave").addEventListener("click", async () => {
    const p = state.photos.find((x) => x.id === anno.photoId);
    if (!p) { close(); return; }
    p.annotations = anno.ops;
    busy("Applying annotations…");
    try { await bakePhoto(p); } finally { busyDone(); }
    markDirty();
    close();
    refresh();
  });
}

async function bakePhoto(p) {
  if (!p.annotations || !p.annotations.length) {
    p.annotatedDataURL = null;
    p.annotatedThumbURL = null;
    return;
  }
  const img = await loadImage(p.dataURL);
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  for (const op of p.annotations) drawOp(ctx, op, c.width, c.height);
  p.annotatedDataURL = c.toDataURL("image/jpeg", 0.88);
  const tc = scaleToCanvas(c, THUMB_DIM);
  p.annotatedThumbURL = tc.toDataURL("image/jpeg", 0.75);
}

/* ---------------- PDF export ---------------- */

const PT = { pageW: 612, pageH: 792, margin: 48 };

function pdfHeader(doc, pageNum, totalPages) {
  const m = state.meta, { pageW, margin } = PT;
  doc.setTextColor(30, 39, 51);
  doc.setFont("helvetica", "bold"); doc.setFontSize(11);
  doc.text(m.projectName || "Photographic Log", margin, 44, { maxWidth: 330 });
  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(100, 116, 139);
  const sub = [m.client, m.site].filter(Boolean).join("  •  ");
  if (sub) doc.text(sub, margin, 57, { maxWidth: 330 });

  doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(30, 39, 51);
  doc.text("PHOTOGRAPHIC LOG", pageW - margin, 44, { align: "right" });
  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(100, 116, 139);
  const right2 = [m.projectNumber ? "Project No. " + m.projectNumber : "", m.dateRange].filter(Boolean).join("  •  ");
  if (right2) doc.text(right2, pageW - margin, 57, { align: "right" });

  doc.setDrawColor(180, 190, 200); doc.setLineWidth(0.8);
  doc.line(margin, 66, pageW - margin, 66);
}

function pdfFooter(doc, pageNum, totalPages) {
  const m = state.meta, { pageW, pageH, margin } = PT;
  const y = pageH - 30;
  doc.setDrawColor(180, 190, 200); doc.setLineWidth(0.8);
  doc.line(margin, y - 12, pageW - margin, y - 12);
  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(100, 116, 139);
  const left = m.footerText || [m.photographer, m.client].filter(Boolean).join(" — ");
  if (left) doc.text(left, margin, y, { maxWidth: 380 });
  doc.text(`Page ${pageNum} of ${totalPages}`, pageW - margin, y, { align: "right" });
}

function cellRects(layout) {
  const { pageW, pageH, margin } = PT;
  const x = margin, y = 80;
  const w = pageW - margin * 2;          // 516
  const h = pageH - y - 56;              // 656
  const gap = 16;
  if (layout === 1) return [{ x, y, w, h }];
  if (layout === 2) {
    const ch = (h - gap) / 2;
    return [{ x, y, w, h: ch }, { x, y: y + ch + gap, w, h: ch }];
  }
  const cw = (w - gap) / 2, ch = (h - gap) / 2;
  return [
    { x, y, w: cw, h: ch }, { x: x + cw + gap, y, w: cw, h: ch },
    { x, y: y + ch + gap, w: cw, h: ch }, { x: x + cw + gap, y: y + ch + gap, w: cw, h: ch },
  ];
}

function pdfPhotoCell(doc, p, idx, cell, layout) {
  const capH = layout === 4 ? 92 : layout === 2 ? 82 : 100;
  const imgAreaH = cell.h - capH;

  // fit image
  const sc = Math.min(cell.w / p.w, imgAreaH / p.h);
  const iw = p.w * sc, ih = p.h * sc;
  const ix = cell.x + (cell.w - iw) / 2;
  const iy = cell.y + (imgAreaH - ih) / 2;
  doc.addImage(exportImage(p), "JPEG", ix, iy, iw, ih, undefined, "FAST");
  doc.setDrawColor(150, 160, 170); doc.setLineWidth(0.6);
  doc.rect(ix, iy, iw, ih);

  // caption block
  let ty = cell.y + imgAreaH + 13;
  doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(30, 39, 51);
  doc.text(`Photo ${idx + 1}`, cell.x, ty);
  const meta = metaLine(p);
  let metaLines = 1;
  if (meta) {
    doc.setFont("helvetica", "italic"); doc.setFontSize(7.5); doc.setTextColor(100, 116, 139);
    metaLines = doc.splitTextToSize(meta, cell.w - 55).length;
    doc.text(meta, cell.x + cell.w, ty, { align: "right", maxWidth: cell.w - 55 });
  }
  ty += 12 + (metaLines - 1) * 9;
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(30, 39, 51);
  const lineH = 11;
  const maxLines = Math.max(1, Math.floor((cell.y + cell.h - ty) / lineH));
  let lines = doc.splitTextToSize(p.caption.trim() || " ", cell.w);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{2}$/, "") + "…";
  }
  doc.text(lines, cell.x, ty + 8);
}

function buildPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "letter", compress: true });
  const layout = state.settings.layout;
  const totalPages = Math.ceil(state.photos.length / layout);

  for (let pg = 0; pg < totalPages; pg++) {
    if (pg > 0) doc.addPage();
    pdfHeader(doc, pg + 1, totalPages);
    pdfFooter(doc, pg + 1, totalPages);
    const cells = cellRects(layout);
    for (let k = 0; k < layout; k++) {
      const idx = pg * layout + k;
      if (idx >= state.photos.length) break;
      pdfPhotoCell(doc, state.photos[idx], idx, cells[k], layout);
    }
  }
  return doc;
}

function exportPDF() {
  if (!state.photos.length) { toast("Import photos first."); return; }
  busy("Building PDF…");
  setTimeout(() => {
    try {
      const doc = buildPDF();
      doc.save(exportFileName("pdf"));
      toast("PDF exported.");
    } catch (e) {
      console.error(e); toast("PDF export failed: " + e.message, 5000);
    } finally { busyDone(); }
  }, 30);
}

/* ---------------- DOCX export ---------------- */

const D = () => window.docx;

function docxFit(p, maxW, maxH) {
  const sc = Math.min(maxW / p.w, maxH / p.h);
  return { width: Math.round(p.w * sc), height: Math.round(p.h * sc) };
}

function docxPhotoParas(p, idx, maxW, maxH) {
  const d = D();
  const dims = docxFit(p, maxW, maxH);
  // keepNext/keepLines chain the image, title, and caption so Word never
  // separates them across a page break
  const paras = [
    new d.Paragraph({
      alignment: d.AlignmentType.CENTER,
      keepNext: true,
      keepLines: true,
      children: [new d.ImageRun({ data: dataURLtoU8(exportImage(p)), transformation: dims })],
    }),
    new d.Paragraph({
      spacing: { before: 80 },
      keepNext: true,
      keepLines: true,
      children: [
        new d.TextRun({ text: `Photo ${idx + 1}`, bold: true, size: 20 }),
        ...(metaLine(p) ? [new d.TextRun({ text: "    " + metaLine(p), italics: true, size: 16, color: "64748B" })] : []),
      ],
    }),
    new d.Paragraph({
      spacing: { before: 40 },
      keepLines: true,
      children: [new d.TextRun({ text: p.caption.trim() || "(no caption)", size: 20 })],
    }),
  ];
  return paras;
}

function docxCell(p, idx, maxW, maxH, widthDxa) {
  const d = D();
  return new d.TableCell({
    width: { size: widthDxa, type: d.WidthType.DXA },
    margins: { top: 110, bottom: 110, left: 110, right: 110 },
    verticalAlign: d.VerticalAlign.TOP,
    children: docxPhotoParas(p, idx, maxW, maxH),
  });
}

function buildDOCX() {
  const d = D();
  const m = state.meta;
  const layout = state.settings.layout;
  const photos = state.photos;
  const border = { style: d.BorderStyle.SINGLE, size: 4, color: "9AA5B0" };
  const borders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };

  const children = [];
  const totalPages = Math.ceil(photos.length / layout);

  for (let pg = 0; pg < totalPages; pg++) {
    const chunk = photos.slice(pg * layout, pg * layout + layout);
    if (layout === 4) {
      const rows = [];
      for (let r = 0; r < 2; r++) {
        const cells = [];
        for (let cI = 0; cI < 2; cI++) {
          const k = r * 2 + cI;
          const idx = pg * layout + k;
          if (chunk[k]) cells.push(docxCell(chunk[k], idx, 270, 200, 4680));
          else cells.push(new d.TableCell({ width: { size: 4680, type: d.WidthType.DXA }, borders: { top: { style: d.BorderStyle.NONE }, bottom: { style: d.BorderStyle.NONE }, left: { style: d.BorderStyle.NONE }, right: { style: d.BorderStyle.NONE } }, children: [new d.Paragraph("")] }));
        }
        rows.push(new d.TableRow({ children: cells, cantSplit: true }));
        if (r === 0 && !chunk[2] && !chunk[3]) break;
      }
      children.push(new d.Table({ rows, width: { size: 9360, type: d.WidthType.DXA }, borders }));
    } else {
      const maxW = layout === 1 ? 580 : 540;
      const maxH = layout === 1 ? 540 : 290;
      chunk.forEach((p, k) => {
        const idx = pg * layout + k;
        children.push(new d.Table({
          rows: [new d.TableRow({ children: [docxCell(p, idx, maxW, maxH, 9360)], cantSplit: true })],
          width: { size: 9360, type: d.WidthType.DXA },
          borders,
        }));
        if (layout === 2 && k === 0 && chunk.length > 1) {
          children.push(new d.Paragraph({ spacing: { before: 120, after: 120 }, children: [] }));
        }
      });
    }
    if (pg < totalPages - 1) {
      children.push(new d.Paragraph({ children: [new d.PageBreak()] }));
    }
  }

  const headerLeft = [m.projectName || "Photographic Log", [m.client, m.site].filter(Boolean).join(" • ")].filter(Boolean);
  const headerRight = ["PHOTOGRAPHIC LOG", [m.projectNumber ? "Project No. " + m.projectNumber : "", m.dateRange].filter(Boolean).join(" • ")].filter(Boolean);

  const header = new d.Header({
    children: [
      new d.Paragraph({
        tabStops: [{ type: d.TabStopType.RIGHT, position: 9360 }],
        children: [
          new d.TextRun({ text: headerLeft[0], bold: true, size: 22 }),
          new d.TextRun({ text: "\t" }),
          new d.TextRun({ text: headerRight[0], bold: true, size: 22 }),
        ],
      }),
      new d.Paragraph({
        tabStops: [{ type: d.TabStopType.RIGHT, position: 9360 }],
        border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: "9AA5B0", space: 4 } },
        children: [
          new d.TextRun({ text: headerLeft[1] || "", size: 17, color: "64748B" }),
          new d.TextRun({ text: "\t" }),
          new d.TextRun({ text: headerRight[1] || "", size: 17, color: "64748B" }),
        ],
      }),
    ],
  });

  const footerLeft = m.footerText || [m.photographer, m.client].filter(Boolean).join(" — ");
  const footer = new d.Footer({
    children: [
      new d.Paragraph({
        tabStops: [{ type: d.TabStopType.RIGHT, position: 9360 }],
        border: { top: { style: d.BorderStyle.SINGLE, size: 6, color: "9AA5B0", space: 4 } },
        children: [
          new d.TextRun({ text: footerLeft || "", size: 16, color: "64748B" }),
          new d.TextRun({ text: "\t" }),
          new d.TextRun({ children: ["Page ", d.PageNumber.CURRENT, " of ", d.PageNumber.TOTAL_PAGES], size: 16, color: "64748B" }),
        ],
      }),
    ],
  });

  return new d.Document({
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 }, // letter, twips
          margin: { top: 1080, bottom: 1080, left: 1440, right: 1440 },
        },
      },
      headers: { default: header },
      footers: { default: footer },
      children,
    }],
  });
}

function exportDOCX() {
  if (!state.photos.length) { toast("Import photos first."); return; }
  busy("Building DOCX…");
  setTimeout(async () => {
    try {
      const doc = buildDOCX();
      const blob = await D().Packer.toBlob(doc);
      saveBlob(blob, exportFileName("docx"));
      toast("DOCX exported.");
    } catch (e) {
      console.error(e); toast("DOCX export failed: " + e.message, 5000);
    } finally { busyDone(); }
  }, 30);
}

function exportFileName(ext) {
  const base = (state.meta.projectNumber || state.meta.projectName || "photo-log")
    .replace(/[\\/:*?"<>|]+/g, "-").trim() || "photo-log";
  return `${base} Photo Log.${ext}`;
}

/* ---------------- update checker ---------------- */

function versionNewer(a, b) {
  // true if version string a > b  (e.g. "1.3.1" > "1.3.0")
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function checkForUpdates() {
  if (UPDATE_REPO.startsWith("__")) return; // not configured
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!res.ok) return;
    const rel = await res.json();
    const latest = String(rel.tag_name || "").replace(/^v/i, "");
    if (!latest || !versionNewer(latest, APP_VERSION)) return;
    if (localStorage.getItem("photolog.skipVersion") === latest) return; // user dismissed this one
    showUpdateBanner(latest, rel.html_url);
  } catch (e) { /* offline or rate-limited — stay quiet */ }
}

function showUpdateBanner(latest, url) {
  if ($("#updateBanner")) return;
  const bar = document.createElement("div");
  bar.id = "updateBanner";
  bar.innerHTML = `
    <span>&#11014; Photo Log <b>v${esc(latest)}</b> is available (you have v${APP_VERSION}).</span>
    <a href="${esc(url)}" target="_blank" rel="noopener">Download update</a>
    <span class="spacer"></span>
    <button id="updateDismiss" title="Hide until the next version">Dismiss</button>`;
  document.body.insertBefore(bar, document.body.firstChild);
  $("#updateDismiss").addEventListener("click", () => {
    try { localStorage.setItem("photolog.skipVersion", latest); } catch (e) { /* ignore */ }
    bar.remove();
  });
}

/* ---------------- AI captions (Claude vision) ---------------- */
/* Direct browser->API calls (no server in this zero-install app), so raw
   fetch rather than the Node SDK. Requires the user's own Anthropic API key. */

const AI_API_URL = "https://api.anthropic.com/v1/messages";
const AI_MAX_IMG = 1200; // px long edge sent to the API — plenty for captioning

const AI_SYSTEM = [
  "You write captions for photographs in environmental consulting photographic logs",
  "(Phase I/II ESAs, construction monitoring, remediation, and site assessments).",
  "",
  "Rules:",
  "- Respond with the caption text only — no preamble, no quotes, no markdown.",
  "- One or two short sentences, objective and factual.",
  "- Describe only what is visible; never speculate about contamination or conditions you cannot see.",
  "- Use standard field terminology where it applies (soil stockpile, groundwater monitoring well,",
  "  secondary containment, staging area, erosion and sediment controls, BMP, boring location, etc.).",
  "- If a camera direction is provided, begin the caption with \"View facing <direction> of\".",
  "- Match the style of the example captions from this log when provided.",
  "- Do not restate the project name, photo number, or date in the caption.",
].join("\n");

function aiGetKey() { return (localStorage.getItem("photolog.aiKey") || "").trim(); }
function aiGetModel() { return localStorage.getItem("photolog.aiModel") || "claude-opus-4-8"; }

function aiContextText(p, idx) {
  const m = state.meta;
  const lines = [];
  if (m.projectName) lines.push(`Project: ${m.projectName}`);
  if (m.site) lines.push(`Site: ${m.site}`);
  if (p.direction) lines.push(`Camera facing: ${p.direction}`);
  if (p.exifDate) lines.push(`Taken: ${fmtDate(p.exifDate)}`);
  lines.push(`This is photo ${idx + 1} of ${state.photos.length} in the log.`);
  const examples = state.photos
    .filter((q, i) => i !== idx && q.caption.trim())
    .slice(0, 5)
    .map((q) => `- ${q.caption.trim()}`);
  if (examples.length) {
    lines.push("", "Example captions already written in this log (match their style):", ...examples);
  }
  lines.push("", "Write the caption for the attached photo.");
  return lines.join("\n");
}

async function aiImageBase64(p) {
  const img = await loadImage(exportImage(p));
  const c = scaleToCanvas(img, AI_MAX_IMG);
  return c.toDataURL("image/jpeg", 0.8).split(",")[1];
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function callClaude(body, attempt = 0) {
  let res;
  try {
    res = await fetch(AI_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": aiGetKey(),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("Could not reach the Anthropic API — check your internet connection.");
  }
  // retry transient failures (rate limit / overload / server error)
  if ((res.status === 429 || res.status >= 500) && attempt < 2) {
    const wait = Number(res.headers.get("retry-after")) || 2 * (attempt + 1);
    await sleep(wait * 1000);
    return callClaude(body, attempt + 1);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) throw new Error("Invalid API key — check it under AI Captions in the sidebar.");
    if (res.status === 429) throw new Error("Rate limited by the API — wait a minute and try again.");
    throw new Error((data && data.error && data.error.message) || `API error (HTTP ${res.status})`);
  }
  return data;
}

async function aiSuggestCaption(p, idx) {
  if (!aiGetKey()) throw new Error("Enter your Anthropic API key under AI Captions in the sidebar first.");
  const b64 = await aiImageBase64(p);
  const resp = await callClaude({
    model: aiGetModel(),
    max_tokens: 300,
    system: AI_SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
        { type: "text", text: aiContextText(p, idx) },
      ],
    }],
  });
  if (resp.stop_reason === "refusal") throw new Error("The model declined to caption this photo.");
  const text = (resp.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim()
    .replace(/^["'“]|["'”]$/g, "");
  if (!text) throw new Error("The API returned no caption text.");
  return text;
}

async function aiCaptionOne(photoId) {
  const idx = indexOf(photoId);
  const p = state.photos[idx];
  if (!p) return;
  if (p.caption.trim() && !confirm(`Photo ${idx + 1} already has a caption. Replace it with an AI draft?`)) return;
  busy(`Claude is drafting a caption for Photo ${idx + 1}…`);
  try {
    p.caption = await aiSuggestCaption(p, idx);
    markDirty();
    refresh();
    if (capIdx === idx && !$("#capModal").hidden) renderCapEditor();
    toast("Caption drafted — review and edit as needed.");
  } catch (e) {
    console.error(e);
    toast(e.message, 5000);
  } finally {
    busyDone();
  }
}

async function aiCaptionAll() {
  if (!state.photos.length) { toast("Import photos first."); return; }
  if (!aiGetKey()) { toast("Enter your Anthropic API key under AI Captions first.", 4500); return; }
  const targets = state.photos.filter((p) => !p.caption.trim());
  if (!targets.length) { toast("Every photo already has a caption."); return; }
  if (!confirm(`Have Claude draft captions for ${targets.length} uncaptioned photo${targets.length === 1 ? "" : "s"}?\n\nDrafts appear in the caption boxes for your review — nothing is exported automatically.`)) return;

  let done = 0, failed = 0;
  for (const p of targets) {
    busy(`Claude is captioning photo ${done + failed + 1} of ${targets.length}…`);
    try {
      p.caption = await aiSuggestCaption(p, indexOf(p.id));
      markDirty();
      done++;
    } catch (e) {
      console.error("AI caption failed:", e);
      failed++;
      if (/API key|internet/.test(e.message)) {   // no point continuing the batch
        busyDone(); refresh();
        toast(e.message, 5000);
        return;
      }
    }
  }
  busyDone();
  refresh();
  toast(`Drafted ${done} caption${done === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""} — review each before exporting.`, 5500);
}

function setupAI() {
  const keyInput = $("#ai_key"), modelSel = $("#ai_model");
  keyInput.value = aiGetKey();
  modelSel.value = aiGetModel();
  keyInput.addEventListener("input", () => {
    try { localStorage.setItem("photolog.aiKey", keyInput.value.trim()); } catch (e) { /* ignore */ }
  });
  modelSel.addEventListener("change", () => {
    try { localStorage.setItem("photolog.aiModel", modelSel.value); } catch (e) { /* ignore */ }
  });
  $("#btnAICaptionAll").addEventListener("click", aiCaptionAll);
  $("#capAI").addEventListener("click", () => {
    const p = state.photos[capIdx];
    if (p) aiCaptionOne(p.id);
  });
}

/* ---------------- feedback ---------------- */

function buildFeedbackIssue() {
  const name = $("#fbName").value.trim();
  const type = $("#fbType").value;
  const sev = $("#fbSev").value;
  const summary = $("#fbSummary").value.trim();
  const details = $("#fbDetails").value.trim();

  const title = `[${type === "Feature request" ? "Feature" : type}] ${summary.slice(0, 120)}`;
  const lines = [
    `**Type:** ${type}   **Severity:** ${sev}`,
    name ? `**Submitted by:** ${name}` : null,
    "",
    "### Details / steps to reproduce",
    details || "_(none provided)_",
  ].filter((l) => l !== null);
  if ($("#fbDiag").checked) {
    lines.push(
      "",
      "### Diagnostics",
      `- App version: ${APP_VERSION}`,
      `- Photos in project: ${state.photos.length}`,
      `- Platform: ${navigator.platform} — ${navigator.userAgent}`
    );
  }
  const body = lines.join("\n");
  const url = `https://github.com/${UPDATE_REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  return { title, body, url };
}

function setupFeedback() {
  const close = () => { $("#fbModal").hidden = true; };
  $("#btnFeedback").addEventListener("click", () => { $("#fbModal").hidden = false; $("#fbSummary").focus(); });
  $("#fbClose").addEventListener("click", close);
  $("#fbCancel").addEventListener("click", close);

  const validate = () => {
    if (!$("#fbSummary").value.trim()) {
      toast("Please enter a one-line summary first.");
      $("#fbSummary").focus();
      return false;
    }
    return true;
  };

  $("#fbSend").addEventListener("click", () => {
    if (!validate()) return;
    const { url } = buildFeedbackIssue();
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("GitHub opened with your report pre-filled — click “Submit new issue”.", 4500);
    close();
  });

  $("#fbCopy").addEventListener("click", async () => {
    if (!validate()) return;
    const { title, body } = buildFeedbackIssue();
    const text = `${title}\n\n${body}\n\nSubmit at: https://github.com/${UPDATE_REPO}/issues/new`;
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied — paste into a new issue at github.com/" + UPDATE_REPO);
    } catch (e) {
      // clipboard API can be blocked on file:// — fall back to a prompt
      window.prompt("Copy this text (Ctrl+C), then paste into a GitHub issue:", text);
    }
  });
}

/* ---------------- save / open project ---------------- */

function saveProject() {
  const data = {
    app: "photo-log",
    version: 2,
    savedAt: new Date().toISOString(),
    meta: state.meta,
    settings: state.settings,
    templates: state.templates,
    photos: state.photos.map((p) => ({
      id: p.id, fileName: p.fileName, dataURL: p.dataURL,
      w: p.w, h: p.h, caption: p.caption, direction: p.direction,
      exifDate: p.exifDate, lat: p.lat, lon: p.lon,
      annotations: p.annotations,
    })),
  };
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const base = (state.meta.projectNumber || state.meta.projectName || "photo-log")
    .replace(/[\\/:*?"<>|]+/g, "-").trim() || "photo-log";
  saveBlob(blob, `${base}.photolog`);
  dirty = false;
  toast("Project saved. Keep the .photolog file to reopen and edit later.");
}

async function openProject(file) {
  busy("Opening project…");
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data.app !== "photo-log" || !Array.isArray(data.photos)) {
      throw new Error("Not a valid .photolog project file.");
    }
    const fresh = blankState();
    state = fresh;
    state.meta = Object.assign(fresh.meta, data.meta || {});
    state.settings = Object.assign(fresh.settings, data.settings || {});
    if (Array.isArray(data.templates) && data.templates.length) state.templates = data.templates;
    state.photos = data.photos.map((p) => ({
      id: p.id || uid(),
      fileName: p.fileName || "photo.jpg",
      dataURL: p.dataURL,
      thumbURL: null,
      w: p.w, h: p.h,
      caption: p.caption || "", direction: p.direction || "",
      exifDate: p.exifDate || null,
      lat: p.lat ?? null, lon: p.lon ?? null,
      annotations: Array.isArray(p.annotations) ? p.annotations : [],
      annotatedDataURL: null, annotatedThumbURL: null,
    }));

    // regenerate thumbnails + baked annotation images
    for (let i = 0; i < state.photos.length; i++) {
      busy(`Preparing photo ${i + 1} of ${state.photos.length}…`);
      const p = state.photos[i];
      try {
        const img = await loadImage(p.dataURL);
        if (!p.w || !p.h) { p.w = img.naturalWidth; p.h = img.naturalHeight; }
        p.thumbURL = scaleToCanvas(img, THUMB_DIM).toDataURL("image/jpeg", 0.75);
        if (p.annotations.length) await bakePhoto(p);
      } catch (e) { console.error("thumb regen failed", e); p.thumbURL = p.dataURL; }
    }

    dirty = false;
    syncFormsFromState();
    refresh();
    toast(`Opened project with ${state.photos.length} photos.`);
  } catch (e) {
    console.error(e);
    alert("Could not open project file:\n" + e.message);
  } finally {
    busyDone();
  }
}

function newProject() {
  if (dirty && !confirm("Discard unsaved changes and start a new project?")) return;
  state = blankState();
  dirty = false;
  syncFormsFromState();
  refresh();
}

function syncFormsFromState() {
  $$("[data-meta]").forEach((el) => { el.value = state.meta[el.dataset.meta] || ""; });
  $$("[data-setting]").forEach((el) => { el.checked = !!state.settings[el.dataset.setting]; });
  $$("#layoutPicker button").forEach((b) =>
    b.classList.toggle("active", Number(b.dataset.layout) === state.settings.layout));
}

/* ---------------- wiring ---------------- */

function setup() {
  // sidebar meta fields
  $$("[data-meta]").forEach((el) => {
    el.addEventListener("input", () => {
      state.meta[el.dataset.meta] = el.value;
      markDirty();
      const name = state.meta.projectName || state.meta.projectNumber;
      $("#projectTitle").textContent = name || "Untitled project";
      document.title = (name ? name + " — " : "") + "Photo Log";
    });
  });
  $$("[data-setting]").forEach((el) => {
    el.addEventListener("change", () => { state.settings[el.dataset.setting] = el.checked; markDirty(); });
  });
  $$("#layoutPicker button").forEach((b) => {
    b.addEventListener("click", () => {
      state.settings.layout = Number(b.dataset.layout);
      markDirty();
      $$("#layoutPicker button").forEach((x) => x.classList.toggle("active", x === b));
    });
  });

  // topbar
  $("#btnNew").addEventListener("click", newProject);
  $("#btnOpen").addEventListener("click", () => $("#openInput").click());
  $("#openInput").addEventListener("change", (e) => {
    if (e.target.files[0]) {
      if (!dirty || confirm("Discard unsaved changes and open another project?")) openProject(e.target.files[0]);
    }
    e.target.value = "";
  });
  $("#btnSave").addEventListener("click", saveProject);
  $("#btnImport").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", (e) => { importFiles(e.target.files); e.target.value = ""; });
  $("#btnSortDate").addEventListener("click", () => {
    if (!state.photos.length) return;
    state.photos.sort((a, b) => {
      if (a.exifDate && b.exifDate) return a.exifDate < b.exifDate ? -1 : a.exifDate > b.exifDate ? 1 : 0;
      if (a.exifDate) return -1;
      if (b.exifDate) return 1;
      return 0;
    });
    markDirty(); refresh();
    toast("Sorted by capture date (photos without a date go last).");
  });
  $("#btnCaptions").addEventListener("click", () => openCaptionEditor(0));
  $("#btnQC").addEventListener("click", () => {
    const p = $("#qcPanel");
    p.hidden = !p.hidden;
    if (!p.hidden) renderQC();
  });

  // export
  $("#btnPDF").addEventListener("click", exportPDF);
  $("#btnDOCX").addEventListener("click", exportDOCX);

  // templates
  $("#tplAdd").addEventListener("click", () => {
    const v = $("#tplNew").value.trim();
    if (!v) return;
    state.templates.push(v);
    $("#tplNew").value = "";
    storeTemplates(); markDirty(); renderTemplates(); renderCapChips();
  });
  $("#tplNew").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#tplAdd").click(); });

  // caption modal
  $("#capClose").addEventListener("click", closeCaptionEditor);
  $("#capPrev").addEventListener("click", () => capStep(-1));
  $("#capNext").addEventListener("click", () => capStep(1));
  $("#capText").addEventListener("input", (e) => {
    const p = state.photos[capIdx];
    if (p) { p.caption = e.target.value; markDirty(); }
  });
  $("#capDir").addEventListener("input", (e) => {
    const p = state.photos[capIdx];
    if (p) { p.direction = e.target.value; markDirty(); }
  });
  $("#capModal").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); capStep(1); }
  });

  // drag & drop import onto main area
  const main = $("#main");
  main.addEventListener("dragover", (e) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      main.classList.add("dragover");
    }
  });
  main.addEventListener("dragleave", (e) => {
    if (e.target === main) main.classList.remove("dragover");
  });
  main.addEventListener("drop", (e) => {
    main.classList.remove("dragover");
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      e.preventDefault();
      importFiles(e.dataTransfer.files);
    }
  });

  // global keys
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#annoModal").hidden) { $("#annoModal").hidden = true; anno.img = null; }
      else if (!$("#capModal").hidden) closeCaptionEditor();
      else if (!$("#fbModal").hidden) $("#fbModal").hidden = true;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveProject();
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  setupAnnotator();
  setupFeedback();
  setupAI();
  syncFormsFromState();
  refresh();
  checkForUpdates();
}

document.addEventListener("DOMContentLoaded", setup);

/* test/debug hook */
window.PhotoLog = {
  get state() { return state; },
  refresh, importFiles, buildPDF, buildDOCX, bakePhoto, openProject, buildFeedbackIssue,
  aiSuggestCaption, aiCaptionAll, checkForUpdates, versionNewer,
  addPhotoRecord(rec) { state.photos.push(rec); markDirty(); refresh(); },
};
