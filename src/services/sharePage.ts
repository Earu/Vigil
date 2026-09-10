// The page a share opens in. One source for both ways of sending one: the
// file carries its blob inline, the hosted page reads it out of the URL
// fragment, and nothing else about them differs.
//
// Constraints measured rather than assumed, on file:// in Chromium and
// Firefox: crypto.subtle is there and the context is secure, ES modules never
// execute, and nothing may be fetched. So this is one classic inline script
// with every byte embedded, and the same page works over https untouched.

const LOGO = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="shieldGradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="50%" stop-color="#bbbbbb" />
      <stop offset="100%" stop-color="#888888" />
    </linearGradient>
  </defs>
  <rect width="24" height="24" rx="4" ry="4" fill="#000000"/>
  <path d="M12 2l7 4v6c0 5-3.5 9-7 10-3.5-1-7-5-7-10V6l7-4z" fill="url(#shieldGradient)"/>
  <circle cx="12" cy="12" r="3" fill="#000000"/>
</svg>`;

const STYLE = `
:root {
  color-scheme: dark light;
  --bg-primary:#1a1a1a; --bg-secondary:#141414; --bg-dark:#000000; --bg-light:#222222;
  --text-primary:#ededed; --text-secondary:#c9c9c9; --text-tertiary:#939393;
  --border-primary:rgba(255,255,255,.07); --border-secondary:rgba(255,255,255,.12); --border-hover:rgba(255,255,255,.2);
  --accent:#ededed; --accent-contrast:#111111; --overlay-medium:rgba(255,255,255,.07);
  --radius-sm:2px; --radius-md:3px;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg-primary:#ffffff; --bg-secondary:#f2f2f2; --bg-dark:#ffffff; --bg-light:#ededed;
    --text-primary:#1a1a1a; --text-secondary:#383838; --text-tertiary:#5f5f5f;
    --border-primary:rgba(0,0,0,.09); --border-secondary:rgba(0,0,0,.14); --border-hover:rgba(0,0,0,.24);
    --accent:#1a1a1a; --accent-contrast:#ffffff; --overlay-medium:rgba(0,0,0,.06);
  }
}
* { box-sizing: border-box; }
body { margin:0; padding:40px 16px; background:var(--bg-dark); color:var(--text-primary);
  font:400 14px/1.45 Inter, system-ui, Avenir, Helvetica, Arial, sans-serif; -webkit-font-smoothing:antialiased; }
main { max-width:420px; margin:0 auto; }
header { display:flex; align-items:center; gap:10px; margin-bottom:22px; }
header svg { width:30px; height:30px; flex:none; border-radius:var(--radius-md); }
h1 { margin:0; font-size:15px; font-weight:600; letter-spacing:-.01em; }
.sub { margin:2px 0 0; color:var(--text-tertiary); font-size:12px; }
.card { padding:14px; border:1px solid var(--border-primary); border-radius:var(--radius-md); background:var(--bg-primary); }
label { display:block; margin:0 0 4px; font-size:10px; font-weight:500; text-transform:uppercase; letter-spacing:.05em; color:var(--text-tertiary); }
.field { margin:0 0 12px; }
.field:last-child { margin-bottom:0; }
input { width:100%; padding:7px 9px; border:1px solid var(--border-secondary); border-radius:var(--radius-sm);
  background:var(--bg-secondary); color:var(--text-primary); font:inherit; }
input:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
input#code { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing:.06em; text-transform:uppercase; }
button { padding:7px 12px; border:1px solid var(--border-secondary); border-radius:var(--radius-sm);
  background:var(--bg-light); color:var(--text-secondary); font:inherit; font-size:12px; cursor:pointer;
  transition:background-color .15s ease, color .15s ease; }
button:hover { background:var(--overlay-medium); color:var(--text-primary); }
button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
button.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-contrast); font-weight:500; }
button.primary:hover { background:var(--accent); color:var(--accent-contrast); opacity:.9; }
.row { display:flex; align-items:center; gap:6px; }
.value { flex:1; min-width:0; padding:7px 9px; border:1px solid var(--border-primary); border-radius:var(--radius-sm);
  background:var(--bg-secondary); color:var(--text-primary); font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size:12.5px; overflow-x:auto; white-space:pre-wrap; word-break:break-word; }
.value.hidden { letter-spacing:.18em; color:var(--text-secondary); }
.otp { font-size:17px; letter-spacing:.16em; }
.otp-left { flex:none; width:34px; text-align:right; color:var(--text-tertiary); font-size:11px; font-variant-numeric:tabular-nums; }
.err:not(:empty) { margin:12px 0 0; padding:8px 10px; border:1px solid var(--border-secondary); border-left:2px solid var(--accent);
  border-radius:var(--radius-sm); background:var(--bg-secondary); color:var(--text-secondary); font-size:12px; }
.note { margin:16px 0 0; color:var(--text-tertiary); font-size:12px; line-height:1.5; }
.message { margin:14px 0 0; padding-top:12px; border-top:1px solid var(--border-primary); color:var(--text-secondary); font-size:12.5px; }
.actions { display:flex; justify-content:flex-end; }
.step { padding:6px 7px; line-height:0; }
.step:disabled { opacity:.35; cursor:default; }
.step:disabled:hover { background:var(--bg-light); color:var(--text-secondary); }
.chev { width:14px; height:14px; }
.chev.back { transform:rotate(180deg); }
.card.message { margin-bottom:10px; padding:11px 13px; border-left:2px solid var(--accent);
  background:var(--bg-light); color:var(--text-primary); font-size:13px; }
.card.message p { margin:3px 0 0; }
.message-label { display:block; font-size:10px; font-weight:600; text-transform:uppercase;
  letter-spacing:.06em; color:var(--text-tertiary); }
a { color:var(--text-secondary); }
a:hover { color:var(--text-primary); }
`.trim();

// Only data is ever encrypted, never code, and the payload is written with
// textContent, so a share cannot introduce markup or script into the page that
// opens it
const SCRIPT_BODY = `
var ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
var $ = function (id) { return document.getElementById(id); };
function bytes(b64) {
  var bin = atob(b64), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function join(a, b) {
  var out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
// Crockford: the letters that look like digits are read as digits
function tidy(value) {
  return value.toUpperCase().replace(/[\s-]/g, '').replace(/[ILU]/g, '1').replace(/O/g, '0');
}
function indexOfCode(head) {
  var index = 0;
  for (var i = 0; i < head.length; i++) {
    var digit = ALPHABET.indexOf(head[i]);
    if (digit < 0) return -1;
    index = index * 32 + digit;
  }
  return index;
}
function el(tag, className, textContent) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}
function chevron(back) {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', back ? 'chev back' : 'chev');
  var path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  path.setAttribute('points', '9 18 15 12 9 6');
  svg.appendChild(path);
  return svg;
}
function stepButton(back, label, onClick) {
  var button = el('button', 'step');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(chevron(back));
  button.onclick = onClick;
  return button;
}
function copyButton(read) {
  var button = el('button', '', 'Copy');
  button.type = 'button';
  button.onclick = function () {
    var value = read();
    var done = function () { button.textContent = 'Copied'; setTimeout(function () { button.textContent = 'Copy'; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done, function () { fallback(value, done); });
    } else { fallback(value, done); }
  };
  return button;
}
function fallback(value, done) {
  var area = document.createElement('textarea');
  area.value = value; area.setAttribute('readonly', '');
  area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.appendChild(area); area.select();
  try { document.execCommand('copy'); done(); } catch (e) { /* nothing left to try */ }
  document.body.removeChild(area);
}
// RFC 4648 base32, the alphabet one-time codes are written in
function base32(value) {
  var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', bits = 0, acc = 0, out = [];
  var text = value.toUpperCase().replace(/[=\s-]/g, '');
  for (var i = 0; i < text.length; i++) {
    var digit = A.indexOf(text[i]);
    if (digit < 0) continue;
    acc = (acc << 5) | digit; bits += 5;
    if (bits >= 8) { out.push((acc >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
async function otpCode(item, counter) {
  var key = await crypto.subtle.importKey('raw', base32(item.secret), { name: 'HMAC', hash: item.algorithm }, false, ['sign']);
  var buffer = new ArrayBuffer(8), view = new DataView(buffer);
  view.setUint32(0, Math.floor(counter / 4294967296));
  view.setUint32(4, counter >>> 0);
  var mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer));
  var offset = mac[mac.length - 1] & 15;
  var truncated = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  if (item.encoder === 'steam') {
    var S = '23456789BCDFGHJKMNPQRTVWXY', left = truncated, code = '';
    for (var i = 0; i < 5; i++) { code += S[left % 26]; left = Math.floor(left / 26); }
    return code;
  }
  var mod = Math.pow(10, item.digits);
  var digits = String(truncated % mod);
  while (digits.length < item.digits) digits = '0' + digits;
  return digits;
}
function renderText(item, secret) {
  var row = el('div', 'row');
  var value = el('div', 'value');
  var shown = !secret;
  var mask = function () { return '•'.repeat(Math.min(item.value.length, 24)); };
  value.textContent = shown ? item.value : mask();
  if (!shown) value.className = 'value hidden';
  row.appendChild(value);
  if (secret) {
    var reveal = el('button', '', 'Show');
    reveal.type = 'button';
    reveal.onclick = function () {
      shown = !shown;
      value.textContent = shown ? item.value : mask();
      value.className = shown ? 'value' : 'value hidden';
      reveal.textContent = shown ? 'Hide' : 'Show';
    };
    row.appendChild(reveal);
  }
  row.appendChild(copyButton(function () { return item.value; }));
  return row;
}
function renderTotp(item) {
  var row = el('div', 'row');
  var value = el('div', 'value otp', '------');
  var left = el('span', 'otp-left', '');
  row.appendChild(value);
  row.appendChild(left);
  row.appendChild(copyButton(function () { return value.textContent; }));
  var tick = function () {
    otpCode(item, Math.floor(Date.now() / 1000 / item.period))
      .then(function (code) { value.textContent = code; }, function () { value.textContent = 'unreadable'; });
  };
  tick();
  setInterval(function () {
    var seconds = item.period - Math.floor(Date.now() / 1000) % item.period;
    left.textContent = seconds + 's';
    if (seconds === item.period) tick();
  }, 1000);
  left.textContent = (item.period - Math.floor(Date.now() / 1000) % item.period) + 's';
  return row;
}
// Counter-based: one code at a time, stepped the way the app steps it
function renderHotp(item) {
  var row = el('div', 'row');
  var value = el('div', 'value otp', '------');
  var mark = el('span', 'otp-left', '#' + item.counter);
  var counter = item.counter;
  var back;
  var draw = function () {
    mark.textContent = '#' + counter;
    back.disabled = counter === 0;
    otpCode(item, counter).then(function (code) { value.textContent = code; }, function () { value.textContent = 'unreadable'; });
  };
  back = stepButton(true, 'Previous code', function () { if (counter > 0) { counter -= 1; draw(); } });
  var forward = stepButton(false, 'Next code', function () { counter += 1; draw(); });
  draw();
  row.appendChild(value);
  row.appendChild(mark);
  row.appendChild(back);
  row.appendChild(forward);
  row.appendChild(copyButton(function () { return value.textContent; }));
  return row;
}
function renderFile(item) {
  var row = el('div', 'row');
  row.appendChild(el('div', 'value', item.size));
  var save = el('button', '', 'Save');
  save.type = 'button';
  save.onclick = function () {
    var blob = new Blob([bytes(item.data)], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url; link.download = item.label;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  };
  row.appendChild(save);
  return row;
}
function show(payload) {
  var out = $('out');
  out.textContent = '';
  if (payload.message) {
    var note = el('div', 'card message');
    note.appendChild(el('span', 'message-label', 'Note'));
    note.appendChild(el('p', '', payload.message));
    out.appendChild(note);
  }
  var card = el('div', 'card');
  for (var i = 0; i < payload.items.length; i++) {
    var item = payload.items[i];
    var field = el('div', 'field');
    field.appendChild(el('label', '', item.label));
    if (item.kind === 'otp') field.appendChild(item.type === 'hotp' ? renderHotp(item) : renderTotp(item));
    else if (item.kind === 'file') field.appendChild(renderFile(item));
    else field.appendChild(renderText(item, item.kind === 'secret'));
    card.appendChild(field);
  }
  out.appendChild(card);
  $('lock').hidden = true;
  var sub = $('sub');
  sub.textContent = 'Sent ' + new Date(payload.sharedAt).toLocaleDateString() + ' with ';
  var link = document.createElement('a');
  link.href = 'https://github.com/Earu/Vigil/releases';
  link.target = '_blank';
  link.rel = 'noreferrer noopener';
  link.textContent = 'Vigil';
  sub.appendChild(link);
}
function fail(value) { $('err').textContent = value; }
async function phraseBits(phrase) {
  var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(phrase), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: bytes(BLOB.salt), iterations: BLOB.iterations, hash: 'SHA-256' }, key, 256));
}
async function openPayload(fileKey) {
  var aes = await crypto.subtle.importKey('raw', fileKey, 'AES-GCM', false, ['decrypt']);
  var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(BLOB.iv) }, aes, bytes(BLOB.data));
  return JSON.parse(new TextDecoder().decode(plain));
}
async function unlockOffline(phrase) {
  return openPayload(await phraseBits(phrase));
}
async function unlockApproved(phrase, typed) {
  var code = tidy(typed);
  if (code.length !== 3 + BLOB.codeLength) throw new Error('shape');
  var index = indexOfCode(code.slice(0, 3));
  if (index < 0) throw new Error('shape');
  if (index >= BLOB.wraps.length) throw new Error('gone');
  var now = Math.floor((Date.now() - BLOB.start) / BLOB.windowMs);
  // The window the code names, or the next one, so a code handed over near the
  // end of a window is not dead on arrival. Client-side, so it is a courtesy
  // to the honest and nothing more
  if (index !== now && index !== now + 1) throw new Error(index < now ? 'stale' : 'early');
  var ikm = join(await phraseBits(phrase), new TextEncoder().encode(code.slice(3)));
  var hk = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  var derived = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: bytes(BLOB.salt), info: new TextEncoder().encode('vigil-share-wrap-v1') }, hk, 352));
  var wrapKey = await crypto.subtle.importKey('raw', derived.slice(0, 32), 'AES-GCM', false, ['decrypt']);
  var fileKey = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: derived.slice(32, 44) }, wrapKey, bytes(BLOB.wraps[index]));
  return openPayload(new Uint8Array(fileKey));
}
var MESSAGES = {
  shape: 'That code does not look right. Check it and try again.',
  gone: 'This share has expired for good. Ask for a new one.',
  stale: 'That code has expired. Ask for a new one.',
  early: 'That code is not usable yet. Check your clock, or ask for a new one.'
};
function paint() {
  var sender = BLOB.sender || 'Someone';
  $('title').textContent = sender + ' shared this with you';
  $('sub').textContent = 'Ask ' + sender + ' for a code, then type it below.';
  var code = $('code');
  code.placeholder = ['000'].concat('0'.repeat(BLOB.codeLength).match(/.{1,5}/g)).join('-');
  if (BLOB.start && BLOB.windowMs && BLOB.wraps) {
    var ends = new Date(BLOB.start + BLOB.wraps.length * BLOB.windowMs);
    $('deadline').textContent = 'This stops working on ' + ends.toLocaleDateString() + ', whatever code you have.';
  }
}
document.addEventListener('DOMContentLoaded', function () {
  if (!BLOB) {
    // A link that lost its tail, or the page opened on its own
    $('lock').hidden = true;
    $('title').textContent = 'Nothing to open';
    $('sub').textContent = 'This link is missing the part that carries the secret. Ask whoever sent it for the whole link.';
    return;
  }
  paint();
  $('form').addEventListener('submit', function (event) {
    event.preventDefault();
    var button = $('go');
    fail('');
    button.disabled = true; button.textContent = 'Opening';
    var phrase = $('phrase') ? $('phrase').value.trim() : '';
    var attempt = BLOB.mode === 'approved' ? unlockApproved(phrase, $('code').value) : unlockOffline(phrase);
    attempt.then(show, function (err) {
      fail(MESSAGES[err && err.message] || 'That did not open this file. Check what you typed and try again.');
      button.disabled = false; button.textContent = 'Open';
      var first = $('phrase') || $('code');
      first.focus(); first.select();
    });
  });
  var first = $('phrase') || $('code');
  first.focus();
});
`.trim();

// Where the blob comes from is the only difference between the two builds
export const INLINE_BLOB = (json: string): string => json;
export const FRAGMENT_BLOB = `(function () {
  try {
    var raw = location.hash.slice(1);
    if (!raw) return null;
    return JSON.parse(new TextDecoder().decode(bytes(raw.replace(/-/g, '+').replace(/_/g, '/'))));
  } catch (e) {
    return null;
  }
})()`;

export const pageScript = (blobExpression: string): string =>
    `var BLOB = ${blobExpression};\n${SCRIPT_BODY}`;

export const PAGE_STYLE = STYLE;

// Digest is injected: the app has WebCrypto, the build script has node's crypto
export async function buildPage(
    blobExpression: string,
    digest: (text: string) => Promise<string>,
): Promise<string> {
    const script = pageScript(blobExpression);
    const csp = `default-src 'none'; script-src '${await digest(script)}'; `
        + `style-src '${await digest(STYLE)}'; base-uri 'none'; form-action 'none'`;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Shared with you</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    ${LOGO}
    <div>
      <h1 id="title">Shared with you</h1>
      <p class="sub" id="sub"></p>
    </div>
  </header>
  <div id="lock">
    <div class="card">
      <form id="form">
        <div class="field">
          <label for="code">Code</label>
          <input id="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false">
        </div>
        <div class="actions"><button id="go" class="primary" type="submit">Open</button></div>
      </form>
    </div>
    <p class="err" id="err" role="alert"></p>
    <p class="note" id="deadline"></p>
  </div>
  <div id="out"></div>
</main>
<script>${script}</script>
</body>
</html>
`;
}
