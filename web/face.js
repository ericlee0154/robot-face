// Robot face renderer. All animation runs here; the Jetson only sends commands.
'use strict';

// ------------------------------------------------------------------ face definitions

// ASCII style: each eye is a text glyph, optionally with a "brow" glyph above it.
//   eyes:  [left, right] glyphs (as seen by the viewer)
//   brows: [left, right] glyphs or '' for none
//   scale: glyph size multiplier
//   fx:    extra animation: zzz | pulse | spin | bounce | question | tears
const ASCII = {
  neutral:   { eyes: ['O', 'O'] },
  happy:     { eyes: ['^', '^'] },
  sad:       { eyes: ['o', 'o'], brows: ['/', '\\'] },
  angry:     { eyes: ['o', 'o'], brows: ['\\', '/'] },
  surprised: { eyes: ['O', 'O'], scale: 1.3 },
  sleepy:    { eyes: ['-', '-'], fx: 'zzz' },
  love:      { eyes: ['<3', '<3'], fx: 'pulse' },
  wink:      { eyes: ['^', '-'] },
  dizzy:     { eyes: ['@', '@'], fx: 'spin' },
  excited:   { eyes: ['>', '<'], fx: 'bounce' },
  confused:  { eyes: ['o', 'O'], brows: ['', '~'], fx: 'question' },
  cry:       { eyes: ['T', 'T'], fx: 'tears' },
  dead:      { eyes: ['x', 'x'] },
  money:     { eyes: ['$', '$'], fx: 'pulse' },
};

// Classic style: glowing rounded rectangles shaped by eyelids.
//   w, h:          eye size multipliers
//   topIn, topOut: how much of the eye the upper lid covers at the inner / outer edge (0..1)
//   bottom:        how far the lower "cheek" pushes up into the eye (happy squint)
//   wink:          1 closes the right eye
const CLASSIC_BASE = { w: 1, h: 1, topIn: 0, topOut: 0, bottom: 0, wink: 0 };
const CLASSIC = {
  neutral:   {},
  happy:     { w: 1.05, h: 0.95, bottom: 0.55 },
  sad:       { h: 0.90, topIn: 0.05, topOut: 0.45 },
  angry:     { h: 0.90, topIn: 0.50, topOut: 0.05 },
  surprised: { w: 1.15, h: 1.25 },
  sleepy:    { w: 1.05, h: 0.85, topIn: 0.55, topOut: 0.60, bottom: 0.10 },
  love:      { w: 1.05, h: 0.95, bottom: 0.45 },
  wink:      { w: 1.05, h: 0.95, bottom: 0.45, wink: 1 },
  dizzy:     { w: 0.85, h: 0.85, topIn: 0.20, topOut: 0.20 },
  excited:   { w: 1.15, h: 1.15, bottom: 0.35 },
  confused:  { topIn: 0.30, topOut: 0.00 },
  cry:       { h: 0.90, topIn: 0.05, topOut: 0.50 },
  dead:      { w: 1.10, h: 0.15 },
  money:     { w: 1.10, h: 1.10 },
};

const STYLES = ['ascii', 'classic'];
const FONT = 'ui-monospace, "DejaVu Sans Mono", "Droid Sans Mono", "Courier New", monospace';
const CLOSED_GLYPHS = new Set(['-', '^', '>', '<', 'x', 'T']);
const GLITCH_GLYPHS = '#%&*+=?!/\\|<>';
const BLINK_DURATION = 0.16;
const GLITCH_DURATION = 0.18;

// ------------------------------------------------------------------ state

const params = new URLSearchParams(location.search);
// ?emotion=... / ?style=... pin those fields, ignoring the server (handy for previews).
const pinned = {
  emotion: CLASSIC[params.get('emotion')] ? params.get('emotion') : null,
  style: STYLES.includes(params.get('style')) ? params.get('style') : null,
};

// ?offline: don't connect to the server at all (used by the control page's gallery).
const OFFLINE = params.has('offline');

const canvas = document.getElementById('face');
const ctx = canvas.getContext('2d');

let emotion = pinned.emotion || 'neutral';
let style = pinned.style || 'ascii';
const target = { ...CLASSIC_BASE, ...CLASSIC[emotion] };
const cur = { ...target, lookX: 0, lookY: 0 };
const lookTarget = { x: 0, y: 0 };
let commandedLook = null;   // [x, y] from the robot, or null = wander on our own
let color = '#3cf0ff';
let blinkStart = -1;        // seconds; < 0 means not blinking
let nextBlinkAt = 2;
let nextSaccadeAt = 1;
let changedAt = -10;        // when the emotion last changed (ASCII glitch transition)
let connected = false;
let disconnectedSince = 0;
let time = 0;
let scanlines = null;

// ------------------------------------------------------------------ commands

function setEmotion(name) {
  if (!CLASSIC[name] || name === emotion) return;
  emotion = name;
  Object.assign(target, CLASSIC_BASE, CLASSIC[name]);
  if (time > 0.5) changedAt = time;  // no glitch on the very first state message
}

function applyMessage(msg) {
  if (msg.emotion && !pinned.emotion) setEmotion(msg.emotion);
  if (msg.style && !pinned.style && STYLES.includes(msg.style)) style = msg.style;
  if ('look' in msg) {
    commandedLook = Array.isArray(msg.look) ? msg.look : null;
    if (commandedLook) {
      lookTarget.x = commandedLook[0];
      lookTarget.y = commandedLook[1];
    } else {
      nextSaccadeAt = time;
    }
  }
  if (msg.color) color = msg.color;
  if (msg.blink) startBlink();
}

function startBlink() {
  if (blinkStart < 0) blinkStart = time;
}

// ------------------------------------------------------------------ connection

let retry = 0;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  let done = false;
  let watchdog = 0;

  const reconnect = () => {
    if (done) return;
    done = true;
    clearTimeout(watchdog);
    if (connected) disconnectedSince = time;
    connected = false;
    try { ws.close(); } catch (_) {}
    setTimeout(connect, Math.min(5000, 300 * 2 ** retry++));
  };
  // The server pings every 15 s; if we hear nothing for 45 s the link is dead.
  const kick = () => { clearTimeout(watchdog); watchdog = setTimeout(reconnect, 45000); };

  ws.onopen = () => { retry = 0; connected = true; kick(); };
  ws.onmessage = (ev) => {
    kick();
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    applyMessage(msg);
  };
  ws.onclose = reconnect;
  ws.onerror = reconnect;
}

// ------------------------------------------------------------------ drawing helpers

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);

  // Scanline pattern for the ASCII "terminal" look.
  const line = Math.max(1, Math.round(dpr));
  const tile = document.createElement('canvas');
  tile.width = 1;
  tile.height = line * 3;
  const t = tile.getContext('2d');
  t.fillStyle = 'rgba(0,0,0,0.35)';
  t.fillRect(0, line * 2, 1, line);
  scanlines = ctx.createPattern(tile, 'repeat');
}

function roundRectPath(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Draw text so its visible ink (not its baseline) is centered on (0, 0).
function fillCentered(text, size) {
  ctx.font = `bold ${size}px ${FONT}`;
  const m = ctx.measureText(text);
  const dy = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  const dx = (m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2;
  ctx.fillText(text, dx, dy);
}

function glyphAt(text, x, y, size, alpha = 1, angle = 0) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  if (angle) ctx.rotate(angle);
  fillCentered(text, size);
  ctx.restore();
}

function blinkOpenness() {
  if (blinkStart < 0) return 1;
  const t = (time - blinkStart) / BLINK_DURATION;
  if (t >= 1) { blinkStart = -1; return 1; }
  return Math.max(0.04, Math.abs(1 - 2 * t));
}

// ------------------------------------------------------------------ classic style

// side: -1 = left eye, +1 = right eye (as seen by the viewer)
function drawClassicEye(x, y, w, h, side, glow) {
  const left = x - w / 2, right = x + w / 2, top = y - h / 2, bottom = y + h / 2;

  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = glow;
  roundRectPath(left, top, w, h, Math.min(w, h) * 0.28);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#000';
  const pad = w * 0.15 + glow;

  // Upper lid: a straight, tilted edge. The inner edge faces the other eye.
  if (cur.topIn > 0.005 || cur.topOut > 0.005) {
    const inY = top + cur.topIn * h;
    const outY = top + cur.topOut * h;
    const leftY = side < 0 ? outY : inY;
    const rightY = side < 0 ? inY : outY;
    ctx.beginPath();
    ctx.moveTo(left - pad, top - pad);
    ctx.lineTo(right + pad, top - pad);
    ctx.lineTo(right + pad, rightY);
    ctx.lineTo(left - pad, leftY);
    ctx.closePath();
    ctx.fill();
  }

  // Lower cheek: a black ellipse rising from below makes an upward crescent.
  if (cur.bottom > 0.005) {
    ctx.beginPath();
    ctx.ellipse(x, bottom + h * 0.35, w * 0.7, h * (0.35 + cur.bottom), 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawClassic(g) {
  for (const side of [-1, 1]) {
    // The eye on the side we're looking toward gets slightly bigger (fake perspective).
    const persp = 1 + cur.lookX * side * 0.08;
    const wink = side > 0 ? 1 - 0.92 * cur.wink : 1;
    const w = g.s * cur.w * persp;
    const h = g.s * 1.15 * cur.h * persp * g.open * wink;
    drawClassicEye(g.cx + side * g.spacing, g.cy, w, h, side, g.s * 0.12);
  }
}

// ------------------------------------------------------------------ ascii style

function drawAscii(g) {
  const { s, cx, spacing, open } = g;
  const face = ASCII[emotion];
  const glitching = time - changedAt < GLITCH_DURATION;
  const hasBrows = face.brows && face.brows.some(Boolean);
  const cy = g.cy + (hasBrows ? s * 0.2 : 0)
           + (face.fx === 'bounce' ? -Math.abs(Math.sin(time * 7)) * s * 0.1 : 0);
  const pulse = face.fx === 'pulse' ? 1 + 0.08 * Math.sin(time * 6) : 1;

  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = s * 0.15;

  [-1, 1].forEach((side, i) => {
    const persp = 1 + cur.lookX * side * 0.08;
    const x = cx + side * spacing;
    let glyph = face.eyes[i];
    if (glitching) glyph = GLITCH_GLYPHS[(Math.floor(time * 25) + i * 7) % GLITCH_GLYPHS.length];
    else if (open < 0.5 && !CLOSED_GLYPHS.has(glyph)) glyph = '-';
    const size = s * 1.6 * (face.scale || 1) * persp * pulse / Math.max(1, glyph.length * 0.7);
    const angle = face.fx === 'spin' && !glitching ? time * 4 * side : 0;
    glyphAt(glyph, x, cy, size, 1, angle);

    const brow = face.brows && face.brows[i];
    if (brow && !glitching) glyphAt(brow, x, cy - s * 0.82, s * 0.55 * persp);

    if (face.fx === 'tears' && !glitching) {
      for (let k = 0; k < 2; k++) {
        const p = (time * 0.7 + k * 0.5 + i * 0.25) % 1;
        glyphAt('.', x + side * s * 0.12, cy + s * 0.68 + p * s * 0.4, s * 1.1, 1 - p);
      }
    }
  });

  const rightX = cx + spacing;
  if (face.fx === 'zzz' && !glitching) {
    for (let k = 0; k < 3; k++) {
      const p = (time * 0.35 + k / 3) % 1;
      glyphAt('z', rightX + s * 0.4 + p * s * 0.4, cy - s * 0.25 - p * s * 0.5,
              s * (0.25 + 0.25 * p), Math.sin(p * Math.PI));
    }
  }
  if (face.fx === 'question' && !glitching) {
    glyphAt('?', rightX + s * 0.7, cy - s * 0.65 + Math.sin(time * 3) * s * 0.05, s * 0.55);
  }
  ctx.shadowBlur = 0;

  // CRT-style scanlines over everything.
  if (scanlines) {
    ctx.fillStyle = scanlines;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

// ------------------------------------------------------------------ frame

function draw() {
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const s = Math.min(W / 4.2, H / 2.2);  // base eye size
  // Slow drift + slight "breathing" so no pixel stays lit in one place (OLED burn-in).
  const driftX = Math.sin(time / 37) * s * 0.06;
  const driftY = Math.sin(time / 23) * s * 0.04 + Math.sin(time * 1.3) * s * 0.012;
  const g = {
    s,
    cx: W / 2 + driftX + cur.lookX * s * 0.55,
    cy: H / 2 + driftY + cur.lookY * s * 0.35,
    spacing: s * 0.85,
    open: blinkOpenness(),
  };

  if (style === 'ascii') drawAscii(g);
  else drawClassic(g);

  // Tiny dim dot in the corner when the link to the Jetson has been down for a while.
  if (!OFFLINE && !connected && time - disconnectedSince > 3) {
    ctx.fillStyle = '#400';
    ctx.beginPath();
    ctx.arc(s * 0.1, s * 0.1, s * 0.03, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ------------------------------------------------------------------ animation loop

function rand(a, b) { return a + Math.random() * (b - a); }

function update(dt) {
  // Idle behaviour: random blinks (sometimes double) and small glances around.
  if (time >= nextBlinkAt) {
    startBlink();
    nextBlinkAt = time + (Math.random() < 0.15 ? 0.25 : rand(2, 6));
  }
  if (commandedLook === null && time >= nextSaccadeAt) {
    if (Math.random() < 0.4) { lookTarget.x = 0; lookTarget.y = 0; }
    else { lookTarget.x = rand(-0.5, 0.5); lookTarget.y = rand(-0.3, 0.3); }
    nextSaccadeAt = time + rand(1.2, 3.5);
  }

  const kShape = 1 - Math.exp(-dt * 10);
  for (const key of Object.keys(CLASSIC_BASE)) cur[key] += (target[key] - cur[key]) * kShape;
  const kLook = 1 - Math.exp(-dt * 18);
  cur.lookX += (lookTarget.x - cur.lookX) * kLook;
  cur.lookY += (lookTarget.y - cur.lookY) * kLook;
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  time += dt;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ screen handling

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (_) { /* needs a secure context (localhost) and a user gesture on some browsers */ }
}

canvas.addEventListener('pointerdown', () => {
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }
  keepAwake();
  startBlink();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake();
});

addEventListener('resize', resize);
resize();
keepAwake();
if (!OFFLINE) connect();
requestAnimationFrame(frame);
