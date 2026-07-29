// collectSignals.client.js
// ---------------------------------------------------------------------------
// Runs IN THE BROWSER. Gathers the stable device/environment signals that the
// server hashes into a fingerprint. Ships the bag to your Worker; the Worker
// computes the fingerprint (salt stays server-side).
//
// Ethics/scope reminder: everything here is standard, non-invasive environment
// info — the same class of data any 3D web app reads to pick a quality tier. It
// identifies a DEVICE, not a person. Disclose it in your privacy policy. It is
// used for seed provenance, visual signature, and multi-account fraud checks —
// never to bias a flip outcome.
// ---------------------------------------------------------------------------

async function canvasHash() {
  try {
    const c = document.createElement('canvas');
    c.width = 240; c.height = 60;
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = "16px 'Arial'";
    ctx.fillStyle = '#f60';
    ctx.fillRect(0, 0, 100, 30);
    ctx.fillStyle = '#069';
    ctx.fillText('coinflip-sig \u2728', 2, 2);
    ctx.strokeStyle = 'rgba(0,120,200,0.4)';
    ctx.arc(120, 30, 20, 0, Math.PI * 2);
    ctx.stroke();
    const data = c.toDataURL();
    return await sha256Hex(data);
  } catch { return ''; }
}

async function audioHash() {
  try {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) return '';
    const ctx = new Ctx(1, 44100, 44100);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 10000;
    const comp = ctx.createDynamicsCompressor();
    osc.connect(comp); comp.connect(ctx.destination);
    osc.start(0);
    const buf = await ctx.startRendering();
    const chan = buf.getChannelData(0);
    let acc = 0;
    for (let i = 4000; i < 5000; i++) acc += Math.abs(chan[i]);
    return await sha256Hex(String(acc));
  } catch { return ''; }
}

function webglInfo() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return { vendor: '', renderer: '' };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : '',
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '',
    };
  } catch { return { vendor: '', renderer: '' }; }
}

async function fontsHash() {
  // Cheap font-availability probe: measure a string in candidate fonts vs a
  // baseline; differing widths imply the font is installed.
  try {
    const test = 'mmmmmmmmmmlli';
    const baseFonts = ['monospace', 'sans-serif', 'serif'];
    const probe = ['Arial', 'Courier New', 'Georgia', 'Comic Sans MS',
                   'Impact', 'Times New Roman', 'Verdana', 'Helvetica'];
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;left:-9999px;font-size:72px';
    span.textContent = test;
    document.body.appendChild(span);
    const widths = {};
    for (const b of baseFonts) { span.style.fontFamily = b; widths[b] = span.offsetWidth; }
    let sig = '';
    for (const f of probe) {
      for (const b of baseFonts) {
        span.style.fontFamily = `'${f}',${b}`;
        sig += span.offsetWidth !== widths[b] ? '1' : '0';
      }
    }
    document.body.removeChild(span);
    return await sha256Hex(sig);
  } catch { return ''; }
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function collectSignals() {
  const gl = webglInfo();
  const [canvas, audio, fonts] = await Promise.all([canvasHash(), audioHash(), fontsHash()]);
  return {
    userAgent: navigator.userAgent || '',
    platform: navigator.platform || '',
    languages: navigator.languages || [navigator.language].filter(Boolean),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    screenColorDepth: screen.colorDepth || 0,
    devicePixelRatio: window.devicePixelRatio || 1,
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
    deviceMemory: navigator.deviceMemory || 0,
    webglVendor: gl.vendor,
    webglRenderer: gl.renderer,
    canvasHash: canvas,
    audioHash: audio,
    fontsHash: fonts,
  };
}

// Capture the flick's physical entropy at the moment of the gesture. Call from
// your pointerup/touchend handler. Returns a hex string folded into the seed.
export async function captureFlick(evt, downEvt) {
  const now = performance.now();
  const dt = downEvt ? now - downEvt.t : 0;
  const dx = downEvt ? evt.clientX - downEvt.x : 0;
  const dy = downEvt ? evt.clientY - downEvt.y : 0;
  const velocity = dt ? Math.hypot(dx, dy) / dt : 0;
  const material = [now, dt, dx, dy, velocity, Date.now()].join(':');
  return {
    flickHex: await sha256Hex(material),
    // normalized 0..1 force for variant selection (tune the divisor to feel)
    flickForce: Math.max(0, Math.min(1, velocity / 3)),
    clockMs: Date.now(),
  };
}
