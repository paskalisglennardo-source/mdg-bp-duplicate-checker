/*
  MDG BP Duplicate Checker - Cloudflare Pages Functions shared library
  Data source remains protected Google Sheet.
  Browser never receives service account credential or raw database dump.
*/

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_TTL_SAFETY_SECONDS = 90;

const DEFAULT_SHEET_ID = '1VepIImbAMSMaDvRo6Vos9nRzxjiVWUYcestTizNJSjo';
const DEFAULT_SIMILARITY_THRESHOLD = 92;
const DEFAULT_MAX_CANDIDATES = 60000;
const DEFAULT_RANGE_CACHE_SECONDS = 300;
const DEFAULT_MAX_BATCH_ROWS = 10000;
const DEFAULT_RATE_LIMIT_PER_MIN = 60;

const memoryCache = new Map();
const rateBucket = new Map();
let tokenCache = { token: null, exp: 0 };

export async function handleCheck(context) {
  try {
    await enforceRateLimit(context.request, context.env);
    await enforceOptionalAccessCode(context.request, context.env);
    const payload = await safeJson(context.request);
    const result = await duplicateCheck(payload, context.env);
    return json(result);
  } catch (err) {
    return json({
      ok: false,
      error: err?.message || 'Unexpected error',
      hint: configHint(err?.message),
      requestId: crypto.randomUUID()
    }, err?.status || 500);
  }
}

export async function handleHealth(context) {
  const cfg = configStatus(context.env);
  let meta = {};
  let sheet_ok = false;
  let sheet_error = '';

  if (cfg.sheet_id_configured && cfg.service_account_configured) {
    try {
      meta = await getMeta(context.env);
      sheet_ok = true;
    } catch (err) {
      sheet_error = err?.message || String(err);
    }
  }

  return json({
    ok: cfg.sheet_id_configured && cfg.service_account_configured && sheet_ok,
    service: 'MDG BP Duplicate Checker API',
    config: cfg,
    sheet_ok,
    sheet_error,
    meta
  }, cfg.sheet_id_configured && cfg.service_account_configured ? 200 : 500);
}

export function handleOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-access-code',
    'access-control-max-age': '86400'
  };
}

export function configStatus(env) {
  return {
    sheet_id_configured: Boolean(getSheetId(env)),
    service_account_configured: Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 || env.GOOGLE_SERVICE_ACCOUNT_JSON || (env.GOOGLE_CLIENT_EMAIL && env.GOOGLE_PRIVATE_KEY)),
    using_default_sheet_id: !Boolean(env.SHEET_ID),
    similarity_threshold: Number(env.SIMILARITY_THRESHOLD || DEFAULT_SIMILARITY_THRESHOLD),
    max_candidates: Number(env.MAX_CANDIDATES || DEFAULT_MAX_CANDIDATES),
    max_batch_rows: Number(env.MAX_BATCH_ROWS || DEFAULT_MAX_BATCH_ROWS),
    range_cache_seconds: Number(env.RANGE_CACHE_SECONDS || DEFAULT_RANGE_CACHE_SECONDS),
    rate_limit_per_min: Number(env.RATE_LIMIT_PER_MIN || DEFAULT_RATE_LIMIT_PER_MIN),
    access_code_enabled: String(env.REQUIRE_API_ACCESS_CODE || '').toLowerCase() === 'true' && Boolean(env.API_ACCESS_CODE),
    same_origin_frontend: true
  };
}

function configHint(message = '') {
  const m = String(message).toLowerCase();
  if (m.includes('service account')) return 'Set GOOGLE_SERVICE_ACCOUNT_JSON_B64 or GOOGLE_SERVICE_ACCOUNT_JSON in Cloudflare Pages > Settings > Variables and Secrets. Share the Google Sheet to the service account client_email.';
  if (m.includes('sheet_id')) return 'Set SHEET_ID in Cloudflare Pages variables or use the included wrangler.toml. Deploy from the repository root.';
  if (m.includes('google sheets api')) return 'Check Google Sheet sharing permission, service account, tab names, and whether the sync already created BP_DATABASE/KTP_INDEX/INDEX_LEN/INDEX_KTP_SHARD/META.';
  return 'Check Cloudflare environment variables, Google Sheet sharing, Google Sheet tab/index readiness, or Cloudflare Access policy.';
}

async function duplicateCheck(payload, env) {
  const started = Date.now();
  const name1 = String(payload?.name_1 || payload?.name1 || '').trim();
  const address = String(payload?.address || '').trim();
  const ktpInput = normalizeDigits(payload?.ktp_number || payload?.ktp || '');
  const queryText = normalizeText(`${name1} ${address}`);
  const queryDigits = normalizeDigits(`${name1} ${address}`);
  const textLen = queryText.length;

  if (!name1 && !address && !ktpInput) {
    throw httpError(400, 'Input minimal Name 1, Address, atau KTP Number.');
  }

  const threshold = Number(env.SIMILARITY_THRESHOLD || DEFAULT_SIMILARITY_THRESHOLD);
  const maxCandidates = Number(env.MAX_CANDIDATES || DEFAULT_MAX_CANDIDATES);
  const batchRows = Number(env.MAX_BATCH_ROWS || DEFAULT_MAX_BATCH_ROWS);

  const meta = await getMeta(env);
  const result = {
    ok: true,
    decision: 'PASS',
    reason: 'No duplicate found above threshold.',
    threshold,
    input: {
      name_1: name1,
      address,
      ktp_masked: maskKtp(ktpInput),
      normalized_length: textLen
    },
    meta,
    exact_ktp_match: null,
    similarity_match: null,
    top_candidates: [],
    stats: {
      scanned_candidates: 0,
      compared_candidates: 0,
      skipped_by_prefilter: 0,
      batches_processed: 0,
      elapsed_ms: 0
    }
  };

  if (ktpInput) {
    const ktpMatch = await findExactKtp(ktpInput, env);
    if (ktpMatch) {
      result.decision = 'FAIL';
      result.reason = 'KTP exact match found in protected database.';
      result.exact_ktp_match = sanitizeBpRow(ktpMatch, 100, { reason: 'KTP Exact Match' });
      result.stats.elapsed_ms = Date.now() - started;
      return result;
    }
  }

  if (!queryText || queryText.length < 3) {
    result.reason = 'KTP not found and text input too short for similarity check.';
    result.stats.elapsed_ms = Date.now() - started;
    return result;
  }

  const lenIndex = await getIndexMap(env, 'INDEX_LEN', 'len');
  const bucketIds = unique([
    lenBucket(Math.max(0, textLen - 5)),
    lenBucket(textLen),
    lenBucket(textLen + 5)
  ]);

  const best = [];
  let found = null;
  let scanned = 0;
  let compared = 0;
  let skipped = 0;
  let batches = 0;

  for (const bucket of bucketIds) {
    const info = lenIndex.get(String(bucket));
    if (!info) continue;

    let rowStart = info.row_start;
    const rowEnd = info.row_end;

    while (rowStart <= rowEnd) {
      const chunkEnd = Math.min(rowStart + batchRows - 1, rowEnd);
      const rows = await getSheetRange(env, `BP_DATABASE!A${rowStart}:G${chunkEnd}`);
      batches += 1;

      for (const row of rows) {
        scanned += 1;
        if (scanned > maxCandidates) break;

        const candidate = bpRowFromSheet(row);
        if (!candidate.norm_text) {
          skipped += 1;
          continue;
        }

        const lenDiff = Math.abs(candidate.text_len - textLen);
        if (lenDiff > 5) {
          skipped += 1;
          continue;
        }

        const quick = quickPrefilter(queryText, queryDigits, candidate.norm_text, candidate.norm_digits);
        if (!quick.pass) {
          skipped += 1;
          continue;
        }

        compared += 1;
        const score = computeSimilarity(queryText, queryDigits, candidate.norm_text, candidate.norm_digits);
        const entry = sanitizeBpRow(candidate, score.combined, {
          levenshtein: score.levenshtein,
          jaccard: score.jaccard,
          numeric_weighted: score.numeric,
          reason: 'Name 1 + Address Similarity'
        });

        pushTop(best, entry, 5);

        if (score.combined >= threshold) {
          found = entry;
          break;
        }
      }

      if (found || scanned > maxCandidates) break;
      rowStart = chunkEnd + 1;
    }

    if (found || scanned > maxCandidates) break;
  }

  result.stats.scanned_candidates = scanned;
  result.stats.compared_candidates = compared;
  result.stats.skipped_by_prefilter = skipped;
  result.stats.batches_processed = batches;
  result.stats.elapsed_ms = Date.now() - started;
  result.top_candidates = best;

  if (found) {
    result.decision = 'FAIL';
    result.reason = `Similarity match found >= ${threshold}.`;
    result.similarity_match = found;
  }

  return result;
}

async function findExactKtp(ktpDigits, env) {
  const ktpShardMap = await getIndexMap(env, 'INDEX_KTP_SHARD', 'ktp');
  const shard = ktpDigits.slice(-2).padStart(2, '0');
  const info = ktpShardMap.get(shard);
  if (!info) return null;

  const rows = await getSheetRange(env, `KTP_INDEX!A${info.row_start}:B${info.row_end}`);
  for (const row of rows) {
    const candidateKtp = normalizeDigits(row[0] || '');
    if (candidateKtp === ktpDigits) {
      const bpDbRow = Number(row[1] || 0);
      if (!bpDbRow) return { bp_id: '', bp_type_id: '', name_1: '', address: '', norm_text: '', norm_digits: '', text_len: 0 };
      const bpRows = await getSheetRange(env, `BP_DATABASE!A${bpDbRow}:G${bpDbRow}`);
      return bpRows?.[0] ? bpRowFromSheet(bpRows[0]) : null;
    }
  }
  return null;
}

export async function getMeta(env) {
  try {
    const rows = await getSheetRange(env, 'META!A2:B50');
    const out = {};
    for (const r of rows) {
      if (r[0]) out[String(r[0])] = r[1] || '';
    }
    return out;
  } catch (err) {
    // META not available should not block a duplicate check, but health will show it.
    return { meta_error: err?.message || String(err) };
  }
}

async function getIndexMap(env, tabName, type) {
  const cacheKey = `index:${tabName}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const rows = await getSheetRange(env, `${tabName}!A2:D10000`);
  const map = new Map();
  for (const r of rows) {
    const key = String(r[0] ?? '').trim();
    if (!key) continue;
    map.set(key, {
      key,
      row_start: Number(r[1] || 0),
      row_end: Number(r[2] || 0),
      count: Number(r[3] || 0),
      type
    });
  }
  setCached(cacheKey, map, Number(env.RANGE_CACHE_SECONDS || DEFAULT_RANGE_CACHE_SECONDS));
  return map;
}

async function getSheetRange(env, rangeA1) {
  const cacheSeconds = Number(env.RANGE_CACHE_SECONDS || DEFAULT_RANGE_CACHE_SECONDS);
  const cacheKey = `range:${rangeA1}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const sheetId = getSheetId(env);
  if (!sheetId) throw httpError(500, 'SHEET_ID is not configured.');

  const token = await getGoogleAccessToken(env);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(rangeA1)}?majorDimension=ROWS`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (!res.ok) {
    const txt = await res.text();
    throw httpError(502, `Google Sheets API error ${res.status}: ${txt.slice(0, 600)}`);
  }
  const data = await res.json();
  const values = data.values || [];
  setCached(cacheKey, values, cacheSeconds);
  return values;
}

function getSheetId(env) {
  return String(env.SHEET_ID || DEFAULT_SHEET_ID || '').trim();
}

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.exp - TOKEN_TTL_SAFETY_SECONDS > now) return tokenCache.token;

  const sa = parseServiceAccount(env);
  const iat = now;
  const exp = now + 3600;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: GOOGLE_SCOPE,
    aud: sa.token_uri || GOOGLE_TOKEN_URL,
    exp,
    iat
  };

  const unsigned = `${base64urlJson(header)}.${base64urlJson(claim)}`;
  const signature = await signRs256(unsigned, sa.private_key);
  const assertion = `${unsigned}.${signature}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  });

  const res = await fetch(sa.token_uri || GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) {
    const txt = await res.text();
    throw httpError(502, `Google OAuth error ${res.status}: ${txt.slice(0, 600)}`);
  }
  const data = await res.json();
  tokenCache = { token: data.access_token, exp: now + Number(data.expires_in || 3600) };
  return tokenCache.token;
}

function parseServiceAccount(env) {
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON_B64) {
    const raw = atob(String(env.GOOGLE_SERVICE_ACCOUNT_JSON_B64).trim());
    return JSON.parse(raw);
  }
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const raw = String(env.GOOGLE_SERVICE_ACCOUNT_JSON).trim();
    return JSON.parse(raw);
  }
  if (env.GOOGLE_CLIENT_EMAIL && env.GOOGLE_PRIVATE_KEY) {
    return {
      client_email: env.GOOGLE_CLIENT_EMAIL,
      private_key: String(env.GOOGLE_PRIVATE_KEY).replace(/\\n/g, '\n'),
      token_uri: GOOGLE_TOKEN_URL
    };
  }
  throw httpError(500, 'Google service account secret is not configured.');
}

async function signRs256(unsigned, privateKeyPem) {
  const keyData = pemToArrayBuffer(privateKeyPem);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return base64urlBytes(new Uint8Array(sig));
}

function pemToArrayBuffer(pem) {
  const b64 = String(pem || '')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bpRowFromSheet(row) {
  const norm = String(row[4] || '');
  const len = Number(row[6] || norm.length || 0);
  return {
    bp_id: String(row[0] || ''),
    bp_type_id: String(row[1] || ''),
    name_1: String(row[2] || ''),
    address: String(row[3] || ''),
    norm_text: norm,
    norm_digits: String(row[5] || ''),
    text_len: len
  };
}

function sanitizeBpRow(row, score, extra = {}) {
  return {
    bp_id: row.bp_id,
    bp_type_id: row.bp_type_id,
    name_1: row.name_1,
    address_preview: preview(row.address, 120),
    score: round2(score),
    ...extra
  };
}

function computeSimilarity(a, aDigits, b, bDigits) {
  const lev = levenshteinSimilarity(a, b);
  const jac = jaccardSimilarity(tokens(a), tokens(b));
  const num = numericWeightedSimilarity(aDigits, bDigits);
  const combined = (lev * 0.5) + (jac * 0.35) + (num * 0.15);
  return { levenshtein: round2(lev), jaccard: round2(jac), numeric: round2(num), combined: round2(combined) };
}

function quickPrefilter(a, aDigits, b, bDigits) {
  const tA = tokens(a);
  const tB = tokens(b);
  const jac = jaccardSimilarity(tA, tB);
  const numeric = numericWeightedSimilarity(aDigits, bDigits);
  const first = firstUsefulToken(tA);
  const prefixHit = first && tB.has(first);

  if (jac >= 28) return { pass: true };
  if (numeric >= 70 && numericDigitsCount(aDigits) >= 3) return { pass: true };
  if (prefixHit && jac >= 18) return { pass: true };
  return { pass: false };
}

function levenshteinSimilarity(a, b) {
  if (a === b) return 100;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) > 5) return 0;

  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  const distance = prev[b.length];
  return Math.max(0, (1 - distance / maxLen) * 100);
}

function jaccardSimilarity(setA, setB) {
  if (!setA.size && !setB.size) return 100;
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union ? (inter / union) * 100 : 0;
}

function numericWeightedSimilarity(aDigits, bDigits) {
  if (!aDigits && !bDigits) return 100;
  if (!aDigits || !bDigits) return 0;
  if (aDigits === bDigits) return 100;
  const aChunks = digitChunks(aDigits);
  const bChunks = digitChunks(bDigits);
  if (!aChunks.length || !bChunks.length) return 0;
  let weighted = 0;
  let total = 0;
  for (const c of aChunks) {
    const w = Math.min(10, Math.max(1, c.length));
    total += w;
    if (bChunks.includes(c)) weighted += w;
    else if (bDigits.includes(c) || c.includes(bDigits)) weighted += w * 0.65;
  }
  return total ? (weighted / total) * 100 : 0;
}

function tokens(s) {
  const out = new Set();
  for (const t of String(s || '').split(' ')) {
    if (t.length >= 2) out.add(t);
  }
  return out;
}

function firstUsefulToken(set) {
  for (const t of set) {
    if (t.length >= 3 && !['jl', 'jalan', 'rt', 'rw', 'no'].includes(t)) return t;
  }
  return '';
}

function digitChunks(digits) {
  return (String(digits || '').match(/\d{2,}/g) || []).slice(0, 8);
}

function numericDigitsCount(d) {
  return d ? d.length : 0;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(pt|cv|tbk|ud|toko|tk|jl|jalan|gg|gang|no|nomor)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function lenBucket(len) {
  return String(Math.floor(Number(len || 0) / 5)).padStart(3, '0');
}

function unique(arr) {
  return Array.from(new Set(arr));
}

function pushTop(arr, entry, max) {
  arr.push(entry);
  arr.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  if (arr.length > max) arr.pop();
}

function preview(s, n) {
  const value = String(s || '');
  return value.length > n ? `${value.slice(0, n)}...` : value;
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function maskKtp(ktp) {
  if (!ktp) return '';
  if (ktp.length <= 6) return '*'.repeat(ktp.length);
  return `${ktp.slice(0, 4)}${'*'.repeat(Math.max(0, ktp.length - 8))}${ktp.slice(-4)}`;
}

function getCached(key) {
  const item = memoryCache.get(key);
  if (!item) return null;
  if (Date.now() > item.exp) {
    memoryCache.delete(key);
    return null;
  }
  return item.value;
}

function setCached(key, value, seconds) {
  memoryCache.set(key, { value, exp: Date.now() + Number(seconds || 0) * 1000 });
}

async function enforceOptionalAccessCode(request, env) {
  // Frontend is same-origin and no longer asks users for an Access Code.
  // Keep API_ACCESS_CODE available only for optional server-to-server hardening.
  // To activate it intentionally, set REQUIRE_API_ACCESS_CODE=true and send x-access-code from a trusted caller.
  const required = String(env.REQUIRE_API_ACCESS_CODE || '').toLowerCase() === 'true';
  if (!required) return;
  const expected = String(env.API_ACCESS_CODE || '').trim();
  if (!expected) return;
  const got = String(request.headers.get('x-access-code') || '').trim();
  if (got !== expected) throw httpError(401, 'Invalid access code.');
}

async function enforceRateLimit(request, env) {
  const limit = Number(env.RATE_LIMIT_PER_MIN || DEFAULT_RATE_LIMIT_PER_MIN);
  if (!limit || limit <= 0) return;
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const key = `${ip}:${Math.floor(Date.now() / 60000)}`;
  const used = (rateBucket.get(key) || 0) + 1;
  rateBucket.set(key, used);

  // Soft cleanup.
  if (rateBucket.size > 5000) {
    const currentMinute = Math.floor(Date.now() / 60000);
    for (const k of rateBucket.keys()) {
      const minute = Number(k.split(':').pop());
      if (Number.isFinite(minute) && currentMinute - minute > 3) rateBucket.delete(k);
    }
  }

  if (used > limit) throw httpError(429, 'Too many requests. Please retry later.');
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch (_err) {
    throw httpError(400, 'Invalid JSON body.');
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function base64urlJson(obj) {
  return base64urlBytes(new TextEncoder().encode(JSON.stringify(obj)));
}

function base64urlBytes(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
