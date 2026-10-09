(function () {
  "use strict";
  const CFG = window.SITE_CONFIG || {};
  const I18N = window.I18N;
  const LANGS = ["en", "tr", "az", "fa"];
  const TYPES = ["city", "village", "region", "mountain", "river", "lake", "island", "landmark", "square", "other"];

  let lang = pickLang();
  let places = [];
  let filter = "all";
  let query = "";
  let markers = {};
  let picking = false;
  let tempMarker = null;
  let pickedLatLng = null;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const t = (k) => (I18N[lang] && I18N[lang][k]) ?? I18N.en[k] ?? k;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => /^https?:\/\//i.test(String(u || "")) ? String(u) : "";

  function pickLang() {
    const q = new URLSearchParams(location.search).get("lang");
    if (LANGS.includes(q)) return q;
    try { const s = localStorage.getItem("lang"); if (LANGS.includes(s)) return s; } catch (e) {}
    return CFG.DEFAULT_LANG || "en";
  }

  // ---------- normalisation for search ----------
  function norm(s) {
    return String(s || "").toLocaleLowerCase("tr")
      .replace(/kh/g, "h").replace(/gh/g, "g").replace(/sh/g, "s").replace(/ch/g, "c").replace(/zh/g, "j")
      .replace(/ə/g, "e").replace(/ı/g, "i").replace(/ğ/g, "g").replace(/ş/g, "s").replace(/ç/g, "c")
      .replace(/ö/g, "o").replace(/ü/g, "u").replace(/x/g, "h").replace(/q/g, "g").replace(/w/g, "v")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/[‌ً-ٟ]/g, "").replace(/[أإآ]/g, "ا")
      .replace(/[-'’`.\s]+/g, "");
  }
  const haystack = (p) => norm([p.original.latin, p.original.arabic, p.persian.fa, p.persian.latin, p.province].join("|"));

  // ---------- data ----------
  async function loadData() {
    const seed = Array.isArray(window.SEED_PLACES) ? window.SEED_PLACES : [];
    let approved = [];
    if (CFG.APPS_SCRIPT_URL) {
      try {
        const r = await fetch(CFG.APPS_SCRIPT_URL + "?action=approved&_=" + Date.now());
        const j = await r.json();
        if (j && j.ok) approved = (j.items || []).map(fromRow).filter(Boolean);
      } catch (e) { console.warn("Could not load approved submissions", e); }
    }
    const byId = new Map(seed.map((p) => [p.id, p]));
    // approved rows with the same id (or refId = a correction) are merged over the seed entry
    approved.forEach((p) => byId.set(p.id, byId.has(p.id) ? mergePlace(byId.get(p.id), p) : p));
    places = Array.from(byId.values());
  }

  function mergePlace(base, upd) {
    const keep = (a, b) => (b !== undefined && b !== null && b !== "" ? b : a);
    const out = Object.assign({}, base, { user: true, corrected: true });
    ["type", "status", "lat", "lng", "province", "period", "confidence"].forEach((k) => { out[k] = keep(base[k], upd[k]); });
    out.original = { latin: keep(base.original.latin, upd.original.latin), arabic: keep(base.original.arabic, upd.original.arabic) };
    out.persian = { fa: keep(base.persian.fa, upd.persian.fa), latin: keep(base.persian.latin, upd.persian.latin) };
    out.desc = Object.assign({}, base.desc);
    Object.keys(upd.desc || {}).forEach((k) => { out.desc[k] = keep(out.desc[k], upd.desc[k]); });
    out.sources = Array.from(new Set([].concat(base.sources || [], upd.sources || [])));
    return out;
  }

  function fromRow(r) {
    const lat = parseFloat(r.lat), lng = parseFloat(r.lng);
    if (!isFinite(lat) || !isFinite(lng) || !r.originalLatin) return null;
    // for a correction (refId set) the free-text description is the reason for the edit, not public text
    const d = r.refId ? "" : (r.description || "");
    return {
      id: String(r.refId || r.id), user: true,
      confidence: ["high", "medium", "low"].includes(r.confidence) ? r.confidence : (r.refId ? "" : "low"),
      type: TYPES.includes(r.type) ? r.type : "other",
      status: r.placeStatus === "restored" ? "restored" : "changed",
      lat, lng,
      original: { latin: r.originalLatin, arabic: r.originalArabic || "" },
      persian: { fa: r.persianFa || "", latin: r.persianLatin || "" },
      province: r.province || "", period: r.period || "",
      desc: { en: r.descEn || d, tr: r.descTr || d, az: r.descAz || d, fa: r.descFa || d },
      sources: String(r.source || "").split(/\s+/).filter(safeUrl)
    };
  }

  // ---------- map ----------
  const map = L.map("map", { zoomControl: true, worldCopyJump: false }).setView(CFG.MAP_CENTER || [38.08, 46.29], CFG.MAP_ZOOM || 7);
  // Free basemaps, no API key.
  // OSM & CARTO refuse requests without a Referer (i.e. when index.html is opened as a local file),
  // so locally we start with Esri; on GitHub Pages we start with OpenStreetMap (shows local/Persian labels).
  const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  const esriUrl = (s) => `https://server.arcgisonline.com/ArcGIS/rest/services/${s}/MapServer/tile/{z}/{y}/{x}`;
  const baseLayers = {
    "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: osmAttr }),
    "Street (Esri)": L.tileLayer(esriUrl("World_Street_Map"), { maxZoom: 19, attribution: "Tiles &copy; Esri" }),
    "Satellite": L.layerGroup([
      L.tileLayer(esriUrl("World_Imagery"), { maxZoom: 19, attribution: "Imagery &copy; Esri" }),
      L.tileLayer(esriUrl("Reference/World_Boundaries_and_Places"), { maxZoom: 19 })
    ])
  };
  const isLocalFile = location.protocol === "file:";
  (isLocalFile ? baseLayers["Street (Esri)"] : baseLayers.OpenStreetMap).addTo(map);
  L.control.layers(baseLayers, null, { position: "topright" }).addTo(map);

  const pinIcon = (cls) => L.divIcon({ className: "", html: `<div class="pin ${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 18], popupAnchor: [0, -18] });

  function descFor(p) {
    const d = p.desc || {};
    return d[lang] || (lang === "tr" ? d.az : lang === "az" ? d.tr : "") || d.en || "";
  }

  // Labels appear gradually so the zoomed-out map stays readable
  function labelMinZoom(p) {
    if (["city", "region", "mountain", "lake"].includes(p.type)) return p.confidence === "low" ? 8 : 7;
    if (["river", "village"].includes(p.type)) return 9;
    return 11; // islands, quarters, landmarks, squares
  }
  function updateZoomClass() {
    const z = map.getZoom(), el = map.getContainer();
    [8, 9, 10, 11].forEach((n) => el.classList.toggle("below" + n, z < n));
  }

  function labelName(p) { return (lang === "fa" && p.original.arabic ? p.original.arabic : p.original.latin).replace(/\s*\(.*\)\s*$/, ""); }

  function renderMarkers() {
    Object.values(markers).forEach((m) => m.remove());
    markers = {};
    visiblePlaces().forEach((p) => {
      const cls = p.status === "restored" ? "restored" : p.user ? "user" : "";
      const m = L.marker([p.lat, p.lng], { icon: pinIcon(cls), title: p.original.latin }).addTo(map);
      m.bindTooltip(esc(labelName(p)), { permanent: true, direction: "right", offset: [6, -10], className: "lbl lz" + labelMinZoom(p) + " " + (p.status === "restored" ? "restored" : "") });
      m.bindPopup(() => popupHtml(p), { maxWidth: 340 });
      m.on("popupopen", () => { highlight(p.id); history.replaceState(null, "", "#place=" + encodeURIComponent(p.id)); });
      markers[p.id] = m;
    });
  }

  function popupHtml(p) {
    const desc = descFor(p) || "";
    const typeName = (t("types") || {})[p.type] || p.type;
    const g = `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
    const o = `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=13/${p.lat}/${p.lng}`;
    const src = (p.sources || []).map(safeUrl).filter(Boolean)
      .map((u) => `<div><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, "").slice(0, 60))}</a></div>`).join("");
    return `<div class="pop">
      <div class="k">${esc(t("original"))}</div>
      <h4>${esc(p.original.latin)}</h4>
      ${p.original.arabic ? `<div class="ar" dir="rtl">${esc(p.original.arabic)}</div>` : ""}
      <div class="kv">
        <div><span class="k">${esc(p.status === "restored" ? t("imposed") : t("current"))}:</span> <span class="fa" dir="rtl">${esc(p.persian.fa)}</span>${p.persian.latin ? " · " + esc(p.persian.latin) : ""}</div>
        <div><span class="k">${esc(t("type"))}:</span> ${esc(typeName)}</div>
        ${p.province ? `<div><span class="k">${esc(t("province"))}:</span> ${esc(p.province)}</div>` : ""}
        ${p.period ? `<div><span class="k">${esc(t("period"))}:</span> ${esc(p.period)}</div>` : ""}
      </div>
      ${p.status === "restored" ? `<div class="tag">✓ ${esc(t("statusRestored"))}</div>` : ""}
      ${p.user ? `<div class="tag user">● ${esc(t("userSubmitted"))}</div>` : ""}
      <div class="meta-tags">
        ${p.confidence ? `<span class="conf ${esc(p.confidence)}" title="${esc(t("reliability"))}">${esc(t("conf" + p.confidence[0].toUpperCase() + p.confidence.slice(1)))}</span>` : ""}
        ${p.approx ? `<span class="conf approx">≈ ${esc(t("approx"))}</span>` : ""}
      </div>
      ${desc ? `<p>${esc(desc)}</p>` : ""}
      ${src ? `<div class="src"><span class="k">${esc(t("sources"))}:</span>${src}</div>` : ""}
      <div class="links"><a href="${g}" target="_blank" rel="noopener">${esc(t("openGoogle"))}</a><a href="${o}" target="_blank" rel="noopener">${esc(t("openOsm"))}</a></div>
      <button type="button" class="btn fix-btn" data-fix="${esc(p.id)}">✎ ${esc(t("suggestFix"))}</button>
    </div>`;
  }

  // ---------- list ----------
  function visiblePlaces() {
    const q = norm(query);
    return places
      .filter((p) => filter === "all" || p.status === filter)
      .filter((p) => !q || haystack(p).includes(q))
      .sort((a, b) => a.original.latin.localeCompare(b.original.latin, "az"));
  }

  function renderList() {
    const items = visiblePlaces();
    $("#count").textContent = t("count").replace("{n}", items.length);
    const ul = $("#list");
    if (!items.length) {
      ul.innerHTML = `<li class="empty">${esc(t("noResults"))}</li>`;
    } else {
      ul.innerHTML = items.map((p) => {
        const typeName = (t("types") || {})[p.type] || p.type;
        const desc = descFor(p) || "";
        return `<li class="item" data-id="${esc(p.id)}">
          <span class="dot ${p.status === "restored" ? "restored" : ""}"></span>
          <div class="names">${esc(p.original.latin)}${p.original.arabic ? `<span class="ar" dir="rtl">${esc(p.original.arabic)}</span>` : ""}<span class="badge">${esc(typeName)}</span>${p.confidence === "low" ? `<span class="conf low">${esc(t("confLow"))}</span>` : ""}</div>
          <div class="fa">${lang === "fa" ? "←" : "→"} <s dir="rtl">${esc(p.persian.fa)}</s>${p.persian.latin ? " (" + esc(p.persian.latin) + ")" : ""}</div>
          <div class="desc">${esc(desc)}</div>
        </li>`;
      }).join("");
    }
    // geo search button
    const gb = $("#geo-search");
    if (query.trim().length >= 2) { gb.hidden = false; gb.textContent = t("findOnMap").replace("{q}", query.trim()); }
    else gb.hidden = true;
  }

  function highlight(id) {
    $$(".item").forEach((el) => el.classList.toggle("active", el.dataset.id === id));
    const el = $(`.item[data-id="${CSS.escape(id)}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function focusPlace(id) {
    const p = places.find((x) => x.id === id);
    const m = markers[id];
    if (!p || !m) return;
    map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), p.type === "region" ? 9 : 11), { duration: 0.8 });
    setTimeout(() => m.openPopup(), 850);
    $("#sidebar").classList.remove("open");
  }

  // ---------- geocoder search (OSM Nominatim, free) ----------
  async function geoSearch() {
    const q = query.trim(); if (!q) return;
    const vb = (CFG.SEARCH_VIEWBOX || []).join(",");
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=${lang === "az" ? "az,fa" : lang}&viewbox=${vb}&bounded=1&q=${encodeURIComponent(q)}`;
    try {
      const r = await (await fetch(url)).json();
      if (!r.length) { $("#geo-search").textContent = t("noResults"); return; }
      const lat = +r[0].lat, lng = +r[0].lon;
      map.flyTo([lat, lng], 12);
      setTemp(L.latLng(lat, lng));
      tempMarker.bindPopup(`<div class="pop"><h4>${esc(r[0].display_name.split(",")[0])}</h4><p>${esc(r[0].display_name)}</p><button class="btn primary" id="suggest-here">${esc(t("suggest"))}</button></div>`).openPopup();
      setTimeout(() => { const b = $("#suggest-here"); if (b) b.onclick = () => openForm(L.latLng(lat, lng)); }, 50);
      $("#sidebar").classList.remove("open");
    } catch (e) { console.warn(e); }
  }

  // ---------- suggestion flow ----------
  function setTemp(latlng) {
    if (tempMarker) tempMarker.remove();
    tempMarker = L.marker(latlng, { icon: pinIcon("temp") }).addTo(map);
  }

  function setPicking(on) {
    picking = on;
    $(".map-wrap").classList.toggle("picking", on);
    $("#suggest-btn").classList.toggle("picking", on);
    $("#pick-hint").hidden = !on;
  }

  let fixFor = null; // place being corrected, or null for a new suggestion

  function openFix(id) {
    const p = places.find((x) => x.id === id);
    if (!p) return;
    map.closePopup();
    fixFor = p;
    pickedLatLng = L.latLng(p.lat, p.lng);
    const f = $("#suggest-form");
    f.reset();
    $("#f-title").textContent = t("fixTitle").replace("{name}", p.original.latin);
    $("#f-hint").textContent = t("fixHint"); $("#f-hint").hidden = false;
    $("#f-msg").textContent = ""; $("#f-msg").className = "msg";
    $("#f-coords").textContent = `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
    f.originalLatin.value = p.original.latin || "";
    f.originalArabic.value = p.original.arabic || "";
    f.persianFa.value = p.persian.fa || "";
    f.persianLatin.value = p.persian.latin || "";
    f.type.value = p.type;
    f.province.value = p.province || "";
    f.period.value = p.period || "";
    f.source.value = "";
    $("#form-dlg").showModal();
  }

  async function openForm(latlng) {
    setPicking(false);
    fixFor = null;
    pickedLatLng = latlng;
    setTemp(latlng);
    const f = $("#suggest-form");
    f.reset();
    $("#f-title").textContent = t("formTitle");
    $("#f-hint").hidden = true;
    $("#f-msg").textContent = ""; $("#f-msg").className = "msg";
    $("#f-coords").textContent = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
    $("#form-dlg").showModal();
    // Current official name from OpenStreetMap (free alternative to the paid Google Places API)
    $("#f-msg").textContent = t("lookingUp");
    try {
      const z = Math.min(Math.max(map.getZoom(), 10), 16);
      const r = await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&namedetails=1&zoom=${z}&accept-language=fa&lat=${latlng.lat}&lon=${latlng.lng}`)).json();
      const nd = r.namedetails || {};
      if (!f.persianFa.value) f.persianFa.value = nd["name:fa"] || nd.name || r.name || "";
      if (!f.persianLatin.value) f.persianLatin.value = nd["name:en"] || "";
      if (!f.originalLatin.value && nd["name:az"] && nd["name:az"] !== f.persianFa.value) f.originalLatin.placeholder = nd["name:az"];
      const a = r.address || {};
      if (!f.province.value) f.province.value = a.state || a.province || "";
    } catch (e) { console.warn(e); }
    $("#f-msg").textContent = "";
  }

  async function submitForm(ev) {
    ev.preventDefault();
    const f = ev.target, msg = $("#f-msg");
    if (f.website.value) return; // honeypot
    if (!f.originalLatin.value.trim() || !f.persianFa.value.trim() || !f.description.value.trim()) {
      msg.textContent = t("required"); msg.className = "msg err"; return;
    }
    if (!CFG.APPS_SCRIPT_URL) { msg.textContent = t("notConfigured"); msg.className = "msg err"; return; }
    const data = Object.fromEntries(new FormData(f).entries());
    delete data.website;
    data.lat = pickedLatLng.lat; data.lng = pickedLatLng.lng; data.lang = lang;
    if (fixFor) data.refId = fixFor.id;
    const btn = f.querySelector("[type=submit]"); btn.disabled = true;
    try {
      // text/plain avoids a CORS preflight, which Apps Script does not support
      const r = await fetch(CFG.APPS_SCRIPT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "submit", data }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "error");
      msg.textContent = t("sent"); msg.className = "msg ok";
      setTimeout(() => { $("#form-dlg").close(); if (tempMarker) tempMarker.remove(); }, 1800);
    } catch (e) {
      console.warn(e); msg.textContent = t("sendError"); msg.className = "msg err";
    } finally { btn.disabled = false; }
  }

  // ---------- i18n ----------
  function applyLang() {
    const d = I18N[lang];
    document.documentElement.lang = lang;
    document.documentElement.dir = d.dir;
    $$("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    $("#search").placeholder = t("search");
    $$(".langs button").forEach((b) => b.classList.toggle("active", b.dataset.lang === lang));
    $("#f-type").innerHTML = TYPES.map((k) => `<option value="${k}">${esc(t("types")[k])}</option>`).join("");
    $("#history-body").innerHTML = (window.HISTORY && (window.HISTORY[lang] || window.HISTORY.en)) || "";
    document.title = `${t("siteTitle")} — ${t("siteSub")}`;
    renderList(); renderMarkers();
  }

  // ---------- events ----------
  $$(".langs button").forEach((b) => b.addEventListener("click", () => {
    lang = b.dataset.lang;
    try { localStorage.setItem("lang", lang); } catch (e) {}
    applyLang();
  }));
  $$(".tab").forEach((b) => b.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.toggle("active", x === b));
    const v = b.dataset.view;
    $("#view-map").hidden = v !== "map";
    $("#view-history").hidden = v !== "history";
    if (v === "map") setTimeout(() => map.invalidateSize(), 50);
  }));
  $$(".chip").forEach((c) => c.addEventListener("click", () => {
    filter = c.dataset.filter;
    $$(".chip").forEach((x) => x.classList.toggle("active", x === c));
    renderList(); renderMarkers();
  }));
  let st;
  $("#search").addEventListener("input", (e) => {
    query = e.target.value; clearTimeout(st);
    st = setTimeout(() => { renderList(); renderMarkers(); }, 120);
  });
  $("#search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const v = visiblePlaces(); v.length ? focusPlace(v[0].id) : geoSearch(); }
  });
  $("#geo-search").addEventListener("click", geoSearch);
  $("#list").addEventListener("click", (e) => { const li = e.target.closest(".item"); if (li) focusPlace(li.dataset.id); });
  $("#suggest-btn").addEventListener("click", () => setPicking(!picking));
  $("#toggle-list").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  map.on("click", (e) => { if (picking) openForm(e.latlng); });
  map.on("zoomend", updateZoomClass); updateZoomClass();
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && picking) setPicking(false); });
  $("#f-cancel").addEventListener("click", () => { $("#form-dlg").close(); if (tempMarker) tempMarker.remove(); });
  $("#suggest-form").addEventListener("submit", submitForm);
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-fix]"); if (b) openFix(b.dataset.fix); });

  // ---------- start ----------
  applyLang();
  loadData().then(() => {
    applyLang();
    const m = location.hash.match(/place=([^&]+)/);
    if (m) focusPlace(decodeURIComponent(m[1]));
  });
})();
