(function () {
  "use strict";
  const URL_ = (window.SITE_CONFIG || {}).APPS_SCRIPT_URL;
  const TYPES = ["city", "village", "region", "mountain", "river", "lake", "island", "landmark", "square", "other"];
  const FIELDS = [
    ["originalLatin", "Original Turkish (Latin)"], ["originalArabic", "Original (Arabic script)", "rtl"],
    ["persianFa", "Persian name", "rtl"], ["persianLatin", "Persian name (Latin)"],
    ["province", "Province"], ["period", "Period"],
    ["description", "Description / reason (as submitted — not shown publicly for corrections)", "", true], ["descEn", "Description EN", "", true],
    ["descTr", "Description TR", "", true], ["descAz", "Description AZ", "", true], ["descFa", "Description FA", "rtl", true], ["source", "Source URL(s), space separated", "", true]
  ];
  let rows = [], filter = "pending";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const status = (m) => { $("#status").textContent = m; };

  try { $("#key").value = sessionStorage.getItem("adminKey") || ""; } catch (e) {}

  async function api(body) {
    if (!URL_) throw new Error("APPS_SCRIPT_URL is empty in config.js");
    body.key = $("#key").value.trim();
    const r = await fetch(URL_, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "error");
    return j;
  }

  async function load() {
    try { sessionStorage.setItem("adminKey", $("#key").value.trim()); } catch (e) {}
    status("Loading…");
    try { rows = (await api({ action: "admin_list" })).items.reverse(); render(); }
    catch (e) { status("Error: " + e.message); }
  }

  const SEED = Array.isArray(window.SEED_PLACES) ? window.SEED_PLACES : [];
  function fixBanner(r) {
    const s = SEED.find((p) => p.id === r.refId);
    if (!s) return `<div class="fixb">✎ Correction for <b>${esc(r.refId)}</b> (not in seed list — maybe an approved user entry)</div>`;
    const cmp = [["Original", s.original.latin, r.originalLatin], ["Arabic", s.original.arabic, r.originalArabic], ["Persian", s.persian.fa, r.persianFa], ["Persian (Latin)", s.persian.latin, r.persianLatin], ["Type", s.type, r.type], ["Province", s.province, r.province], ["Period", s.period, r.period]]
      .filter(([, o, n]) => String(o || "") !== String(n || ""))
      .map(([k, o, n]) => `<div>${k}: <s>${esc(o)}</s> → <b>${esc(n)}</b></div>`).join("") || "<div>No name/field changes — see the reason below.</div>";
    return `<div class="fixb">✎ Correction for <b>${esc(s.original.latin)}</b> (${esc(r.refId)})${cmp}</div>`;
  }

  function render() {
    const list = rows.filter((r) => filter === "all" || r.status === filter);
    status(`${list.length} shown · ${rows.filter((r) => r.status === "pending").length} pending · ${rows.length} total`);
    $("#rows").innerHTML = list.map((r) => `
      <div class="card ${esc(r.status)}" data-id="${esc(r.id)}">
        <div>
          ${r.refId ? fixBanner(r) : ""}
          <div class="meta"><span class="st">${esc(r.status)}</span> · ${esc(r.id)} · ${esc(r.createdAt)} · ${esc(r.nickname || "anonymous")} · lang ${esc(r.lang)}</div>
          <div class="grid">
            ${FIELDS.map(([k, label, dir, full]) => `<label class="${full ? "full" : ""}">${label}
              ${full ? `<textarea name="${k}" rows="2" ${dir ? 'dir="rtl"' : ""}>${esc(r[k])}</textarea>` : `<input name="${k}" value="${esc(r[k])}" ${dir ? 'dir="rtl"' : ""}>`}</label>`).join("")}
            <label>Type<select name="type">${TYPES.map((t) => `<option ${t === r.type ? "selected" : ""}>${t}</option>`).join("")}</select></label>
            <label>Name status<select name="placeStatus"><option value="changed" ${r.placeStatus !== "restored" ? "selected" : ""}>changed</option><option value="restored" ${r.placeStatus === "restored" ? "selected" : ""}>restored</option></select></label>
            <label>Reliability<select name="confidence">${["", "high", "medium", "low"].map((c) => `<option value="${c}" ${c === (r.confidence || "") ? "selected" : ""}>${c || "(auto)"}</option>`).join("")}</select></label>
            <label>Correction of (refId)<input name="refId" value="${esc(r.refId)}" placeholder="empty = new place"></label>
            <label>Lat<input name="lat" value="${esc(r.lat)}"></label>
            <label>Lng<input name="lng" value="${esc(r.lng)}"></label>
          </div>
          <div class="btns">
            <button class="btn ok" data-act="approved">Approve</button>
            <button class="btn no" data-act="rejected">Reject</button>
            <button class="btn ghost" data-act="save">Save edits</button>
            <button class="btn ghost" data-act="pending">Back to pending</button>
          </div>
        </div>
        <div class="mini" id="m-${esc(r.id)}"></div>
      </div>`).join("");
    list.forEach((r) => {
      const lat = +r.lat, lng = +r.lng;
      if (!isFinite(lat)) return;
      const m = L.map("m-" + r.id, { zoomControl: false, attributionControl: false }).setView([lat, lng], 11);
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}").addTo(m);
      L.marker([lat, lng]).addTo(m);
    });
  }

  $("#rows").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const card = b.closest(".card"), id = card.dataset.id, act = b.dataset.act;
    const fields = {};
    card.querySelectorAll("input,textarea,select").forEach((el) => { fields[el.name] = el.value; });
    b.disabled = true;
    try {
      await api({ action: "admin_update", id, status: act === "save" ? "" : act, fields });
      const r = rows.find((x) => x.id === id); Object.assign(r, fields); if (act !== "save") r.status = act;
      render();
    } catch (err) { alert("Error: " + err.message); b.disabled = false; }
  });

  document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => {
    filter = c.dataset.f;
    document.querySelectorAll(".chip").forEach((x) => x.classList.toggle("active", x === c));
    render();
  }));
  $("#load").addEventListener("click", load);
  $("#key").addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });

  // Export: seed + approved rows in data/places.js format (commit this to GitHub as a permanent backup)
  $("#export").addEventListener("click", async () => {
    const seed = Array.isArray(window.SEED_PLACES) ? window.SEED_PLACES : [];
    const map = new Map(seed.map((p) => [p.id, p]));
    rows.filter((r) => r.status === "approved").forEach((r) => {
      const d = r.description || "";
      const key = r.refId || r.id;
      const base = map.get(key);
      const d0 = r.refId ? "" : d;
      if (base) {
        const k = (a, b) => (b !== undefined && b !== null && String(b) !== "" ? b : a);
        map.set(key, Object.assign({}, base, {
          type: k(base.type, r.type), status: r.placeStatus === "restored" ? "restored" : base.status,
          lat: +k(base.lat, r.lat), lng: +k(base.lng, r.lng),
          original: { latin: k(base.original.latin, r.originalLatin), arabic: k(base.original.arabic, r.originalArabic) },
          persian: { fa: k(base.persian.fa, r.persianFa), latin: k(base.persian.latin, r.persianLatin) },
          province: k(base.province, r.province), period: k(base.period, r.period),
          desc: { en: k(base.desc.en, r.descEn), tr: k(base.desc.tr, r.descTr), az: k(base.desc.az, r.descAz), fa: k(base.desc.fa, r.descFa) },
          sources: Array.from(new Set([].concat(base.sources || [], String(r.source || "").split(/\s+/).filter((u) => /^https?:\/\//.test(u))))),
          confidence: k(base.confidence, r.confidence)
        }));
        return;
      }
      map.set(key, {
        id: r.id, type: r.type, status: r.placeStatus === "restored" ? "restored" : "changed",
        lat: +r.lat, lng: +r.lng,
        original: { latin: r.originalLatin, arabic: r.originalArabic },
        persian: { fa: r.persianFa, latin: r.persianLatin },
        province: r.province, period: r.period,
        desc: { en: r.descEn || d0, tr: r.descTr || d0, az: r.descAz || d0, fa: r.descFa || d0 }, confidence: r.confidence || "low",
        sources: String(r.source || "").split(/\s+/).filter((u) => /^https?:\/\//.test(u))
      });
    });
    const js = "// Başlangıç listesi / seed list. Admin sayfasındaki \"Export places.js\" ile güncellenir.\nwindow.SEED_PLACES = " + JSON.stringify(Array.from(map.values()), null, 2) + ";\n";
    const blob = new Blob([js], { type: "text/javascript" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "places.js"; a.click();
  });
})();
