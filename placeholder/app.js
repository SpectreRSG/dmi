// DMI Timesheet: fills the blank DMI timesheet PDF in the browser.
// Nothing leaves the device - entries, profile and signature live in
// localStorage, and the PDF is built here with pdf-lib and downloaded.
(function () {
  "use strict";

  // A known pay period start (Sunday 7/20/2025). Every period is 14 days
  // counted from here, so any date maps to exactly one period.
  var ANCHOR = new Date(2025, 6, 20);
  var PERIOD_DAYS = 14;
  var DAY_MS = 86400000;
  var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Positions on the template, in PDF points measured from the TOP of the
  // page (612 x 792). Converted to pdf-lib's bottom-up y in put().
  var PAGE_H = 792;
  var LAYOUT = {
    name: { x: 160, y: 181.5 },
    location: { x: 413, y: 181.5 },
    phone: { x: 223, y: 204.5 },
    period: { x: 413, y: 204.5 },
    firstRowTop: 229.8,
    rowHeight: 13.93,
    rows: 31,
    baseline: 10.2,
    cols: { date: 76, clockIn: 169, clockOut: 233, hours: 301, comment: 377 },
    commentWidth: 160,
    totalY: 672,
    sig: { x: 204, top: 678, w: 96, h: 32 },
  };

  // ---------- storage (every access guarded: private mode can throw) ----------
  function load(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage unavailable: the page still works, it just won't remember */
    }
  }

  // ---------- dates ----------
  function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  }
  function periodStartFor(d) {
    var day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var diff = Math.round((day - ANCHOR) / DAY_MS);
    var k = Math.floor(diff / PERIOD_DAYS);
    return addDays(ANCHOR, k * PERIOD_DAYS);
  }
  function short(d) {
    return d.getMonth() + 1 + "/" + d.getDate() + "/" + String(d.getFullYear()).slice(-2);
  }
  function iso(d) {
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + dd;
  }

  // ---------- numbers and clock times ----------
  function fmtHours(h) {
    return Math.round(h * 10) === h * 10 ? h.toFixed(1) : h.toFixed(2);
  }
  // "1000", "10:00", "930" -> minutes after midnight, or null.
  function parseClock(s) {
    var m = String(s || "").trim().replace(":", "").match(/^(\d{1,2})(\d{2})$/);
    if (!m) return null;
    var h = +m[1], min = +m[2];
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }
  function fmtClock(s) {
    var mins = parseClock(s);
    if (mins === null) return String(s || "").trim();
    return String(Math.floor(mins / 60)).padStart(2, "0") + String(mins % 60).padStart(2, "0");
  }
  // Hours come only from the shift times - there is no typed-in hours value.
  function hoursOf(row) {
    var a = parseClock(row.clockIn), b = parseClock(row.clockOut);
    if (a === null || b === null) return 0;
    var mins = b - a;
    if (mins <= 0) mins += 24 * 60; // overnight shift
    return Math.round((mins / 60) * 100) / 100;
  }
  // A time typed in but not readable (like 2500), or only one of the pair.
  function badClock(s) { return String(s || "").trim() !== "" && parseClock(s) === null; }
  function incomplete(row) {
    return badClock(row.clockIn) || badClock(row.clockOut) ||
      (!row.clockIn.trim() !== !row.clockOut.trim());
  }

  // ---------- state ----------
  var $ = function (id) { return document.getElementById(id); };
  var profile = load("dmi.profile", { name: "", phone: "", location: "", comment: "" });
  var start = periodStartFor(new Date());
  var rows = [];

  function periodKey() { return "dmi.period." + iso(start); }
  function loadPeriod() {
    var saved = load(periodKey(), null);
    rows = [];
    for (var i = 0; i < PERIOD_DAYS; i++) {
      var r = (saved && saved[i]) || {};
      rows.push({ clockIn: r.clockIn || "", clockOut: r.clockOut || "", comment: r.comment || "" });
    }
  }
  function savePeriod() { save(periodKey(), rows); }

  // ---------- profile fields ----------
  ["name", "phone", "location", "comment"].forEach(function (f) {
    var el = $(f);
    el.value = profile[f] || "";
    el.addEventListener("input", function () {
      profile[f] = el.value;
      save("dmi.profile", profile);
      if (f === "comment") renderDays(); // refresh the placeholder shown on empty rows
    });
  });

  // ---------- day table ----------
  function input(value, cls, label, placeholder, type) {
    var td = document.createElement("td");
    td.className = cls;
    var el = document.createElement("input");
    el.value = value;
    el.setAttribute("aria-label", label);
    if (placeholder) el.placeholder = placeholder;
    if (type === "calc") {
      // Worked out from Clock in / Clock out; not typeable.
      el.readOnly = true;
      el.tabIndex = -1;
    } else if (type === "clock") {
      el.inputMode = "numeric";
      el.maxLength = 5;
    }
    td.appendChild(el);
    return { td: td, el: el };
  }

  function renderDays() {
    var body = $("days");
    body.textContent = "";
    rows.forEach(function (row, i) {
      var d = addDays(start, i);
      var tr = document.createElement("tr");
      if (d.getDay() === 0 || d.getDay() === 6) tr.className = "weekend";
      var th = document.createElement("th");
      th.scope = "row";
      th.textContent = DAY_NAMES[d.getDay()] + " " + short(d);
      tr.appendChild(th);

      var label = DAY_NAMES[d.getDay()] + " " + short(d);
      var cin = input(row.clockIn, "clock", "Clock in " + label, "In", "clock");
      var cout = input(row.clockOut, "clock", "Clock out " + label, "Out", "clock");
      var hours = input("", "hours", "Hours worked " + label + " (calculated)", "–", "calc");
      var comment = input(row.comment, "comment", "Comment " + label, profile.comment || "Comment");

      function showRow() {
        var h = hoursOf(row);
        hours.el.value = h > 0 ? fmtHours(h) : "";
        cin.el.setAttribute("aria-invalid", badClock(row.clockIn) ? "true" : "false");
        cout.el.setAttribute("aria-invalid", badClock(row.clockOut) ? "true" : "false");
      }
      function onClock() {
        row.clockIn = cin.el.value;
        row.clockOut = cout.el.value;
        showRow();
        savePeriod();
        updateTotal();
      }
      showRow();
      cin.el.addEventListener("input", onClock);
      cout.el.addEventListener("input", onClock);
      comment.el.addEventListener("input", function () {
        row.comment = comment.el.value;
        savePeriod();
      });

      tr.appendChild(cin.td);
      tr.appendChild(cout.td);
      tr.appendChild(hours.td);
      tr.appendChild(comment.td);
      body.appendChild(tr);
    });
    updateTotal();
  }

  function total() {
    return rows.reduce(function (sum, r) { return sum + hoursOf(r); }, 0);
  }
  function updateTotal() { $("total").textContent = fmtHours(total()); }

  function periodText() { return short(start) + " - " + short(addDays(start, PERIOD_DAYS - 1)); }
  function showPeriod() {
    $("periodLabel").textContent = periodText();
    loadPeriod();
    renderDays();
    $("status").textContent = "";
  }
  $("prev").addEventListener("click", function () { start = addDays(start, -PERIOD_DAYS); showPeriod(); });
  $("next").addEventListener("click", function () { start = addDays(start, PERIOD_DAYS); showPeriod(); });
  $("clearPeriod").addEventListener("click", function () {
    if (!confirm("Clear all hours for " + periodText() + "?")) return;
    try { localStorage.removeItem(periodKey()); } catch (e) { /* ignore */ }
    showPeriod();
  });

  // ---------- signature pad ----------
  var canvas = $("sig");
  var ctx = canvas.getContext("2d");
  var drawing = false;
  var hasInk = false;

  function restoreSignature() {
    var data = load("dmi.sig", null);
    if (!data) return;
    var img = new Image();
    img.onload = function () {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      hasInk = true;
    };
    img.src = data;
  }
  function point(e) {
    var r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
  }
  canvas.addEventListener("pointerdown", function (e) {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    var p = point(e);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#10213d";
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.1, p.y);
    ctx.stroke();
  });
  canvas.addEventListener("pointermove", function (e) {
    if (!drawing) return;
    var p = point(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });
  function endStroke() {
    if (!drawing) return;
    drawing = false;
    hasInk = true;
    save("dmi.sig", canvas.toDataURL("image/png"));
  }
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  $("sigClear").addEventListener("click", function () {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasInk = false;
    try { localStorage.removeItem("dmi.sig"); } catch (e) { /* ignore */ }
  });

  // Crop the drawn signature to its ink so it fills the space on the form.
  function croppedSignature() {
    var w = canvas.width, h = canvas.height;
    var px = ctx.getImageData(0, 0, w, h).data;
    var x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (px[(y * w + x) * 4 + 3] > 10) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    var out = document.createElement("canvas");
    out.width = x1 - x0 + 1;
    out.height = y1 - y0 + 1;
    out.getContext("2d").drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  }

  // ---------- PDF ----------
  async function buildPdf() {
    var PDFLib = window.PDFLib;
    var bytes = await fetch("dmi-timesheet-template.pdf").then(function (r) {
      if (!r.ok) throw new Error("Could not load the blank timesheet (" + r.status + ")");
      return r.arrayBuffer();
    });
    var doc = await PDFLib.PDFDocument.load(bytes);
    var font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    var page = doc.getPages()[0];
    var black = PDFLib.rgb(0, 0, 0);

    function put(text, x, top, size, maxWidth) {
      text = String(text || "");
      if (!text) return;
      size = size || 8;
      if (maxWidth) {
        // Shrink long text to fit its column, then trim if still too long.
        while (size > 5.5 && font.widthOfTextAtSize(text, size) > maxWidth) size -= 0.25;
        while (text.length > 1 && font.widthOfTextAtSize(text, size) > maxWidth) text = text.slice(0, -1);
      }
      page.drawText(text, { x: x, y: PAGE_H - top, size: size, font: font, color: black });
    }

    put(profile.name, LAYOUT.name.x, LAYOUT.name.y, 8, 120);
    put(profile.location, LAYOUT.location.x, LAYOUT.location.y, 8, 118);
    put(profile.phone, LAYOUT.phone.x, LAYOUT.phone.y, 8, 120);
    put(periodText(), LAYOUT.period.x, LAYOUT.period.y, 8, 118);

    // Only days actually worked go on the sheet, top to bottom, like the
    // paper version.
    var worked = [];
    rows.forEach(function (r, i) { if (hoursOf(r) > 0) worked.push({ r: r, d: addDays(start, i) }); });
    var c = LAYOUT.cols;
    worked.slice(0, LAYOUT.rows).forEach(function (w, i) {
      var top = LAYOUT.firstRowTop + i * LAYOUT.rowHeight + LAYOUT.baseline;
      put(short(w.d), c.date, top);
      put(fmtClock(w.r.clockIn), c.clockIn, top, 8, 55);
      put(fmtClock(w.r.clockOut), c.clockOut, top, 8, 60);
      put(fmtHours(hoursOf(w.r)), c.hours, top);
      put(w.r.comment || profile.comment, c.comment, top, 8, LAYOUT.commentWidth);
    });
    put(fmtHours(total()), c.hours, LAYOUT.totalY);

    if ($("sigUse").checked && hasInk) {
      var sigData = croppedSignature();
      if (sigData) {
        var png = await doc.embedPng(sigData);
        var s = LAYOUT.sig;
        var scale = Math.min(s.w / png.width, s.h / png.height);
        var w = png.width * scale, h = png.height * scale;
        page.drawImage(png, { x: s.x, y: PAGE_H - (s.top + s.h), width: w, height: h });
      }
    }
    return { bytes: await doc.save(), count: worked.length };
  }

  $("download").addEventListener("click", async function () {
    var status = $("status");
    var unfinished = [];
    rows.forEach(function (r, i) { if (incomplete(r)) unfinished.push(short(addDays(start, i))); });
    if (unfinished.length) {
      status.textContent = "Check the clock times on " + unfinished.join(", ") + " - each day needs both a Clock in and a Clock out, like 1000 and 1630.";
      return;
    }
    if (total() <= 0) {
      status.textContent = "Add a Clock in and Clock out to at least one day first.";
      return;
    }
    if (!profile.name.trim()) {
      status.textContent = "Tip: add your officer name above - downloading without it.";
    } else {
      status.textContent = "Building PDF...";
    }
    try {
      var result = await buildPdf();
      var blob = new Blob([result.bytes], { type: "application/pdf" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "DMI_Timesheet_" + iso(start) + "_to_" + iso(addDays(start, PERIOD_DAYS - 1)) + ".pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      status.textContent = "Downloaded: " + result.count + " day(s), " + fmtHours(total()) + " hours.";
    } catch (err) {
      status.textContent = "Something went wrong: " + err.message;
    }
  });

  restoreSignature();
  showPeriod();
})();
