/*
  update-schedule.js
  ------------------
  Downloads the Metrolinx GTFS zip, parses the Stouffville line schedule for
  Agincourt GO, and writes updated times into agincourt.html.

  Run:
    npm install       (first time only)
    npm run update    (or: node update-schedule.js)

  Re-run whenever Metrolinx publishes a new schedule (usually seasonal).
*/

'use strict';

const AdmZip  = require('adm-zip');
const fs      = require('fs');
const https   = require('https');
const path    = require('path');

const GTFS_URL   = 'https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip';
const HTML_FILE  = path.join(__dirname, 'agincourt.html');
const STOP_MATCH = /agincourt/i;          // matched against stop_name
const ROUTE_MATCH = /stouffville/i;       // matched against route_long_name

// direction_id 0 = inbound (toward Union), 1 = outbound in Metrolinx GTFS
const DIR_LABELS = {
  '0': { key: 'inbound',  direction: 'toward Union Station' },
  '1': { key: 'outbound', direction: 'toward Stouffville'   }
};

// --- CSV parser (no deps) ---
function parseCSV(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = splitCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
    return obj;
  });
}

function splitCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { result.push(cur); cur = ''; continue; }
    cur += c;
  }
  result.push(cur);
  return result;
}

// --- Download ---
function download(url) {
  return new Promise((resolve, reject) => {
    console.log('Downloading GTFS from Metrolinx…');
    const chunks = [];
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return download(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// --- Time helpers ---
function parseMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function sortTimes(arr) {
  return arr.sort((a, b) => parseMinutes(a) - parseMinutes(b));
}

function stripSeconds(t) {
  return t.split(':').slice(0, 2).join(':');
}

// --- Main ---
async function run() {
  const buf = await download(GTFS_URL);
  console.log(`Downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

  const zip = new AdmZip(buf);

  function getText(name) {
    const entry = zip.getEntry(name);
    if (!entry) throw new Error(`Missing ${name} in GTFS zip`);
    return entry.getData().toString('utf8');
  }

  console.log('Parsing GTFS files…');

  // 1. Find Agincourt stop_id(s)
  const stops = parseCSV(getText('stops.txt'));
  const agiStopIds = new Set(
    stops.filter(s => STOP_MATCH.test(s.stop_name)).map(s => s.stop_id)
  );
  if (agiStopIds.size === 0) throw new Error('Agincourt stop not found in stops.txt');
  console.log(`Agincourt stop IDs: ${[...agiStopIds].join(', ')}`);

  // 2. Find Stouffville route_id
  const routes = parseCSV(getText('routes.txt'));
  const stRoute = routes.find(r => ROUTE_MATCH.test(r.route_long_name) || ROUTE_MATCH.test(r.route_short_name));
  if (!stRoute) throw new Error('Stouffville route not found in routes.txt');
  console.log(`Stouffville route_id: ${stRoute.route_id} (${stRoute.route_long_name})`);

  // 3. Find weekday service_ids from calendar.txt
  const calendar = parseCSV(getText('calendar.txt'));
  const weekdayServiceIds = new Set(
    calendar.filter(c => c.monday === '1' && c.tuesday === '1' && c.wednesday === '1').map(c => c.service_id)
  );

  // 4. Get trip_ids for Stouffville, weekdays, by direction
  const trips = parseCSV(getText('trips.txt'));
  const tripDirMap = {}; // trip_id → direction_id
  trips.forEach(t => {
    if (t.route_id === stRoute.route_id && weekdayServiceIds.has(t.service_id)) {
      tripDirMap[t.trip_id] = t.direction_id;
    }
  });
  console.log(`Trips found: ${Object.keys(tripDirMap).length}`);

  // 5. Parse stop_times for Agincourt on matching trips
  const stopTimesText = getText('stop_times.txt');
  const times = { '0': new Set(), '1': new Set() };

  const lines = stopTimesText.replace(/\r/g, '').split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  const tidIdx  = headers.indexOf('trip_id');
  const sidIdx  = headers.indexOf('stop_id');
  const depIdx  = headers.indexOf('departure_time');

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cols = splitCSVLine(lines[i]);
    const tripId = cols[tidIdx]?.trim();
    const stopId = cols[sidIdx]?.trim();
    const dep    = cols[depIdx]?.trim();

    if (!tripId || !stopId || !dep) continue;
    const dir = tripDirMap[tripId];
    if (dir === undefined) continue;
    if (!agiStopIds.has(stopId)) continue;

    times[dir].add(stripSeconds(dep));
  }

  const result = {};
  for (const [dirId, { key, direction }] of Object.entries(DIR_LABELS)) {
    const sorted = sortTimes([...times[dirId]]);
    result[key] = { direction, times: sorted };
    console.log(`  ${key}: ${sorted.length} departures`);
  }

  if (result.inbound.times.length === 0 && result.outbound.times.length === 0) {
    throw new Error('No times found — check direction_id mapping or stop IDs');
  }

  // 6. Patch agincourt.html
  const html = fs.readFileSync(HTML_FILE, 'utf8');
  const newBlock = `const STATIC_TIMES = ${JSON.stringify(result, null, 4)};`;
  const patched = html.replace(/const STATIC_TIMES = \{[\s\S]*?\};/, newBlock);

  if (patched === html) {
    console.warn('Warning: STATIC_TIMES block not found in HTML — no changes made');
  } else {
    fs.writeFileSync(HTML_FILE, patched, 'utf8');
    console.log(`\nagincourt.html updated — ${new Date().toLocaleString()}`);
  }
}

run().catch(err => {
  console.error('\nError:', err.message);
  console.error('\nIf this is a network/CORS error, the GTFS URL may have moved.');
  console.error('Check: https://www.metrolinx.com/en/about-us/open-data');
  process.exit(1);
});
