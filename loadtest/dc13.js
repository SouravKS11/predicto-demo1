// DC13 load test (k6). Simulates a launch-city peak against the "Load Test (internal)" city:
//   browse    customers opening the shop, home, store pages and pricing a basket
//   orders    guests placing card orders (demo payments) and watching the tracking page
//   stores    store tablets polling the order board, accepting and marking orders ready
//   couriers  couriers online, sharing GPS, taking offers, picking up and delivering
//   realtime  open live-update connections listening for order changes
// MODE=smoke runs a tiny version to check the script; MODE=peak runs the real test.
import http from "k6/http";
import ws from "k6/ws";
import { check, sleep } from "k6";
import { Counter, Trend, Rate } from "k6/metrics";
import exec from "k6/execution";

const URL = __ENV.SUPABASE_URL, ANON = __ENV.SUPABASE_ANON, SHOP = __ENV.SHOP_URL || "https://shop.digitalcode13.online";
const MODE = __ENV.MODE || "smoke";
const P = MODE === "peak"
  ? { browse: 300, ordersPerMin: 60, orderVUs: 100, stores: 8, couriers: 50, realtime: 150, ramp: "5m", hold: "12m", down: "2m" }
  : { browse: 5, ordersPerMin: 4, orderVUs: 4, stores: 2, couriers: 3, realtime: 3, ramp: "30s", hold: "2m", down: "15s" };
const totalMs = (s) => s.split(/(?<=[ms])/).reduce((a, x) => a + parseInt(x) * (x.endsWith("m") ? 60000 : 1000), 0);
const RUN_MS = totalMs(P.ramp) + totalMs(P.hold) + totalMs(P.down);

export const options = {
  scenarios: {
    browse: { executor: "ramping-vus", exec: "browse", startVUs: 0, stages: [{ duration: P.ramp, target: P.browse }, { duration: P.hold, target: P.browse }, { duration: P.down, target: 0 }] },
    stores: { executor: "constant-vus", exec: "store", vus: P.stores, duration: `${Math.round(RUN_MS / 1000) + 60}s` },
    couriers: { executor: "constant-vus", exec: "courier", vus: P.couriers, duration: `${Math.round(RUN_MS / 1000) + 60}s` },
    orders: { executor: "ramping-arrival-rate", exec: "order", startRate: 0, timeUnit: "1m", preAllocatedVUs: P.orderVUs, maxVUs: P.orderVUs, startTime: "30s",
              stages: [{ duration: P.ramp, target: P.ordersPerMin }, { duration: P.hold, target: P.ordersPerMin }, { duration: P.down, target: 0 }] },
    realtime: { executor: "constant-vus", exec: "realtime", vus: P.realtime, duration: `${Math.round(RUN_MS / 1000)}s` },
  },
  thresholds: {
    "http_req_failed{kind:api}": ["rate<0.02"],
    "http_req_duration{kind:api}": ["p(95)<1500"],
    "http_req_duration{name:place_order}": ["p(95)<2500"],
    "http_req_duration{name:storefront_store}": ["p(95)<1500"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

const placed = new Counter("orders_placed"), placeFail = new Counter("orders_failed"), accepted = new Counter("orders_accepted"), readied = new Counter("orders_ready");
const claimed = new Counter("orders_claimed"), delivered = new Counter("orders_delivered"), signupFail = new Counter("guest_signup_failed");
const rtJoinOk = new Counter("realtime_joined"), rtJoinFail = new Counter("realtime_join_failed"), rtEvents = new Counter("realtime_events"), rtErrors = new Counter("realtime_errors");
const pageLoad = new Trend("page_load_ms", true), appErrors = new Rate("app_errors");

const H = (token) => ({ apikey: ANON, Authorization: `Bearer ${token || ANON}`, "Content-Type": "application/json" });
function rpc(name, body, token) {
  const r = http.post(`${URL}/rest/v1/rpc/${name}`, JSON.stringify(body || {}), { headers: H(token), tags: { name, kind: "api" } });
  let j = null; try { j = r.json(); } catch { /* empty */ }
  const ok = r.status >= 200 && r.status < 300;
  appErrors.add(!ok);
  if (!ok && Math.random() < 0.05) console.warn(`${name} ${r.status} ${String(r.body).slice(0, 160)}`);
  return { ok, status: r.status, j };
}
function get(path, token, name) {
  const r = http.get(`${URL}/rest/v1/${path}`, { headers: H(token), tags: { name, kind: "api" } });
  let j = null; try { j = r.json(); } catch { /* empty */ }
  return { ok: r.status === 200, j };
}
function guest() {
  const r = http.post(`${URL}/auth/v1/signup`, JSON.stringify({ data: {} }), { headers: { apikey: ANON, "Content-Type": "application/json" }, tags: { name: "guest_signup", kind: "auth" } });
  const t = r.status === 200 ? r.json("access_token") : null;
  if (!t) { signupFail.add(1); console.warn(`guest signup ${r.status} ${String(r.body).slice(0, 120)}`); }
  return t;
}
const jitter = (v, d) => v + (Math.random() - 0.5) * d;
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ---------------- shared test data ----------------
export function setup() {
  const cities = rpc("storefront_cities").j || [];
  const city = cities.find((c) => c.name === "Load Test (internal)");
  if (!city) throw new Error("Run loadtest/setup.sql first: no Load Test city");
  const center = { lat: city.lat || 43.8563, lng: city.lng || 18.4131 };
  const list = rpc("storefront_stores", { p_city: city.id, p_lat: center.lat, p_lng: center.lng }).j || [];
  const stores = [];
  for (const s of list) {
    const d = rpc("storefront_store", { p_slug: s.slug }).j;
    const items = (d?.items || d?.menu?.flatMap?.((c) => c.items) || []).filter((i) => i.available !== false && !i.rx_required && !(i.options || []).some((o) => (o.min || 0) > 0));
    if (items.length) stores.push({ id: s.id, slug: s.slug, lat: s.lat || center.lat, lng: s.lng || center.lng, items: items.map((i) => i.id) });
  }
  if (!stores.length) throw new Error("No orderable stores in the Load Test city");
  console.log(`setup: ${stores.length} stores, ${stores.reduce((a, s) => a + s.items.length, 0)} items`);
  return { city: city.id, center, stores };
}

// ---------------- customers browsing ----------------
export function browse(data) {
  if (exec.vu.iterationInScenario === 0) {
    const t0 = Date.now();
    const page = http.get(SHOP + "/", { tags: { name: "shop_page", kind: "static" } });
    const js = (String(page.body).match(/src="(\/assets\/[^"]+\.js)"/) || [])[1];
    if (js) http.get(SHOP + js, { tags: { name: "shop_js", kind: "static" } });
    pageLoad.add(Date.now() - t0);
    rpc("storefront_config");
  }
  rpc("storefront_home", { p_city: data.city });
  rpc("storefront_stores", { p_city: data.city, p_lat: jitter(data.center.lat, 0.04), p_lng: jitter(data.center.lng, 0.04) });
  sleep(2 + Math.random() * 4);
  const s = pick(data.stores);
  rpc("storefront_store", { p_slug: s.slug });
  sleep(3 + Math.random() * 5);
  rpc("price_order", { p: { merchant_id: s.id, mode: "delivery", items: [{ item_id: pick(s.items), qty: 1 }], dropoff: { lat: jitter(s.lat, 0.02), lng: jitter(s.lng, 0.02) } } });
  sleep(4 + Math.random() * 6);
}

// ---------------- guests ordering and tracking ----------------
let myToken = null;
export function order(data) {
  if (!myToken) myToken = guest();
  if (!myToken) { sleep(5); return; }
  const s = pick(data.stores);
  const items = [{ item_id: pick(s.items), qty: 1 + Math.floor(Math.random() * 2) }];
  if (Math.random() < 0.5) items.push({ item_id: pick(s.items), qty: 1 });
  const r = rpc("place_order", { p: { merchant_id: s.id, mode: "delivery", tip: 0, payment: "card", customer_name: "LT Customer", customer_note: "",
    customer_phone: "+387 61 " + String(100000 + Math.floor(Math.random() * 899999)), items,
    dropoff: { lat: jitter(s.lat, 0.02), lng: jitter(s.lng, 0.02), address: "Load test street " + exec.vu.idInTest } } }, myToken);
  if (!r.ok || !r.j?.id) { placeFail.add(1); return; }
  placed.add(1);
  for (let i = 0; i < 3; i++) {          // the tracking page refreshes every 10 seconds
    sleep(10);
    get(`orders?select=*&id=eq.${r.j.id}`, myToken, "track_order");
    rpc("order_view", { p_order: r.j.id }, myToken);
  }
}

// ---------------- store tablets ----------------
let storeToken = null, storeId = null; const acceptedAt = {};
export function store() {
  if (!storeToken) {
    storeToken = guest(); if (!storeToken) { sleep(30); return; }
    const e = rpc("loadtest_enroll", { p_role: "store", p_idx: exec.vu.idInTest }, storeToken);
    storeId = e.j?.merchant; if (!storeId) { storeToken = null; sleep(30); return; }
  }
  const b = rpc("store_board", { p_merchant: storeId }, storeToken);
  for (const o of (Array.isArray(b.j) ? b.j : [])) {
    if (o.status === "placed") { if (rpc("store_action", { p_order: o.id, p_action: "accept", p_minutes: 10, p_reason: null }, storeToken).ok) { accepted.add(1); acceptedAt[o.id] = Date.now(); } }
    else if (o.status === "preparing") {
      if (!acceptedAt[o.id]) acceptedAt[o.id] = Date.now();
      if (Date.now() - acceptedAt[o.id] > 30000 && rpc("store_action", { p_order: o.id, p_action: "ready", p_minutes: null, p_reason: null }, storeToken).ok) readied.add(1);
    }
  }
  sleep(8);
}

// ---------------- couriers ----------------
let kToken = null, kId = null, pos = null, lastPing = 0, lastJobs = 0, jobs = []; const pickedAt = {};
export function courier(data) {
  if (!kToken) {
    kToken = guest(); if (!kToken) { sleep(30); return; }
    const e = rpc("loadtest_enroll", { p_role: "courier", p_idx: exec.vu.idInTest }, kToken);
    kId = e.j?.courier; if (!kId) { kToken = null; sleep(30); return; }
    pos = { lat: jitter(data.center.lat, 0.03), lng: jitter(data.center.lng, 0.03) };
    rpc("courier_set_online", { p_online: true, p_lat: pos.lat, p_lng: pos.lng }, kToken);
  }
  const now = Date.now();
  if (now - lastPing > 20000) { pos = { lat: jitter(pos.lat, 0.004), lng: jitter(pos.lng, 0.004) }; rpc("courier_ping", { p_lat: pos.lat, p_lng: pos.lng }, kToken); lastPing = now; }
  const pool = rpc("courier_pool", {}, kToken);
  if (now - lastJobs > 7000 || !jobs.length) {
    const g = get(`orders?select=id,status&courier_id=eq.${kId}&status=in.(preparing,ready,picked_up)&order=assigned_at`, kToken, "courier_jobs");
    jobs = Array.isArray(g.j) ? g.j : []; lastJobs = now;
  }
  if (jobs.length < 2) {
    const offer = (Array.isArray(pool.j) ? pool.j : []).find((o) => o.offer);
    if (offer && rpc("courier_action", { p_order: offer.id, p_action: "claim", p_pin: null, p_note: null }, kToken).ok) { claimed.add(1); lastJobs = 0; }
  }
  for (const j of jobs) {
    if (j.status === "ready" && rpc("courier_action", { p_order: j.id, p_action: "pickup", p_pin: null, p_note: null }, kToken).ok) { pickedAt[j.id] = now; lastJobs = 0; }
    else if (j.status === "picked_up") {
      if (!pickedAt[j.id]) pickedAt[j.id] = now;
      if (now - pickedAt[j.id] > 20000 && rpc("courier_action", { p_order: j.id, p_action: "deliver", p_pin: null, p_note: null }, kToken).ok) { delivered.add(1); lastJobs = 0; }
    }
  }
  sleep(5);
}

// ---------------- live-update connections ----------------
export function realtime(data) {
  const wsUrl = URL.replace("https://", "wss://") + `/realtime/v1/websocket?apikey=${ANON}&vsn=1.0.0`;
  const s = data.stores[exec.vu.idInTest % data.stores.length];
  const res = ws.connect(wsUrl, { tags: { name: "realtime" } }, (socket) => {
    let ref = 1;
    socket.on("open", () => {
      socket.send(JSON.stringify({ topic: `realtime:lt-${exec.vu.idInTest}`, event: "phx_join", ref: String(ref++), join_ref: "1",
        payload: { config: { broadcast: { ack: false, self: false }, presence: { key: "" }, postgres_changes: [{ event: "*", schema: "public", table: "orders", filter: `merchant_id=eq.${s.id}` }], private: false }, access_token: ANON } }));
      socket.setInterval(() => socket.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(ref++) })), 25000);
      socket.setTimeout(() => socket.close(), Math.max(30000, RUN_MS - 30000));
    });
    socket.on("message", (m) => {
      let d; try { d = JSON.parse(m); } catch { return; }
      if (d.event === "phx_reply" && d.ref === "1") { if (d.payload?.status === "ok") rtJoinOk.add(1); else { rtJoinFail.add(1); console.warn("realtime join " + JSON.stringify(d.payload).slice(0, 160)); } }
      else if (d.event === "postgres_changes") rtEvents.add(1);
      else if (d.event === "system" && d.payload?.status === "error") { rtErrors.add(1); console.warn("realtime system " + JSON.stringify(d.payload).slice(0, 160)); }
      else if (d.event === "phx_error" || d.event === "phx_close") rtErrors.add(1);
    });
    socket.on("error", (e) => { rtErrors.add(1); console.warn("realtime error " + e.error()); });
  });
  check(res, { "realtime connected": (r) => r && r.status === 101 });
  sleep(1);
}

export function handleSummary(d) {
  return { "loadtest/summary.json": JSON.stringify(d, null, 1), stdout: "\n" + JSON.stringify(Object.fromEntries(Object.entries(d.metrics).map(([k, v]) => [k, v.values])), null, 0).slice(0, 6000) + "\n" };
}
