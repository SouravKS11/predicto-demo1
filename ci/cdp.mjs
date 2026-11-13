// Drives one app's WebView over the Chrome DevTools protocol (debug build) and prints a JSON report.
// usage: node ci/cdp.mjs <app> <package>
import { execSync } from "node:child_process";
const [app, pkg] = process.argv.slice(2);
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { app, checks: {}, errors: [] };
const ok = (k, v) => { out.checks[k] = v; };

async function connect() {
  for (let i = 0; i < 30; i++) {
    const sock = sh("adb shell cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1 || true");
    if (sock) {
      sh("adb forward --remove-all || true");
      sh(`adb forward tcp:9333 localabstract:${sock}`);
      const list = await fetch("http://127.0.0.1:9333/json").then((r) => r.json()).catch(() => []);
      const page = list.find((t) => t.type === "page" && /localhost/.test(t.url));
      if (page) return page.webSocketDebuggerUrl;
    }
    await sleep(1000);
  }
  throw new Error("no debuggable WebView found");
}

const wsUrl = await connect();
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const waiting = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") out.errors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || "").slice(0, 300));
  if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") out.errors.push("console: " + d.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? null; };
const back = async () => { sh("adb shell input keyevent 4"); await sleep(2500); };
await send("Runtime.enable");

const base = await ev(`return { origin: location.origin, path: location.pathname, native: !!(window.Capacitor && Capacitor.isNativePlatform()), platform: window.Capacitor?.getPlatform?.(), cls: document.documentElement.className,
  plugins: Object.fromEntries(["App", "StatusBar", "SplashScreen", "PushNotifications", "KeepAwake", "BackgroundGeolocation"].map((p) => [p, !!window.Capacitor?.isPluginAvailable?.(p)])),
  title: document.title, text: document.body.innerText.slice(0, 160) }`);
ok("start", base);

if (app === "customer") {
  await sleep(4000);
  ok("stores_listed", await ev(`return document.querySelectorAll('a[href*="/store/"]').length`));
  ok("open_store", await ev(`const a = document.querySelector('a[href*="/store/"]'); if (!a) return null; a.click(); await new Promise(r => setTimeout(r, 4000)); return location.pathname`));
  ok("add_item", await ev(`const it = document.querySelector('.item'); if (!it) return 'no items'; it.click(); await new Promise(r => setTimeout(r, 1200));
     const ch = document.querySelector('.modal .choice'); const add = [...document.querySelectorAll('.modal button.btn.primary')].pop(); if (add && add.disabled && ch) ch.click(); if (add) add.click();
     await new Promise(r => setTimeout(r, 1200)); return document.body.innerText.match(/Go to checkout|Checkout|Basket[^\\n]*/i)?.[0] || 'added?'`));
  ok("checkout", await ev(`const b = [...document.querySelectorAll('button, a')].find(x => /checkout/i.test(x.innerText)); if (!b) return 'no checkout button'; b.click(); await new Promise(r => setTimeout(r, 3500));
     return { path: location.pathname, payment: /Payment/.test(document.body.innerText), card: /Card online/.test(document.body.innerText), notice: (document.body.innerText.match(/Test mode[^\\n]*|Test payments[^\\n]*|After you place the order[^\\n]*/) || [null])[0] }`));
  await back(); ok("back_1", await ev(`return location.pathname`));
  await back(); ok("back_2", await ev(`return location.pathname`));
  ok("account_social_hidden", await ev(`history.pushState({}, '', '/account'); dispatchEvent(new PopStateEvent('popstate')); await new Promise(r => setTimeout(r, 2500)); return { path: location.pathname, google: /Continue with Google/.test(document.body.innerText), apple: /Continue with Apple/.test(document.body.innerText) }`));
} else {
  ok("sign_in_form", await ev(`return { email: !!document.querySelector('input[type=email]'), password: !!document.querySelector('input[type=password]') }`));
}
ok("dir_lang", await ev(`return document.documentElement.lang + '/' + document.documentElement.dir`));
ws.close();
console.log(JSON.stringify(out));
process.exit(0);
