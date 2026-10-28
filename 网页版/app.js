/* 捞一条 · app.js
 * 纯静态 PWA。数据存在本地（localStorage）。
 * 规则见 Figma 说明板：排队式、7 天轮换不删、一个时段一轮、按剩余时间挑、"不看了"可找回。
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // 常量
  // ---------------------------------------------------------------------
  const STORAGE_KEY = 'laoyitiao.v1';
  const QUEUE_SIZE = 10;
  const ROTATE_DAYS = 7;           // 排队中 N 天没看 → 退到候补末尾
  const DISMISS_KEEP_DAYS = 30;    // "不看了" 保留 N 天可找回
  const DAY = 24 * 60 * 60 * 1000;

  const SOURCES = {
    douyin:   { name: '抖音',   short: '抖', cls: 'src-douyin',   hosts: ['douyin.com', 'iesdouyin.com'] },
    xhs:      { name: '小红书', short: '书', cls: 'src-xhs',      hosts: ['xiaohongshu.com', 'xhslink.com'] },
    bili:     { name: 'B站',    short: 'B',  cls: 'src-bili',     hosts: ['bilibili.com', 'b23.tv'] },
    kuaishou: { name: '快手',   short: '快', cls: 'src-kuaishou', hosts: ['kuaishou.com', 'kuaishou.cn', 'kwai.com'] },
    other:    { name: '网页',   short: '链', cls: 'src-other',    hosts: [] },
  };

  const DURATIONS = [
    { id: '5',      label: '5 分钟内', min: 5 },
    { id: '15',     label: '15 分钟',  min: 15 },
    { id: 'long',   label: '更长',     min: 30 },
    { id: 'image',  label: '图文',     min: 5 },
    { id: 'custom', label: '自定义…' },
  ];

  const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

  const DEFAULT_SCENES = () => ([
    { id: 'commute', name: '通勤', days: 'weekdays', windows: [{ start: '08:00', end: '09:00' }, { start: '18:00', end: '19:00' }], max: 3, durations: ['5', '15'], enabled: true, custom: false, inconvenient: 0 },
    { id: 'bed',     name: '睡前', days: 'daily',    windows: [{ start: '22:30', end: '23:59' }], max: 1, durations: ['5', '15', 'long'], enabled: true, custom: false, inconvenient: 0 },
    { id: 'weekend', name: '周末', days: 'weekend',  windows: [{ start: '10:00', end: '12:00' }], max: 5, durations: ['5', '15', 'long'], enabled: true, custom: false, inconvenient: 0 },
  ]);

  const APP_ICON_SVG = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><rect width="120" height="120" rx="28" fill="#1C1A16"/><g transform="rotate(12 60 48)"><circle cx="67" cy="12" r="4.5" stroke="#fff" stroke-width="5" fill="none"/><path d="M67 17 V43 a16 16 0 0 1 -32 0 V30" stroke="#fff" stroke-width="9" fill="none" stroke-linecap="round"/><path d="M35 34 L41 39" stroke="#fff" stroke-width="4.5" fill="none" stroke-linecap="round"/><rect x="36" y="56" width="52" height="12" rx="6" fill="#C94A24"/></g><path d="M20 92 q10 -8 20 0 t20 0 t20 0 t20 0" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.35"/><path d="M20 105 q10 -8 20 0 t20 0 t20 0 t20 0" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.18"/></svg>`;

  // ---------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const now = () => Date.now();
  const pad2 = (n) => String(n).padStart(2, '0');
  const minutesOf = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
  const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  let toastTimer = null;
  function toast(msg, ms = 2200) {
    const el = $('#toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  function fmtSavedDay(ts) {
    const d = new Date(ts), t = new Date();
    const dd = Math.floor((new Date(t.getFullYear(), t.getMonth(), t.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / DAY);
    if (dd === 0) return '今天存的';
    if (dd === 1) return '昨天存的';
    if (dd < 7) return `周${DAY_NAMES[d.getDay()]}存的`;
    return `${d.getMonth() + 1}月${d.getDate()}日存的`;
  }
  function fmtAgo(ts) {
    const d = new Date(ts), t = new Date();
    const dd = Math.floor((new Date(t.getFullYear(), t.getMonth(), t.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / DAY);
    if (dd === 0) return '今天'; if (dd === 1) return '昨天'; if (dd < 7) return `周${DAY_NAMES[d.getDay()]}`;
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  // ---------------------------------------------------------------------
  // 数据
  // ---------------------------------------------------------------------
  let state = null;

  function defaultState() {
    return {
      version: 1,
      items: {},           // id → item
      queue: [],           // 排队中 ids（顺序即优先级）
      standby: [],         // 候补 ids
      done: [],            // 看过的 ids（新的在前）
      dismissed: [],       // 不看的 ids（新的在前）
      scenes: DEFAULT_SCENES(),
      settings: { chain: true, onboarded: false, queueSize: QUEUE_SIZE, notifAsked: false },
      session: { key: null, count: 0 },
      lastNotifiedKey: null,
      lastRotationNote: null, // { at, count }
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) { state = Object.assign(defaultState(), JSON.parse(raw)); }
      else state = defaultState();
    } catch (e) { state = defaultState(); }
    if (!state.scenes || !state.scenes.length) state.scenes = DEFAULT_SCENES();
  }
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } }

  const item = (id) => state.items[id];
  const queueItems = () => state.queue.map(item).filter(Boolean);
  const standbyItems = () => state.standby.map(item).filter(Boolean);
  const scene = (id) => state.scenes.find((s) => s.id === id);

  // ---- 内容识别 ----
  function extractUrl(text) {
    const m = String(text || '').match(/https?:\/\/[^\s"'<>）)】\]]+/i);
    return m ? m[0].replace(/[。，,.!！?？]+$/, '') : null;
  }
  function detectSource(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      for (const [k, s] of Object.entries(SOURCES)) if (s.hosts.some((h) => host === h || host.endsWith('.' + h))) return k;
    } catch (_) {}
    return 'other';
  }
  function guessTitle(text, url) {
    let t = String(text || '');
    if (url) t = t.replace(url, ' ');
    t = t.replace(/https?:\/\/\S+/g, ' ');
    t = t.replace(/\d+\.\d+\s*/g, ' ');
    t = t.replace(/复制打开抖音|复制此链接|打开抖音|打开小红书|在小红书|看看.*?的作品|查看.*?的作品|【[^】]*】|长按复制此消息|打开快手|极速版|搜索|直接观看|视频|作品/g, ' ');
    t = t.replace(/[\s，,。！!、:：\-—]+/g, ' ').trim();
    t = t.replace(/^(分享|来自|发现|我在)/, '').trim();
    if (t.length > 60) t = t.slice(0, 60);
    return t;
  }
  function normalizeUrl(url) { try { const u = new URL(url); return (u.hostname + u.pathname).replace(/\/$/, '').toLowerCase(); } catch (_) { return String(url || '').toLowerCase(); } }
  function findDuplicate(url) {
    const key = normalizeUrl(url);
    return Object.values(state.items).find((it) => (it.status === 'queue' || it.status === 'standby') && normalizeUrl(it.url) === key) || null;
  }
  function parseShareText(text) {
    const url = extractUrl(text);
    if (!url) return { ok: false, text };
    const source = detectSource(url);
    return { ok: true, url, source, title: guessTitle(text, url), recognized: source !== 'other' };
  }

  // ---- 时长 ----
  function durationMinutes(it) {
    if (typeof it.duration === 'number') return it.duration;
    const d = DURATIONS.find((x) => x.id === it.duration);
    return d && d.min ? d.min : 10;
  }
  function durationClass(it) {
    if (it.duration === 'image') return '5';
    const m = durationMinutes(it);
    return m <= 5 ? '5' : m <= 15 ? '15' : 'long';
  }
  function durationLabel(it) {
    if (it.duration === 'image') return '图文';
    if (it.duration === 'long') return '30 分钟以上';
    return `${durationMinutes(it)} 分钟`;
  }

  // ---- 场景与时段 ----
  function sceneDays(sc) {
    if (Array.isArray(sc.days)) return sc.days;
    if (sc.days === 'weekdays') return [1, 2, 3, 4, 5];
    if (sc.days === 'weekend') return [0, 6];
    return [0, 1, 2, 3, 4, 5, 6];
  }
  function sceneDaysLabel(sc) {
    if (sc.days === 'weekdays') return '工作日';
    if (sc.days === 'weekend') return '周六、周日';
    if (sc.days === 'daily') return '每天';
    const d = sceneDays(sc); if (d.length === 7) return '每天';
    return d.map((x) => '周' + DAY_NAMES[x]).join('、');
  }
  function sceneWindowsLabel(sc) {
    return sc.windows.map((w) => w.end === '23:59' ? `${w.start} 起` : `${w.start}–${w.end}`).join('，');
  }
  function sceneMaxLabel(sc) { return sc.max === 'unlimited' ? '不限' : `${sc.max} 条`; }

  function activeWindows(d = new Date()) {
    const wd = d.getDay(), nowMin = d.getHours() * 60 + d.getMinutes();
    const out = [];
    for (const sc of state.scenes) {
      if (!sc.enabled || !sceneDays(sc).includes(wd)) continue;
      for (const w of sc.windows) {
        const s = minutesOf(w.start), e = minutesOf(w.end);
        if (nowMin >= s && nowMin < e) out.push({ scene: sc, window: w, remaining: e - nowMin, sinceStart: nowMin - s, key: `${sc.id}|${dateKey(d)}|${w.start}` });
      }
    }
    // 重叠时都算；主时段取"不方便"分数低的
    out.sort((a, b) => (a.scene.inconvenient || 0) - (b.scene.inconvenient || 0));
    return out;
  }
  function activeWindow(d) { const a = activeWindows(d); return a[0] || null; }
  function nextWindowLabel(d = new Date()) {
    // 未来 7 天内最近的一个时段
    for (let k = 0; k < 7; k++) {
      const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + k);
      const wd = dd.getDay(); const nowMin = k === 0 ? d.getHours() * 60 + d.getMinutes() : -1;
      let best = null;
      for (const sc of state.scenes) {
        if (!sc.enabled || !sceneDays(sc).includes(wd)) continue;
        for (const w of sc.windows) { const s = minutesOf(w.start); if (s > nowMin && (!best || s < best.s)) best = { s, sc, w }; }
      }
      if (best) return `${k === 0 ? '今天' : k === 1 ? '明天' : '周' + DAY_NAMES[wd]} ${best.w.start} ${best.sc.name}`;
    }
    return null;
  }
  function sessionFor(aw) {
    if (!aw) return null;
    if (state.session.key !== aw.key) { state.session = { key: aw.key, count: 0 }; save(); }
    return state.session;
  }
  function limitReached(aw) {
    if (!aw) return false; const s = sessionFor(aw);
    return aw.scene.max !== 'unlimited' && s.count >= Number(aw.scene.max);
  }

  // ---- 挑选 ----
  function fitsWindow(it, aw) {
    return durationMinutes(it) <= aw.remaining && aw.scene.durations.includes(durationClass(it));
  }
  const byAge = (a, b) => (a.queuedAt || 0) - (b.queuedAt || 0);
  function pickForPush(aw, exclude = []) {
    const q = queueItems().filter((it) => !exclude.includes(it.id));
    if (!q.length || !aw) return null;
    const sc = aw.scene;
    const tiers = [
      q.filter((it) => (it.scenes || []).includes(sc.id)),
      q.filter((it) => (it.scenes || []).includes('any')),
      q,
    ];
    for (const tier of tiers) { const fit = tier.filter((it) => fitsWindow(it, aw)).sort(byAge); if (fit.length) return fit[0]; }
    return null;
  }
  function pickForToday(exclude = []) {
    const q = queueItems().filter((it) => !exclude.includes(it.id));
    if (!q.length) return { item: null, aw: null };
    const aw = activeWindow();
    if (!aw) return { item: q[0], aw: null };
    const pushPick = pickForPush(aw, exclude);
    if (pushPick) return { item: pushPick, aw };
    const tagged = q.filter((it) => (it.scenes || []).includes(aw.scene.id)).sort(byAge);
    return { item: tagged[0] || q[0], aw, loose: true };
  }

  // ---- 队列操作 ----
  function promote() {
    const size = state.settings.queueSize || QUEUE_SIZE;
    while (state.queue.length < size && state.standby.length) {
      const id = state.standby.shift(); const it = item(id); if (!it) continue;
      it.status = 'queue'; it.queuedAt = now(); state.queue.push(id);
    }
  }
  function addItem(data) {
    const it = {
      id: uid(), url: data.url, source: data.source || detectSource(data.url), title: (data.title || '').trim() || '（没写名字）',
      why: (data.why || '').trim(), duration: data.duration || '5', scenes: data.scenes && data.scenes.length ? data.scenes : ['any'],
      createdAt: now(), status: 'standby', queuedAt: null, demotedCount: 0, doneAt: null, dismissedAt: null,
    };
    state.items[it.id] = it;
    state.standby.push(it.id);
    promote(); save();
    return it;
  }
  function updateItem(id, data) { const it = item(id); if (!it) return; Object.assign(it, data); save(); }
  function removeFromLists(id) { for (const k of ['queue', 'standby', 'done', 'dismissed']) state[k] = state[k].filter((x) => x !== id); }
  function markDone(id) {
    const it = item(id); if (!it) return;
    removeFromLists(id); it.status = 'done'; it.doneAt = now(); state.done.unshift(id);
    const aw = activeWindow(); if (aw) { sessionFor(aw).count++; }
    promote(); save();
  }
  function dismiss(id) {
    const it = item(id); if (!it) return;
    removeFromLists(id); it.status = 'dismissed'; it.dismissedAt = now(); state.dismissed.unshift(id);
    promote(); save();
  }
  function restore(id) {   // 不看的 → 候补末尾（有空位会自动进排队）
    const it = item(id); if (!it) return;
    removeFromLists(id); it.status = 'standby'; it.dismissedAt = null; state.standby.push(id); promote(); save();
  }
  function rewatch(id) { restore(id); }
  function swapBack(id) {  // 换一条：这条往后排一位
    const i = state.queue.indexOf(id); if (i < 0 || i >= state.queue.length - 1) return false;
    state.queue.splice(i, 1); state.queue.splice(i + 1, 0, id); save(); return true;
  }
  function jumpQueue(id) { // 候补 → 排队最前；挤出去的那条到候补最前
    const it = item(id); if (!it) return;
    removeFromLists(id); it.status = 'queue'; it.queuedAt = now(); state.queue.unshift(id);
    const size = state.settings.queueSize || QUEUE_SIZE;
    while (state.queue.length > size) { const last = state.queue.pop(); const li = item(last); if (li) { li.status = 'standby'; state.standby.unshift(last); } }
    save();
  }
  function moveInQueue(id, dir) {
    const i = state.queue.indexOf(id); const j = i + dir; if (i < 0 || j < 0 || j >= state.queue.length) return;
    state.queue.splice(i, 1); state.queue.splice(j, 0, id); save();
  }
  function markInconvenient(sceneId) {
    const sc = scene(sceneId); if (sc) sc.inconvenient = (sc.inconvenient || 0) + 1;
    const aw = activeWindow(); if (aw) { const s = sessionFor(aw); s.snoozed = true; }
    save();
  }
  function deleteForever(id) { removeFromLists(id); delete state.items[id]; save(); }

  function daysLeft(it) { if (!it.queuedAt) return ROTATE_DAYS; return Math.max(0, ROTATE_DAYS - Math.floor((now() - it.queuedAt) / DAY)); }

  function maintenance() {
    let rotated = 0;
    for (const id of [...state.queue]) {
      const it = item(id); if (!it) { state.queue = state.queue.filter((x) => x !== id); continue; }
      if (it.queuedAt && now() - it.queuedAt >= ROTATE_DAYS * DAY) {
        state.queue = state.queue.filter((x) => x !== id); it.status = 'standby'; it.demotedCount = (it.demotedCount || 0) + 1; state.standby.push(id); rotated++;
      }
    }
    if (rotated) state.lastRotationNote = { at: now(), count: rotated + ((state.lastRotationNote && now() - state.lastRotationNote.at < 7 * DAY) ? state.lastRotationNote.count : 0) };
    for (const id of [...state.dismissed]) { const it = item(id); if (!it || (it.dismissedAt && now() - it.dismissedAt > DISMISS_KEEP_DAYS * DAY)) deleteForever(id); }
    promote(); save();
  }

  // ---------------------------------------------------------------------
  // 通知
  // ---------------------------------------------------------------------
  let swReg = null;
  async function registerSW() {
    if (!('serviceWorker' in navigator)) return null;
    try { swReg = await navigator.serviceWorker.register('./sw.js'); } catch (e) { swReg = null; }
    navigator.serviceWorker.addEventListener('message', (e) => {
      const m = e.data || {}; if (m.type !== 'notification-action') return;
      handleNotificationAction(m.action, m.itemId, m.sceneId);
    });
    return swReg;
  }
  function handleNotificationAction(action, itemId, sceneId) {
    if (action === 'later' && sceneId) { markInconvenient(sceneId); toast('好，这个时段以后少推'); }
    if (action === 'dismiss' && itemId) { dismiss(itemId); toast('已放进「不看的」，30 天内可找回'); }
    render();
  }
  function notifPermission() { return ('Notification' in window) ? Notification.permission : 'unsupported'; }
  async function askNotification() {
    if (!('Notification' in window)) { toast('这个浏览器不支持通知'); return 'unsupported'; }
    state.settings.notifAsked = true; save();
    const p = await Notification.requestPermission();
    return p;
  }
  async function showReminder(payload) {
    if (notifPermission() !== 'granted') return false;
    const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.ready.catch(() => null));
    if (reg && reg.active) { reg.active.postMessage({ type: 'show-reminder', payload }); return true; }
    try { new Notification(payload.title || '捞一条', { body: payload.body, icon: './icons/icon-192.png' }); return true; } catch (_) { return false; }
  }
  function reminderText(it, aw) {
    const sc = aw.scene; const rem = aw.remaining;
    const why = it.why ? `你${fmtSavedDay(it.createdAt).replace('存的', '')}说「${it.why}」。` : '';
    return `${sc.name}还有 ${rem} 分钟？${why}「${it.title}」只要${durationLabel(it)}，${daysLeft(it) <= 1 ? '明天就轮到下一条了。' : '现在正好。'}`;
  }
  // 本地提醒：页面开着（或在后台没被杀）时，时段一开始就推一条。
  // 真正的离线推送需要服务端（见 README 第二步）。
  function localReminderTick() {
    maintenance();
    const aw = activeWindow(); if (!aw) return;
    if (aw.sinceStart > 3) return;                       // 只在时段开始的前几分钟推
    if (state.lastNotifiedKey === aw.key) return;
    if (limitReached(aw)) return;
    const it = pickForPush(aw); if (!it) return;
    state.lastNotifiedKey = aw.key; save();
    showReminder({ title: '捞一条', body: reminderText(it, aw), itemId: it.id, url: it.url, sceneId: aw.scene.id, tag: aw.key });
  }

  // ---------------------------------------------------------------------
  // 路由 & 渲染
  // ---------------------------------------------------------------------
  let pendingShare = null;   // { text, url, title }
  let obStep = 0;

  function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [name, arg] = h.split('/');
    return { name: name || 'home', arg };
  }
  function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

  function render() {
    maintenance();
    const r = route();
    const view = $('#view'); const tabbar = $('#tabbar');
    const needsOnboarding = !state.settings.onboarded && r.name !== 'welcome';
    if (needsOnboarding) { obStep = 0; location.hash = '#/welcome'; return; }
    view.className = 'view fade-in';
    const map = { home: viewHome, save: viewSave, queue: viewQueue, archive: viewArchive, settings: viewSettings, scene: viewScene, edit: viewEdit, welcome: viewWelcome };
    const fn = map[r.name] || viewHome;
    if (r.name !== 'save' && r.name !== 'edit') draft = null;   // 离开存入页就丢掉草稿
    const showTabs = ['home', 'queue', 'settings', 'save'].includes(r.name) && !(r.name === 'save');
    tabbar.hidden = !showTabs;
    if (!showTabs) view.classList.add('no-tabbar');
    $$('.tab', tabbar).forEach((t) => t.classList.toggle('on', t.dataset.tab === r.name));
    view.innerHTML = '';
    fn(view, r.arg);
    window.scrollTo(0, 0);
  }

  // ---- 通用片段 ----
  const srcTile = (it, cls = '') => { const s = SOURCES[it.source] || SOURCES.other; return `<div class="src ${s.cls} ${cls}">${esc(s.short)}</div>`; };
  const srcName = (it) => (SOURCES[it.source] || SOURCES.other).name;
  const sceneNames = (it) => (it.scenes || []).map((id) => id === 'any' ? '随时' : (scene(id) ? scene(id).name : null)).filter(Boolean).join(' · ');
  const headerHTML = (title, caption, right = '') => `
    <div class="header"><div class="title"><h1 class="h1">${esc(title)}</h1>${caption ? `<p class="caption">${caption}</p>` : ''}</div>${right ? `<div class="header-right">${right}</div>` : ''}</div>`;
  const closeBtn = (hash) => `<a class="icon-btn" href="${hash}" aria-label="关闭"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></a>`;

  function attachSwipe(root, onDelete) {
    $$('.item[data-swipe]', root).forEach((row) => {
      const inner = $('.item-inner', row); let x0 = null, dx = 0, dragging = false;
      inner.addEventListener('pointerdown', (e) => { x0 = e.clientX; dx = 0; dragging = false; inner.style.transition = 'none'; });
      inner.addEventListener('pointermove', (e) => {
        if (x0 == null) return; dx = e.clientX - x0;
        if (Math.abs(dx) > 8) dragging = true;
        if (dragging) { const base = row.classList.contains('open') ? -88 : 0; const t = Math.max(-88, Math.min(0, base + dx)); inner.style.transform = `translateX(${t}px)`; }
      });
      const end = () => {
        if (x0 == null) return; inner.style.transition = ''; inner.style.transform = '';
        if (dragging) {
          const wasOpen = row.classList.contains('open');
          if (dx < -44) { $$('.item.open', root).forEach((r) => { if (r !== row) r.classList.remove('open'); }); row.classList.add('open'); }
          else if (dx > 30 || !wasOpen) row.classList.remove('open');
        }
        x0 = null;
      };
      inner.addEventListener('pointerup', end); inner.addEventListener('pointercancel', end); inner.addEventListener('pointerleave', end);
      inner.addEventListener('click', (e) => {
        if (dragging) { e.preventDefault(); e.stopPropagation(); dragging = false; return; }   // 拖完的那次 click 不算
        if (row.classList.contains('open')) { row.classList.remove('open'); e.preventDefault(); e.stopPropagation(); }
      }, true);
      $('.item-delete', row).addEventListener('click', () => onDelete(row.dataset.id));
    });
  }

  // ---------------------------------------------------------------------
  // 页面：今天
  // ---------------------------------------------------------------------
  function viewHome(view) {
    const q = queueItems(); const sb = standbyItems();
    const pill = `<span class="pill">排队 <b>${q.length}</b> · 候补 <b>${sb.length}</b></span>`;
    if (!q.length) {
      view.innerHTML = headerHTML('今天捞一条', sb.length ? '候补里有，排队区马上补上' : '队伍还是空的', pill) + `
        <div class="grow" style="display:flex;flex-direction:column;justify-content:center;gap:16px">
          <div class="card empty">
            <div class="big-icon"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></div>
            <h2 class="h2" style="font-size:18px">还没存东西，先存第一条</h2>
            <div class="steps">
              <div class="step"><span class="num">1</span>在抖音或小红书点「分享」</div>
              <div class="step"><span class="num">2</span>点「复制链接」</div>
              <div class="step"><span class="num">3</span>回到这里，它会自动识别</div>
            </div>
            <div class="hint center">安卓用户在分享面板里直接选「捞一条」就行</div>
            <a class="btn btn-primary btn-sm" href="#/save">我复制好了，去存</a>
          </div>
          <button class="link center" data-act="ob">再看一遍引导 ›</button>
        </div>`;
      $('[data-act=ob]', view).addEventListener('click', () => { obStep = 0; go('#/welcome'); });
      return;
    }
    const { item: it, aw, loose } = pickForToday();
    const sess = sessionFor(aw);
    let caption;
    if (!aw) { const nx = nextWindowLabel(); caption = `现在不是提醒时段，随便看一条也行${nx ? ` · 下一个时段：${nx}` : ''}`; }
    else if (limitReached(aw)) caption = `${aw.scene.name} · 这段的 ${sceneMaxLabel(aw.scene)}看完了，休息一下`;
    else caption = `${aw.scene.name} · 这段第 ${sess.count + 1}${aw.scene.max === 'unlimited' ? '' : ' / ' + aw.scene.max} 条 · 还有 ${aw.remaining} 分钟${loose ? ' · 没有正好合适的，先给你这条' : ''}`;
    const dl = daysLeft(it); const progress = Math.round(((ROTATE_DAYS - dl) / ROTATE_DAYS) * 100);
    const next = pickForToday([it.id]).item; const restCount = q.length - 1;
    const canChain = state.settings.chain && aw && !limitReached(aw);
    view.innerHTML = headerHTML('今天捞一条', caption, pill) + `
      <div class="card card-shadow">
        <div class="today-meta">
          <div class="row"><span class="tag">${esc(srcName(it))}</span><span class="small" style="color:var(--ink2)">${esc(durationLabel(it))}</span>${it.scenes && it.scenes.length ? `<span class="small">· ${esc(sceneNames(it))}</span>` : ''}</div>
          <span class="small accent" style="font-weight:500">${dl <= 0 ? '今晚退到候补' : `还剩 ${dl} 天`}</span>
        </div>
        <a class="cover" href="${esc(it.url)}" target="_blank" rel="noopener"><span class="play"><svg viewBox="0 0 20 20"><path d="M6 3.5v13l11-6.5z"/></svg></span><span class="cover-src">${esc(it.url.replace(/^https?:\/\//, '').slice(0, 40))}</span></a>
        <h2 class="today-title">${esc(it.title)}</h2>
        ${it.why ? `<div class="why"><div class="bar"></div><div><div class="why-label">你${esc(fmtSavedDay(it.createdAt).replace('存的', ''))}存的时候说</div><div class="why-text">「${esc(it.why)}」</div></div></div>` : ''}
        <div class="expiry"><div class="labels"><span>${esc(fmtSavedDay(it.createdAt))}</span><span>${dl <= 0 ? '今晚先退到候补末尾' : `${dl} 天后先退到候补末尾`}</span></div><div class="track"><div class="fill" style="width:${progress}%"></div></div></div>
        <a class="btn btn-primary" href="${esc(it.url)}" target="_blank" rel="noopener">现在看 →</a>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn btn-secondary btn-sm" data-act="done">${canChain && next ? '看完了，下一条' : '看完了 ✓'}</button>
          <button class="btn btn-secondary btn-sm" data-act="dismiss">不看了</button>
        </div>
      </div>
      ${next ? `<div class="card-soft next-up" style="margin-top:12px">${srcTile(next, 'sm')}<div class="t"><div class="l">接下来</div><div class="v">${esc(next.title)} · ${esc(durationLabel(next))}</div></div><span class="small">还有 ${restCount} 条</span></div>` : ''}
      <div class="center" style="margin-top:10px"><button class="link" data-act="swap">↻ 这条不合适，换一条</button>${aw ? `<button class="link" data-act="later">现在不方便</button>` : ''}</div>
      ${state.lastRotationNote && now() - state.lastRotationNote.at < 7 * DAY ? `<p class="footer-note" style="margin-top:12px">上周有 ${state.lastRotationNote.count} 条退到了候补，没删</p>` : ''}
    `;
    $('[data-act=done]', view).addEventListener('click', () => { markDone(it.id); toast(next ? '出队了，下一条来了' : '出队了'); render(); });
    $('[data-act=dismiss]', view).addEventListener('click', () => { dismiss(it.id); toast('已放进「不看的」，30 天内可找回'); render(); });
    $('[data-act=swap]', view).addEventListener('click', () => { if (swapBack(it.id)) { toast('往后排了一位'); render(); } else toast('队伍里只有这一条'); });
    const later = $('[data-act=later]', view); if (later) later.addEventListener('click', () => { markInconvenient(aw.scene.id); toast(`好，「${aw.scene.name}」这个时段以后少推`); render(); });
  }

  // ---------------------------------------------------------------------
  // 页面：存入
  // ---------------------------------------------------------------------
  let draft = null; // { url, source, title, why, duration, customMin, scenes:[], recognized, duplicate }

  function viewSave(view) {
    if (pendingShare) {
      const p = parseShareText([pendingShare.url, pendingShare.text, pendingShare.title].filter(Boolean).join(' '));
      pendingShare = null;
      if (p.ok) startDraft(p); else { draft = null; toast('分享过来的内容里没找到链接'); }
    }
    if (!draft) return renderPasteStep(view);
    if (draft.duplicate) return renderDuplicate(view);
    renderSaveForm(view);
  }
  function startDraft(p) {
    const dup = findDuplicate(p.url);
    draft = { url: p.url, source: p.source, title: p.title || '', why: '', duration: p.source === 'xhs' ? 'image' : '5', customMin: '', scenes: [], recognized: p.recognized, duplicate: dup };
  }
  function renderPasteStep(view) {
    view.innerHTML = headerHTML('存一条', '把复制的链接粘到这里，抖音分享的整段文字也行', closeBtn('#/')) + `
      <div class="stack">
        <div class="paste-box">
          <textarea class="input" id="paste" rows="4" placeholder="粘贴链接或分享文字…"></textarea>
          <div class="btn-row">
            <button class="btn btn-secondary btn-sm" data-act="paste">从剪贴板粘贴</button>
            <button class="btn btn-primary btn-sm" data-act="parse">识别</button>
          </div>
        </div>
        <div class="hint">支持抖音、小红书、B 站、快手，其他网页链接也能存。识别不出来的可以自己写个名字。</div>
      </div>`;
    const ta = $('#paste', view);
    const doParse = () => { const p = parseShareText(ta.value); if (!p.ok) { toast('没找到链接，检查一下粘贴的内容'); return; } startDraft(p); render(); };
    $('[data-act=parse]', view).addEventListener('click', doParse);
    $('[data-act=paste]', view).addEventListener('click', async () => {
      try { const t = await navigator.clipboard.readText(); if (!t) { toast('剪贴板是空的'); return; } ta.value = t; doParse(); }
      catch (e) { toast('没拿到剪贴板，长按输入框手动粘贴也行'); ta.focus(); }
    });
    ta.addEventListener('paste', () => setTimeout(doParse, 50));
    setTimeout(() => ta.focus(), 50);
  }
  function renderDuplicate(view) {
    const d = draft.duplicate; const pos = d.status === 'queue' ? `排第 ${state.queue.indexOf(d.id) + 1} 位` : `候补第 ${state.standby.indexOf(d.id) + 1} 位`;
    view.innerHTML = headerHTML('存一条', '不用再存一次', closeBtn('#/')) + `
      <div class="grow" style="display:flex;flex-direction:column;justify-content:center;gap:16px">
        <div class="card empty">
          <div class="big-icon"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></div>
          <h2 class="h2" style="font-size:18px">这条已经在队伍里了</h2>
          <div class="card-soft row" style="width:100%;background:var(--canvas)">${srcTile(d)}<div class="item-text"><div class="item-title">${esc(d.title)}</div><div class="item-meta">${pos} · ${esc(fmtSavedDay(d.createdAt))}${d.scenes ? ' · ' + esc(sceneNames(d)) : ''}</div></div></div>
          <div class="stack" style="width:100%;gap:10px">
            <a class="btn btn-primary btn-sm" href="#/queue">去队伍看看</a>
            <button class="btn btn-secondary btn-sm" data-act="jump">让它插队到最前面</button>
          </div>
        </div>
        <button class="link center" data-act="close">关掉</button>
      </div>`;
    $('[data-act=jump]', view).addEventListener('click', () => { jumpQueue(d.id); draft = null; toast('插到最前面了'); go('#/'); });
    $('[data-act=close]', view).addEventListener('click', () => { draft = null; go('#/'); });
  }
  function sceneChipsHTML(selected) {
    const list = state.scenes.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.name })).concat([{ id: 'any', name: '随时' }]);
    return list.map((s) => `<button class="chip ${selected.includes(s.id) ? 'on' : ''}" data-scene="${esc(s.id)}">${esc(s.name)}</button>`).join('');
  }
  function renderSaveForm(view, editing = null) {
    const d = draft; const src = SOURCES[d.source] || SOURCES.other;
    const posNote = editing ? '' : (state.queue.length < (state.settings.queueSize || QUEUE_SIZE) ? `存进去就排队，前面还有 ${state.queue.length} 条` : `排队区满了，会先进候补（第 ${state.standby.length + 1} 位），轮到它才提醒你`);
    view.innerHTML = headerHTML(editing ? '改一下' : '存一条', d.recognized ? '链接已经识别好了，补两个字就行' : '这条没识别出来，自己写个名字就行', closeBtn(editing ? '#/queue' : '#/')) + `
      <div class="stack">
        <div class="source-card">
          ${d.recognized ? `<div class="src ${src.cls}">${esc(src.short)}</div>` : `<div class="src src-unknown">?</div>`}
          <div class="meta"><div class="l ${d.recognized ? '' : 'err'}">${d.recognized ? esc(src.name) + ' · ' + (d.duration === 'image' ? '图文' : '视频') : '没识别出来 · 平台不支持或链接失效'}</div><div class="u">${esc(d.url.replace(/^https?:\/\//, ''))}</div></div>
          <div class="check ${d.recognized ? '' : 'warn'}">${d.recognized ? '✓' : '!'}</div>
        </div>
        ${d.recognized ? '' : '<div class="hint">封面和时长抓不到不影响提醒，队伍里会显示你写的名字</div>'}
        <div class="field"><label>视频标题</label><input class="input" id="f-title" value="${esc(d.title)}" placeholder="${d.recognized ? '给它起个名' : '比如：阳台改造那篇'}"></div>
        <div class="field"><label>为什么想看？</label><input class="input" id="f-why" value="${esc(d.why)}" placeholder="一个词就够，比如：想自己做一个"></div>
        <div class="field"><label>内容时长</label>
          <div class="chips" id="f-dur">${DURATIONS.map((x) => `<button class="chip ${(x.id === 'custom' ? typeof d.duration === 'number' : d.duration === x.id) ? 'on' : ''}" data-dur="${x.id}">${x.label}</button>`).join('')}</div>
          <div class="row" id="f-custom" ${typeof d.duration === 'number' ? '' : 'hidden'}><input class="input" style="width:110px" id="f-custom-min" type="number" inputmode="numeric" min="1" max="600" value="${typeof d.duration === 'number' ? d.duration : ''}" placeholder="分钟"><span class="small">分钟</span></div>
          <div class="hint">图文按 5 分钟内算；自定义填分钟数</div>
        </div>
        <div class="field"><label>场景</label><div class="chips" id="f-scenes">${sceneChipsHTML(d.scenes)}</div><div class="hint">就是你作息里的场景，可以多选；不选等于「随时」</div></div>
        <div class="grow"></div>
        ${posNote ? `<div class="footer-note">${esc(posNote)}</div>` : ''}
        <button class="btn btn-primary" data-act="save">${editing ? '保存' : '存进去'}</button>
        ${editing ? '<button class="link link-accent center" data-act="del">不看了，删掉</button>' : ''}
      </div>`;
    $('#f-title', view).addEventListener('input', (e) => { d.title = e.target.value; });
    $('#f-why', view).addEventListener('input', (e) => { d.why = e.target.value; });
    $$('#f-dur .chip', view).forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.dur;
      if (id === 'custom') { d.duration = Number($('#f-custom-min', view).value) || 10; $('#f-custom', view).hidden = false; $('#f-custom-min', view).value = d.duration; $('#f-custom-min', view).focus(); }
      else { d.duration = id; $('#f-custom', view).hidden = true; }
      $$('#f-dur .chip', view).forEach((x) => x.classList.toggle('on', x === b));
    }));
    $('#f-custom-min', view).addEventListener('input', (e) => { const n = Number(e.target.value); if (n > 0) d.duration = n; });
    $$('#f-scenes .chip', view).forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.scene;
      if (id === 'any') d.scenes = d.scenes.includes('any') ? [] : ['any'];
      else { d.scenes = d.scenes.filter((x) => x !== 'any'); d.scenes = d.scenes.includes(id) ? d.scenes.filter((x) => x !== id) : d.scenes.concat([id]); }
      $$('#f-scenes .chip', view).forEach((x) => x.classList.toggle('on', d.scenes.includes(x.dataset.scene)));
    }));
    $('[data-act=save]', view).addEventListener('click', () => {
      if (!d.title.trim()) { toast('给它起个名字吧'); $('#f-title', view).focus(); return; }
      const data = { url: d.url, source: d.source, title: d.title, why: d.why, duration: d.duration, scenes: d.scenes.length ? d.scenes : ['any'] };
      if (editing) { updateItem(editing, data); draft = null; toast('改好了'); go('#/queue'); return; }
      const it = addItem(data); draft = null;
      toast(it.status === 'queue' ? `存进去了 · 排第 ${state.queue.indexOf(it.id) + 1} 位` : `存进去了 · 候补第 ${state.standby.indexOf(it.id) + 1} 位`);
      go('#/');
    });
    const del = $('[data-act=del]', view); if (del) del.addEventListener('click', () => { dismiss(editing); draft = null; toast('已放进「不看的」，30 天内可找回'); go('#/queue'); });
  }
  function viewEdit(view, id) {
    const it = item(id); if (!it) { go('#/queue'); return; }
    draft = { url: it.url, source: it.source, title: it.title, why: it.why, duration: it.duration, scenes: [...(it.scenes || [])], recognized: it.source !== 'other', duplicate: null };
    renderSaveForm(view, id);
  }

  // ---------------------------------------------------------------------
  // 页面：队伍
  // ---------------------------------------------------------------------
  function viewQueue(view) {
    const q = queueItems(), sb = standbyItems();
    const rowHTML = (it, i, kind) => {
      const dl = daysLeft(it);
      const right = kind === 'queue'
        ? `<span class="item-right ${dl <= 3 ? 'urgent' : ''}">${dl <= 0 ? '今晚退候补' : `还剩 ${dl} 天`}</span>`
        : `<button class="chip sm" data-jump="${it.id}">插队</button>`;
      const meta = kind === 'queue' ? `${srcName(it)} · ${durationLabel(it)} · ${fmtSavedDay(it.createdAt)}` : `${srcName(it)} · ${durationLabel(it)} · 排第 ${i + 1}${it.demotedCount ? ` · 退回过 ${it.demotedCount} 次` : ''}`;
      return `<div class="item ${kind === 'standby' ? 'item-muted' : ''}" data-swipe data-id="${it.id}">
        <div class="item-inner"><a class="row" style="flex:1;min-width:0" href="#/edit/${it.id}">${srcTile(it, kind === 'standby' ? 'dim' : '')}<div class="item-text"><div class="item-title">${esc(it.title)}</div><div class="item-meta">${esc(meta)}</div></div></a>${right}</div>
        <button class="item-delete">不看了</button></div>`;
    };
    view.innerHTML = headerHTML('队伍', '按你设的时段推，按顺序来 · 左滑删掉不想看的') + `
      <div class="stack" style="gap:14px">
        <div>
          <div class="section-head"><span class="t">排队中<b>${q.length}</b></span><span class="s">会提醒 · ${ROTATE_DAYS} 天没看退到候补末尾</span></div>
          <div class="list">${q.length ? q.map((it, i) => rowHTML(it, i, 'queue')).join('') : '<div class="more-row">空的，存一条或者从候补插队</div>'}${q.length > 1 ? '<div class="more-row">点一行可以改 · 左滑「不看了」</div>' : ''}</div>
        </div>
        <div>
          <div class="section-head"><span class="t">候补<b>${sb.length}</b></span><span class="s">不提醒 · 轮到了再说，不会删</span></div>
          <div class="list list-translucent">${sb.length ? sb.map((it, i) => rowHTML(it, i, 'standby')).join('') : '<div class="more-row">没有候补的</div>'}${sb.length ? '<div class="more-row">排队区空出来就自动往上补</div>' : ''}</div>
        </div>
        <a class="card-soft row" href="#/archive"><span style="font-weight:500;font-size:14px">看过的</span><span class="small" style="font-weight:500">${state.done.length}</span><span class="small">·</span><span style="font-weight:500;font-size:14px">不看的</span><span class="small" style="font-weight:500">${state.dismissed.length}</span><span class="spacer"></span><svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:var(--ink3);stroke-width:2;fill:none"><path d="M9 5l7 7-7 7"/></svg></a>
      </div>`;
    attachSwipe(view, (id) => { dismiss(id); toast('已放进「不看的」，30 天内可找回'); render(); });
    $$('[data-jump]', view).forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); jumpQueue(b.dataset.jump); toast('插到最前面了'); render(); }));
  }

  // ---------------------------------------------------------------------
  // 页面：看过的 / 不看的
  // ---------------------------------------------------------------------
  let archiveTab = 'done';
  function viewArchive(view) {
    const list = (archiveTab === 'done' ? state.done : state.dismissed).map(item).filter(Boolean);
    const rows = list.map((it) => `<div class="item item-muted"><div class="item-inner">${srcTile(it, 'dim')}<div class="item-text"><div class="item-title">${esc(it.title)}</div><div class="item-meta">${esc(srcName(it))} · ${archiveTab === 'done' ? `${fmtAgo(it.doneAt)}看完的` : `${fmtAgo(it.dismissedAt)}放弃的 · ${Math.max(0, DISMISS_KEEP_DAYS - Math.floor((now() - it.dismissedAt) / DAY))} 天后彻底删`}</div></div><button class="chip sm" data-restore="${it.id}">${archiveTab === 'done' ? '再看一遍' : '找回'}</button></div></div>`).join('');
    view.innerHTML = `<div style="margin-bottom:6px"><a class="link" href="#/queue" style="padding-left:0">‹ 队伍</a></div>` + headerHTML(archiveTab === 'done' ? '看过的' : '不看的') + `
      <div class="stack" style="gap:14px">
        <div class="segmented"><button class="${archiveTab === 'done' ? 'on' : ''}" data-tab="done">看过的 ${state.done.length}</button><button class="${archiveTab === 'dismissed' ? 'on' : ''}" data-tab="dismissed">不看的 ${state.dismissed.length}</button></div>
        <div class="list">${rows || `<div class="more-row">${archiveTab === 'done' ? '还没有看完的' : '没有放弃的'}</div>`}</div>
        <div class="hint">看过的一直留着。「不看的」也留 ${DISMISS_KEEP_DAYS} 天，想回来点「找回」就行，${DISMISS_KEEP_DAYS} 天后才真正删。</div>
      </div>`;
    $$('.segmented button', view).forEach((b) => b.addEventListener('click', () => { archiveTab = b.dataset.tab; render(); }));
    $$('[data-restore]', view).forEach((b) => b.addEventListener('click', () => { restore(b.dataset.restore); toast('放回队伍了'); render(); }));
  }

  // ---------------------------------------------------------------------
  // 页面：作息（场景列表 + 设置）
  // ---------------------------------------------------------------------
  function viewSettings(view) {
    const np = notifPermission();
    const notifLabel = np === 'granted' ? '已打开' : np === 'denied' ? '被拒绝了，去系统设置里打开' : np === 'unsupported' ? '这个浏览器不支持' : '还没打开';
    view.innerHTML = headerHTML('我的作息', '提醒只在这些时段来 · 点进去改，也可以自己加') + `
      <div class="stack" style="gap:12px">
        <div class="list">${state.scenes.map((sc) => `
          <a class="scene-row item" href="#/scene/${esc(sc.id)}" style="opacity:${sc.enabled ? 1 : .55}">
            <div class="txt"><div class="name">${esc(sc.name)}${sc.custom ? '<span class="badge">自定义</span>' : ''}</div><div class="d1">${esc(sceneDaysLabel(sc))} · ${esc(sceneWindowsLabel(sc))}</div><div class="d2">最多 ${esc(sceneMaxLabel(sc))}${sc.inconvenient ? ` · 被说过 ${sc.inconvenient} 次不方便` : ''}</div></div>
            <button class="toggle ${sc.enabled ? 'on' : ''}" data-toggle="${esc(sc.id)}" aria-label="开关"></button>
            <svg class="chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>
          </a>`).join('')}</div>
        <a class="add-dashed" href="#/scene/new"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>添加场景</a>
        <div class="hint center">比如：午休、健身房、地铁上、洗衣服的时候</div>
        <div class="setting-row"><div class="txt"><div class="t">看完一条，接着推下一条</div><div class="s">只在同一时段里接，按剩余时间挑。老被点「现在不方便」的时段会自动少推。</div></div><button class="toggle ${state.settings.chain ? 'on' : ''}" data-act="chain"></button></div>
        <div class="setting-row"><div class="txt"><div class="t">通知 · ${notifLabel}</div><div class="s">${isIOS() && !isStandalone() ? 'iPhone 要先「添加到主屏幕」，从主屏幕打开的才能收到。' : '时段一开始就推一条。'}</div></div>${np === 'default' || np === 'unsupported' ? '<button class="chip on" data-act="notif">打开</button>' : np === 'granted' ? '<button class="chip sm" data-act="test">试一条</button>' : ''}</div>
        <div class="setting-row"><div class="txt"><div class="t">数据</div><div class="s">都在这台手机上。换手机或清浏览器会丢，导出一份留着。</div></div><button class="chip sm" data-act="export">导出</button><button class="chip sm" data-act="import">导入</button></div>
        <div class="setting-row"><div class="txt"><div class="t">重看引导</div><div class="s">怎么存、怎么装到主屏幕</div></div><button class="chip sm" data-act="ob">看</button></div>
        <div class="center small" style="padding:8px 0 0">捞一条 · 网页版 0.1</div>
        <input type="file" id="import-file" accept="application/json" hidden>
      </div>`;
    $$('[data-toggle]', view).forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); const sc = scene(b.dataset.toggle); sc.enabled = !sc.enabled; save(); render(); }));
    $('[data-act=chain]', view).addEventListener('click', () => { state.settings.chain = !state.settings.chain; save(); render(); });
    const nb = $('[data-act=notif]', view); if (nb) nb.addEventListener('click', async () => { const p = await askNotification(); toast(p === 'granted' ? '通知打开了' : '没打开'); render(); });
    const tb = $('[data-act=test]', view); if (tb) tb.addEventListener('click', () => { const q = queueItems(); showReminder({ title: '捞一条', body: q.length ? `试一条：「${q[0].title}」${durationLabel(q[0])}，现在正好。` : '试一条：通知是通的。', itemId: q[0] && q[0].id, url: q[0] && q[0].url }); toast('发了，看看通知栏'); });
    $('[data-act=export]', view).addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `laoyitiao-${dateKey(new Date())}.json`; a.click();
    });
    $('[data-act=import]', view).addEventListener('click', () => $('#import-file', view).click());
    $('#import-file', view).addEventListener('change', (e) => {
      const f = e.target.files[0]; if (!f) return; const r = new FileReader();
      r.onload = () => { try { const s = JSON.parse(r.result); if (!s.items) throw 0; state = Object.assign(defaultState(), s); save(); toast('导入了'); render(); } catch (_) { toast('这个文件不对'); } };
      r.readAsText(f);
    });
    $('[data-act=ob]', view).addEventListener('click', () => { obStep = 0; go('#/welcome'); });
  }

  // ---------------------------------------------------------------------
  // 页面：场景编辑
  // ---------------------------------------------------------------------
  function viewScene(view, id) {
    const isNew = id === 'new';
    const sc = isNew ? { id: 's' + uid(), name: '', days: 'weekdays', windows: [{ start: '12:00', end: '13:00' }], max: 2, durations: ['5', '15'], enabled: true, custom: true, inconvenient: 0 } : JSON.parse(JSON.stringify(scene(id)));
    if (!sc) { go('#/settings'); return; }
    const daysMode = Array.isArray(sc.days) ? 'custom' : sc.days;
    const paint = () => {
      view.innerHTML = headerHTML(isNew ? '添加场景' : '编辑场景', '起个名，说清楚哪几天、几点、最多几条', closeBtn('#/settings')) + `
        <div class="stack">
          <div class="field"><label>名字</label><input class="input" id="s-name" value="${esc(sc.name)}" placeholder="比如：午饭、健身房、地铁上"></div>
          <div class="field"><label>哪几天</label><div class="chips" id="s-days">${[['weekdays', '工作日'], ['daily', '每天'], ['weekend', '周末'], ['custom', '自己选']].map(([k, l]) => `<button class="chip ${daysMode === k ? 'on' : ''}" data-days="${k}">${l}</button>`).join('')}</div>
            <div class="days7" id="s-days7" ${daysMode === 'custom' ? '' : 'hidden'}>${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button class="${sceneDays(sc).includes(d) ? 'on' : ''}" data-d="${d}">${DAY_NAMES[d]}</button>`).join('')}</div></div>
          <div class="field"><label>时间段</label><div class="stack" id="s-windows" style="gap:10px">${sc.windows.map((w, i) => `
            <div class="time-row"><div class="range"><input class="time-input" type="time" value="${esc(w.start)}" data-w="${i}" data-k="start"><span class="faint">–</span><input class="time-input" type="time" value="${esc(w.end)}" data-w="${i}" data-k="end"></div>${sc.windows.length > 1 ? `<button class="link" data-rm="${i}">删除</button>` : ''}</div>`).join('')}</div>
            <button class="link" data-act="addw" style="align-self:flex-start;padding-left:0">＋ 再加一段</button></div>
          <div class="field"><label>这段最多</label><div class="chips" id="s-max">${[[1, '1 条'], [2, '2 条'], [3, '3 条'], [5, '5 条'], ['unlimited', '不限']].map(([k, l]) => `<button class="chip ${String(sc.max) === String(k) ? 'on' : ''}" data-max="${k}">${l}</button>`).join('')}</div></div>
          <div class="field"><label>适合看多长的</label><div class="chips" id="s-dur">${[['5', '5 分钟内'], ['15', '15 分钟'], ['long', '更长']].map(([k, l]) => `<button class="chip ${sc.durations.includes(k) ? 'on' : ''}" data-dur="${k}">${l}</button>`).join('')}</div><div class="hint">存的时候选了这个场景的内容，才会在这个时段被推；图文按 5 分钟内算</div></div>
          <div class="grow"></div>
          <button class="btn btn-primary" data-act="save">保存</button>
          ${isNew ? '' : '<button class="link link-accent center" data-act="del">删除这个场景</button>'}
        </div>`;
      $('#s-name', view).addEventListener('input', (e) => { sc.name = e.target.value; });
      $$('#s-days .chip', view).forEach((b) => b.addEventListener('click', () => { const k = b.dataset.days; sc.days = k === 'custom' ? sceneDays(sc) : k; paint(); }));
      $$('#s-days7 button', view).forEach((b) => b.addEventListener('click', () => { const d = Number(b.dataset.d); let arr = sceneDays(sc).slice(); arr = arr.includes(d) ? arr.filter((x) => x !== d) : arr.concat([d]); sc.days = arr; b.classList.toggle('on'); }));
      $$('#s-windows input', view).forEach((inp) => inp.addEventListener('change', () => { sc.windows[Number(inp.dataset.w)][inp.dataset.k] = inp.value || '00:00'; }));
      $$('[data-rm]', view).forEach((b) => b.addEventListener('click', () => { sc.windows.splice(Number(b.dataset.rm), 1); paint(); }));
      $('[data-act=addw]', view).addEventListener('click', () => { sc.windows.push({ start: '12:00', end: '13:00' }); paint(); });
      $$('#s-max .chip', view).forEach((b) => b.addEventListener('click', () => { sc.max = b.dataset.max === 'unlimited' ? 'unlimited' : Number(b.dataset.max); $$('#s-max .chip', view).forEach((x) => x.classList.toggle('on', x === b)); }));
      $$('#s-dur .chip', view).forEach((b) => b.addEventListener('click', () => { const k = b.dataset.dur; sc.durations = sc.durations.includes(k) ? sc.durations.filter((x) => x !== k) : sc.durations.concat([k]); b.classList.toggle('on'); }));
      $('[data-act=save]', view).addEventListener('click', () => {
        if (!sc.name.trim()) { toast('给场景起个名'); return; }
        if (!sc.durations.length) sc.durations = ['5', '15', 'long'];
        if (Array.isArray(sc.days) && !sc.days.length) { toast('至少选一天'); return; }
        sc.windows = sc.windows.filter((w) => minutesOf(w.end) > minutesOf(w.start)); if (!sc.windows.length) { toast('时间段的结束要晚于开始'); return; }
        if (isNew) state.scenes.push(sc); else state.scenes[state.scenes.findIndex((x) => x.id === sc.id)] = sc;
        save(); toast('保存了'); go('#/settings');
      });
      const del = $('[data-act=del]', view); if (del) del.addEventListener('click', () => {
        if (state.scenes.length <= 1) { toast('至少留一个场景'); return; }
        state.scenes = state.scenes.filter((x) => x.id !== sc.id);
        for (const it of Object.values(state.items)) { it.scenes = (it.scenes || []).filter((x) => x !== sc.id); if (!it.scenes.length) it.scenes = ['any']; }
        save(); toast('删了，标了它的内容改成「随时」'); go('#/settings');
      });
    };
    paint();
  }

  // ---------------------------------------------------------------------
  // 页面：引导
  // ---------------------------------------------------------------------
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

  function viewWelcome(view) {
    view.className = 'ob fade-in';
    const total = 4;
    const arrow = '<svg class="arrow" viewBox="0 0 20 12"><path d="M1 6h15M12 1.5l4.5 4.5L12 10.5"/></svg>';
    const pages = [
      { title: '刷到想看的，先存进来', body: '在抖音、小红书点「分享」→「复制链接」，回到捞一条它会自动识别。补一句为什么想看，就存好了。',
        illo: `<div class="stack" style="align-items:center;gap:14px"><div class="flow-steps"><span class="chip" style="background:#fff">分享</span>${arrow}<span class="chip" style="background:#fff">复制链接</span>${arrow}<span class="chip on">回到捞一条</span></div><div class="small">安卓：分享面板里直接选「捞一条」</div></div>`, btn: '下一步' },
      { title: '到点提醒你，按你的节奏', body: '通勤、睡前、周末，各自设几点、最多几条。看完一条接下一条，7 天没看的退到后面，不删。',
        illo: `<div class="mini-notif"><div class="h"><span class="app-icon" style="width:26px;height:26px">${APP_ICON_SVG(26)}</span><b>捞一条</b><span class="t">18:00</span></div><div class="b">通勤 15 分钟？你周二存的「手工榫卯凳子教程」只要 5 分钟。</div></div>`, btn: '下一步' },
      { title: '告诉它你几点通勤、几点睡', body: '设三个时间，提醒只在那时候来。老是不方便的时段，它会自己少推。',
        illo: `<div class="times-illo"><div class="r">通勤<span>08:00 · 18:00</span></div><div class="r">睡前<span>22:30</span></div><div class="r">周末<span>10:00</span></div></div>`, btn: '设置作息，下一步', secondary: '先随便看看' },
      { title: '最后两步，不然收不到提醒', body: isIOS() ? 'iPhone 只有装到主屏幕的网页才能发通知，这是苹果的规定。装好后从主屏幕打开，再点下面的按钮。' : '装到主屏幕，再允许通知。安卓会直接弹出安装提示，点「安装」就行。',
        illo: `<div class="install-steps">
          <div class="st"><div class="ic ${isStandalone() ? 'done' : ''}"><svg viewBox="0 0 24 24"><path d="M12 3v12M8 7l4-4 4 4M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6"/></svg></div><div class="tx"><div class="t">添加到主屏幕</div><div class="s">${isIOS() ? 'Safari 底部「分享」→「添加到主屏幕」' : '浏览器菜单里「安装应用」或「添加到主屏幕」'}</div></div><span class="n ${isStandalone() ? 'done' : ''}">${isStandalone() ? '✓' : '1'}</span></div>
          <div class="st"><div class="ic ${notifPermission() === 'granted' ? 'done' : ''}"><svg viewBox="0 0 24 24"><path d="M6 17V11a6 6 0 0112 0v6l2 2H4l2-2zM10 21h4"/></svg></div><div class="tx"><div class="t">允许通知</div><div class="s">不允许的话，到点了它也没法叫你</div></div><span class="n ${notifPermission() === 'granted' ? 'done' : ''}">${notifPermission() === 'granted' ? '✓' : '2'}</span></div>
        </div>`, btn: isStandalone() || !isIOS() ? (installPrompt ? '安装到主屏幕' : '打开通知，开始用') : '我装好了，打开通知', secondary: '先不开，以后在作息里再开' },
    ];
    const p = pages[obStep];
    view.innerHTML = `
      <div class="ob-top">${obStep < total - 1 ? '<button class="link" data-act="skip">跳过</button>' : ''}</div>
      <div class="ob-mid"><div class="illo">${p.illo}</div><div class="ob-text"><h2>${esc(p.title)}</h2><p>${esc(p.body)}</p></div></div>
      <div class="ob-foot"><div class="dots">${Array.from({ length: total }, (_, i) => `<i class="${i === obStep ? 'on' : ''}"></i>`).join('')}</div><button class="btn btn-primary" data-act="next">${esc(p.btn)}</button>${p.secondary ? `<button class="link" data-act="secondary">${esc(p.secondary)}</button>` : ''}</div>`;
    const finish = () => { state.settings.onboarded = true; save(); };
    const skip = $('[data-act=skip]', view); if (skip) skip.addEventListener('click', () => { finish(); go('#/'); });
    $('[data-act=next]', view).addEventListener('click', async () => {
      if (obStep === 2) { obStep = 3; finish(); render(); return; }
      if (obStep === 3) {
        if (installPrompt && !isStandalone()) { installPrompt.prompt(); await installPrompt.userChoice.catch(() => {}); installPrompt = null; render(); return; }
        const r = await askNotification(); toast(r === 'granted' ? '通知打开了' : '没打开，以后可以在作息里开'); finish(); go('#/'); return;
      }
      obStep++; render();
    });
    const sec = $('[data-act=secondary]', view); if (sec) sec.addEventListener('click', () => { finish(); if (obStep === 2) { obStep = 3; render(); } else go('#/'); });
  }

  // ---------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------
  function handleLaunchParams() {
    const sp = new URLSearchParams(location.search);
    if (sp.has('text') || sp.has('url') || sp.has('title')) {
      pendingShare = { text: sp.get('text') || '', url: sp.get('url') || '', title: sp.get('title') || '' };
      history.replaceState(null, '', location.pathname + '#/save');
      return;
    }
    if (sp.has('nAction')) {
      const a = sp.get('nAction'); const itemId = sp.get('itemId'); const sceneId = sp.get('sceneId');
      history.replaceState(null, '', location.pathname + '#/');
      if (a === 'later' || a === 'dismiss') handleNotificationAction(a, itemId, sceneId);
    }
    if (sp.has('source')) history.replaceState(null, '', location.pathname + (location.hash || '#/'));
  }

  function boot() {
    load();
    handleLaunchParams();
    registerSW();
    window.addEventListener('hashchange', render);
    render();
    setInterval(localReminderTick, 30 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { localReminderTick(); render(); } });
    localReminderTick();
  }
  boot();

  // 调试用
  window.__laoyitiao = { get state() { return state; }, save, render, addItem, maintenance, pickForToday, activeWindow };
})();
