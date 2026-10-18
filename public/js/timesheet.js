// Officer timesheet form: works out hours as you type, and lets you sign
// with your finger or mouse. (The PDF itself is made on the server.)
document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('[data-timesheet]');
  if (!form) return;

  // ---- Hours ----
  // "1000", "10:00", "930" -> minutes after midnight, or null.
  const parseClock = (text) => {
    const m = String(text || '').trim().replace(':', '').match(/^(\d{1,2})(\d{2})$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const fmt = (h) => (Math.round(h * 10) === h * 10 ? h.toFixed(1) : h.toFixed(2));
  const rows = [...form.querySelectorAll('[data-row]')];

  function update() {
    let total = 0;
    for (const row of rows) {
      const [inBox, outBox] = row.querySelectorAll('[data-clock]');
      const a = parseClock(inBox.value);
      const b = parseClock(outBox.value);
      inBox.setAttribute('aria-invalid', String(inBox.value.trim() !== '' && a === null));
      outBox.setAttribute('aria-invalid', String(outBox.value.trim() !== '' && b === null));
      let hours = 0;
      if (a !== null && b !== null) {
        let minutes = b - a;
        if (minutes <= 0) minutes += 24 * 60; // overnight shift
        hours = Math.round((minutes / 60) * 100) / 100;
      }
      row.querySelector('[data-hours]').textContent = hours ? fmt(hours) : '–';
      total += hours;
    }
    form.querySelector('[data-total]').textContent = fmt(total);
  }
  form.addEventListener('input', (event) => {
    if (event.target.matches('[data-clock]')) update();
  });
  update();

  // ---- Signature pad ----
  const canvas = form.querySelector('[data-sig]');
  const ctx = canvas.getContext('2d');
  const STORE_KEY = 'dmi.sig'; // the same key the old timesheet page used, so a saved signature carries over
  let drawing = false;
  let hasInk = false;

  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        hasInk = true;
      };
      img.src = JSON.parse(saved);
    }
  } catch {
    // storage not available: just start with an empty box
  }

  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
  };
  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const p = point(e);
    Object.assign(ctx, { lineWidth: 3, lineCap: 'round', lineJoin: 'round', strokeStyle: '#10213d' });
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.1, p.y);
    ctx.stroke();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = point(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });
  const endStroke = () => {
    if (!drawing) return;
    drawing = false;
    hasInk = true;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(canvas.toDataURL('image/png')));
    } catch {
      // storage not available: the signature just isn't remembered
    }
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  form.querySelector('[data-sig-clear]').addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasInk = false;
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      // ignore
    }
  });

  // Crop the drawing to just the ink, so it fills the signature space on the form.
  function croppedSignature() {
    const { width: w, height: h } = canvas;
    const px = ctx.getImageData(0, 0, w, h).data;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (px[(y * w + x) * 4 + 3] > 10) {
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      }
    }
    if (x1 < 0) return '';
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1;
    out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }

  form.addEventListener('submit', (event) => {
    const signature = hasInk ? croppedSignature() : '';
    if (!signature) {
      event.preventDefault();
      window.alert('Please sign in the signature box first.');
      return;
    }
    form.querySelector('[data-sig-value]').value = signature;
  });
});
