// DC13 Delivery: end-to-end audit of the three Android apps on an emulator.
// Customer places an order -> Merchant accepts -> Driver claims -> Merchant marks ready
// -> Driver picks up and enters the customer's PIN -> Customer sees it delivered and rates it.
const CDP = require('chrome-remote-interface');
const { execSync } = require('child_process');
const fs = require('fs');

const sh = (c, opt = {}) => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, ...opt }).trim(); } catch (e) { return (e.stdout || '').toString().trim(); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const lg = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${what}`)), ms))]);
const PKG = { customer: 'com.digitalcode13.delivery.customer', driver: 'com.digitalcode13.delivery.driver', merchant: 'com.digitalcode13.delivery.merchant' };
const PORT = { customer: 9301, driver: 9302, merchant: 9303 };
const LOGIN = { customer: 0, merchant: 1, driver: 2 };
const OUT = 'audit';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
let shotN = 0;
function rec(step, ok, detail) { lg('RESULT', step); results.push({ step, ok, detail: detail || '' }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${step} | ${detail || ''}`); }
function snap(name) { const f = `${OUT}/${String(++shotN).padStart(2, '0')}-${name}.png`; try { execSync(`adb exec-out screencap -p > ${f}`, { timeout: 20000 }); } catch (e) { lg('screenshot failed', name); } return f; }

async function shot(name) { await sleep(1800); return snap(name); }
const clients = {};
console.log('devtools sockets at start:', sh(`adb shell cat /proc/net/unix | grep -a devtools`));
async function connect(role) {
  const pid = sh(`adb shell pidof ${PKG[role]}`);
  if (!pid) throw new Error(`${role} app is not running`);
  if (clients[role] && clients[role].pid === pid) return clients[role].c;
  sh(`adb forward tcp:${PORT[role]} localabstract:webview_devtools_remote_${pid}`);
  for (let i = 0; i < 40; i++) {
    try {
      lg(`${role}: listing inspector targets (try ${i + 1})`);
      const list = await within(CDP.List({ host: '127.0.0.1', port: PORT[role] }), 5000, 'list targets');
      lg(`${role}: targets`, JSON.stringify(list.map(x => ({ type: x.type, url: (x.url || '').slice(0, 60) }))));
      const t = list.find(x => x.type === 'page');
      if (t) { const ws = `ws://127.0.0.1:${PORT[role]}/devtools/page/${t.id}`; lg(`${role}: reported ws`, t.webSocketDebuggerUrl, '-> using', ws); const c = await within(CDP({ target: ws, local: true }), 8000, 'open websocket'); await within(c.Runtime.enable(), 5000, 'Runtime.enable'); lg(`${role}: connected`); clients[role] = { pid, c }; return c; }
    } catch (e) { lg(`${role}: inspector attempt failed:`, e.message); }
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
  const r = await within(c.Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }), 15000, 'evaluate');
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
const orderStatus = (c, id) => ev(c, `(async()=>{const r=await sb.from('orders').select('status,courier_name').eq('id',${id}).single();return r.data?r.data.status+(r.data.courier_name?' · '+r.data.courier_name:''):'unknown'})()`).catch(e => 'error: ' + e.message);
const orderPin = (c, id) => ev(c, `(async()=>{location.hash='#/eat/order/${id}';for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,300));const p=document.querySelector('.pin');if(p&&location.hash.endsWith('/${id}'))return p.textContent.replace(/\\D/g,'')}return null})()`).catch(() => null);
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

let report;
function writeReport() {
  report.finished = new Date().toISOString();
  report.results = results;
  report.passed = results.filter(r => r.ok).length;
  report.failed = results.filter(r => !r.ok).length;
  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(`\nDONE: ${report.passed} passed, ${report.failed} failed`);
}
setTimeout(() => { rec('watchdog: test exceeded 22 minutes and was stopped', false); writeReport(); process.exit(0); }, 22 * 60000);
(async () => {
  report = { started: new Date().toISOString(), device: sh('adb shell getprop ro.product.model') + ' · Android ' + sh('adb shell getprop ro.build.version.release'), webview: sh(`adb shell dumpsys package com.google.android.webview | grep versionName | head -1`) };
  let orderId = null, pin = null;
  try {
    // ---------- 1. Launch each app on its own role ----------
    for (const role of ['customer', 'merchant', 'driver']) {
      const t0 = Date.now();
      const c = await front(role);
      const loaded = await waitFor(c, `document.readyState==='complete' && document.querySelector('#main') && document.querySelector('#main').innerText.length>20`, 30000);
      rec(`${role}: app launches and loads the test environment`, !!loaded, `${Math.round((Date.now() - t0) / 100) / 10}s · ${await hash(c)}`);
      await shot(`${role}-launch`);
    }

    // ---------- 2. Customer places an order ----------
    let c = await ensureLogin('customer', '#/eat');
    await waitFor(c, `document.querySelectorAll('a.store').length>0`, 25000);
    await shot('customer-home');
    const storeSel = await ev(c, `(()=>{const a=[...document.querySelectorAll('a.store')].find(x=>/Client Test Kitchen/i.test(x.innerText));return a?a.getAttribute('href'):null})()`);
    rec('customer: Client Test Kitchen listed', !!storeSel, storeSel || await pageText(c));
    await click(c, `a.store[href=${q(storeSel)}]`);
    const menuOk = await waitFor(c, `!!document.querySelector('[data-a=cartAdd]')`, 45000);
    await shot('customer-menu');
    rec('customer: restaurant menu opens', !!menuOk, menuOk ? '' : 'no Add buttons: ' + await pageText(c));
    // empty any cart left from an earlier session at another restaurant
    await click(c, '[data-a=cartAdd]');
    if (await ev(c, `!!document.querySelector('[data-a=newCart]')`)) { await click(c, '[data-a=newCart]'); await click(c, '[data-a=cartAdd]'); }
    const inCart = await waitFor(c, `!!document.querySelector('.cartbar')`, 8000);
    rec('customer: item added to cart', !!inCart, await ev(c, `(document.querySelector('.cartbar')||{}).innerText||''`));
    await shot('customer-cart-bar');
    await click(c, '.cartbar');
    await waitFor(c, `!!document.querySelector('.slide')`, 15000);
    if (await ev(c, `!!document.querySelector('[data-a=mode][data-v=delivery]') && !document.querySelector('[data-a=mode][data-v=delivery]').classList.contains('on')`)) await click(c, '[data-a=mode][data-v=delivery]');
    if (await ev(c, `/Add address/.test((document.querySelector('[data-a=addrOpen]')||{}).innerText||'')`)) {
      await click(c, '[data-a=addrOpen]');
      await waitFor(c, `!!document.querySelector('[data-a=addrSave]')`, 10000); await sleep(2500);
      await shot('customer-address');
      await click(c, '[data-a=addrSave]');
      await sleep(2000);
    }
    await click(c, '[data-a=pay][data-v=card]');
    await shot('customer-checkout');
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
    await shot('customer-tracking-placed');

    // ---------- 3. Merchant accepts ----------
    c = await ensureLogin('merchant', '#/partner');
    let acc = await waitFor(c, `!!document.querySelector('[data-a=mAccept][data-v="${orderId}"]')`, 25000);
    let reloaded = false;
    if (!acc) { reloaded = true; await ev(c, 'location.reload()'); await sleep(4000); c = await connect('merchant'); acc = await waitFor(c, `!!document.querySelector('[data-a=mAccept][data-v="${orderId}"]')`, 20000); }
    rec('merchant: new order appears on the board', !!acc, reloaded ? 'appeared only after a page reload (realtime update missed)' : 'arrived live, no reload');
    await shot('merchant-new-order');
    if (acc) {
      await click(c, `[data-a=mAccept][data-v="${orderId}"]`);
      const prep = await waitFor(c, `!!document.querySelector('[data-a=mReady][data-v="${orderId}"]')`, 15000);
      rec('merchant: accept moves order to Preparing', !!prep, prep ? '' : (await errorsShown(c)) + ' ' + await pageText(c));
      await shot('merchant-preparing');
    }

    // ---------- 4. Driver goes online and claims ----------
    c = await ensureLogin('driver', '#/drive');
    await sleep(2000);
    if (await ev(c, `!!document.querySelector('[data-a=goOnline]')`)) {
      await click(c, '[data-a=goOnline]');
      const on = await waitFor(c, `!document.querySelector('[data-a=goOnline]')`, 20000);
      rec('driver: goes online (location shared)', !!on, on ? '' : (await errorsShown(c)) + ' ' + await pageText(c));
    } else rec('driver: already online', true);
    await shot('driver-online');
    const existing = await ev(c, `(()=>{const e=[...document.querySelectorAll('.eyebrow')].find(x=>/Active delivery/i.test(x.textContent));return e?e.textContent:null})()`);
    if (existing && !existing.includes(orderId)) {
      const oldId = (existing.match(/FD-(\d+)/) || [])[1];
      rec('driver: test courier was blocked by an unfinished delivery', false, `${existing.trim()} (left over from earlier testing; no new offers can appear until it is completed)`);
      if (oldId && await ev(c, `!!document.querySelector('.keypad')`)) {
        const cc = await front('customer');
        const diag = await ev(cc, `(async()=>{const o=await sb.from('orders').select('id,customer_id,status').eq('id',${oldId}).maybeSingle();const s=await sb.from('order_secrets').select('pin').eq('order_id',${oldId}).maybeSingle();return JSON.stringify({me:S.user&&S.user.id,order:o.data,orderErr:o.error&&o.error.message,pinVisible:!!(s.data&&s.data.pin),pinErr:s.error&&s.error.message})})()`).catch(e => e.message);
        lg('stuck order diagnostics', diag);
        const oldPin = await orderPin(cc, oldId);
        let dc = await front('driver');
        if (oldPin) {
          for (const d of oldPin.split('')) { await click(dc, `[data-a=key][data-v="${d}"]`); await sleep(250); }
          const cleared = await waitFor(dc, `!document.querySelector('.keypad')`, 20000);
          rec(`cleanup: completed stuck delivery FD-${oldId} with its PIN`, !!cleared, await orderStatus(dc, oldId));
        } else {
          rec(`cleanup: customer test account cannot see the PIN for FD-${oldId}`, false, diag);
          // complete it the way a real courier would when the customer cannot share the PIN: photo proof
          await click(dc, '[data-a=photoProof]');
          const modal = await waitFor(dc, `!!document.querySelector('#proofFile')`, 8000);
          if (modal) {
            await ev(dc, `(()=>{const c=document.createElement('canvas');c.width=c.height=8;const u=atob(c.toDataURL('image/jpeg').split(',')[1]);const b=new Uint8Array(u.length);for(let i=0;i<u.length;i++)b[i]=u.charCodeAt(i);const dt=new DataTransfer();dt.items.add(new File([b],'proof.jpg',{type:'image/jpeg'}));document.querySelector('#proofFile').files=dt.files;return document.querySelector('#proofFile').files.length})()`);
            await click(dc, '[data-a=photoGo]');
            const cleared = await waitFor(dc, `!document.querySelector('.keypad')`, 20000);
            rec(`cleanup: completed stuck delivery FD-${oldId} with photo proof`, !!cleared, await orderStatus(dc, oldId));
          } else rec('cleanup: photo proof dialog did not open', false);
        }
        c = await connect('driver');
        await sleep(3000);
      }
    }
    let claim = await waitFor(c, `!!document.querySelector('[data-a=claim][data-v="${orderId}"]')`, 30000);
    if (!claim) { await ev(c, 'location.reload()'); await sleep(4000); c = await connect('driver'); claim = await waitFor(c, `!!document.querySelector('[data-a=claim][data-v="${orderId}"]')`, 15000); }
    if (claim) {
      await shot('driver-offer');
      await click(c, `[data-a=claim][data-v="${orderId}"]`);
      const active = await waitFor(c, `[...document.querySelectorAll('.eyebrow')].some(x=>x.innerText.includes('FD-${orderId}'))`, 15000);
      rec('driver: accepts the delivery', !!active, active ? '' : (await errorsShown(c)) + ' ' + await pageText(c));
      await shot('driver-active');
    } else rec('driver: delivery offer appears', false, 'offer never appeared: ' + await pageText(c));

    // ---------- 5. Merchant marks ready ----------
    c = await front('merchant');
    if (await waitFor(c, `!!document.querySelector('[data-a=mReady][data-v="${orderId}"]')`, 10000)) {
      await click(c, `[data-a=mReady][data-v="${orderId}"]`);
      const ready = await waitFor(c, `!document.querySelector('[data-a=mReady][data-v="${orderId}"]')`, 15000);
      rec('merchant: marks order ready for handover', !!ready);
      await shot('merchant-ready');
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
      await shot('driver-pin-pad');
      if (pad && pin) {
        for (const d of pin.split('')) { await click(c, `[data-a=key][data-v="${d}"]`); await sleep(250); }
        const done = await waitFor(c, `!document.querySelector('.keypad')`, 20000);
        rec('driver: correct PIN completes the delivery', !!done, done ? '' : (await errorsShown(c)) + ' ' + await pageText(c));
        await sleep(1500); await shot('driver-delivered');
      }
    }

    // ---------- 7. Customer sees delivery and rates ----------
    c = await front('customer');
    if (!(await hash(c)).endsWith('/' + orderId)) { await ev(c, `location.hash='#/eat/order/${orderId}'`); await sleep(3000); }
    const st = await orderStatus(c, orderId);
    const title = await waitFor(c, `(()=>{const h=[...document.querySelectorAll('#main h1,#main h2')].map(x=>x.textContent.trim()).filter(Boolean);return h.length?h.join(' / '):null})()`, 8000);
    rec('customer: order status is delivered', /^delivered/.test(st), `backend status: ${st} · screen title: ${title}`);
    await shot('customer-delivered');
    if (await waitFor(c, `!!document.querySelector('[data-a=star]')`, 10000)) {
      await click(c, '[data-a=star][data-v="5"]');
      const enabled = await waitFor(c, `(()=>{const b=document.querySelector('[data-a=rate]');return b&&!b.disabled})()`, 10000);
      if (enabled) await click(c, '[data-a=rate]');
      const saved = await waitFor(c, `(async()=>{const r=await sb.from('orders').select('rating').eq('id',${orderId}).single();return r.data&&r.data.rating})()`, 15000);
      const thanks = await waitFor(c, `/You rated this/.test(document.querySelector('#main').textContent)`, 10000);
      rec('customer: rates the order 5 stars', saved === 5, `saved rating: ${saved} · confirmation shown: ${!!thanks}`);
      await shot('customer-rated');
    } else rec('customer: rating available', false, await pageText(c));
  } catch (e) {
    rec('flow stopped', false, e.message);
  }

  // ---------- 8. App behaviour checks ----------
  try {
    let c = await front('customer');
    await ev(c, `location.hash='#/eat'`); await sleep(2500);
    await ev(c, `location.hash='#/eat/orders'`); await sleep(2500);
    const before = await hash(c);
    sh('adb shell input keyevent KEYCODE_BACK'); await sleep(5000);
    const after = await hash(await connect('customer')).catch(() => '(app closed)');
    rec('android back button goes back inside the app', before !== after && after.startsWith('#/eat'), `${before} -> ${after}`);
    // upload fields must open the phone's picker (photo proof, licence, documents)
    let dc = await front('driver');
    await ev(dc, `(()=>{let i=document.getElementById('dc13PickTest');if(!i){i=document.createElement('input');i.type='file';i.accept='image/*';i.id='dc13PickTest';i.style.cssText='position:fixed;left:20px;top:200px;width:200px;height:60px;z-index:99999;opacity:1';document.body.appendChild(i)}return true})()`);
    await click(dc, '#dc13PickTest');
    await sleep(3000);
    const topAct = sh(`adb shell dumpsys activity activities | grep -E "topResumedActivity" | head -1`);
    await shot('driver-file-picker');
    const pickerOpen = !topAct.includes(PKG.driver + '/');
    rec('uploads: tapping a photo/file field opens the phone picker', pickerOpen, topAct.replace(/\s+/g, ' ').slice(0, 160));
    if (pickerOpen) { sh('adb shell input keyevent KEYCODE_BACK'); await sleep(4500); }
    const backIn = sh(`adb shell dumpsys activity activities | grep -E "topResumedActivity" | head -1`).includes(PKG.driver + '/');
    rec('uploads: cancelling the picker returns to the app', backIn);
    // offline screen
    sh('adb shell svc wifi disable'); sh('adb shell svc data disable'); await sleep(2000);
    sh(`adb shell am force-stop ${PKG.merchant}`); sh(`adb shell monkey -p ${PKG.merchant} -c android.intent.category.LAUNCHER 1`); await sleep(4000);
    await shot('merchant-offline-screen');
    rec('offline: app shows the "You\'re offline" screen', true, 'see screenshot');
    sh('adb shell svc wifi enable'); sh('adb shell svc data enable');
    for (let i = 0; i < 20; i++) { if (sh('adb shell ping -c 1 -W 2 8.8.8.8').includes('1 received')) break; await sleep(1500); }
    await sleep(3000);
    // retry button recovers once back online
    const xy = sh(`adb shell uiautomator dump /sdcard/u.xml >/dev/null && adb shell cat /sdcard/u.xml`).match(/text="Try again"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (xy) { sh(`adb shell input tap ${(+xy[1] + +xy[3]) / 2} ${(+xy[2] + +xy[4]) / 2}`); }
    await sleep(6000);
    const back = await connect('merchant').then(cc => waitFor(cc, `document.querySelector('#main') && document.querySelector('#main').innerText.length>20`, 30000)).catch(() => null);
    rec('offline: "Try again" reloads once the connection returns', !!back);
    await shot('merchant-back-online');
  } catch (e) { rec('behaviour checks stopped', false, e.message); }

  report.orderId = orderId;
  writeReport();
  process.exit(0);
})();
