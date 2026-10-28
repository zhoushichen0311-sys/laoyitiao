// 用 Chromium 以手机尺寸跑一遍每个页面并截图，顺便收集报错
// 用法：先 `python3 -m http.server 8080`，再 `node tools/screenshot.js`
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:8080/';
const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const now = Date.now(), DAY = 86400000;
const seed = {
  version: 1,
  items: {
    a: { id: 'a', url: 'https://v.douyin.com/iRk3F2b/', source: 'douyin', title: '手工榫卯凳子教程', why: '想自己做一个', duration: '5', scenes: ['commute'], createdAt: now - 4 * DAY, status: 'queue', queuedAt: now - 4 * DAY, demotedCount: 0 },
    b: { id: 'b', url: 'https://xhslink.com/a/8Kd2', source: 'xhs', title: '小户型阳台改造前后', why: '', duration: 'image', scenes: ['weekend'], createdAt: now - 2 * DAY, status: 'queue', queuedAt: now - 2 * DAY, demotedCount: 0 },
    c: { id: 'c', url: 'https://b23.tv/abc123', source: 'bili', title: 'Blender 布料模拟入门', why: '课上要用', duration: 12, scenes: ['bed', 'weekend'], createdAt: now - 1 * DAY, status: 'queue', queuedAt: now - 1 * DAY, demotedCount: 0 },
    d: { id: 'd', url: 'https://v.douyin.com/coffee/', source: 'douyin', title: '手冲咖啡的水粉比', why: '', duration: '5', scenes: ['any'], createdAt: now - 3 * DAY, status: 'standby', queuedAt: null, demotedCount: 1 },
    e: { id: 'e', url: 'https://xhslink.com/b/table', source: 'xhs', title: '折叠桌腿五金怎么选', why: '', duration: 'image', scenes: ['any'], createdAt: now - 1 * DAY, status: 'standby', queuedAt: null, demotedCount: 0 },
    f: { id: 'f', url: 'https://v.douyin.com/done1/', source: 'douyin', title: '宿舍桌面收纳思路', why: '', duration: '5', scenes: ['any'], createdAt: now - 9 * DAY, status: 'done', queuedAt: null, doneAt: now - DAY, demotedCount: 0 },
  },
  queue: ['a', 'b', 'c'], standby: ['d', 'e'], done: ['f'], dismissed: [],
  settings: { chain: true, onboarded: true, queueSize: 10, notifAsked: false },
  session: { key: null, count: 0 }, lastNotifiedKey: null, lastRotationNote: null,
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN', timezoneId: 'Europe/London' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true }); console.log('shot', name); };

  // 1. 引导（空数据）
  await page.goto(BASE); await page.evaluate(() => localStorage.clear()); await page.goto(BASE + '#/welcome'); await page.reload();
  await shot('06a-welcome');
  await page.click('[data-act=next]'); await shot('06b-welcome');
  await page.click('[data-act=next]'); await shot('06c-welcome');
  await page.click('[data-act=next]'); await shot('06d-welcome');

  // 2. 空状态
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('laoyitiao.v1')); s.settings.onboarded = true; localStorage.setItem('laoyitiao.v1', JSON.stringify(s)); });
  await page.goto(BASE + '#/'); await page.reload(); await shot('02b-empty');

  // 3. 带数据
  await page.evaluate((s) => localStorage.setItem('laoyitiao.v1', JSON.stringify(s)), seed);
  await page.goto(BASE + '#/'); await page.reload(); await shot('02-home');
  await page.goto(BASE + '#/queue'); await shot('04-queue');
  // 左滑一行
  const row = page.locator('.item[data-swipe]').nth(1);
  const box = await row.boundingBox();
  await page.mouse.move(box.x + box.width - 40, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 140, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
  await shot('04-queue-swiped');
  await page.goto(BASE + '#/archive'); await shot('04b-archive');
  await page.goto(BASE + '#/settings'); await shot('05-settings');
  await page.goto(BASE + '#/scene/commute'); await shot('05b-scene');
  await page.goto(BASE + '#/save'); await shot('01-save-paste');
  await page.fill('#paste', '8.23 复制打开抖音，看看【木工小王的作品】手工榫卯凳子从零开始 https://v.douyin.com/iRk3F2b/ 复制此链接，打开Dou音搜索，直接观看视频！');
  await page.click('[data-act=parse]'); await shot('01c-duplicate');
  await page.click('[data-act=close]');
  await page.goto(BASE + '#/save'); await page.waitForSelector('#paste'); await page.fill('#paste', '看看这个 https://v.douyin.com/NEW123/ 挺有意思');
  await page.click('[data-act=parse]'); await shot('01-save-form');
  await page.goto(BASE + '#/'); await page.goto(BASE + '#/save'); await page.waitForSelector('#paste'); await page.fill('#paste', 'https://example.com/some/article');
  await page.click('[data-act=parse]'); await shot('01b-save-unrecognized');
  await page.fill('#f-title', '一篇文章'); await page.click('[data-act=save]'); await shot('02-home-after-save');
  await page.goto(BASE + '#/edit/a'); await shot('01-edit');

  // 4. 规则检查：轮换、挑选
  const checks = await page.evaluate(() => {
    const L = window.__laoyitiao; const s = L.state; const DAY = 86400000;
    const before = s.queue.slice();
    s.items.a.queuedAt = Date.now() - 8 * DAY; L.save(); L.maintenance();
    const rotated = !s.queue.includes('a') && s.standby[s.standby.length - 1] === 'a' && s.items.a.demotedCount === 1;
    return { before, after: s.queue.slice(), standby: s.standby.slice(), rotated, aw: L.activeWindow() && L.activeWindow().scene.name, pick: L.pickForToday().item && L.pickForToday().item.title };
  });
  console.log('checks', JSON.stringify(checks));
  console.log('errors', errors.length ? errors : 'none');
  await browser.close();
})();
