// Robot face renderer. All animation runs here; the Jetson only sends commands.
'use strict';

// w, h:          eye size multipliers
// topIn, topOut: how much of the eye the upper lid covers at the inner / outer edge (0..1)
// bottom:        how far the lower "cheek" pushes up into the eye (happy squint)
const EMOTIONS = {
  neutral:   { w: 1.00, h: 1.00, topIn: 0.00, topOut: 0.00, bottom: 0.00 },
  happy:     { w: 1.05, h: 0.95, topIn: 0.00, topOut: 0.00, bottom: 0.55 },
  sad:       { w: 1.00, h: 0.90, topIn: 0.05, topOut: 0.45, bottom: 0.00 },
  angry:     { w: 1.00, h: 0.90, topIn: 0.50, topOut: 0.05, bottom: 0.00 },
  surprised: { w: 1.15, h: 1.25, topIn: 0.00, topOut: 0.00, bottom: 0.00 },
  sleepy:    { w: 1.05, h: 0.85, topIn: 0.55, topOut: 0.60, bottom: 0.10 },
};

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('face');
const ctx = canvas.getContext('2d');

const cur = { ...EMOTIONS.neutral, lookX: 0, lookY: 0 };
const target = { ...EMOTIONS.neutral };
const lookTarget = { x: 0, y: 0 };
let commandedLook = null;   // [x, y] from the robot, or null = wander on our own
let color = '#3cf0ff';
let blinkStart = -1;        // seconds; < 0 means not blinking
let nextBlinkAt = 2;
let nextSaccadeAt = 1;
let connected = false;
let disconnectedSince = 0;
let time = 0;

const BLINK_DURATION = 0.16;

// ------------------------------------------------------------------ commands

function applyMessage(msg) {
  if (msg.emotion && EMOTIONS[msg.emotion]) Object.assign(target, EMOTIONS[msg.emotion]);
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

// ------------------------------------------------------------------ drawing

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
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

// side: -1 = left eye, +1 = right eye (as seen by the viewer)
function drawEye(x, y, w, h, side, glow) {
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

function blinkOpenness() {
  if (blinkStart < 0) return 1;
  const t = (time - blinkStart) / BLINK_DURATION;
  if (t >= 1) { blinkStart = -1; return 1; }
  return Math.max(0.04, Math.abs(1 - 2 * t));
}

function draw() {
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const s = Math.min(W / 4.2, H / 2.2);  // base eye size
  // Slow drift + slight "breathing" so no pixel stays lit in one place (OLED burn-in).
  const driftX = Math.sin(time / 37) * s * 0.06;
  const driftY = Math.sin(time / 23) * s * 0.04 + Math.sin(time * 1.3) * s * 0.012;
  const cx = W / 2 + driftX + cur.lookX * s * 0.55;
  const cy = H / 2 + driftY + cur.lookY * s * 0.35;
  const spacing = s * 0.85;
  const open = blinkOpenness();
  const glow = s * 0.12;

  for (const side of [-1, 1]) {
    // The eye on the side we're looking toward gets slightly bigger (fake perspective).
    const persp = 1 + cur.lookX * side * 0.08;
    const w = s * cur.w * persp;
    const h = s * 1.15 * cur.h * persp * open;
    drawEye(cx + side * spacing, cy, w, h, side, glow);
  }

  // Tiny dim dot in the corner when the link to the Jetson has been down for a while.
  if (!connected && time - disconnectedSince > 3) {
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
  for (const key of Object.keys(target)) cur[key] += (target[key] - cur[key]) * kShape;
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
if (params.get('emotion') && EMOTIONS[params.get('emotion')]) applyMessage({ emotion: params.get('emotion') });
connect();
requestAnimationFrame(frame);
