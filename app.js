/**
 * PetPal × Delhivery mock server — The Great Rewiring 2026, Round 3
 *
 * EXISTING DELHIVERY CAPABILITIES (Round 2 answer, capabilities 21–27)
 *   21 check_serviceability          GET  /c/api/pin-codes/json/
 *   22 create_reorder_shipment       POST /api/cmu/create.json            (+ POST /api/backend/clientwarehouse/create/)
 *   23 track_delivery                GET  /api/v1/packages/json/
 *   24 handle_missed_delivery (NDR)  POST /api/p/update  + GET /api/cmu/get_bulk_upl/{id}
 *   25 initiate_return_pickup (QC)   POST /api/cmu/create.json with payment_mode "Pickup" and qc fields
 *   26 resolve_and_verify_address    Delhivery Maps: validate_address, verify_address, geocode_address
 *   27 get_route_and_eta             Delhivery Maps: route, compute_distance_matrix
 *   + helpers PetPal needs:          GET /api/dc/expected_tat , POST /api/p/edit (edit / cancel)
 *
 * IMAGINED CAPABILITIES (Round 2 must-builds 28–30), flagged imagined_capability: true
 *   28 emergency_same_day_run        POST /api/direct/v1/orders , GET /api/direct/v1/orders/{id}
 *   29 predict_days_of_food_left     GET  /api/v1/replenishment/forecast
 *   30 reorder_without_own_warehouse POST /api/cmu/create_on_behalf.json
 *
 * MCP connector for AgenticOrg:  POST /mcp
 */
const express = require('express');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const store = require('./lib/store');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).trim().replace(/\/$/, '');
const TOKEN = (process.env.DELHIVERY_TOKEN || process.env.MOCK_TOKEN || 'petpal-demo-token').trim();
const CONTROL_KEY = (process.env.CONTROL_KEY || 'curtain').trim();
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 25000);

// ---------------------------------------------------------------------------
// World data
// ---------------------------------------------------------------------------
const SELLERS = {
  HAPPYPAWS_LKO: { display: 'HappyPaws Pet Store, Gomti Nagar, Lucknow', warehouses: ['HAPPYPAWS_GOMTINAGAR'], warehouse_pin: '226010', consent_token: 'CONSENT-BUDDY-001' },
};
const PIN_DB = {
  '226010': { city: 'Lucknow', district: 'Lucknow', state_code: 'UP', sort_code: 'LKO/GTN', lat: 26.8500, lng: 80.9990, locality: 'Gomti Nagar' },
  '226001': { city: 'Lucknow', district: 'Lucknow', state_code: 'UP', sort_code: 'LKO/HZG', lat: 26.8467, lng: 80.9462, locality: 'Hazratganj' },
  '226016': { city: 'Lucknow', district: 'Lucknow', state_code: 'UP', sort_code: 'LKO/IND', lat: 26.8724, lng: 80.9910, locality: 'Indira Nagar' },
  '700019': { city: 'Kolkata', district: 'Kolkata', state_code: 'WB', sort_code: 'CCU/BLG', lat: 22.5205, lng: 88.3640, locality: 'Ballygunge' },
  '110001': { city: 'New Delhi', district: 'New Delhi', state_code: 'DL', sort_code: 'DEL/CNP', lat: 28.6315, lng: 77.2167, locality: 'Connaught Place' },
  '122002': { city: 'Gurugram', district: 'Gurgaon', state_code: 'HR', sort_code: 'GGN/DLF', lat: 28.4744, lng: 77.0910, locality: 'DLF Phase 3' },
  '560001': { city: 'Bengaluru', district: 'Bangalore', state_code: 'KA', sort_code: 'BLR/MGR', lat: 12.9756, lng: 77.6050, locality: 'MG Road' },
  '400001': { city: 'Mumbai', district: 'Mumbai', state_code: 'MH', sort_code: 'BOM/FRT', lat: 18.9388, lng: 72.8354, locality: 'Fort' },
};
const DIRECT_PIN_PREFIXES = ['110', '120', '121', '122', '201', '560', '400', '500', '380']; // Delhi-NCR, Bengaluru, Mumbai, Hyderabad, Ahmedabad
const OWNER = { name: 'Buddy Owner', phone: '9999999999', address: 'House 12, Vipul Khand, Gomti Nagar, Lucknow', pin: '226010' };

function defaultScenario() {
  return {
    delivery: 'normal',              // normal | ndr | delayed
    unserviceable_pins: ['744301'],
    oda_pins: ['194101'],
    direct_riders: 'available',      // available | none
    address_quality: 'auto',         // auto | incomplete | incorrect
    timeout_next: [], malformed_next: [], error_next: [],
  };
}
function freshState() {
  const day = 86400000; const now = Date.now();
  // Seeded history: two earlier deliveries of Buddy's renal food to the owner's address (26-day cycle, last one 22 days ago)
  const history = [
    { waybill: '1490038817220', order: 'BUDDY-FOOD-AUG', product: 'Renal dry food 2kg', delivered_at: new Date(now - 48 * day).toISOString() },
    { waybill: '1490051293347', order: 'BUDDY-FOOD-SEP', product: 'Renal dry food 2kg', delivered_at: new Date(now - 22 * day).toISOString() },
  ];
  return { scenario: defaultScenario(), shipments: {}, upls: {}, warehouses: {}, direct: {}, history };
}

const als = new AsyncLocalStorage();
const S = () => als.getStore();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const rid = (p) => `${p}${crypto.randomBytes(6).toString('hex')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const take = (list, op) => { const i = list.indexOf(op); if (i === -1) return false; list.splice(i, 1); return true; };

async function injectFault(op, res) {
  const s = S().scenario;
  if (take(s.timeout_next, op)) {
    res.locals.injected = `timeout:${op}`;
    await sleep(TIMEOUT_MS);
    res.status(504).type('text/html').send('<html><head><title>504 Gateway Time-out</title></head><body><center><h1>504 Gateway Time-out</h1></center></body></html>');
    return true;
  }
  if (take(s.malformed_next, op)) {
    res.locals.injected = `malformed:${op}`;
    res.status(200).type('application/json').send('{"status":"ok","data":{"waybill":"28"');
    return true;
  }
  if (take(s.error_next, op)) {
    res.locals.injected = `error:${op}`;
    res.status(500).json({ error: 'Internal Server Error', success: false });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Load state -> handle -> save state + call log, before releasing the response
// ---------------------------------------------------------------------------
app.use(async (req, res, next) => {
  const isMcp = req.path === '/mcp';
  const skipLog = req.path.startsWith('/mock/') || req.path === '/' || req.path === '/favicon.ico' || (isMcp && !(req.body && req.body.method === 'tools/call'));
  let st = null;
  if (!isMcp) {
    try { const raw = await store.get('state'); st = raw ? JSON.parse(raw) : freshState(); }
    catch (e) { return res.status(500).json({ error: `state store unavailable: ${e.message}` }); }
  }
  const started = Date.now(); const chunks = [];
  const origSend = res.send.bind(res);
  res.send = (body) => { chunks.push(typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : JSON.stringify(body)); return origSend(body); };
  const origEnd = res.end.bind(res);
  let ended = false;
  res.end = (...args) => {
    if (ended) return origEnd(...args);
    ended = true;
    if (!chunks.length && args[0] && typeof args[0] !== 'function') chunks.push(Buffer.isBuffer(args[0]) ? args[0].toString('utf8') : String(args[0]));
    const work = [];
    if (st && !res.locals.readOnly) work.push(store.set('state', JSON.stringify(st)));
    if (!skipLog) {
      let request = req.body && Object.keys(req.body).length ? req.body : null;
      let response = chunks.join('');
      if (isMcp) {
        request = { tool: req.body.params && req.body.params.name, arguments: req.body.params && req.body.params.arguments };
        try { const j = JSON.parse(response); response = (j.result && j.result.content && j.result.content[0] && j.result.content[0].text) || response; } catch { /* keep */ }
      }
      work.push(store.push('log', JSON.stringify({ at: new Date(started).toISOString(), ms: Date.now() - started, method: isMcp ? 'MCP' : req.method, path: req.originalUrl, status: res.statusCode, injected: res.locals.injected || null, request, response: String(response).slice(0, 6000) })));
    }
    Promise.all(work).catch((e) => console.error('store error', e)).finally(() => origEnd(...args));
    return res;
  };
  if (st) als.run(st, next); else next();
});

const auth = (req, res, next) => (req.headers.authorization === `Token ${TOKEN}` ? next() : res.status(401).json({ detail: 'Authentication credentials were not provided or are invalid.' }));
const controlAuth = (req, res, next) => ((req.query.key || req.headers['x-control-key']) === CONTROL_KEY ? next() : res.status(403).json({ error: 'control key required (?key=...)' }));
const parsePayload = (req) => { if (req.body && typeof req.body.data === 'string') { try { return JSON.parse(req.body.data); } catch { return null; } } return req.body || null; };

// ===========================================================================
// 21 — Pincode serviceability
// ===========================================================================
app.get('/c/api/pin-codes/json/', auth, async (req, res) => {
  if (await injectFault('pincode_serviceability', res)) return;
  const s = S().scenario;
  const codes = String(req.query.filter_codes || '').split(',').map((c) => c.trim()).filter((c) => /^\d{6}$/.test(c));
  res.json({ delivery_codes: codes.map((pin) => {
    const info = PIN_DB[pin] || { city: 'NA', district: 'NA', state_code: 'NA', sort_code: 'NA' };
    const nsz = s.unserviceable_pins.includes(pin);
    return { postal_code: { pin: Number(pin), city: info.city, district: info.district, state_code: info.state_code, country_code: 'IN', sort_code: nsz ? '' : info.sort_code,
      pre_paid: nsz ? 'N' : 'Y', cod: nsz ? 'N' : 'Y', cash: nsz ? 'N' : 'Y', pickup: nsz ? 'N' : 'Y', repl: nsz ? 'N' : 'Y', is_oda: s.oda_pins.includes(pin) ? 'Y' : 'N', remarks: nsz ? 'NSZ' : '', max_amount: 0, max_weight: 0 } };
  }) });
});

function tatDays(o, d) {
  const a = PIN_DB[o]; const b = PIN_DB[d];
  return (a && b && a.state_code === b.state_code ? 2 : 4) + (S().scenario.delivery === 'delayed' ? 4 : 0);
}
app.get('/api/dc/expected_tat', auth, async (req, res) => {
  if (await injectFault('expected_tat', res)) return;
  const { origin_pin, destination_pin } = req.query;
  if (!/^\d{6}$/.test(String(origin_pin || '')) || !/^\d{6}$/.test(String(destination_pin || ''))) return res.status(400).json({ status: false, msg: 'origin_pin and destination_pin must be 6-digit pincodes', data: {} });
  if (S().scenario.unserviceable_pins.includes(String(destination_pin))) return res.json({ status: false, msg: 'Destination pincode not serviceable', data: {} });
  res.json({ status: true, msg: '', data: { tat: tatDays(String(origin_pin), String(destination_pin)) } });
});

// ===========================================================================
// 22 / 25 / 30 — Warehouse, shipment creation (forward + reverse with QC), on-behalf
// ===========================================================================
app.post('/api/backend/clientwarehouse/create/', auth, async (req, res) => {
  if (await injectFault('create_warehouse', res)) return;
  const b = req.body || {};
  const missing = ['name', 'phone', 'address', 'pin', 'return_address'].filter((f) => !b[f]);
  if (missing.length) return res.status(400).json({ success: false, error: [`Missing mandatory field(s): ${missing.join(', ')}`] });
  if (S().warehouses[b.name]) return res.status(400).json({ success: false, error: ['Warehouse with this name already exists'] });
  S().warehouses[b.name] = { ...b, created_at: nowIso() };
  res.json({ success: true, data: { name: b.name, pincode: b.pin, message: 'Warehouse created' } });
});

const newWaybill = () => String(Date.now()).slice(-8) + String(Math.floor(100000 + Math.random() * 899999));

function createShipments(payload, res, sellerClient) {
  const st = S(); const s = st.scenario;
  const pickup = payload.pickup_location && payload.pickup_location.name;
  const shipments = Array.isArray(payload.shipments) ? payload.shipments : [];
  const allowed = sellerClient ? SELLERS[sellerClient].warehouses : Object.keys(st.warehouses);
  if (!pickup || !allowed.includes(pickup)) {
    return res.json({ cash_pickups_count: 0, package_count: 0, upload_wbn: null, replacement_count: 0, rmk: 'ClientWarehouse matching query does not exist.', pickups_count: 0, packages: [], cash_pickups: 0, cod_count: 0, success: false, prepaid_count: 0, cod_amount: 0 });
  }
  if (!shipments.length) return res.json({ success: false, rmk: 'No shipments found in payload', packages: [], package_count: 0 });
  const originPin = sellerClient ? SELLERS[sellerClient].warehouse_pin : st.warehouses[pickup].pin;
  const packages = []; let prepaid = 0; let cod = 0; let reverse = 0;
  for (const sh of shipments) {
    const missing = ['name', 'add', 'pin', 'phone', 'order', 'payment_mode'].filter((f) => !sh[f]);
    if (missing.length) { packages.push({ status: 'Fail', waybill: '', refnum: sh.order || '', serviceable: false, remarks: [`Missing mandatory field(s): ${missing.join(', ')}`] }); continue; }
    if (Object.values(st.shipments).some((x) => x.order === String(sh.order))) { packages.push({ status: 'Fail', waybill: '', refnum: String(sh.order), serviceable: true, remarks: ['Duplicate order id'] }); continue; }
    const pin = String(sh.pin);
    if (s.unserviceable_pins.includes(pin) || !/^\d{6}$/.test(pin)) { packages.push({ status: 'Fail', waybill: '', refnum: String(sh.order), serviceable: false, remarks: ['Non serviceable pincode'] }); continue; }
    const mode = String(sh.payment_mode); const isReverse = mode.toLowerCase() === 'pickup';
    const waybill = newWaybill();
    st.shipments[waybill] = { waybill, order: String(sh.order), pin, consignee: sh.name, add: sh.add, phone: sh.phone, created_at: nowIso(),
      expected: ymd(addDays(new Date(), tatDays(originPin, pin))), step: 0, polled: false, mode: s.delivery, reverse: isReverse, qc: sh.qc || null,
      ndr_reattempted: false, pending: false, delay_polls: 3, first_pending: null, cancelled: false, products_desc: sh.products_desc || '' };
    if (isReverse) reverse++; else if (mode.toLowerCase() === 'cod') cod++; else prepaid++;
    packages.push({ status: 'Success', client: sellerClient || 'PETPAL', sort_code: (PIN_DB[pin] || {}).sort_code || 'NA', remarks: [], waybill, cod_amount: 0, payment: mode, serviceable: true, refnum: String(sh.order) });
  }
  const ok = packages.filter((p) => p.status === 'Success');
  res.json({ cash_pickups_count: 0, package_count: ok.length, upload_wbn: rid('UPL'), replacement_count: 0, pickups_count: reverse, packages, cash_pickups: 0, cod_count: cod, success: ok.length > 0, prepaid_count: prepaid, cod_amount: 0,
    ...(sellerClient ? { on_behalf_of: sellerClient, imagined_capability: true } : {}) });
}

app.post('/api/cmu/create.json', auth, async (req, res) => {
  if (await injectFault('create_shipment', res)) return;
  const p = parsePayload(req);
  if (!p) return res.status(400).json({ success: false, rmk: 'Invalid JSON in data parameter' });
  createShipments(p, res, null);
});

// IMAGINED #30 — ship from an approved seller's registered warehouse on the owner's behalf, with seller consent
app.post('/api/cmu/create_on_behalf.json', auth, async (req, res) => {
  if (await injectFault('create_shipment_on_behalf', res)) return;
  const p = parsePayload(req);
  if (!p) return res.status(400).json({ success: false, rmk: 'Invalid JSON in data parameter' });
  const seller = SELLERS[p.seller_client];
  if (!seller) return res.status(404).json({ success: false, rmk: `Seller client '${p.seller_client}' not found`, imagined_capability: true });
  if (p.consent_token !== seller.consent_token) return res.status(403).json({ success: false, rmk: 'Seller has not granted this agent consent to create shipments (invalid consent_token)', imagined_capability: true });
  createShipments(p, res, p.seller_client);
});

app.post('/api/p/edit', auth, async (req, res) => {
  if (await injectFault('edit_or_cancel_shipment', res)) return;
  const b = req.body || {}; const sh = S().shipments[b.waybill];
  if (!sh) return res.json({ status: false, waybill: b.waybill || '', error: 'Waybill not found' });
  if (sh.step >= 4) return res.json({ status: false, waybill: sh.waybill, error: 'Shipment already delivered; edit/cancel not allowed' });
  if (String(b.cancellation).toLowerCase() === 'true') {
    if (sh.step >= 3) return res.json({ status: false, waybill: sh.waybill, error: 'Shipment is out for delivery; cancellation not allowed' });
    sh.cancelled = true;
    return res.json({ status: true, waybill: sh.waybill, remark: 'Shipment has been cancelled' });
  }
  for (const f of ['name', 'add', 'phone', 'products_desc']) if (b[f]) sh[f === 'name' ? 'consignee' : f] = b[f];
  res.json({ status: true, waybill: sh.waybill, remark: 'Shipment details updated' });
});

// ===========================================================================
// 23 — Tracking   24 — NDR
// ===========================================================================
const STEPS = [
  { Status: 'Manifested', StatusType: 'UD', Instructions: 'Shipment information received', loc: 'Lucknow_Gomtinagar_C (Uttar Pradesh)' },
  { Status: 'In Transit', StatusType: 'UD', Instructions: 'Shipment picked up', loc: 'Lucknow_Gomtinagar_C (Uttar Pradesh)' },
  { Status: 'In Transit', StatusType: 'UD', Instructions: 'Shipment received at destination hub', loc: 'Lucknow_Hub (Uttar Pradesh)' },
  { Status: 'Dispatched', StatusType: 'UD', Instructions: 'Out for delivery', loc: 'Lucknow_Hub (Uttar Pradesh)' },
  { Status: 'Delivered', StatusType: 'DL', Instructions: 'Delivered to consignee', loc: 'Lucknow_Hub (Uttar Pradesh)' },
];
const RSTEPS = [
  { Status: 'Open', StatusType: 'PP', Instructions: 'Pickup request created', loc: 'Lucknow_Hub (Uttar Pradesh)' },
  { Status: 'Scheduled', StatusType: 'PP', Instructions: 'Pickup scheduled', loc: 'Lucknow_Hub (Uttar Pradesh)' },
  { Status: 'Picked Up', StatusType: 'PU', Instructions: 'Item picked up after QC check', loc: 'Lucknow_Gomtinagar_C (Uttar Pradesh)' },
  { Status: 'In Transit', StatusType: 'PU', Instructions: 'Return in transit to seller', loc: 'Lucknow_Hub (Uttar Pradesh)' },
  { Status: 'DTO', StatusType: 'DTO', Instructions: 'Delivered to origin (seller)', loc: 'Lucknow_Gomtinagar_C (Uttar Pradesh)' },
];
const NDR = { Status: 'Pending', StatusType: 'UD', Instructions: 'Consignee unavailable', loc: 'Lucknow_Hub (Uttar Pradesh)', NSLCode: 'EOD-11' };

function advance(sh) {
  const steps = sh.reverse ? RSTEPS : STEPS;
  if (sh.cancelled) return { Status: 'Cancelled', StatusType: 'CN', Instructions: 'Shipment cancelled by client', loc: steps[sh.step].loc };
  if (!sh.polled) { sh.polled = true; return steps[0]; }
  if (!sh.reverse) {
    if (sh.mode === 'ndr' && sh.step === 3 && !sh.ndr_reattempted && !sh.pending) { sh.pending = true; sh.first_pending = sh.first_pending || nowIso(); return NDR; }
    if (sh.pending) { if (!sh.ndr_reattempted) return NDR; sh.pending = false; sh.step = 3; return STEPS[3]; }
    if (sh.mode === 'delayed' && sh.step === 2 && sh.delay_polls > 0) { sh.delay_polls--; return { ...STEPS[2], Instructions: 'Shipment delayed at hub due to network congestion' }; }
  }
  if (sh.step < steps.length - 1) sh.step++;
  if (!sh.reverse && sh.step === 4 && !sh.delivered_at) {
    sh.delivered_at = nowIso();
    S().history.push({ waybill: sh.waybill, order: sh.order, product: sh.products_desc, delivered_at: sh.delivered_at });
  }
  return steps[sh.step];
}

app.get('/api/v1/packages/json/', auth, async (req, res) => {
  if (await injectFault('track_shipment', res)) return;
  const ids = String(req.query.waybill || req.query.ref_ids || '').split(',').map((x) => x.trim()).filter(Boolean);
  const ShipmentData = [];
  for (const id of ids) {
    const sh = S().shipments[id] || Object.values(S().shipments).find((x) => x.order === id);
    if (!sh) continue;
    const st = advance(sh);
    sh.scans = (sh.scans || []).concat([{ ScanDetail: { ScanDateTime: nowIso(), ScanType: st.StatusType, Scan: st.Status, StatusDateTime: nowIso(), ScannedLocation: st.loc, Instructions: st.Instructions, StatusCode: st.NSLCode || '' } }]);
    ShipmentData.push({ Shipment: { AWB: sh.waybill, ReferenceNo: sh.order, OrderType: sh.reverse ? 'Pickup' : 'Pre-paid', Destination: (PIN_DB[sh.pin] || {}).city || 'NA',
      Consignee: { Name: sh.consignee, PinCode: Number(sh.pin) },
      Status: { Status: st.Status, StatusType: st.StatusType, StatusDateTime: nowIso(), StatusLocation: st.loc, Instructions: st.Instructions, StatusCode: st.NSLCode || '' },
      ExpectedDeliveryDate: sh.mode === 'delayed' && !sh.reverse ? ymd(addDays(new Date(sh.expected), 2)) : sh.expected, PickUpDate: sh.created_at, Scans: sh.scans } });
  }
  if (!ShipmentData.length) return res.json({ ShipmentData: [], Error: 'No such waybill or Order Id found' });
  res.json({ ShipmentData });
});

app.post('/api/p/update', auth, async (req, res) => {
  if (await injectFault('ndr_action', res)) return;
  const items = Array.isArray(req.body && req.body.data) ? req.body.data : null;
  if (!items || !items.length) return res.status(400).json({ error: 'data must be a non-empty list of {waybill, act}' });
  const upl = crypto.randomUUID();
  const result = items.map((it) => {
    const sh = S().shipments[it.waybill]; const act = String(it.act || '').toUpperCase();
    if (!sh) return { waybill: it.waybill, status: 'Failure', remark: 'Waybill not found' };
    if (!['RE-ATTEMPT', 'DEFER_DLV', 'EDIT_DETAILS'].includes(act)) return { waybill: it.waybill, status: 'Failure', remark: `Invalid act '${it.act}'` };
    if (!sh.pending) return { waybill: it.waybill, status: 'Failure', remark: 'Action not allowed for current shipment status' };
    if (act === 'DEFER_DLV') {
      const d = new Date(it.deferred_date || ''); const limit = addDays(new Date(sh.first_pending), 6);
      if (isNaN(d) || d > limit) return { waybill: it.waybill, status: 'Failure', remark: 'Deferred date must be within 6 days of first pending date' };
    }
    sh.ndr_reattempted = true;
    return { waybill: it.waybill, status: 'Success', remark: `${act} applied` };
  });
  S().upls[upl] = { status: 'Completed', result, created_at: nowIso() };
  res.json({ request_id: upl });
});

app.get('/api/cmu/get_bulk_upl/:upl', auth, async (req, res) => {
  if (await injectFault('ndr_status', res)) return;
  const u = S().upls[req.params.upl];
  if (!u) return res.status(404).json({ status: 'Failure', error: 'UPL not found' });
  res.json({ status: u.status, request_id: req.params.upl, result: u.result });
});

// ===========================================================================
// 26 / 27 — Delhivery Maps (tool names as in Delhivery Maps MCP docs)
// ===========================================================================
function parseAddress(text) {
  const t = String(text || '');
  const pinMatch = t.match(/\b(\d{6})\b/);
  const pin = pinMatch ? pinMatch[1] : null;
  const known = pin && PIN_DB[pin];
  const byLocality = Object.entries(PIN_DB).find(([, v]) => t.toLowerCase().includes(v.locality.toLowerCase()));
  return { t, pin, known, byLocality };
}
app.post('/maps/v1/validate_address', auth, async (req, res) => {
  if (await injectFault('validate_address', res)) return;
  const { t, pin, known, byLocality } = parseAddress(req.body && req.body.address);
  if (!t.trim()) return res.status(400).json({ error: 'address is required' });
  const forced = S().scenario.address_quality;
  const missing = [];
  if (!pin) missing.push('pincode');
  if (!/\d/.test(t.replace(pin || '', ''))) missing.push('house_number');
  let verdict = missing.length ? 'incomplete' : 'good';
  if (pin && !known) verdict = 'incorrect';
  if (pin && known && byLocality && byLocality[0] !== pin && byLocality[1].city === known.city) verdict = 'incorrect';
  if (forced !== 'auto') verdict = forced;
  const fixPin = byLocality ? byLocality[0] : pin;
  const corrected = verdict === 'good' ? t : `${t.replace(/\b\d{6}\b/, '').replace(/,\s*$/, '').trim()}${fixPin ? `, ${fixPin}` : ''}`;
  res.json({ input_address: t, verdict, reason: verdict === 'good' ? 'Address is complete and deliverable' : verdict === 'incomplete' ? `Missing: ${missing.join(', ') || 'detail'}` : 'Pincode does not match locality',
    missing_components: missing, corrected_address: corrected, corrections: verdict === 'good' ? [] : [{ field: missing.includes('pincode') ? 'pincode' : 'pincode', from: pin, to: fixPin }] });
});
app.post('/maps/v1/verify_address', auth, async (req, res) => {
  if (await injectFault('verify_address', res)) return;
  const { t, pin, known } = parseAddress(req.body && req.body.address);
  const months = Math.min(Math.max(Number(req.body && req.body.months) || 3, 1), 24);
  if (!t.trim()) return res.status(400).json({ error: 'address is required' });
  const isOwner = pin === OWNER.pin && /gomti/i.test(t);
  const inWindow = S().history.filter((h) => Date.now() - new Date(h.delivered_at).getTime() <= months * 30 * 86400000);
  res.json({ input_address: t, valid: Boolean(known), visited_in_window: isOwner && inWindow.length > 0, window_months: months,
    deliveries_in_window: isOwner ? inWindow.length : 0, last_visit: isOwner && inWindow.length ? inWindow[inWindow.length - 1].delivered_at : null });
});
app.post('/maps/v1/geocode_address', auth, async (req, res) => {
  if (await injectFault('geocode_address', res)) return;
  const { t, known, byLocality } = parseAddress(req.body && req.body.address);
  const hit = known || (byLocality && byLocality[1]);
  if (!hit) return res.json({ input_address: t, results: [], status: 'ZERO_RESULTS' });
  res.json({ input_address: t, status: 'OK', results: [{ lat: hit.lat, lng: hit.lng, error_radius_m: known ? 120 : 600, formatted_address: `${hit.locality}, ${hit.city}`, pincode: Object.keys(PIN_DB).find((k) => PIN_DB[k] === hit) }] });
});
const hav = (a, b) => { const R = 6371000; const r = (x) => (x * Math.PI) / 180; const dl = r(b[0] - a[0]); const dn = r(b[1] - a[1]); const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const SPEED = { auto: 6.5, car: 6.5, motorcycle: 7.5, truck: 4.5 }; // m/s, city traffic
app.post('/maps/v1/route', auth, async (req, res) => {
  if (await injectFault('route', res)) return;
  const pts = (req.body && req.body.coordinates) || [];
  const mode = String((req.body && req.body.mode) || 'auto').toLowerCase();
  if (!Array.isArray(pts) || pts.length < 2) return res.status(400).json({ error: 'coordinates must be a list of at least two [lat, lng] pairs' });
  let dist = 0; for (let i = 1; i < pts.length; i++) dist += hav(pts[i - 1], pts[i]) * 1.35;
  const traffic = (new Date().getUTCHours() + 5.5) % 24 >= 17 && (new Date().getUTCHours() + 5.5) % 24 <= 21 ? 1.4 : 1.0;
  res.json({ status: 'OK', mode, routes: [{ distance_m: Math.round(dist), duration_s: Math.round((dist / (SPEED[mode] || 6.5)) * traffic), traffic_factor: traffic, summary: `${(dist / 1000).toFixed(1)} km via city roads` }] });
});
app.post('/maps/v1/compute_distance_matrix', auth, async (req, res) => {
  if (await injectFault('compute_distance_matrix', res)) return;
  const src = (req.body && req.body.sources) || []; const tgt = (req.body && req.body.targets) || [];
  const mode = String((req.body && req.body.mode) || 'auto').toLowerCase();
  if (!src.length || !tgt.length) return res.status(400).json({ error: 'sources and targets are required lists of [lat, lng]' });
  res.json({ status: 'OK', mode, rows: src.map((s) => ({ elements: tgt.map((t) => { const d = hav(s, t) * 1.35; return { distance_m: Math.round(d), duration_s: Math.round(d / (SPEED[mode] || 6.5)) }; }) })) });
});

// ===========================================================================
// IMAGINED #28 — Delhivery Direct same-day rush delivery as an API
// ===========================================================================
app.post('/api/direct/v1/orders', auth, async (req, res) => {
  if (await injectFault('direct_rush_delivery', res)) return;
  const b = req.body || {};
  const missing = ['pickup_address', 'pickup_pin', 'drop_address', 'drop_pin', 'item_description', 'receiver_phone'].filter((f) => !b[f]);
  if (missing.length) return res.status(400).json({ success: false, error: `Missing field(s): ${missing.join(', ')}`, imagined_capability: true });
  const inCity = (p) => DIRECT_PIN_PREFIXES.some((x) => String(p).startsWith(x));
  if (!inCity(b.pickup_pin) || !inCity(b.drop_pin)) return res.status(422).json({ success: false, code: 'CITY_NOT_SERVICEABLE', message: 'Delhivery Direct is available in Delhi-NCR, Bengaluru, Mumbai, Hyderabad and Ahmedabad only', imagined_capability: true });
  if (S().scenario.direct_riders === 'none') return res.status(409).json({ success: false, code: 'NO_RIDER_AVAILABLE', message: 'No rider available near pickup. Retry in 10 minutes or use standard delivery.', imagined_capability: true });
  const id = rid('DD-');
  S().direct[id] = { id, ...b, status: 'RIDER_ASSIGNED', polls: 0, created_at: nowIso() };
  res.json({ success: true, imagined_capability: true, order_id: id, status: 'RIDER_ASSIGNED', rider: { name: 'Rakesh', phone_masked: '98XXXXX210' }, pickup_eta_minutes: 12, drop_eta_minutes: 45 });
});
app.get('/api/direct/v1/orders/:id', auth, async (req, res) => {
  if (await injectFault('direct_status', res)) return;
  const o = S().direct[req.params.id];
  if (!o) return res.status(404).json({ success: false, error: 'Order not found', imagined_capability: true });
  const seq = ['RIDER_ASSIGNED', 'PICKED_UP', 'DELIVERED']; o.polls = Math.min(o.polls + 1, 2); o.status = seq[o.polls];
  res.json({ success: true, imagined_capability: true, order_id: o.id, status: o.status, updated_at: nowIso() });
});

// ===========================================================================
// IMAGINED #29 — Replenishment forecast from repeat-delivery history
// ===========================================================================
app.get('/api/v1/replenishment/forecast', auth, async (req, res) => {
  if (await injectFault('replenishment_forecast', res)) return;
  const phone = String(req.query.consignee_phone || ''); const product = String(req.query.product || '').toLowerCase();
  if (!phone || !product) return res.status(400).json({ success: false, error: 'consignee_phone and product are required', imagined_capability: true });
  if (phone !== OWNER.phone) return res.json({ success: true, imagined_capability: true, deliveries_found: 0, forecast: null, message: 'Not enough repeat deliveries to this consignee to forecast' });
  const hits = S().history.filter((h) => String(h.product).toLowerCase().includes(product.split(' ')[0])).sort((a, b) => new Date(a.delivered_at) - new Date(b.delivered_at));
  if (hits.length < 2) return res.json({ success: true, imagined_capability: true, deliveries_found: hits.length, forecast: null, message: 'Need at least 2 deliveries of this product to forecast' });
  const gaps = []; for (let i = 1; i < hits.length; i++) gaps.push((new Date(hits[i].delivered_at) - new Date(hits[i - 1].delivered_at)) / 86400000);
  const cycle = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
  const last = hits[hits.length - 1];
  const runOut = addDays(new Date(last.delivered_at), cycle);
  const daysLeft = Math.ceil((runOut - Date.now()) / 86400000);
  res.json({ success: true, imagined_capability: true, consignee_phone: phone, product: hits[hits.length - 1].product, deliveries_found: hits.length,
    delivery_dates: hits.map((h) => ymd(h.delivered_at)), average_cycle_days: cycle, last_delivered: ymd(last.delivered_at), predicted_run_out: ymd(runOut), days_left: daysLeft,
    reorder_by: ymd(addDays(runOut, -tatDays(SELLERS.HAPPYPAWS_LKO.warehouse_pin, OWNER.pin) - 1)) });
});

// ===========================================================================
// MCP connector
// ===========================================================================
async function rest(method, path, { query, body } = {}) {
  const q = query ? Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '') : [];
  const qs = q.length ? `?${new URLSearchParams(q).toString()}` : '';
  try {
    const r = await fetch(`${PUBLIC_BASE_URL}${path}${qs}`, { method, headers: { Authorization: `Token ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let response; try { response = JSON.parse(text); } catch { response = text; }
    return { endpoint: `${method} ${path}${qs}`, http_status: r.status, response };
  } catch (e) { return { endpoint: `${method} ${path}${qs}`, http_status: 0, response: { network_error: String(e.message || e) } }; }
}
const Shipment = z.object({
  name: z.string(), add: z.string(), pin: z.string(), city: z.string().optional(), state: z.string().optional(), phone: z.string(),
  order: z.string().describe('Unique order id'), payment_mode: z.enum(['Prepaid', 'COD', 'Pickup']).describe('Pickup = reverse pickup (return to seller)'),
  products_desc: z.string().optional(), hsn_code: z.string().optional(), total_amount: z.string().optional(), quantity: z.string().optional(), weight: z.string().optional().describe('grams'),
  qc: z.object({ item: z.string().optional(), description: z.string().optional(), check_seal: z.boolean().optional() }).optional().describe('Quality check at pickup, for reverse pickups'),
});
const LatLng = z.array(z.number()).length(2).describe('[latitude, longitude]');

function buildMcp() {
  const s = new McpServer({ name: 'delhivery', version: '1.0.0' });
  const tool = (name, description, schema, fn) => s.registerTool(name, { description, inputSchema: schema }, async (a) => ({ content: [{ type: 'text', text: JSON.stringify(await fn(a), null, 2) }] }));

  tool('delhivery_pincode_serviceability', 'GET /c/api/pin-codes/json/ — is a pincode serviceable? Empty delivery_codes, pre_paid "N" or remarks "NSZ" = NOT serviceable.',
    { filter_codes: z.string().describe('6-digit pincode(s), comma separated') }, (a) => rest('GET', '/c/api/pin-codes/json/', { query: a }));
  tool('delhivery_expected_tat', 'GET /api/dc/expected_tat — expected delivery days (data.tat) between two pincodes.',
    { origin_pin: z.string(), destination_pin: z.string() }, (a) => rest('GET', '/api/dc/expected_tat', { query: { ...a, mot: 'S', pdt: 'B2C' } }));
  tool('delhivery_create_warehouse', 'POST /api/backend/clientwarehouse/create/ — register a pickup warehouse for YOUR OWN Delhivery account.',
    { name: z.string(), phone: z.string(), address: z.string(), city: z.string().optional(), pin: z.string(), return_address: z.string(), return_pin: z.string().optional() },
    (a) => rest('POST', '/api/backend/clientwarehouse/create/', { body: { ...a, country: 'India' } }));
  tool('delhivery_create_shipment', 'POST /api/cmu/create.json — create a shipment from YOUR OWN registered warehouse (forward, or reverse pickup with payment_mode "Pickup"). PetPal owns no warehouse, so for the pet store use delhivery_create_shipment_on_behalf.',
    { pickup_location_name: z.string(), shipments: z.array(Shipment).min(1) },
    (a) => rest('POST', '/api/cmu/create.json', { body: { pickup_location: { name: a.pickup_location_name }, shipments: a.shipments } }));
  tool('delhivery_create_shipment_on_behalf', 'IMAGINED CAPABILITY — POST /api/cmu/create_on_behalf.json. Create a shipment from the approved pet store\'s registered warehouse on the owner\'s behalf, using the store\'s consent token. Use payment_mode "Prepaid" for a paid reorder (only after payment is confirmed) or "Pickup" with qc to return a wrong item to the store. packages[0].status "Success" gives the waybill; "Fail" gives remarks; success=false with rmk means rejected.',
    { seller_client: z.string().default('HAPPYPAWS_LKO'), consent_token: z.string().default('CONSENT-BUDDY-001'), pickup_location_name: z.string().default('HAPPYPAWS_GOMTINAGAR'), shipments: z.array(Shipment).min(1) },
    (a) => rest('POST', '/api/cmu/create_on_behalf.json', { body: { seller_client: a.seller_client, consent_token: a.consent_token, pickup_location: { name: a.pickup_location_name }, shipments: a.shipments } }));
  tool('delhivery_edit_or_cancel_shipment', 'POST /api/p/edit — cancel a shipment (cancellation true) before it is out for delivery, or edit consignee name/address/phone.',
    { waybill: z.string(), cancellation: z.boolean().optional(), name: z.string().optional(), add: z.string().optional(), phone: z.string().optional() },
    (a) => rest('POST', '/api/p/edit', { body: { ...a, ...(a.cancellation ? { cancellation: 'true' } : {}) } }));
  tool('delhivery_track_shipment', 'GET /api/v1/packages/json/ — track by waybill. Forward: Manifested, In Transit, Dispatched (out for delivery), Pending (failed attempt / NDR), Delivered, Cancelled. Reverse: Open, Scheduled, Picked Up, In Transit, DTO (back at store). Also ExpectedDeliveryDate.',
    { waybill: z.string() }, (a) => rest('GET', '/api/v1/packages/json/', { query: a }));
  tool('delhivery_ndr_action', 'POST /api/p/update — act on a failed delivery (status Pending): RE-ATTEMPT, DEFER_DLV (deferred_date YYYY-MM-DD within 6 days) or EDIT_DETAILS. Returns request_id; confirm with delhivery_ndr_status.',
    { waybill: z.string(), act: z.enum(['RE-ATTEMPT', 'DEFER_DLV', 'EDIT_DETAILS']), deferred_date: z.string().optional() },
    (a) => rest('POST', '/api/p/update', { body: { data: [a] } }));
  tool('delhivery_ndr_status', 'GET /api/cmu/get_bulk_upl/{request_id} — result of an NDR action (Success / Failure per waybill).',
    { request_id: z.string() }, (a) => rest('GET', `/api/cmu/get_bulk_upl/${encodeURIComponent(a.request_id)}`, { query: { verbose: 'true' } }));
  tool('validate_address', 'Delhivery Maps — validate an Indian address: verdict good / incomplete / incorrect, missing components and a corrected address. Use before the first delivery to a new address.',
    { address: z.string() }, (a) => rest('POST', '/maps/v1/validate_address', { body: a }));
  tool('verify_address', 'Delhivery Maps — has Delhivery delivered to this address within the last N months? (visited_in_window, deliveries_in_window, last_visit).',
    { address: z.string(), months: z.number().int().min(1).max(24).default(3) }, (a) => rest('POST', '/maps/v1/verify_address', { body: a }));
  tool('geocode_address', 'Delhivery Maps — convert an address to latitude/longitude (needed for route and distance matrix).',
    { address: z.string() }, (a) => rest('POST', '/maps/v1/geocode_address', { body: a }));
  tool('route', 'Delhivery Maps — traffic-aware route between points: distance_m and duration_s. mode auto, motorcycle or truck. Use in an emergency to give the owner travel time to the vet.',
    { coordinates: z.array(LatLng).min(2), mode: z.enum(['auto', 'motorcycle', 'truck']).default('auto') }, (a) => rest('POST', '/maps/v1/route', { body: a }));
  tool('compute_distance_matrix', 'Delhivery Maps — travel distance and time from each source to each target. Use to pick the nearest open vet.',
    { sources: z.array(LatLng).min(1), targets: z.array(LatLng).min(1), mode: z.enum(['auto', 'motorcycle', 'truck']).default('auto') },
    (a) => rest('POST', '/maps/v1/compute_distance_matrix', { body: a }));
  tool('delhivery_direct_rush_delivery', 'IMAGINED CAPABILITY — POST /api/direct/v1/orders. Same-day rider delivery (Delhivery Direct) for urgent medicine. Only in Delhi-NCR, Bengaluru, Mumbai, Hyderabad, Ahmedabad; otherwise CITY_NOT_SERVICEABLE. May return NO_RIDER_AVAILABLE.',
    { pickup_address: z.string(), pickup_pin: z.string(), drop_address: z.string(), drop_pin: z.string(), item_description: z.string(), receiver_phone: z.string() },
    (a) => rest('POST', '/api/direct/v1/orders', { body: a }));
  tool('delhivery_direct_status', 'IMAGINED CAPABILITY — GET /api/direct/v1/orders/{id}: RIDER_ASSIGNED, PICKED_UP, DELIVERED.',
    { order_id: z.string() }, (a) => rest('GET', `/api/direct/v1/orders/${encodeURIComponent(a.order_id)}`));
  tool('delhivery_replenishment_forecast', 'IMAGINED CAPABILITY — GET /api/v1/replenishment/forecast. From Delhivery\'s record of repeat deliveries of the same product to the same consignee: average_cycle_days, predicted_run_out, days_left and reorder_by date.',
    { consignee_phone: z.string().default('9999999999'), product: z.string().default('Renal dry food') }, (a) => rest('GET', '/api/v1/replenishment/forecast', { query: a }));
  return s;
}

app.post('/mcp', async (req, res) => {
  const server = buildMcp();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
  catch (e) { if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(e.message || e) }, id: null }); }
});
app.get('/mcp', (req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server). POST JSON-RPC here.' }, id: null }));

// ===========================================================================
// Behind the curtain
// ===========================================================================
app.get('/mock/scenario', controlAuth, (req, res) => { res.locals.readOnly = true; res.json(S().scenario); });
app.post('/mock/scenario', controlAuth, (req, res) => {
  const allowed = Object.keys(defaultScenario());
  for (const [k, v] of Object.entries(req.body || {})) if (allowed.includes(k)) S().scenario[k] = v;
  res.json({ ok: true, scenario: S().scenario });
});
app.get('/mock/set', controlAuth, (req, res) => { // browser-friendly: /mock/set?key=curtain&delivery=ndr
  const allowed = Object.keys(defaultScenario()); const listKeys = ['timeout_next', 'malformed_next', 'error_next', 'unserviceable_pins', 'oda_pins'];
  for (const [k, v] of Object.entries(req.query)) if (k !== 'key' && allowed.includes(k)) S().scenario[k] = listKeys.includes(k) ? String(v).split(',').filter(Boolean) : v;
  res.json({ ok: true, scenario: S().scenario });
});
app.all('/mock/reset', controlAuth, async (req, res) => {
  const f = freshState(); Object.keys(S()).forEach((k) => delete S()[k]); Object.assign(S(), f);
  if (req.query.clear_log === 'true') await store.del('log');
  res.json({ ok: true, scenario: S().scenario });
});
app.get('/mock/state', controlAuth, (req, res) => { res.locals.readOnly = true; res.json(S()); });
app.get('/mock/log', controlAuth, async (req, res) => { res.locals.readOnly = true; res.json((await store.range('log')).map((x) => JSON.parse(x))); });
app.get('/mock/console', controlAuth, (req, res) => {
  res.locals.readOnly = true;
  res.send(`<!doctype html><html><head><title>PetPal · Delhivery calls</title><style>
body{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:#0f1419;color:#d6dde6;margin:0;padding:14px}h1{font:600 15px system-ui;margin:0 0 10px}
.row{border-bottom:1px solid #263040;padding:8px 0}.m{color:#7cc4ff;font-weight:700}.mcp{color:#c792ea;font-weight:700}.p{color:#fff}.ok{color:#5fd38d}.bad{color:#ff7a7a}
.inj{background:#5a3b00;color:#ffcf66;padding:1px 6px;border-radius:4px;margin-left:6px}pre{white-space:pre-wrap;word-break:break-all;margin:4px 0 0;color:#aab6c4;max-height:180px;overflow:auto}.t{color:#6b7787}</style></head><body>
<h1>PetPal · Delhivery mock — live calls</h1><div id="l"></div><script>
const k=new URLSearchParams(location.search).get('key');const esc=s=>String(s).replace(/</g,'&lt;');
async function r(){const d=await (await fetch('/mock/log?key='+k)).json();
document.getElementById('l').innerHTML=d.slice().reverse().map(e=>'<div class="row"><span class="t">'+e.at.slice(11,19)+'</span> <span class="'+(e.method==='MCP'?'mcp':'m')+'">'+e.method+'</span> <span class="p">'+esc(e.method==='MCP'&&e.request?'tool · '+e.request.tool:e.path)+'</span> <span class="'+(e.status<400?'ok':'bad')+'">'+e.status+'</span> <span class="t">'+e.ms+'ms</span>'+(e.injected?'<span class="inj">'+e.injected+'</span>':'')+(e.request?'<pre>→ '+esc(JSON.stringify(e.request))+'</pre>':'')+'<pre>← '+esc(e.response)+'</pre></div>').join('')}
r();setInterval(r,2000)</script></body></html>`);
});

app.get('/', (req, res) => {
  res.locals.readOnly = true;
  res.json({
    service: 'PetPal × Delhivery mock (Round 3)', storage: store.useRedis ? 'upstash-redis' : 'memory', mcp_url: `${PUBLIC_BASE_URL}/mcp`,
    diagnostics: { vercel_env: process.env.VERCEL_ENV || 'local', public_base_url_set: Boolean(process.env.PUBLIC_BASE_URL),
      env_names_seen: Object.keys(process.env).filter((k) => /KV|UPSTASH|REDIS|PUBLIC_BASE|TOKEN|CONTROL_KEY/i.test(k) && !/^npm_/.test(k)).sort() },
  });
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ code: 'INVALID_JSON', message: 'Request body is not valid JSON' });
  res.status(500).json({ code: 'INTERNAL_ERROR', message: String((err && err.message) || err) });
});

module.exports = app;
