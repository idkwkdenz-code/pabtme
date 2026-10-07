'use strict';

/* ============================ helpers ============================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const USERNAME_RE = /^[A-Za-z0-9_]{6,20}$/;

async function api(url, opts = {}) {
  const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: { 'X-Requested-With': 'pabtme' } };
  if (opts.json) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
  }
  if (opts.form) init.body = opts.form;
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('No connection. Check your internet and try again.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong.');
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3600);
}

function showErr(el, msg) {
  el.textContent = msg;
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}

/* ============================ particle background ============================ */
(function particles() {
  const c = $('#bg');
  const ctx = c.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w, h, dots = [];
  const mouse = { x: -999, y: -999 };

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = c.width = innerWidth * dpr;
    h = c.height = innerHeight * dpr;
    c.style.width = innerWidth + 'px';
    c.style.height = innerHeight + 'px';
    const n = Math.min(90, Math.floor((innerWidth * innerHeight) / 18000));
    dots = Array.from({ length: n }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.4 * dpr, vy: (Math.random() - 0.5) * 0.4 * dpr,
      r: (Math.random() * 1.6 + 0.6) * dpr
    }));
  }
  addEventListener('resize', resize);
  addEventListener('pointermove', (e) => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    mouse.x = e.clientX * dpr; mouse.y = e.clientY * dpr;
  });
  resize();

  function frame() {
    ctx.clearRect(0, 0, w, h);
    const link = 140 * (w / innerWidth);
    for (const d of dots) {
      if (!reduce) { d.x += d.vx; d.y += d.vy; }
      if (d.x < 0 || d.x > w) d.vx *= -1;
      if (d.y < 0 || d.y > h) d.vy *= -1;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, 6.283);
      ctx.fillStyle = 'rgba(190,170,255,.7)';
      ctx.fill();
    }
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        const dx = dots[i].x - dots[j].x, dy = dots[i].y - dots[j].y;
        const dist = Math.hypot(dx, dy);
        if (dist < link) {
          ctx.strokeStyle = `rgba(139,92,246,${(1 - dist / link) * 0.35})`;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(dots[i].x, dots[i].y); ctx.lineTo(dots[j].x, dots[j].y); ctx.stroke();
        }
      }
      const mx = dots[i].x - mouse.x, my = dots[i].y - mouse.y;
      const md = Math.hypot(mx, my);
      if (md < link * 1.3) {
        ctx.strokeStyle = `rgba(34,211,238,${(1 - md / (link * 1.3)) * 0.5})`;
        ctx.beginPath(); ctx.moveTo(dots[i].x, dots[i].y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke();
      }
    }
    if (!reduce) requestAnimationFrame(frame);
  }
  frame();
})();

/* ============================ safe markdown ============================ */
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderMd(src) {
  const blocks = [];
  src = src.replace(/```([\w+#.-]*)\n?([\s\S]*?)(```|$)/g, (m, lang, code) => {
    blocks.push({ lang, code: code.replace(/\n$/, '') });
    return `\u0000${blocks.length - 1}\u0000`;
  });
  let h = esc(src);
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  h = h.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  let out = '', list = null;
  const close = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const line of h.split('\n')) {
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { close(); const n = m[1].length + 1; out += `<h${n}>${m[2]}</h${n}>`; }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); out += '<ul>'; list = 'ul'; } out += `<li>${m[1]}</li>`; }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out += '<ol>'; list = 'ol'; } out += `<li>${m[1]}</li>`; }
    else if (!line.trim()) close();
    else { close(); out += `<p>${line}</p>`; }
  }
  close();
  out = out.replace(/<p>\u0000(\d+)\u0000<\/p>|\u0000(\d+)\u0000/g, (m, a, b) => {
    const blk = blocks[+(a ?? b)];
    return `<div class="code"><div class="code-head"><span>${esc(blk.lang || 'code')}</span><button type="button" data-copy-code>Copy</button></div><pre><code>${esc(blk.code)}</code></pre></div>`;
  });
  return out;
}

/* ============================ state ============================ */
const state = {
  user: null,
  chats: [],
  chatId: null,
  messages: [],
  files: [],
  busy: false,
  googleReady: false
};

/* ============================ views ============================ */
function show(view) {
  $('#authView').classList.toggle('hidden', view !== 'auth');
  $('#appView').classList.toggle('hidden', view !== 'app');
}

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModals() { $$('.modal').forEach((m) => m.classList.add('hidden')); }

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-open-about]')) { openModal('#aboutModal'); closeSidebar(); }
  if (e.target.closest('[data-close]') || e.target.classList.contains('modal')) closeModals();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

/* ============================ auth UI ============================ */
function setTab(reg) {
  $('#tabLogin').classList.toggle('active', !reg);
  $('#tabRegister').classList.toggle('active', reg);
  $('#tabLogin').setAttribute('aria-selected', String(!reg));
  $('#tabRegister').setAttribute('aria-selected', String(reg));
  $('.tabs').classList.toggle('reg', reg);
  $('#loginForm').classList.toggle('hidden', reg);
  $('#registerForm').classList.toggle('hidden', !reg);
}
$('#tabLogin').onclick = () => setTab(false);
$('#tabRegister').onclick = () => setTab(true);

$$('[data-eye]').forEach((b) => {
  b.onclick = () => {
    const i = $('#' + b.dataset.eye);
    i.type = i.type === 'password' ? 'text' : 'password';
  };
});

function pwScore(p) {
  let s = 0;
  if (p.length >= 8) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (p.length >= 12 || /[^A-Za-z0-9]/.test(p)) s++;
  return p ? Math.max(s, 1) : 0;
}
$('#regPw').addEventListener('input', (e) => {
  const p = e.target.value;
  $('.meter').dataset.s = pwScore(p);
  const ok = p.length >= 8 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p);
  $('#pwHint').className = 'hint ' + (p ? (ok ? 'good' : 'bad') : '');
  $('#pwHint').textContent = ok ? 'Strong enough.' : '8+ characters with upper, lower case and a number.';
});
$('#regUser').addEventListener('input', (e) => {
  const v = e.target.value;
  const ok = USERNAME_RE.test(v);
  $('#userHint').className = 'hint ' + (v ? (ok ? 'good' : 'bad') : '');
  $('#userHint').textContent = !v ? '' : ok ? 'Looks good.' : v.length < 6 ? `${6 - v.length} more character${6 - v.length === 1 ? '' : 's'} needed.` : 'Only letters, numbers and underscore.';
});

function withBusy(btn, fn) {
  return async (...a) => {
    btn.disabled = true;
    try { await fn(...a); } finally { btn.disabled = false; }
  };
}

$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = $('#loginForm button[type=submit]');
  withBusy(btn, async () => {
    $('#loginErr').textContent = '';
    try {
      const { user } = await api('/api/auth/login', {
        method: 'POST',
        json: { identifier: $('#loginId').value, password: $('#loginPw').value }
      });
      $('#loginPw').value = '';
      enterApp(user);
    } catch (err) {
      showErr($('#loginErr'), err.message);
    }
  })();
});

$('#registerForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const username = $('#regUser').value.trim();
  const email = $('#regEmail').value.trim();
  const password = $('#regPw').value;
  const err = $('#regErr');
  err.textContent = '';
  if (!USERNAME_RE.test(username)) return showErr(err, 'Username must be 6-20 characters: letters, numbers or underscore.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return showErr(err, 'Enter a valid email address.');
  if (password.length < 8 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password))
    return showErr(err, 'Password needs 8+ characters with upper case, lower case and a number.');
  const btn = $('#registerForm button[type=submit]');
  withBusy(btn, async () => {
    try {
      const { user } = await api('/api/auth/register', { method: 'POST', json: { username, email, password } });
      $('#regPw').value = '';
      enterApp(user);
    } catch (er) {
      showErr(err, er.message);
    }
  })();
});

/* ---------- Google sign-in ---------- */
function loadGoogle(clientId) {
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    if (!window.google || !google.accounts) return;
    google.accounts.id.initialize({
      client_id: clientId,
      callback: async (resp) => {
        try {
          const { user } = await api('/api/auth/google', { method: 'POST', json: { credential: resp.credential } });
          enterApp(user);
        } catch (err) {
          toast(err.message, 'bad');
        }
      }
    });
    google.accounts.id.renderButton($('#googleBtn'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: 330 });
    $('#googleWrap').classList.remove('hidden');
  };
  document.head.appendChild(s);
}

/* ============================ app ============================ */
function enterApp(user) {
  state.user = user;
  show('app');
  $('#userName').textContent = user.username;
  $('#userMail').textContent = user.email;
  $('#avatar').textContent = user.username[0].toUpperCase();
  $('#hello').textContent = `Hey ${user.username}`;
  loadChats();
  newChat();
  if (!user.usernameSet) {
    $('#nameInput').value = user.username;
    openModal('#nameModal');
  }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  state.user = null;
  $('#messages').innerHTML = '';
  show('auth');
  if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
}
$('#logout').onclick = logout;

/* ---------- username ---------- */
$('#editName').onclick = () => { $('#nameInput').value = state.user.username; $('#nameErr').textContent = ''; openModal('#nameModal'); closeSidebar(); };
$('#nameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('#nameInput').value.trim();
  if (!USERNAME_RE.test(v)) return showErr($('#nameErr'), 'Username must be 6-20 characters: letters, numbers or underscore.');
  try {
    const { user } = await api('/api/me/username', { method: 'POST', json: { username: v } });
    state.user = user;
    $('#userName').textContent = user.username;
    $('#avatar').textContent = user.username[0].toUpperCase();
    $('#hello').textContent = `Hey ${user.username}`;
    closeModals();
    toast('Username saved', 'good');
  } catch (err) {
    showErr($('#nameErr'), err.message);
  }
});

/* ---------- sidebar ---------- */
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show'); }
$('#menuBtn').onclick = () => { $('#sidebar').classList.add('open'); $('#scrim').classList.add('show'); };
$('#scrim').onclick = closeSidebar;

async function loadChats() {
  try {
    const { chats } = await api('/api/chats');
    state.chats = chats;
  } catch { state.chats = []; }
  renderChatList();
}

function renderChatList() {
  const list = $('#chatList');
  list.innerHTML = '';
  if (!state.chats.length) {
    const p = document.createElement('div');
    p.className = 'empty-list';
    p.textContent = 'Your chats will show up here.';
    list.appendChild(p);
    return;
  }
  for (const c of state.chats) {
    const b = document.createElement('button');
    b.className = 'chat-item' + (c.id === state.chatId ? ' active' : '');
    const sp = document.createElement('span');
    sp.textContent = c.title;
    b.appendChild(sp);
    b.onclick = () => openChat(c.id);
    list.appendChild(b);
  }
}

function newChat() {
  state.chatId = null;
  state.messages = [];
  state.files = [];
  renderFiles();
  $('#messages').innerHTML = '';
  $('#welcome').classList.remove('hidden');
  $('#chatTitle').textContent = 'New chat';
  renderChatList();
  closeSidebar();
  $('#input').focus();
}
$('#newChat').onclick = newChat;

async function openChat(id) {
  try {
    const { chat, messages } = await api('/api/chats/' + encodeURIComponent(id));
    state.chatId = chat.id;
    state.messages = messages;
    $('#messages').innerHTML = '';
    $('#welcome').classList.add('hidden');
    $('#chatTitle').textContent = chat.title;
    messages.forEach((m) => addMessage(m.role, m.content, m.files, false));
    renderChatList();
    closeSidebar();
    scrollDown(true);
  } catch (err) {
    toast(err.message, 'bad');
  }
}

$('#clearBtn').onclick = async () => {
  if (!state.chatId) return newChat();
  if (!confirm('Delete this chat for good?')) return;
  try {
    await api('/api/chats/' + encodeURIComponent(state.chatId), { method: 'DELETE' });
    await loadChats();
    newChat();
    toast('Chat deleted', 'good');
  } catch (err) { toast(err.message, 'bad'); }
};

$('#exportBtn').onclick = () => {
  if (!state.messages.length) return toast('Nothing to download yet.');
  const text = state.messages.map((m) => `${m.role === 'user' ? 'You' : 'PABTME.ai'}:\n${m.content}\n`).join('\n---\n\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  a.download = 'pabtme-chat.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

/* ---------- messages ---------- */
function scrollDown(instant) {
  const s = $('#scroller');
  s.scrollTo({ top: s.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
}

function addMessage(role, text, files = [], animate = true) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (role === 'user' ? 'me' : 'ai');
  if (!animate) wrap.style.animation = 'none';
  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = role === 'user' ? (state.user ? state.user.username[0].toUpperCase() : 'U') : 'P';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (files && files.length) {
    const att = document.createElement('div');
    att.className = 'att';
    files.forEach((f) => { const s = document.createElement('span'); s.textContent = '📎 ' + f; att.appendChild(s); });
    bubble.appendChild(att);
  }
  const body = document.createElement('div');
  body.className = 'body';
  if (role === 'user') body.textContent = text;
  else body.innerHTML = renderMd(text);
  bubble.appendChild(body);
  if (role !== 'user') {
    const tools = document.createElement('div');
    tools.className = 'msg-tools';
    const cp = document.createElement('button');
    cp.type = 'button';
    cp.textContent = 'Copy';
    cp.onclick = async () => {
      try { await navigator.clipboard.writeText(wrap.dataset.raw || text); toast('Copied', 'good'); } catch { toast('Could not copy', 'bad'); }
    };
    const rg = document.createElement('button');
    rg.type = 'button';
    rg.textContent = 'Ask again';
    rg.onclick = () => {
      const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
      if (lastUser && !state.busy) { $('#input').value = lastUser.content; send(); }
    };
    tools.append(cp, rg);
    bubble.appendChild(tools);
  }
  wrap.dataset.raw = text;
  wrap.append(badge, bubble);
  $('#messages').appendChild(wrap);
  return { wrap, body };
}

$('#messages').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy-code]');
  if (!b) return;
  const code = b.closest('.code').querySelector('code').textContent;
  try { await navigator.clipboard.writeText(code); b.textContent = 'Copied!'; setTimeout(() => (b.textContent = 'Copy'), 1400); } catch { toast('Could not copy', 'bad'); }
});

function typeOut(body, wrap, text) {
  return new Promise((resolve) => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || text.length > 6000) { body.innerHTML = renderMd(text); return resolve(); }
    let i = 0;
    const step = Math.max(3, Math.ceil(text.length / 180));
    const tick = () => {
      i = Math.min(text.length, i + step);
      body.innerHTML = renderMd(text.slice(0, i));
      scrollDown(true);
      if (i < text.length) setTimeout(tick, 16); else resolve();
    };
    tick();
  });
}

/* ---------- attachments ---------- */
const MAX_FILES = 5, MAX_BYTES = 10 * 1024 * 1024;

function addFiles(list) {
  for (const f of list) {
    if (state.files.length >= MAX_FILES) { toast(`Up to ${MAX_FILES} files per message.`, 'bad'); break; }
    if (f.size > MAX_BYTES) { toast(`${f.name} is over 10 MB.`, 'bad'); continue; }
    state.files.push(f);
  }
  renderFiles();
}

function renderFiles() {
  const tray = $('#fileTray');
  tray.innerHTML = '';
  state.files.forEach((f, idx) => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    if (f.type.startsWith('image/')) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = URL.createObjectURL(f);
      img.onload = () => URL.revokeObjectURL(img.src);
      chip.appendChild(img);
    } else {
      const ico = document.createElement('div');
      ico.className = 'ico';
      ico.textContent = f.name.toLowerCase().endsWith('.pdf') ? '📄' : '📃';
      chip.appendChild(ico);
    }
    const name = document.createElement('b');
    name.textContent = f.name;
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Remove ' + f.name);
    x.onclick = () => { state.files.splice(idx, 1); renderFiles(); };
    chip.append(name, x);
    tray.appendChild(chip);
  });
}

$('#attachBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
const comp = $('#composer');
['dragenter', 'dragover'].forEach((ev) => comp.addEventListener(ev, (e) => { e.preventDefault(); comp.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => comp.addEventListener(ev, (e) => { e.preventDefault(); comp.classList.remove('drag'); }));
comp.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
$('#input').addEventListener('paste', (e) => {
  const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (imgs.length) { e.preventDefault(); addFiles(imgs); }
});

/* ---------- voice input ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  $('#micBtn').classList.remove('hidden');
  let rec = null;
  $('#micBtn').onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.interimResults = false;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = (e) => {
      const t = [...e.results].map((r) => r[0].transcript).join(' ');
      const inp = $('#input');
      inp.value = (inp.value ? inp.value + ' ' : '') + t;
      autosize();
    };
    rec.onend = () => { $('#micBtn').classList.remove('rec'); rec = null; };
    rec.onerror = () => toast('Voice input is not available right now.', 'bad');
    rec.start();
    $('#micBtn').classList.add('rec');
  };
}

/* ---------- composer ---------- */
const input = $('#input');
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; }
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$('#sendBtn').onclick = send;

$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-p]');
  if (!b) return;
  input.value = b.dataset.p;
  autosize();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
});

async function send() {
  if (state.busy) return;
  const text = input.value.trim();
  if (!text && !state.files.length) return;
  state.busy = true;
  $('#sendBtn').disabled = true;

  const files = state.files.slice();
  $('#welcome').classList.add('hidden');
  addMessage('user', text || '(attachment)', files.map((f) => f.name));
  state.messages.push({ role: 'user', content: text || '(attachment)' });
  input.value = '';
  state.files = [];
  autosize();
  renderFiles();

  const { wrap, body } = addMessage('assistant', '');
  body.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  scrollDown();

  const fd = new FormData();
  fd.append('message', text);
  if (state.chatId) fd.append('chatId', state.chatId);
  files.forEach((f) => fd.append('files', f, f.name));

  try {
    const data = await api('/api/chat', { method: 'POST', form: fd });
    state.chatId = data.chatId;
    $('#chatTitle').textContent = data.title;
    wrap.dataset.raw = data.reply;
    await typeOut(body, wrap, data.reply);
    state.messages.push({ role: 'assistant', content: data.reply });
    loadChats();
  } catch (err) {
    if (err.status === 401) { toast('Session expired. Please log in again.', 'bad'); return logout(); }
    body.textContent = '⚠ ' + err.message;
    state.messages.pop();
    input.value = text;
    autosize();
  } finally {
    state.busy = false;
    $('#sendBtn').disabled = false;
    scrollDown();
    input.focus();
  }
}

/* ============================ boot ============================ */
(async function boot() {
  try {
    const cfg = await api('/api/config');
    if (cfg.googleClientId) loadGoogle(cfg.googleClientId);
  } catch { /* offline */ }
  try {
    const { user } = await api('/api/me');
    enterApp(user);
  } catch {
    show('auth');
  }
})();
