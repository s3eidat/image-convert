/* Image Convert — decode with the browser, re-encode with <canvas>. Nothing is uploaded.
   SVGs are only ever drawn through <img> from a blob URL, so scripts inside them never run. */
(function () {
  "use strict";
  const $ = S3.$, $$ = S3.$$;
  const MAX_SIDE = 16384, MAX_AREA = 40e6;
  const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif" };
  const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" };
  const saved = S3.store("convert") || {};
  const opts = { format: saved.format || "png", quality: saved.quality || 92, bg: saved.bg || "#ffffff", flatten: !!saved.flatten };
  const enc = { "image/webp": false, "image/avif": false };
  let items = [], run = 0, queue = Promise.resolve(), nextId = 1;

  // ---------- pipeline ----------
  function canvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
  function canEncode(type) { return new Promise(res => canvas(2, 2).toBlob(b => res(!!b && b.type === type), type, 0.5)); }
  function toBlob(c, type, q) {
    return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error("The browser could not encode this image (too large?)")), type, q));
  }
  function isSvg(file) { return file.type === "image/svg+xml" || /\.svgz?$/i.test(file.name); }
  // Size of an SVG from its width/height or viewBox (parsed inertly, never rendered as a document).
  function svgSize(text) {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml"), el = doc.documentElement;
    if (!el || el.nodeName.toLowerCase() !== "svg") throw new Error("Not a valid SVG file");
    const num = v => { const m = /^\s*([\d.]+)\s*(px)?\s*$/.exec(v || ""); return m ? parseFloat(m[1]) : 0; };
    const vb = (el.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    let w = num(el.getAttribute("width")), h = num(el.getAttribute("height"));
    const vw = vb.length === 4 ? vb[2] : 0, vh = vb.length === 4 ? vb[3] : 0;
    if (!w && !h && vw && vh) { w = vw; h = vh; } else if (w && !h && vw && vh) h = w * vh / vw; else if (h && !w && vw && vh) w = h * vw / vh;
    if (!w || !h) { w = 1024; h = 1024; }
    return { w: Math.round(w), h: Math.round(h) };
  }
  async function decode(file) {
    let blob = file, size = null;
    if (isSvg(file)) { size = svgSize(await file.text()); blob = new Blob([await file.arrayBuffer()], { type: "image/svg+xml" }); }
    const url = URL.createObjectURL(blob), img = new Image();
    img.src = url;
    try { await img.decode(); } catch (e) { URL.revokeObjectURL(url); throw new Error("Can't read this image (unsupported or damaged)"); }
    const w = size ? size.w : img.naturalWidth, h = size ? size.h : img.naturalHeight;
    if (!w || !h) { URL.revokeObjectURL(url); throw new Error("This image has no size"); }
    return { img, url, w, h };
  }
  function fit(w, h) {
    let s = 1;
    if (w * h > MAX_AREA) s = Math.sqrt(MAX_AREA / (w * h));
    if (Math.max(w, h) * s > MAX_SIDE) s = MAX_SIDE / Math.max(w, h);
    return { w: Math.max(1, Math.floor(w * s + 1e-6)), h: Math.max(1, Math.floor(h * s + 1e-6)), scaled: s < 1 };
  }
  async function convert(src, o) {
    const type = MIME[o.format], f = fit(src.w, src.h), c = canvas(f.w, f.h), x = c.getContext("2d");
    if (type === "image/jpeg" || o.flatten) { x.fillStyle = o.bg; x.fillRect(0, 0, f.w, f.h); }
    x.imageSmoothingQuality = "high";
    x.drawImage(src.img, 0, 0, f.w, f.h);
    const blob = await toBlob(c, type, o.quality / 100);
    if (blob.type !== type) throw new Error("This browser can't write " + EXT[type].toUpperCase());
    return { blob, type, w: f.w, h: f.h, scaled: f.scaled };
  }
  function outName(name, type) { return name.replace(/\.[^.]+$/, "") + "." + EXT[type]; }
  function kind(file) { return isSvg(file) ? "SVG" : ((file.type.split("/")[1] || file.name.split(".").pop() || "?").replace("jpeg", "jpg").replace(/^x-ms-/, "").toUpperCase()); }

  // ---------- UI ----------
  const tiles = $("#tiles");
  function seg(el, value, onPick) {
    $$("button", el).forEach(b => {
      b.setAttribute("aria-pressed", String(b.dataset.v === value));
      b.addEventListener("click", () => { $$("button", el).forEach(x => x.setAttribute("aria-pressed", String(x === b))); onPick(b.dataset.v); });
    });
  }
  function save() { S3.store("convert", opts); $("#qfield").classList.toggle("off", opts.format === "png"); $("#quality").disabled = opts.format === "png"; }

  function addFiles(files) {
    const fresh = files.map(f => ({ id: nextId++, file: f }));
    items = items.concat(fresh);
    fresh.forEach(it => { it.el = S3.h("li", { "class": "cv-tile" }); tiles.appendChild(it.el); render(it); });
    refresh();
    return Promise.all(fresh.map(it => enqueue(it, run)));
  }
  function enqueue(it, my) { queue = queue.then(() => work(it, my)); return queue; }
  async function work(it, my) {
    if (my !== run || items.indexOf(it) < 0 || it.bad) return;
    it.busy = true; render(it);
    try {
      if (!it.src) it.src = await decode(it.file);
      const r = await convert(it.src, opts);
      if (my !== run || items.indexOf(it) < 0) return;
      if (it.res) URL.revokeObjectURL(it.res.url);
      r.url = URL.createObjectURL(r.blob); it.res = r; it.err = null;
    } catch (e) { it.err = e.message || "Failed"; it.bad = !it.src; }
    finally { it.busy = false; render(it); refresh(); }
  }
  function reconvert() {
    save(); run++;
    const my = run;
    return Promise.all(items.map(it => enqueue(it, my))).then(() => { if (items.some(it => it.res)) S3.done(); });
  }
  function render(it) {
    const r = it.res, f = it.file;
    const pic = r && !it.busy ? '<img alt="" src="' + r.url + '">' : it.src ? '<img alt="" src="' + it.src.url + '">' : "";
    const meta = it.err ? '<span class="chip bad">' + S3.esc(it.err) + "</span>"
      : !r || it.busy ? "Converting…"
      : kind(f) + " → " + EXT[r.type].toUpperCase() + " · " + r.w + "×" + r.h + " · " + S3.fmtBytes(r.blob.size) + (r.scaled ? " · scaled to fit" : "");
    it.el.innerHTML = '<div class="cv-pic checker">' + pic + "</div>" +
      '<div class="cv-name" title="' + S3.esc(f.name) + '">' + S3.esc(f.name) + "</div>" +
      '<div class="cv-meta">' + meta + "</div>" +
      '<div class="cv-act"><button class="btn small" data-dl' + (r && !it.busy && !it.err ? "" : " disabled") + '><svg class="i"><use href="#i-download"/></svg>' + (r ? "." + EXT[r.type] : "Save") + "</button>" +
      '<button class="btn ghost small icon" data-rm aria-label="Remove ' + S3.esc(f.name) + '"><svg class="i"><use href="#i-x"/></svg></button></div>';
  }
  function refresh() {
    const ok = items.filter(it => it.res && !it.err);
    $("#empty").hidden = items.length > 0;
    $("#count").textContent = items.length ? ok.length + " of " + items.length : "";
    $("#zip").disabled = !ok.length; $("#clear").disabled = !items.length;
  }
  function remove(it) {
    items = items.filter(x => x !== it); it.el.remove();
    if (it.src) URL.revokeObjectURL(it.src.url);
    if (it.res) URL.revokeObjectURL(it.res.url);
    refresh();
  }
  tiles.addEventListener("click", e => {
    const li = e.target.closest(".cv-tile"), it = items.filter(x => x.el === li)[0];
    if (!it) return;
    if (e.target.closest("[data-rm]")) remove(it);
    else if (e.target.closest("[data-dl]")) { S3.download(it.res.blob, outName(it.file.name, it.res.type)); S3.done(); }
  });

  S3.drop($("#drop"), addFiles, { accept: "image/*,.svg,.bmp,.gif,.webp,.png,.jpg,.jpeg", multiple: true });
  document.addEventListener("paste", e => {
    const fs = Array.prototype.slice.call((e.clipboardData && e.clipboardData.files) || []).filter(f => /^image\//.test(f.type));
    if (fs.length) { e.preventDefault(); addFiles(fs); }
  });
  const q = $("#quality"), redo = S3.debounce(reconvert, 300);
  q.value = opts.quality; $("#qv").textContent = opts.quality + "%";
  q.addEventListener("input", () => { opts.quality = +q.value; $("#qv").textContent = q.value + "%"; redo(); });
  $("#bg").value = opts.bg; $("#bgv").textContent = opts.bg;
  $("#bg").addEventListener("input", e => { opts.bg = e.target.value; $("#bgv").textContent = opts.bg; redo(); });
  $("#flatten").checked = opts.flatten;
  $("#flatten").addEventListener("change", e => { opts.flatten = e.target.checked; reconvert(); });
  $("#clear").addEventListener("click", () => { items.slice().forEach(remove); run++; });
  $("#zip").addEventListener("click", async () => {
    const used = {}, files = [];
    for (const it of items) {
      if (!it.res || it.err) continue;
      let n = outName(it.file.name, it.res.type), base = n, i = 2;
      while (used[n.toLowerCase()]) n = base.replace(/(\.[^.]+)$/, "-" + (i++) + "$1");
      used[n.toLowerCase()] = 1;
      files.push({ name: n, data: new Uint8Array(await it.res.blob.arrayBuffer()) });
    }
    S3.download(S3.zip(files), "converted-images.zip"); S3.done();
  });

  const ready = Promise.all(Object.keys(enc).map(t => canEncode(t).then(ok => { enc[t] = ok; }))).then(() => {
    $("#format [data-v=webp]").hidden = !enc["image/webp"];
    $("#format [data-v=avif]").hidden = !enc["image/avif"];
    if (MIME[opts.format] in enc && !enc[MIME[opts.format]]) opts.format = "png";
    seg($("#format"), opts.format, v => { opts.format = v; reconvert(); });
    save();
  });

  // ---------- samples (drawn locally) ----------
  function sticker(w, h) {
    const c = canvas(w, h), x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, "#3dd6d0"); g.addColorStop(1, "#6d5dfc");
    x.fillStyle = g; x.beginPath(); x.arc(w / 2, h / 2, Math.min(w, h) * 0.42, 0, Math.PI * 2); x.fill();
    x.fillStyle = "#fff"; x.font = "800 " + Math.round(h * 0.22) + "px Inter, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
    x.fillText("S3", w / 2, h / 2);
    return c;
  }
  function landscape(w, h) {
    const c = canvas(w, h), x = c.getContext("2d");
    const sky = x.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, "#14204f"); sky.addColorStop(0.55, "#d85c7f"); sky.addColorStop(1, "#ffb56b");
    x.fillStyle = sky; x.fillRect(0, 0, w, h);
    x.fillStyle = "#ffe3a1"; x.beginPath(); x.arc(w * 0.66, h * 0.58, h * 0.14, 0, Math.PI * 2); x.fill();
    [["#3b2c5e", 0.66, 5], ["#151231", 0.84, 11]].forEach((m, i) => {
      x.fillStyle = m[0]; x.beginPath(); x.moveTo(0, h);
      for (let k = 0; k <= 60; k++) { const px = w * k / 60; x.lineTo(px, h * m[1] - Math.abs(Math.sin(px / w * m[2] + i)) * h * 0.15); }
      x.lineTo(w, h); x.fill();
    });
    return c;
  }
  // Minimal 24-bit BMP writer, so the self-test can prove BMP input works without shipping a file.
  function bmp(w, h, rgb) {
    const row = (w * 3 + 3) & ~3, size = 54 + row * h, b = new Uint8Array(size), v = new DataView(b.buffer);
    b[0] = 66; b[1] = 77; v.setUint32(2, size, true); v.setUint32(10, 54, true); v.setUint32(14, 40, true);
    v.setInt32(18, w, true); v.setInt32(22, h, true); v.setUint16(26, 1, true); v.setUint16(28, 24, true); v.setUint32(34, row * h, true);
    for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) { const o = 54 + y * row + xx * 3; b[o] = rgb[2]; b[o + 1] = rgb[1]; b[o + 2] = rgb[0]; }
    return b;
  }
  const SVG_SAMPLE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 160"><rect width="240" height="160" rx="24" fill="#0e7c86"/><circle cx="80" cy="80" r="44" fill="#f5b971"/><path d="M140 112l30-56 30 56z" fill="#fff"/></svg>';
  async function file(c, name, type) { return new File([await toBlob(c, type, 0.92)], name, { type }); }

  window.S3_DEMO = async function () {
    await ready;
    const wb = $("#format [data-v=webp]"); if (!wb.hidden) wb.click();
    await addFiles([
      await file(landscape(1600, 1000), "holiday.jpg", "image/jpeg"),
      await file(sticker(600, 600), "logo-sticker.png", "image/png"),
      new File([SVG_SAMPLE], "icon.svg", { type: "image/svg+xml" }),
      new File([bmp(320, 200, [61, 214, 208])], "scan.bmp", { type: "image/bmp" })
    ]);
  };

  window.S3_SELFTEST = async function () {
    await ready;
    const px = async (blob, x, y) => { const s = await decode(new File([blob], "p")), c = canvas(s.w, s.h), g = c.getContext("2d"); g.drawImage(s.img, 0, 0); return g.getImageData(x, y, 1, 1).data; };
    const head = async (blob, n) => Array.from(new Uint8Array(await blob.slice(0, n).arrayBuffer()));
    // Transparent PNG -> JPEG with a red background: corner (outside the circle) must be red.
    const png = await decode(await file(sticker(200, 200), "s.png", "image/png"));
    const j = await convert(png, { format: "jpeg", quality: 90, bg: "#ff0000", flatten: false });
    const jc = await px(j.blob, 2, 2), jh = await head(j.blob, 3);
    const ok1 = jh.join() === "255,216,255" && jc[0] > 240 && jc[1] < 20 && jc[2] < 20;
    // Same PNG -> PNG keeps alpha; -> WebP writes RIFF....WEBP.
    const p = await convert(png, { format: "png", quality: 92, bg: "#ff0000", flatten: false });
    const ok2 = (await head(p.blob, 4)).join() === "137,80,78,71" && (await px(p.blob, 2, 2))[3] === 0;
    let ok3 = true;
    if (enc["image/webp"]) {
      const wv = await convert(png, { format: "webp", quality: 80, bg: "#fff", flatten: false }), wh = await head(wv.blob, 12);
      ok3 = String.fromCharCode.apply(null, wh.slice(0, 4)) === "RIFF" && String.fromCharCode.apply(null, wh.slice(8, 12)) === "WEBP";
    }
    // SVG (viewBox only) -> PNG at 240x160 with the right colour; BMP -> PNG keeps size and colour.
    const sv = await decode(new File([SVG_SAMPLE], "a.svg", { type: "image/svg+xml" }));
    const sp = await convert(sv, { format: "png", quality: 92, bg: "#fff", flatten: false }), sc = await px(sp.blob, 120, 10);
    const bm = await decode(new File([bmp(3, 2, [10, 200, 30])], "b.bmp", { type: "image/bmp" }));
    const bp = await convert(bm, { format: "png", quality: 92, bg: "#fff", flatten: false }), bc = await px(bp.blob, 2, 1);
    const ok4 = sp.w === 240 && sp.h === 160 && sc[0] === 14 && sc[1] === 124 && sc[2] === 134 &&
      bp.w === 3 && bp.h === 2 && bc[0] === 10 && bc[1] === 200 && bc[2] === 30;
    const s2 = svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="50" viewBox="0 0 100 40"/>');
    const ok5 = s2.w === 50 && s2.h === 20 && outName("a.b.png", "image/jpeg") === "a.b.jpg";
    return (ok1 && ok2 && ok3 && ok4 && ok5) || { ok1, ok2, ok3, ok4, ok5, jc: Array.from(jc), sc: Array.from(sc), bc: Array.from(bc), sp: [sp.w, sp.h] };
  };
})();
