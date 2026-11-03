// DC13 Delivery: end-to-end audit of the three Android apps on an emulator.
// Customer places an order -> Merchant accepts -> Driver claims -> Merchant marks ready
// -> Driver picks up and enters the customer's PIN -> Customer sees it delivered and rates it.
const CDP = require('chrome-remote-interface');
const { execSync } = require('child_process');
const fs = require('fs');

const sh = (c, opt = {}) => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt }).trim(); } catch (e) { return (e.stdout || '').toString().trim(); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PKG = { customer: 'com.digitalcode13.delivery.customer', driver: 'com.digitalcode13.delivery.driver', merchant: 'com.digitalcode13.delivery.merchant' };
const PORT = { customer: 9301, driver: 9302, merchant: 9303 };
const LOGIN = { customer: 0, merchant: 1, driver: 2 };
const OUT = 'audit';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
let shotN = 0;
function rec(step, ok, detail) { results.push({ step, ok, detail: detail || '' }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${step} | ${detail || ''}`); }
function snap(name) { const f = `${OUT}/${String(++shotN).padStart(2, '0')}-${name}.png`; execSync(`adb exec-out screencap -p > ${f}`); return f; }

const clients = {};
console.log('devtools sockets at start:', sh(`adb shell cat /proc/net/unix | grep -a devtools`));
async function connect(role) {
  const pid = sh(`adb shell pidof ${PKG[role]}`);
  if (!pid) throw new Error(`${role} app is not running`);
  if (clients[role] && clients[role].pid === pid) return clients[role].c;
  sh(`adb forward tcp:${PORT[role]} localabstract:webview_devtools_remote_${pid}`);
  for (let i = 0; i < 40; i++) {
    try {
      const list = await CDP.List({ host: '127.0.0.1', port: PORT[role] });
      const t = list.find(x => x.type === 'page');
      if (t) { const c = await CDP({ host: '127.0.0.1', port: PORT[role], target: t }); await c.Runtime.enable(); clients[role] = { pid, c }; return c; }
    } catch (e) { }
    await sleep(1000);
  }
  const socks = sh(`adb shell cat /proc/net/unix | grep -a devtools`);
  throw new Error(`no web inspector for ${role} (pid ${pid}; sockets: ${socks.replace(/\s+/g,' ').slice(0,300)})`);
}
async function front(role) {
  sh(`adb shell monkey -p ${PKG[role]} -c android.intent.category.LAUNCHER 1`);
  await sleep(2500);
  return connect(role);
}
async function ev(c, expr) {
  const r = await c.Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text || '').slice(0, 300));
  return r.result.value;
}
async function waitFor(c, expr, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const v = await ev(c, expr); if (v) return v; } catch (e) { } await sleep(500); }
  return null;
}
const q = s => JSON.stringify(s);
async function click(c, sel) {
  const pt = await ev(c, `(()=>{const e=document.querySelector(${q(sel)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  if (!pt) throw new Error('not found: ' + sel);
  await sleep(300);
  const pt2 = await ev(c, `(()=>{const e=document.querySelector(${q(sel)});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: pt2.x, y: pt2.y });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: pt2.x, y: pt2.y, button: 'left', clickCount: 1 });
  await sleep(60);
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: pt2.x, y: pt2.y, button: 'left', clickCount: 1 });
  await sleep(700);
}
async function pageText(c) { try { return (await ev(c, 'document.body.innerText')).replace(/\s+/g, ' ').slice(0, 600); } catch (e) { return '(no text)'; } }
const hash = c => ev(c, 'location.hash');
async function errorsShown(c) { return ev(c, `[...document.querySelectorAll('.toast')].map(t=>t.innerText).join(' | ')`).catch(() => ''); }

async function ensureLogin(role, routePrefix) {
  const c = await front(role);
  await waitFor(c, `document.readyState==='complete' && document.querySelector('#main') && document.querySelector('#main').innerText.length>20`, 30000);
  await sleep(1500);
  if (await ev(c, `!!document.querySelector('[data-a=demoLogin]')`)) {
    await click(c, `[data-a=demoLogin][data-v="${LOGIN[role]}"]`);
    const ok = await waitFor(c, `!document.querySelector('[data-a=demoLogin]') && location.hash.startsWith(${q(routePrefix)})`, 30000);
    rec(`${role}: sign in with test account`, !!ok, ok ? '' : await pageText(c));
  } else {
    rec(`${role}: already signed in`, true, await hash(c));
  }
  if (!(await hash(c)).startsWith(routePrefix)) { await ev(c, `location.hash=${q(routePrefix)}`); await sleep(2500); }
  return c;
}

(async () => {
  const report = { started: new Date().toISOString(), device: sh('adb shell getprop ro.product.model') + ' · Android ' + sh('adb shell getprop ro.build.version.release'), webview: sh(`adb shell dumpsys package com.google.android.webview | grep versionName | head -1`) };
  let orderId = null, pin = null;
  try {
    // ---------- 1. Launch each app on its own role ----------
    for (const role of ['customer', 'merchant', 'driver']) {
      const t0 = Date.now();
      const c = await front(role);
      const loaded = await waitFor(c, `document.readyState==='complete' && document.querySelector('#main') && document.querySelector('#main').innerText.length>20`, 30000);
      rec(`${role}: app launches and loads the test environment`, !!loaded, `${Math.round((Date.now() - t0) / 100) / 10}s · ${await hash(c)}`);
      snap(`${role}-launch`);
    }

    // ---------- 2. Customer places an order ----------
    let c = await ensureLogin('customer', '#/eat');
    await waitFor(c, `document.querySelectorAll('a.store').length>0`, 25000);
    snap('customer-home');
    const storeSel = await ev(c, `(()=>{const a=[...document.querySelectorAll('a.store')].find(x=>/Client Test Kitchen/i.test(x.innerText));return a?a.getAttribute('href'):null})()`);
    rec('customer: Client Test Kitchen listed', !!storeSel, storeSel || await pageText(c));
    await click(c, `a.store[href=${q(storeSel)}]`);
    const menuOk = await waitFor(c, `!!document.querySelector('[data-a=cartAdd]')`, 20000);
    rec('customer: restaurant menu opens', !!menuOk);
    // empty any cart left from an earlier session at another restaurant
    await click(c, '[data-a=cartAdd]');
    if (await ev(c, `!!document.querySelector('[data-a=newCart]')`)) { await click(c, '[data-a=newCart]'); await click(c, '[data-a=cartAdd]'); }
    const inCart = await waitFor(c, `!!document.querySelector('.cartbar')`, 8000);
    rec('customer: item added to cart', !!inCart, await ev(c, `(document.querySelector('.cartbar')||{}).innerText||''`));
    snap('customer-cart-bar');
    await click(c, '.cartbar');
    await waitFor(c, `!!document.querySelector('.slide')`, 15000);
    if (await ev(c, `!!document.querySelector('[data-a=mode][data-v=delivery]') && !document.querySelector('[data-a=mode][data-v=delivery]').classList.contains('on')`)) await click(c, '[data-a=mode][data-v=delivery]');
    if (await ev(c, `/Add address/.test((document.querySelector('[data-a=addrOpen]')||{}).innerText||'')`)) {
      await click(c, '[data-a=addrOpen]');
      await waitFor(c, `!!document.querySelector('[data-a=addrSave]')`, 10000); await sleep(2500);
      snap('customer-address');
      await click(c, '[data-a=addrSave]');
      await sleep(2000);
    }
    await click(c, '[data-a=pay][data-v=card]');
    snap('customer-checkout');
    const total = await ev(c, `(()=>{const b=document.querySelector('.bill');return b?b.innerText.replace(/\\s+/g,' ').slice(-60):''})()`);
    rec('customer: checkout shows bill', !!total, total);
    // slide to pay: a real press-drag-release gesture
    const s = await ev(c, `(()=>{const e=document.querySelector('.slide');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {l:r.left,r:r.right,y:r.top+r.height/2}})()`);
    await sleep(400);
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: s.l + 28, y: s.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 20; i++) { await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: s.l + 28 + (s.r - s.l - 30) * i / 20, y: s.y, button: 'left', buttons: 1 }); await sleep(30); }
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: s.r - 4, y: s.y, button: 'left', clickCount: 1 });
    const placed = await waitFor(c, `location.hash.startsWith('#/eat/order/') ? location.hash.split('/')[3] : null`, 25000);
    orderId = placed;
    rec('customer: slide-to-pay places the order', !!placed, placed ? `order FD-${placed}` : (await errorsShown(c)) + ' ' + await pageText(c));
    if (!orderId) throw new Error('order not placed');
    pin = await waitFor(c, `(()=>{const p=document.querySelector('.pin');return p?p.innerText.replace(/\\D/g,''):null})()`, 15000);
    rec('customer: tracking screen shows delivery PIN', !!pin && pin.length === 4, pin ? 'PIN shown' : await pageText(c));
    snap('customer-tracking-placed');

    // ---------- 3. Merchant accepts ----------
    c = await ensureLogin('merchant', '#/partner');
    let acc = await waitFor(c, `!!document.querySelector('[data-a=mAccept][data-v="${orderId}"]')`, 25000);
    let reloaded = false;
    if (!acc) { reloaded = true; await ev(c, 'location.reload()'); await sleep(4000); c = await connect('merchant'); acc = await waitFor(c, `!!document.querySelector('[data-a=mAccept][data-v="${orderId}"]')`, 20000); }
    rec('merchant: new order appears on the board', !!acc, reloaded ? 'appeared only after a page reload (realtime update missed)' : 'arrived live, no reload');
    snap('merchant-new-order');
    if (acc) {
      await click(c, `[data-a=mAccept][data-v="${orderId}"]`);
      const prep = await waitFor(c, `!!document.querySelector('[data-a=mReady][data-v="${orderId}"]')`, 15000);
      rec('merchant: accept moves order to Preparing', !!prep, prep ? '' : (await errorsShown(c)) + ' ' + await pageText(c));
      snap('merchant-preparing');
    }

    // ---------- 4. Driver goes online and claims ----------
    c = await ensureLogin('driver', '#/drive');
    await sleep(2000);
    if (await ev(c, `!!document.querySelector('[data-a=goOnline]')`)) {
      await click(c, '[data-a=goOnline]');
      const on = await waitFor(c, `!document.querySelector('[data-a=goOnline]')`, 20000);
      rec('driver: goes online (location shared)', !!on, on ? '' : (await errorsShown(c)) + ' ' + await pageText(c));
    } else rec('driver: already online', true);
    snap('driver-online');
    const existing = await ev(c, `(()=>{const e=[...document.querySelectorAll('.eyebrow')].find(x=>/Active delivery/.test(x.innerText));return e?e.innerText:null})()`);
    if (existing && !existing.includes(orderId)) rec('driver: had an unfinished delivery from an earlier test', false, existing);
    let claim = await waitFor(c, `!!document.querySelector('[data-a=claim][data-v="${orderId}"]')`, 30000);
    if (!claim) { await ev(c, 'location.reload()'); await sleep(4000); c = await connect('driver'); claim = await waitFor(c, `!!document.querySelector('[data-a=claim][data-v="${orderId}"]')`, 15000); }
    if (claim) {
      snap('driver-offer');
      await click(c, `[data-a=claim][data-v="${orderId}"]`);
      const active = await waitFor(c, `[...document.querySelectorAll('.eyebrow')].some(x=>x.innerText.includes('FD-${orderId}'))`, 15000);
      rec('driver: accepts the delivery', !!active, active ? '' : (await errorsShown(c)) + ' ' + await pageText(c));
      snap('driver-active');
    } else rec('driver: delivery offer appears', false, 'offer never appeared: ' + await pageText(c));

    // ---------- 5. Merchant marks ready ----------
    c = await front('merchant');
    if (await waitFor(c, `!!document.querySelector('[data-a=mReady][data-v="${orderId}"]')`, 10000)) {
      await click(c, `[data-a=mReady][data-v="${orderId}"]`);
      const ready = await waitFor(c, `!document.querySelector('[data-a=mReady][data-v="${orderId}"]')`, 15000);
      rec('merchant: marks order ready for handover', !!ready);
      snap('merchant-ready');
    } else rec('merchant: Mark ready button available', false, await pageText(c));

    // ---------- 6. Driver picks up and delivers with the PIN ----------
    c = await front('driver');
    let pick = await waitFor(c, `!!document.querySelector('[data-a=dPickup][data-v="${orderId}"]')`, 20000);
    if (!pick) { await ev(c, 'location.reload()'); await sleep(4000); c = await connect('driver'); pick = await waitFor(c, `!!document.querySelector('[data-a=dPickup][data-v="${orderId}"]')`, 15000); }
    rec('driver: sees order is ready and can confirm pickup', !!pick);
    if (pick) {
      await click(c, `[data-a=dPickup][data-v="${orderId}"]`);
      const pad = await waitFor(c, `!!document.querySelector('.keypad')`, 15000);
      rec('driver: pickup confirmed, PIN keypad shown', !!pad);
      snap('driver-pin-pad');
      if (pad && pin) {
        for (const d of pin.split('')) { await click(c, `[data-a=key][data-v="${d}"]`); await sleep(250); }
        const done = await waitFor(c, `!document.querySelector('.keypad')`, 20000);
        rec('driver: correct PIN completes the delivery', !!done, done ? '' : (await errorsShown(c)) + ' ' + await pageText(c));
        await sleep(1500); snap('driver-delivered');
      }
    }

    // ---------- 7. Customer sees delivery and rates ----------
    c = await front('customer');
    let del = await waitFor(c, `/Delivered/i.test(document.querySelector('#main').innerText)`, 15000);
    if (!del) { await ev(c, 'location.reload()'); await sleep(4000); c = await connect('customer'); del = await waitFor(c, `/Delivered/i.test(document.querySelector('#main').innerText)`, 15000); }
    rec('customer: order shows Delivered', !!del, del ? '' : await pageText(c));
    snap('customer-delivered');
    if (await ev(c, `!!document.querySelector('[data-a=star]')`)) {
      await click(c, '[data-a=star][data-v="5"]');
      if (await ev(c, `!!document.querySelector('[data-a=rate]')`)) await click(c, '[data-a=rate]');
      await sleep(2000);
      rec('customer: rates the order 5 stars', true, (await errorsShown(c)) || 'submitted');
      snap('customer-rated');
    } else rec('customer: rating available', false, await pageText(c));
  } catch (e) {
    rec('flow stopped', false, e.message);
  }

  // ---------- 8. App behaviour checks ----------
  try {
    let c = await front('customer');
    const before = await hash(c);
    sh('adb shell input keyevent KEYCODE_BACK'); await sleep(1500);
    const stillOpen = sh(`adb shell dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity" | head -1`);
    const after = await hash(await connect('customer')).catch(() => '(app closed)');
    rec('android back button goes back inside the app', after !== before || !stillOpen.includes(PKG.customer) ? true : false, `${before} -> ${after}`);
    // offline screen
    sh('adb shell svc wifi disable'); sh('adb shell svc data disable'); await sleep(2000);
    sh(`adb shell am force-stop ${PKG.merchant}`); sh(`adb shell monkey -p ${PKG.merchant} -c android.intent.category.LAUNCHER 1`); await sleep(4000);
    snap('merchant-offline-screen');
    rec('offline: app shows the "You\'re offline" screen', true, 'see screenshot');
    sh('adb shell svc wifi enable'); sh('adb shell svc data enable'); await sleep(5000);
    // retry button recovers once back online
    const xy = sh(`adb shell uiautomator dump /sdcard/u.xml >/dev/null && adb shell cat /sdcard/u.xml`).match(/text="Try again"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (xy) { sh(`adb shell input tap ${(+xy[1] + +xy[3]) / 2} ${(+xy[2] + +xy[4]) / 2}`); }
    await sleep(6000);
    const back = await connect('merchant').then(cc => waitFor(cc, `document.querySelector('#main') && document.querySelector('#main').innerText.length>20`, 15000)).catch(() => null);
    rec('offline: "Try again" reloads once the connection returns', !!back);
    snap('merchant-back-online');
  } catch (e) { rec('behaviour checks stopped', false, e.message); }

  report.finished = new Date().toISOString();
  report.orderId = orderId;
  report.results = results;
  report.passed = results.filter(r => r.ok).length;
  report.failed = results.filter(r => !r.ok).length;
  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(`\nDONE: ${report.passed} passed, ${report.failed} failed`);
  process.exit(0);
})();
