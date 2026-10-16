'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const STORAGE_KEY = 'cursorDailyCredits.dailySnapshots.v4';
const DEFAULT_WARN_AT_PERCENT = 80;
const USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const LEGACY_URL = 'https://cursor.com/api/usage';
const PLAN_URL = 'https://cursor.com/api/auth/stripe';
const EVENTS_URL = 'https://cursor.com/api/dashboard/get-filtered-usage-events';
const TEAMS_URL = 'https://cursor.com/api/dashboard/teams';
const DEFAULT_NAMESPACE = 'Teaya';
let statusItem;
let panel;
let output;
let contextRef;
let latest = null;
let lastError = '';
let busy = false;
let timer;
let lastExceededNoticeKey = '';

function log(message) {
  if (output) output.appendLine(`[${new Date().toISOString()}] ${message}`);
}
function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function localDateOnly(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
function daysUntilReset(end, now = new Date()) {
  if (!(end instanceof Date) || !Number.isFinite(end.getTime())) return null;
  const diff = Math.round((localDateOnly(end).getTime() - localDateOnly(now).getTime()) / 86400000);
  if (diff > 0) return diff;
  if (now.getTime() < end.getTime()) return 1;
  return 0;
}
function fmtUsed(value) {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 0.05) return `${rounded}%`;
  return `${value.toFixed(1)}%`;
}
function parseDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(Math.abs(value) < 100000000000 ? value * 1000 : value);
  }
  if (typeof value === 'string' && value.trim()) {
    if (/^\d+$/.test(value.trim())) {
      const n = Number(value.trim());
      return new Date(n < 100000000000 ? n * 1000 : n);
    }
    const d = new Date(value);
    if (Number.isFinite(d.getTime())) return d;
  }
  return null;
}
function money(valueInCents) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(valueInCents / 100);
}
function fmtValue(value, kind) {
  if (!Number.isFinite(value)) return '—';
  if (kind === 'usd_cents') return money(value);
  if (kind === 'requests') return `${Math.round(value).toLocaleString()} requests`;
  return `${value.toFixed(1)}%`;
}
function fmtTarget(value, kind) {
  if (kind === 'usd_cents') return money(value);
  if (kind === 'requests') return `${value.toFixed(1)} requests`;
  return `${value.toFixed(2)}%`;
}
function pct(value) { return `${Math.max(0, Math.min(100, value)).toFixed(1)}%`; }
function warningThreshold() { return clamp(Number(vscode.workspace.getConfiguration('cursorDailyCredits').get('warningThresholdPercent', DEFAULT_WARN_AT_PERCENT)), 1, 100); }
function configuredNamespace() {
  const value = String(vscode.workspace.getConfiguration('cursorDailyCredits').get('namespace', DEFAULT_NAMESPACE) || '').trim();
  return value || DEFAULT_NAMESPACE;
}
function refreshIntervalMs() { return clamp(Number(vscode.workspace.getConfiguration('cursorDailyCredits').get('refreshIntervalMinutes', 5)), 1, 60) * 60 * 1000; }
function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function cycleKey(start, end) {
  const s = start && Number.isFinite(start.getTime()) ? start.toISOString() : 'unknown-start';
  const e = end && Number.isFinite(end.getTime()) ? end.toISOString() : 'unknown-end';
  return `${s}|${e}`;
}
function findUserIdInObject(value, seen = new Set()) {
  if (typeof value === 'string') {
    const match = value.match(/user_[A-Za-z0-9_-]{10,}/);
    return match ? match[0] : null;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) { const id = findUserIdInObject(item, seen); if (id) return id; }
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (/^(user_?id|id|did)$/i.test(key) && typeof item === 'string') {
        const id = findUserIdInObject(item, seen);
        if (id) return id;
      }
      const id = findUserIdInObject(item, seen);
      if (id) return id;
    }
  }
  return null;
}
function cursorStoragePaths() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  if (process.platform === 'win32') {
    return [
      path.join(appData, 'Cursor', 'sentry', 'scope_v3.json'),
      path.join(appData, 'Cursor', 'sentry', 'session.json'),
      path.join(appData, 'Cursor', 'User', 'globalStorage', 'storage.json'),
      path.join(appData, 'Cursor', 'storage.json'),
      path.join(appData, 'Cursor', 'User', 'settings.json'),
      path.join(home, '.cursor', 'storage.json'),
    ];
  }
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support', 'Cursor');
    return [path.join(base, 'sentry', 'scope_v3.json'), path.join(base, 'sentry', 'session.json'), path.join(base, 'User', 'globalStorage', 'storage.json'), path.join(base, 'storage.json'), path.join(home, '.cursor', 'storage.json')];
  }
  const base = path.join(home, '.config', 'Cursor');
  return [path.join(base, 'sentry', 'scope_v3.json'), path.join(base, 'sentry', 'session.json'), path.join(base, 'User', 'globalStorage', 'storage.json'), path.join(base, 'storage.json'), path.join(home, '.cursor', 'storage.json')];
}
function getUserId() {
  const paths = cursorStoragePaths();
  for (const file of paths) {
    try {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const id = findUserIdInObject(parsed);
      if (id) { log(`Found signed-in Cursor user ID in ${file}`); return id; }
    } catch (e) { log(`Could not inspect one Cursor metadata file (${path.basename(file)}).`); }
  }
  // Some builds put the identity in another JSON file under Cursor's sentry folder.
  for (const file of paths.filter(p => p.includes(`${path.sep}sentry${path.sep}`))) {
    try {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const candidate = path.join(dir, name);
        try { const id = findUserIdInObject(JSON.parse(fs.readFileSync(candidate, 'utf8'))); if (id) return id; } catch { /* skip malformed metadata */ }
      }
    } catch { /* optional folder */ }
  }
  return null;
}
function runFile(command, args, timeout = 8000) {
  return new Promise((resolve, reject) => execFile(command, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
    if (err) return reject(err);
    resolve((stdout || '').trim());
  }));
}
async function readTokenWithPython(dbPath) {
  const code = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1], timeout=3); c.execute('PRAGMA query_only=ON'); r=c.execute(\"SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken' LIMIT 1\").fetchone(); print(r[0] if r and r[0] else ''); c.close()";
  const commands = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  for (const cmd of commands) {
    try {
      const args = cmd === 'py' ? ['-3', '-c', code, dbPath] : ['-c', code, dbPath];
      const token = await runFile(cmd, args);
      if (token) return token;
    } catch { /* try another Python command */ }
  }
  return null;
}
async function readAccessToken() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const dbPath = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
      : path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(dbPath)) { log('Cursor session database was not found in the usual location.'); return null; }
  // Prefer Node's SQLite module when available (newer Cursor runtimes); fall back to local Python sqlite3.
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1").get();
      let token = row && typeof row.value === 'string' ? row.value : null;
      if (token) { try { const decoded = JSON.parse(token); if (typeof decoded === 'string') token = decoded; } catch { /* token was stored as plain text */ } return token; }
    } finally { db.close(); }
  } catch (e) { log('Built-in SQLite reader is unavailable here; trying local Python SQLite.'); }
  const token = await readTokenWithPython(dbPath);
  return token || null;
}
function requestJson(urlText, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    if (url.protocol !== 'https:' || !['cursor.com', 'api2.cursor.sh'].includes(url.hostname)) {
      reject(new Error('Blocked unexpected usage endpoint.')); return;
    }
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Cursor-Daily-Credits/1.3',
        'Accept': 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', part => { text += part; if (text.length > 2 * 1024 * 1024) req.destroy(new Error('Usage response was unexpectedly large.')); });
      res.on('end', () => {
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) { reject(new Error(`Cursor usage endpoint returned HTTP ${status}.`)); return; }
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error('Cursor returned a response that was not valid JSON.')); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Timed out contacting Cursor usage service.')));
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}
function buildCookie(userId, token) {
  return `WorkosCursorSessionToken=${userId}%3A%3A${token}`;
}
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}
function membershipLabel(plan) {
  if (!plan) return 'Cursor plan';
  if (plan.isTeamMember) return 'Team';
  const tier = String(plan.individualMembershipType || plan.membershipType || '').toLowerCase();
  if (tier.includes('ultra')) return 'Ultra';
  if (tier.includes('pro_plus') || tier.includes('pro+') || tier.includes('proplus')) return 'Pro+';
  if (tier === 'pro') return 'Pro';
  if (tier === 'free' || !tier) return 'Free / unknown';
  return tier.replace(/[_-]/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
}
function normalizeUsage(current, legacy, plan) {
  const usage = current && current.planUsage ? current.planUsage : null;
  const end = parseDate(current && current.billingCycleEnd);
  const start = parseDate(current && current.billingCycleStart);
  if (usage) {
    const autoUsed = finiteNumber(usage.autoPercentUsed);
    const apiUsed = finiteNumber(usage.apiPercentUsed);
    const pools = [];
    if (Number.isFinite(autoUsed) && autoUsed >= 0) {
      pools.push({ id: 'cursor', label: 'Cursor Models', detail: 'Includes Cursor Grok and Composer', used: autoUsed });
    }
    if (Number.isFinite(apiUsed) && apiUsed >= 0) {
      pools.push({ id: 'other', label: 'Other Models', detail: 'Models outside Cursor Models.', used: apiUsed });
    }
    if (pools.length) {
      const primary = pools[0];
      const validStart = start && Number.isFinite(start.getTime()) ? start : null;
      const validEnd = end && Number.isFinite(end.getTime()) ? end : null;
      return {
        model: 'plan_pools',
        kind: 'percent',
        pools,
        total: 100,
        remaining: Math.max(0, 100 - primary.used),
        used: primary.used,
        cycleSpend: primary.used,
        bonus: 0,
        start: validStart,
        end: validEnd,
        plan: membershipLabel(plan),
        displayMessage: null,
        autoPercent: Number.isFinite(autoUsed) ? autoUsed : null,
        apiPercent: Number.isFinite(apiUsed) ? apiUsed : null,
      };
    }
    const limit = finiteNumber(usage.limit);
    const totalSpend = finiteNumber(usage.totalSpend);
    const includedSpendRaw = finiteNumber(usage.includedSpend);
    const bonusSpendRaw = finiteNumber(usage.bonusSpend);
    const explicitRemaining = finiteNumber(usage.remaining);
    // Older payloads used `used`. Current Cursor usage uses includedSpend (cents).
    const explicitUsed = finiteNumber(usage.used);
    const hasLimit = Number.isFinite(limit) && limit > 0;
    let includedSpend = NaN;
    if (Number.isFinite(includedSpendRaw) && includedSpendRaw >= 0) includedSpend = includedSpendRaw;
    else if (hasLimit && Number.isFinite(explicitRemaining) && explicitRemaining >= 0) includedSpend = Math.max(0, limit - explicitRemaining);
    else if (Number.isFinite(explicitUsed) && explicitUsed >= 0) includedSpend = explicitUsed;
    else if (hasLimit && Number.isFinite(totalSpend) && totalSpend >= 0) includedSpend = Math.min(totalSpend, limit);
    let remaining = NaN;
    if (hasLimit && Number.isFinite(explicitRemaining) && explicitRemaining >= 0) remaining = Math.min(explicitRemaining, limit);
    else if (hasLimit && Number.isFinite(includedSpend)) remaining = Math.max(0, limit - includedSpend);
    // totalPercentUsed is not includedSpend/limit. Cursor's "included usage" line is the dollar pool.
    if (hasLimit && Number.isFinite(remaining) && Number.isFinite(includedSpend)) {
      const bonus = Number.isFinite(bonusSpendRaw) && bonusSpendRaw > 0
        ? bonusSpendRaw
        : (Number.isFinite(totalSpend) ? Math.max(0, totalSpend - includedSpend) : 0);
      const cycleSpend = Number.isFinite(totalSpend) && totalSpend >= 0 ? totalSpend : includedSpend + bonus;
      const validStart = start && Number.isFinite(start.getTime()) ? start : null;
      const validEnd = end && Number.isFinite(end.getTime()) ? end : null;
      // Pace and display in percent of the included allowance, matching Cursor's included-usage line.
      const toPercent = cents => cents / limit * 100;
      return {
        model: 'included_usage',
        kind: 'percent',
        total: 100,
        remaining: toPercent(remaining),
        used: toPercent(includedSpend),
        cycleSpend: toPercent(cycleSpend),
        bonus: toPercent(bonus),
        start: validStart,
        end: validEnd,
        plan: membershipLabel(plan),
        displayMessage: current && typeof current.displayMessage === 'string' ? current.displayMessage : null,
        autoPercent: null,
        apiPercent: null,
      };
    }
    const percentFromApi = finiteNumber(usage.totalPercentUsed);
    if (Number.isFinite(percentFromApi) && percentFromApi >= 0 && !hasLimit) {
      const total = 100;
      const used = clamp(percentFromApi, 0, total);
      const validStart = start && Number.isFinite(start.getTime()) ? start : null;
      const validEnd = end && Number.isFinite(end.getTime()) ? end : null;
      return {
        model: 'usage_percentage',
        kind: 'percent',
        total,
        remaining: total - used,
        used,
        cycleSpend: used,
        bonus: 0,
        start: validStart,
        end: validEnd,
        plan: membershipLabel(plan),
        displayMessage: current && typeof current.displayMessage === 'string' ? current.displayMessage : null,
        autoPercent: Number.isFinite(finiteNumber(usage.autoPercentUsed)) ? finiteNumber(usage.autoPercentUsed) : null,
        apiPercent: Number.isFinite(finiteNumber(usage.apiPercentUsed)) ? finiteNumber(usage.apiPercentUsed) : null,
      };
    }
  }
  const gpt4 = legacy && legacy['gpt-4'];
  if (gpt4 && Number(gpt4.maxRequestUsage) > 0 && Number.isFinite(Number(gpt4.numRequests))) {
    const total = Number(gpt4.maxRequestUsage);
    const used = clamp(Number(gpt4.numRequests), 0, total);
    const legacyStart = legacy.startOfMonth ? parseDate(legacy.startOfMonth) : null;
    let legacyEnd = null;
    if (legacyStart && Number.isFinite(legacyStart.getTime())) {
      legacyEnd = new Date(legacyStart.getTime());
      legacyEnd.setUTCMonth(legacyEnd.getUTCMonth() + 1);
    }
    return { model: 'legacy_requests', kind: 'requests', total, remaining: total - used, used, start: legacyStart, end: legacyEnd, plan: membershipLabel(plan), autoPercent: null, apiPercent: null };
  }
  return null;
}
async function fetchCursorData() {
  const userId = getUserId();
  if (!userId) throw new Error('Could not find your signed-in Cursor account. Open Cursor and sign in, then run Refresh Usage.');
  const token = await readAccessToken();
  if (!token) throw new Error('Could not read Cursor’s local session token. Restart Cursor and try again. No token was sent to any service other than Cursor.');
  const cookie = buildCookie(userId, token);
  const [currentResult, legacyResult, planResult] = await Promise.allSettled([
    requestJson(USAGE_URL, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Connect-Protocol-Version': '1' }, body: {} }),
    requestJson(`${LEGACY_URL}?user=${encodeURIComponent(userId)}`, { headers: { 'Cookie': cookie } }),
    requestJson(PLAN_URL, { headers: { 'Cookie': cookie } }),
  ]);
  const current = currentResult.status === 'fulfilled' ? currentResult.value : null;
  const legacy = legacyResult.status === 'fulfilled' ? legacyResult.value : null;
  const plan = planResult.status === 'fulfilled' ? planResult.value : null;
  if (currentResult.status === 'rejected') log(`Current usage endpoint unavailable: ${currentResult.reason && currentResult.reason.message || 'unknown error'}`);
  if (legacyResult.status === 'rejected') log(`Legacy usage endpoint unavailable: ${legacyResult.reason && legacyResult.reason.message || 'unknown error'}`);
  if (planResult.status === 'rejected') log(`Plan metadata endpoint unavailable: ${planResult.reason && planResult.reason.message || 'unknown error'}`);
  const normalized = normalizeUsage(current, legacy, plan);
  if (!normalized) {
    if (currentResult.status === 'rejected' && legacyResult.status === 'rejected') throw new Error('Cursor usage could not be retrieved. The unofficial endpoint may have changed or your session may have expired.');
    throw new Error('Cursor returned data, but no supported usage allowance could be identified for this plan.');
  }
  const team = await resolveNamespace(cookie, plan);
  const history = await loadUsageHistory(cookie, team.teamId, normalized.start, normalized.end);
  return {
    ...normalized,
    history,
    namespace: team.namespace,
    teamId: team.teamId,
    fetchedAt: Date.now(),
    rawPlanStatus: plan && plan.subscriptionStatus ? String(plan.subscriptionStatus) : null,
    cycleId: cycleKey(normalized.start, normalized.end),
  };
}
function teamRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['teams', 'teamMemberships', 'memberships']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}
function teamLabel(team) {
  if (!team || typeof team !== 'object') return '';
  return String(team.name || team.teamName || team.slug || team.namespace || '').trim();
}
function teamNumericId(team) {
  if (!team || typeof team !== 'object') return 0;
  const id = Number(team.id || team.teamId);
  return Number.isFinite(id) && id > 0 ? id : 0;
}
async function resolveNamespace(cookie, plan) {
  const wanted = configuredNamespace();
  let teams = [];
  try {
    const data = await requestJson(TEAMS_URL, { headers: { Cookie: cookie, Origin: 'https://cursor.com', Referer: 'https://cursor.com/dashboard' } });
    teams = teamRecords(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Team list unavailable: ${message}`);
  }
  const match = teams.find(team => teamLabel(team).toLowerCase() === wanted.toLowerCase());
  if (match) {
    const teamId = teamNumericId(match);
    log(`Using namespace ${wanted} (team ${teamId}).`);
    return { namespace: wanted, teamId };
  }
  const fallbackId = plan && Number.isFinite(Number(plan.teamId)) ? Number(plan.teamId) : 0;
  log(`Namespace ${wanted} was not in the team list; usage events use team ${fallbackId}.`);
  return { namespace: wanted, teamId: fallbackId > 0 ? fallbackId : 0 };
}
function eventTimestamp(value) {
  const n = finiteNumber(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n < 100000000000 ? n * 1000 : n);
  return Number.isFinite(date.getTime()) ? date : null;
}
function normalizeEvent(row) {
  if (!row || typeof row !== 'object') return null;
  const when = eventTimestamp(row.timestamp);
  if (!when) return null;
  const tokens = row.tokenUsage && typeof row.tokenUsage === 'object' ? row.tokenUsage : {};
  const tokenCount = ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens']
    .reduce((sum, key) => sum + (Number.isFinite(finiteNumber(tokens[key])) ? finiteNumber(tokens[key]) : 0), 0);
  const requests = finiteNumber(row.requestsCosts);
  const fallbackRequests = finiteNumber(row.numRequests);
  const kindRaw = typeof row.kind === 'string' ? row.kind : '';
  const charged = finiteNumber(row.chargedCents);
  return {
    at: when.getTime(),
    day: todayKey(when),
    model: typeof row.model === 'string' && row.model.trim() ? row.model.trim() : 'Unknown model',
    kind: kindRaw.includes('USAGE_BASED') ? 'On-demand' : kindRaw.includes('ERRORED') ? 'Errored' : kindRaw.includes('ABORTED') ? 'Aborted' : 'Included',
    cents: Number.isFinite(charged) && charged > 0 ? charged : 0,
    tokens: tokenCount,
    requests: Number.isFinite(requests) && requests > 0 ? requests : (Number.isFinite(fallbackRequests) && fallbackRequests > 0 ? fallbackRequests : 1),
  };
}
function emptyBucket() {
  return { cents: 0, tokens: 0, requests: 0 };
}
function addEvent(bucket, event) {
  bucket.cents += event.cents;
  bucket.tokens += event.tokens;
  bucket.requests += event.requests;
}
function cycleLastDay(end, now) {
  if (!(end instanceof Date) || !Number.isFinite(end.getTime())) return localDateOnly(now);
  const last = localDateOnly(end);
  if (end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0 && end.getMilliseconds() === 0) {
    last.setDate(last.getDate() - 1);
  }
  const today = localDateOnly(now);
  return last.getTime() < today.getTime() ? today : last;
}
function summarizeHistory(events, start, end) {
  const counted = events.filter(event => event && event.kind !== 'Errored' && event.kind !== 'Aborted');
  const byDay = new Map();
  const byModel = new Map();
  const todayModels = new Map();
  const today = todayKey();
  for (const event of counted) {
    if (!byDay.has(event.day)) byDay.set(event.day, { day: event.day, ...emptyBucket(), models: new Map() });
    const day = byDay.get(event.day);
    addEvent(day, event);
    day.models.set(event.model, (day.models.get(event.model) || 0) + event.requests);
    if (!byModel.has(event.model)) byModel.set(event.model, { model: event.model, ...emptyBucket() });
    addEvent(byModel.get(event.model), event);
    if (event.day === today) {
      if (!todayModels.has(event.model)) todayModels.set(event.model, { model: event.model, ...emptyBucket() });
      addEvent(todayModels.get(event.model), event);
    }
  }
  const now = new Date();
  const from = start instanceof Date && Number.isFinite(start.getTime()) && start.getTime() < now.getTime()
    ? localDateOnly(start)
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const until = cycleLastDay(end, now);
  const days = [];
  for (let cursor = new Date(from); cursor <= until && days.length < 45; cursor.setDate(cursor.getDate() + 1)) {
    const key = todayKey(cursor);
    const row = byDay.get(key);
    days.push(row ? { day: key, cents: row.cents, tokens: row.tokens, requests: row.requests, models: [...row.models.keys()] } : { day: key, ...emptyBucket(), models: [] });
  }
  const models = [...byModel.values()].sort((a, b) => b.cents - a.cents || b.requests - a.requests || b.tokens - a.tokens);
  const todayUsage = byDay.get(today) || { day: today, ...emptyBucket(), models: new Map() };
  return {
    days,
    models,
    todayModels: [...todayModels.values()].sort((a, b) => b.cents - a.cents || b.requests - a.requests),
    today: { day: today, cents: todayUsage.cents, tokens: todayUsage.tokens, requests: todayUsage.requests },
    eventCount: counted.length,
    measure: days.some(day => day.cents > 0) ? 'cents' : 'requests',
  };
}
async function loadUsageHistory(cookie, teamId, start, end) {
  const startMs = start instanceof Date && Number.isFinite(start.getTime()) ? start.getTime() : Date.now() - 31 * 86400000;
  const cycleEndMs = end instanceof Date && Number.isFinite(end.getTime()) ? end.getTime() : Date.now();
  const endMs = Math.min(cycleEndMs, Date.now());
  const events = [];
  try {
    for (let page = 1; page <= 15; page++) {
      const data = await requestJson(EVENTS_URL, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://cursor.com', Referer: 'https://cursor.com/dashboard' },
        body: { teamId, startDate: String(startMs), endDate: String(endMs), page, pageSize: 100 },
      });
      const rows = data && Array.isArray(data.usageEventsDisplay) ? data.usageEventsDisplay : [];
      for (const row of rows) {
        const event = normalizeEvent(row);
        if (event) events.push(event);
      }
      const total = finiteNumber(data && data.totalUsageEventsCount);
      if (rows.length < 100 || (Number.isFinite(total) && events.length >= total)) break;
    }
    log(`Loaded ${events.length} usage events for the daily history.`);
    return summarizeHistory(events, start, end);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Usage history unavailable: ${message}`);
    return { ...summarizeHistory([], start, end), error: message };
  }
}
function snapshotPools(snapshot) {
  if (Array.isArray(snapshot.pools) && snapshot.pools.length) return snapshot.pools;
  if (Number.isFinite(snapshot.used)) return [{ id: 'included', label: 'Included usage', detail: '', used: snapshot.used }];
  return [];
}
function getDailyState(snapshot) {
  const now = new Date();
  const daysLeft = daysUntilReset(snapshot.end, now);
  const pools = snapshotPools(snapshot);
  if (daysLeft === null || daysLeft < 1 || !pools.length) return { daysLeft: daysLeft || null, tracking: false, pools: [], over: false, warning: false };
  const date = todayKey(now);
  const all = contextRef.globalState.get(STORAGE_KEY, {});
  let changed = false;
  const rows = pools.map(pool => {
    const key = `${snapshot.cycleId}|${date}|${pool.id}`;
    let baseline = all[key];
    const remainingNow = Math.max(0, 100 - pool.used);
    const dailyBudget = remainingNow / daysLeft;
    if (!baseline || baseline.kind !== 'percent') {
      baseline = {
        date,
        startingUsed: pool.used,
        daysAtStart: daysLeft,
        baselineAt: now.getTime(),
        kind: 'percent',
      };
      all[key] = baseline;
      changed = true;
    }
    const meterToday = Math.max(0, pool.used - baseline.startingUsed);
    const eventToday = todayEventPercent(snapshot, pool);
    const usedToday = eventToday === null ? meterToday : eventToday;
    const dailyRemaining = dailyBudget - usedToday;
    const usedPct = dailyBudget > 0 ? usedToday / dailyBudget * 100 : (usedToday > 0 ? 100 : 0);
    const slack = 0.05;
    return {
      ...pool,
      remainingNow,
      usedToday,
      dailyBudget,
      dailyRemaining,
      usedPct,
      baselineAt: baseline.baselineAt,
      over: usedToday > dailyBudget + slack,
      warning: usedPct >= warningThreshold() && usedToday <= dailyBudget + slack,
    };
  });
  if (changed) {
    const keys = Object.keys(all).sort((a, b) => String(all[b].date || '').localeCompare(String(all[a].date || '')));
    for (const k of keys.slice(45)) delete all[k];
    void contextRef.globalState.update(STORAGE_KEY, all);
    log(`Created today's balance snapshot (${date}); the baseline is held locally.`);
  }
  return {
    daysLeft,
    tracking: true,
    pools: rows,
    over: rows.some(row => row.over),
    warning: rows.some(row => row.warning) && !rows.some(row => row.over),
  };
}
function updateStatusBar() {
  if (!statusItem) return;
  if (busy) {
    statusItem.text = '$(sync~spin) Daily Credits: Syncing';
    statusItem.tooltip = 'Reading live usage from your signed-in Cursor account.';
    statusItem.backgroundColor = undefined;
  } else if (!latest) {
    statusItem.text = '$(warning) Daily Credits: Refresh';
    statusItem.tooltip = lastError || 'Click to refresh your Cursor usage.';
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    const state = getDailyState(latest);
    if (!state.tracking) {
      statusItem.text = '$(warning) Daily Credits: No reset date';
      statusItem.tooltip = 'Cursor did not return a billing reset date; daily allowance cannot be calculated.';
      statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      const icon = state.over ? '$(error)' : state.warning ? '$(warning)' : '$(check)';
      const shortName = pool => pool.id === 'cursor' ? 'Cursor' : pool.id === 'other' ? 'Other' : pool.label;
      statusItem.text = `${icon} Today ${state.pools.map(pool => `${shortName(pool)} ${fmtTarget(pool.usedToday, 'percent')}/${fmtTarget(pool.dailyBudget, 'percent')}`).join(' · ')}`;
      statusItem.tooltip = state.pools.map(pool => `${pool.label}: used ${fmtTarget(pool.usedToday, 'percent')} today of ${fmtTarget(pool.dailyBudget, 'percent')} allocated. Cycle ${fmtUsed(pool.used)} used, ${fmtUsed(pool.remainingNow)} left.`).join(' ') + ` ${state.daysLeft} day(s) until reset. Click to open dashboard.`;
      statusItem.backgroundColor = state.over ? new vscode.ThemeColor('statusBarItem.errorBackground') : state.warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      if (state.over) {
        const noticeKey = `${latest.cycleId}|${todayKey()}|over`;
        if (noticeKey !== lastExceededNoticeKey) {
          lastExceededNoticeKey = noticeKey;
          const overPool = state.pools.find(pool => pool.over);
          void vscode.window.showWarningMessage(`Cursor Daily Credits: today's ${overPool ? overPool.label : 'allowance'} is exceeded. Used ${fmtTarget(overPool ? overPool.usedToday : 0, 'percent')} against ${fmtTarget(overPool ? overPool.dailyBudget : 0, 'percent')}.`);
        }
      }
    }
  }
  if (panel) panel.webview.html = dashboardHtml();
}
function shortValue(value, kind) {
  if (kind === 'usd_cents') return money(value);
  if (kind === 'requests') return `${value.toFixed(1)} req`;
  return `${value.toFixed(1)}%`;
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
function fmtTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}
function dayLabel(day) {
  const parts = String(day).split('-');
  return parts.length === 3 ? String(Number(parts[2])) : String(day);
}
function historyAmount(row, measure) {
  return measure === 'cents' ? money(row.cents) : `${Math.round(row.requests)} requests`;
}
function todayEventPercent(snapshot, pool) {
  const history = snapshot && snapshot.history;
  if (!history || !Array.isArray(history.days)) return null;
  const chartPool = (Array.isArray(snapshot.pools) ? snapshot.pools : []).find(row => row.id === 'cursor') || (Array.isArray(snapshot.pools) ? snapshot.pools[0] : null);
  if (chartPool && pool.id !== chartPool.id) return null;
  const measure = history.measure === 'cents' ? 'cents' : 'requests';
  const weight = history.days.reduce((sum, day) => sum + (measure === 'cents' ? day.cents : day.requests), 0);
  if (weight <= 0) return null;
  const today = chartDays(history, pool.used).find(day => day.day === todayKey());
  return today ? today.usedPct : null;
}
function chartDays(history, cycleUsed) {
  const days = history && Array.isArray(history.days) ? history.days : [];
  const measure = history && history.measure === 'cents' ? 'cents' : 'requests';
  const totalWeight = days.reduce((sum, day) => sum + (measure === 'cents' ? day.cents : day.requests), 0);
  const used = Number.isFinite(cycleUsed) ? Math.max(0, cycleUsed) : 0;
  return days.map(day => {
    const weight = measure === 'cents' ? day.cents : day.requests;
    const usedPct = totalWeight > 0 ? used * weight / totalWeight : 0;
    return { ...day, usedPct };
  });
}
function dashboardHtml() {
  const nonce = Array.from({ length: 32 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 62))).join('');
  if (busy) return page(nonce, `<div class="empty"><h2>Syncing Cursor usage…</h2><p>Reading your signed-in plan and live allowance.</p></div>`);
  if (!latest) return page(nonce, `<div class="empty"><h2>Couldn't read Cursor usage</h2><p>${escapeHtml(lastError || 'Run Refresh Usage to try again.')}</p><button data-action="refresh">Refresh usage</button><p class="muted">This extension reads session data locally and sends usage requests only to Cursor's own domains. It does not upload or store your access token.</p></div>`);
  const state = getDailyState(latest);
  if (!state.tracking) return page(nonce, `<div class="hero"><div><h1>Cursor Daily Credits</h1><p>Automatic usage tracking</p></div><button data-action="refresh">Refresh now</button></div><div class="alert warn">Cursor returned usage, but the billing reset date could not be used. A daily allowance cannot be calculated automatically.</div><p>Plan: <b>${escapeHtml(latest.plan)}</b></p><p>Last synced: ${new Date(latest.fetchedAt).toLocaleString()}</p>`);
  const statusClass = state.over ? 'danger' : state.warning ? 'warn' : 'good';
  const overPool = state.pools.find(pool => pool.over);
  const warnPool = state.pools.find(pool => pool.warning);
  const statusText = overPool
    ? `${overPool.label} is over today's target by ${fmtTarget(Math.max(0, overPool.usedToday - overPool.dailyBudget), 'percent')}.`
    : warnPool
      ? `${warnPool.label} has used ${pct(warnPool.usedPct)} of today's target. ${fmtTarget(Math.max(0, warnPool.dailyRemaining), 'percent')} remains today.`
      : `Within today's targets. Each pool's leftover percent is split across ${state.daysLeft} day(s).`;
  const trackingStarted = new Date(state.pools[0].baselineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const resetDate = latest.end ? latest.end.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : 'Unavailable';
  const poolCards = state.pools.map(pool => {
    const todayPct = clamp(pool.usedPct, 0, 100);
    return `<div class="metric"><span>${escapeHtml(pool.label)}</span><strong>${fmtTarget(pool.usedToday, 'percent')} / ${fmtTarget(pool.dailyBudget, 'percent')}</strong><small>Used today / allocated today</small><div class="bar"><i class="${pool.over ? 'badbar' : ''}" style="width:${todayPct}%"></i></div><p class="tiny">${fmtUsed(pool.remainingNow)} left ÷ ${state.daysLeft} days = ${fmtTarget(pool.dailyBudget, 'percent')} allocated. Used today matches today's bar.</p></div>`;
  }).join('');
  const history = latest.history || { days: [], models: [], todayModels: [], today: { cents: 0, tokens: 0, requests: 0 }, measure: 'requests', eventCount: 0 };
  const measure = history.measure === 'cents' ? 'cents' : 'requests';
  const cyclePool = state.pools.find(pool => pool.id === 'cursor') || state.pools[0];
  const cycleUsed = cyclePool ? cyclePool.used : latest.used;
  const plotted = chartDays(history, cycleUsed);
  const todayAllowance = cyclePool ? cyclePool.dailyBudget : 0;
  const percentLeft = cyclePool ? cyclePool.remainingNow : Math.max(0, 100 - cycleUsed);
  const maxScale = Math.max(todayAllowance, ...plotted.map(day => day.usedPct), 0.01);
  const todayKeyNow = todayKey();
  const chart = plotted.map(day => {
    const upcoming = day.day > todayKeyNow;
    const amount = upcoming ? todayAllowance : day.usedPct;
    const height = amount > 0 ? Math.max(4, Math.round(amount / maxScale * 100)) : 0;
    const usedLabel = upcoming ? `${todayAllowance.toFixed(1)}%` : `${day.usedPct.toFixed(1)}%`;
    const modelHint = Array.isArray(day.models) && day.models.length ? ` · ${day.models.join(', ')}` : '';
    const title = upcoming
      ? `${day.day} · daily limit ${fmtTarget(todayAllowance, 'percent')} = ${fmtUsed(percentLeft)} left ÷ ${state.daysLeft} days`
      : `${day.day} · used ${usedLabel} · today's limit is ${fmtTarget(todayAllowance, 'percent')} (${fmtUsed(percentLeft)} left ÷ ${state.daysLeft} days) · ${historyAmount(day, measure)}${modelHint}`;
    return `<div class="col ${day.day === todayKeyNow ? 'today' : ''}${upcoming ? ' upcoming' : ''}" title="${escapeHtml(title)}"><span class="used">${escapeHtml(usedLabel)}</span><div class="grow"><i style="height:${height}%"></i></div><span>${escapeHtml(dayLabel(day.day))}</span></div>`;
  }).join('');
  const modelRows = rows => (rows || []).map(row => `<tr><td>${escapeHtml(row.model)}</td><td class="num">${escapeHtml(String(Math.round(row.requests)))}</td><td class="num">${escapeHtml(fmtTokens(row.tokens))}</td><td class="num">${escapeHtml(money(row.cents))}</td></tr>`).join('');
  const todayModels = history.todayModels || [];
  const cycleModels = history.models || [];
  const historyNote = history.error ? `<p class="tiny">Usage history could not be loaded (${escapeHtml(history.error)}). The daily percent targets above still come from Plan & Usage.</p>` : '';
  return page(nonce, `
  <div class="hero"><div><h1>Plan & Usage</h1><p>Daily allowance, what you used, and the billing-cycle history</p></div><div class="actions"><button data-action="refresh">⟳ Refresh now</button><button class="secondary" data-action="usage">Open Usage & Plans</button></div></div>
  <div class="subhead"><span class="plan">${escapeHtml(latest.namespace || configuredNamespace())}</span><span class="plan">${escapeHtml(latest.plan)}</span><span class="muted">Usage limits reset on ${escapeHtml(resetDate)} (${state.daysLeft} days left)</span><span class="muted">Last synced ${new Date(latest.fetchedAt).toLocaleTimeString()}</span></div>
  <div class="grid">
   ${poolCards}
   <div class="metric"><span>Days left</span><strong>${escapeHtml(String(state.daysLeft))}</strong><small>Reset ${escapeHtml(resetDate)}</small><p class="tiny">The daily limit is whatever percent is still left, split across these days. It is not a fixed 30-day month.</p></div>
  </div>
  <div class="alert ${statusClass}">${escapeHtml(statusText)}</div>
  <h2>Each day this cycle</h2>
  <p class="tiny">Past days show used percent. Today and the days still left each show ${fmtTarget(todayAllowance, 'percent')}, which is ${fmtUsed(percentLeft)} left divided by ${state.daysLeft} days.</p>
  ${historyNote}
  <div class="chart">${chart || '<p class="tiny">No daily history yet.</p>'}</div>
  <h2>Monthly limit</h2>
  <p class="tiny">Each pool's cap for this billing cycle is 100%. The number is what you have used of that monthly limit.</p>
  <div class="grid">
   ${state.pools.map(pool => {
    const monthUsed = clamp(pool.used, 0, 100);
    return `<div class="metric"><span>${escapeHtml(pool.label)}</span><strong>${fmtUsed(pool.used)} / 100%</strong><small>Used this cycle / monthly limit</small><div class="bar"><i class="${monthUsed >= 100 ? 'badbar' : ''}" style="width:${monthUsed}%"></i></div><p class="tiny">${fmtUsed(pool.remainingNow)} left. Resets ${escapeHtml(resetDate)}.</p></div>`;
  }).join('')}
  </div>
  <h2>What you used today</h2>
  ${todayModels.length ? `<table class="usage"><thead><tr><th>Model</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num">Charged</th></tr></thead><tbody>${modelRows(todayModels)}</tbody></table>` : '<p class="tiny">No usage events for today yet.</p>'}
  <h2>What you used this cycle</h2>
  ${cycleModels.length ? `<table class="usage"><thead><tr><th>Model</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num">Charged</th></tr></thead><tbody>${modelRows(cycleModels.slice(0, 20))}</tbody></table>` : '<p class="tiny">No usage events in this billing cycle yet.</p>'}
  <div class="footnote"><b>Daily limit</b> = percent still left ÷ days still left. With 50% left and 20 days left, each day is 2.50%. The split updates from the live meter and the real reset date.</div>
  `);
}
function page(nonce, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><title>Cursor Daily Credits</title><style>
  :root{color-scheme:light dark}body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:1050px;margin:0 auto}.hero{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}h1{font-size:24px;margin:0 0 6px}h2{font-size:18px;margin:0 0 8px}.hero p,.subhead .muted,.muted,.tiny,.footnote{color:var(--vscode-descriptionForeground)}.hero p{margin:0 0 18px}.actions{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit;border:0;border-radius:5px;padding:8px 12px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.subhead{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px}.plan{font-weight:600;padding:4px 9px;border:1px solid var(--vscode-panel-border);border-radius:999px}.muted{font-size:12px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(205px,1fr));gap:12px}.metric{border:1px solid var(--vscode-panel-border);border-radius:10px;padding:15px;background:var(--vscode-sideBar-background);min-width:0}.metric span{display:block;font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:9px}.metric strong{font-size:22px;display:block;overflow-wrap:anywhere}.metric small{display:block;margin:7px 0 10px;color:var(--vscode-descriptionForeground)}.tiny{font-size:11px;line-height:1.4;margin-bottom:0}.bar{height:6px;background:var(--vscode-progressBar-background);opacity:.32;border-radius:99px;overflow:hidden}.bar i{height:100%;display:block;background:var(--vscode-charts-green);opacity:1;border-radius:99px}.bar i.badbar{background:var(--vscode-errorForeground)}.alert{padding:12px 14px;border-radius:7px;margin-top:14px}.good{border:1px solid var(--vscode-testing-iconPassed)}.warn{border:1px solid var(--vscode-editorWarning-foreground)}.danger{border:1px solid var(--vscode-errorForeground)}.footnote{font-size:12px;line-height:1.6;margin-top:22px}h2{margin:22px 0 8px}.chart{display:flex;align-items:flex-end;gap:4px;height:196px;overflow-x:auto;padding:8px 0 0}.col{flex:1 0 28px;min-width:28px;height:100%;display:flex;flex-direction:column;align-items:center}.col .used{font-size:9px;line-height:1.1;margin-bottom:3px;color:var(--vscode-foreground)}.grow{flex:1;width:70%;display:flex;align-items:flex-end}.grow i{display:block;width:100%;background:var(--vscode-charts-blue, var(--vscode-button-background));border-radius:3px 3px 0 0}.col.today .grow i{background:var(--vscode-charts-green, var(--vscode-testing-iconPassed))}.col.upcoming .grow i{background:var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground));opacity:.55}.col span{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:4px}table.usage{width:100%;border-collapse:collapse;margin-top:8px}table.usage th,table.usage td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);font-size:12px}table.usage td.num,table.usage th.num{text-align:right}.empty{padding:45px 20px;max-width:600px;margin:auto;text-align:center}.empty p{line-height:1.6}.empty button{margin-top:10px}
  </style></head><body>${body}<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(b)vscode.postMessage({action:b.dataset.action})});</script></body></html>`;
}
function openDashboard() {
  if (panel) { panel.reveal(vscode.ViewColumn.One); panel.webview.html = dashboardHtml(); return; }
  panel = vscode.window.createWebviewPanel('cursorDailyCredits', 'Cursor Daily Credits', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.onDidReceiveMessage(message => {
    if (message.action === 'refresh') void refreshUsage(true);
    if (message.action === 'usage') void vscode.env.openExternal(vscode.Uri.parse('https://cursor.com/dashboard?tab=usage'));
  });
  panel.onDidDispose(() => { panel = undefined; });
  panel.webview.html = dashboardHtml();
}
async function refreshUsage(manual = false) {
  if (busy) return;
  busy = true; lastError = ''; updateStatusBar();
  try {
    latest = await fetchCursorData();
    lastError = '';
    log(`Usage refreshed. Plan=${latest.plan}; model=${latest.model}; reset=${latest.end ? latest.end.toISOString() : 'unknown'}.`);
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    log(`Refresh failed: ${lastError}`);
    if (manual) void vscode.window.showErrorMessage(`Cursor Daily Credits: ${lastError}`);
  } finally {
    busy = false;
    updateStatusBar();
  }
}
function activate(context) {
  contextRef = context;
  output = vscode.window.createOutputChannel('Cursor Daily Credits');
  context.subscriptions.push(output);
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.command = 'cursorDailyCredits.openDashboard';
  statusItem.show();
  context.subscriptions.push(statusItem);
  context.subscriptions.push(vscode.commands.registerCommand('cursorDailyCredits.openDashboard', openDashboard));
  context.subscriptions.push(vscode.commands.registerCommand('cursorDailyCredits.refreshUsage', () => refreshUsage(true)));
  context.subscriptions.push(vscode.commands.registerCommand('cursorDailyCredits.openUsagePage', () => vscode.env.openExternal(vscode.Uri.parse('https://cursor.com/dashboard?tab=usage'))));
  context.subscriptions.push(vscode.commands.registerCommand('cursorDailyCredits.showLogs', () => output.show()));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('cursorDailyCredits')) { updateStatusBar(); if (timer) clearInterval(timer); timer = setInterval(() => { void refreshUsage(false); }, refreshIntervalMs()); }
  }));
  void vscode.commands.executeCommand('setContext', 'cursorDailyCredits.active', true);
  void refreshUsage(false);
  timer = setInterval(() => { void refreshUsage(false); }, refreshIntervalMs());
  context.subscriptions.push({ dispose: () => { if (timer) clearInterval(timer); } });
  log('Cursor Daily Credits started. No manual data entry is required.');
}
function deactivate() { if (timer) clearInterval(timer); }
module.exports = { activate, deactivate, normalizeUsage, daysUntilReset, summarizeHistory };
