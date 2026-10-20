// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const configOk = Boolean(SUPABASE_URL && SUPABASE_KEY);

// Don't process.exit() here: on Vercel that turns every request (even static
// ones) into an HTML "500" page. Report the problem as JSON instead.
if (!configOk) {
  console.error('❌ ERROR: Missing SUPABASE_URL or SUPABASE_KEY (set them in .env locally, or in Vercel → Settings → Environment Variables).');
}

// IMPORTANT: never keep a logged-in session on a shared client. Serverless
// instances are reused and different requests can land on different instances,
// so queries must carry the *caller's* token explicitly (see clientForToken).
const authOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

// Used only for signUp / signIn / getUser.
const authClient = configOk ? createClient(SUPABASE_URL, SUPABASE_KEY, authOptions) : null;

// A fresh client per request that queries as the logged-in user, so Row Level
// Security policies for the "authenticated" role apply correctly.
const clientForToken = (token) =>
  createClient(SUPABASE_URL, SUPABASE_KEY, {
    ...authOptions,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

const app = express();
app.use(cors());
app.use(express.json());

// Local development only: serve the front-end files explicitly instead of
// express.static('./') which would also expose server.js, package.json, etc.
// (On Vercel the static files are served by the @vercel/static builds.)
if (!process.env.VERCEL) {
  const pages = ['index.html', 'login.html', 'college.html', 'exam.html', 'style.css', 'app.js'];
  pages.forEach((file) => app.get(`/${file}`, (req, res) => res.sendFile(path.join(__dirname, file))));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  app.use('/images', express.static(path.join(__dirname, 'images')));
}

app.use('/api', (req, res, next) => {
  if (!configOk) {
    return res.status(500).json({ error: 'Server misconfigured: SUPABASE_URL / SUPABASE_KEY are not set.' });
  }
  next();
});

// ---------------------------------------------------------------- Auth routes
app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const { data, error } = await authClient.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  res.status(200).json({ message: 'Signup successful! Please check your email for verification.', data });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  res.status(200).json({ token: data.session.access_token, user: data.user });
});

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(403).json({ error: 'Forbidden: Invalid or expired token' });
    }
    req.user = data.user;
    req.token = token;
    next();
  } catch (err) {
    console.error('Token verification failed:', err);
    res.status(500).json({ error: 'Could not verify session' });
  }
};

// ------------------------------------------------------------- Search helpers
const TABLES = {
  University: ['universities', 'University_rows'], // primary, fallback
  College: ['colleges', 'College_rows'],
};

// Exam tables are joined in code (not with PostgREST embedding), so no
// foreign-key relationship has to exist in Supabase.
const EXAM_TABLES = {
  University: { ug: 'university_ug_exams', pg: 'university_pg_exams' },
  College: { ug: 'college_ug_exams', pg: 'college_pg_exams' },
};

const PAGE_SIZE = Number(process.env.PAGE_SIZE) || 60;            // cards per page when browsing
const EXAM_RESULT_CAP = Number(process.env.EXAM_RESULT_CAP) || 300; // max institutions per exam search
const DB_PAGE = 1000;                                             // Supabase's max rows per request
const IN_CHUNK = 100;                                             // codes per .in() request (URL length)

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
// Column names with spaces/hyphens ("College - AISHE_CODE") must be double-quoted in
// query-string filters, otherwise the client strips the spaces and Postgres can't find them.
const qc = (name) => (/^[A-Za-z0-9_]+$/.test(name) ? name : `"${name}"`);
const lit = (v) => String(v).replace(/[\\%_]/g, '\\$&'); // escape LIKE wildcards in user input

// Postgres column names are case-sensitive. Look at a real row to learn the exact names.
const schemaCache = new Map();

async function sampleTable(db, candidates) {
  let lastError = null;
  let emptyTable = null;
  for (const table of candidates) {
    const { data, error } = await db.from(table).select('*').limit(1);
    if (error) { lastError = error; continue; }
    if (!data || data.length === 0) {
      console.warn(`⚠️ Table "${table}" returned 0 rows. If it has data, check its RLS SELECT policy (role: authenticated).`);
      emptyTable = emptyTable || { table, columns: null };
      continue;
    }
    return { table, columns: Object.keys(data[0]) };
  }
  if (emptyTable) return emptyTable;
  throw new Error(`Could not read table ${candidates[0]} (${lastError?.message || 'unknown error'})`);
}

async function resolveTable(db, entityType) {
  if (schemaCache.has(entityType)) return schemaCache.get(entityType);
  const info = await sampleTable(db, TABLES[entityType]);
  if (info.columns) {
    schemaCache.set(entityType, info);
    console.log(`📋 ${entityType} table "${info.table}" columns:`, info.columns.join(' | '));
  }
  return info;
}

// Exam table: first find the AISHE-code column, the other column holds the exam name.
async function resolveExamTable(db, entityType, kind) {
  const name = EXAM_TABLES[entityType][kind];
  const cacheKey = `exam:${name}`;
  if (schemaCache.has(cacheKey)) return schemaCache.get(cacheKey);
  const info = await sampleTable(db, [name]);
  if (!info.columns) {
    throw new Error(`Table "${name}" returned no rows. Check that it has data and an RLS SELECT policy for logged-in users.`);
  }
  const keyCol = findKey(info.columns, entityType);
  const textCol = info.columns.find((c) => c !== keyCol && /exam/i.test(c)) || info.columns.find((c) => c !== keyCol);
  const res = { table: name, keyCol, textCol };
  schemaCache.set(cacheKey, res);
  return res;
}

// "AISHE_Code" (universities) / "College - AISHE_CODE" (colleges). Tolerates renamed columns.
const findKey = (columns, entityType) => {
  const codes = columns.filter((c) => /aishecode$/.test(norm(c)));
  const own = codes.find((c) =>
    entityType === 'University' ? !/^college/.test(norm(c)) : !/^university/.test(norm(c))
  );
  return own || codes[0] || columns[0];
};

const ALIASES = {
  State: ['State', 'State_UT', 'StateName'],
  Location_Type: ['Location_Type', 'Location'],
  University_Type: ['University_Type', 'Type'],
  College_Type: ['College_Type', 'Type'],
};
const resolveColumn = (info, wanted) => {
  if (!info.columns) return wanted;
  for (const name of ALIASES[wanted] || [wanted]) {
    const hit = info.columns.find((c) => norm(c) === norm(name));
    if (hit) return hit;
  }
  return null;
};

// Adds the sidebar filters to a query. Column names come from the real schema.
function applyFilters(q, info, entityType, f) {
  const rules = [
    ['State', f.state, (v) => `%${lit(v)}%`],
    ['Location_Type', f.location_type, (v) => lit(v)],                 // Urban / Rural (case-insensitive equal)
    entityType === 'University'
      ? ['University_Type', f.univ_type, (v) => `${lit(v)}%`]          // "Deemed" matches "Deemed University - ..."
      : ['College_Type', f.coll_type, (v) => `${lit(v)}%`],            // "Affiliated" matches "Affiliated College"
  ];
  for (const [name, value, pattern] of rules) {
    if (!value || value === 'all') continue;
    const col = resolveColumn(info, name);
    if (!col) { console.warn(`⚠️ Column "${name}" not found in "${info.table}"; skipping that filter.`); continue; }
    q = q.ilike(qc(col), pattern(value));
  }
  return q;
}

// Which tables take part. With "both", picking only a University Type (or only a
// College Type) means the user wants just that kind of institution.
function entityTypes(f) {
  let types = [];
  if (f.level !== 'college') types.push('University');
  if (f.level !== 'university') types.push('College');
  if (types.length === 2) {
    const u = f.univ_type && f.univ_type !== 'all';
    const c = f.coll_type && f.coll_type !== 'all';
    if (u && !c) types = ['University'];
    if (c && !u) types = ['College'];
  }
  return types;
}

// Read every page of a query (Supabase returns max 1000 rows per request).
// build(ordered) returns a query; if ordering by an odd column name fails we retry unordered.
async function pagedSelect(build, max = 50000) {
  const rows = [];
  let ordered = true;
  for (let from = 0; from < max; from += DB_PAGE) {
    let { data, error } = await build(ordered).range(from, from + DB_PAGE - 1);
    if (error && ordered) {
      console.warn('⚠️ Ordered query failed, retrying without ORDER BY:', error.message);
      ordered = false;
      ({ data, error } = await build(false).range(from, from + DB_PAGE - 1));
    }
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < DB_PAGE) break;
  }
  return rows;
}

// ---------------------------------------------------- Browse (college.html)
async function browse(db, f, page) {
  const types = entityTypes(f);
  const infos = await Promise.all(types.map((t) => resolveTable(db, t)));

  const counts = await Promise.all(
    types.map(async (t, i) => {
      const q = applyFilters(db.from(infos[i].table).select('*', { count: 'exact', head: true }), infos[i], t, f);
      const { count, error } = await q;
      if (error) throw new Error(`${t} count failed: ${error.message}`);
      return count || 0;
    })
  );
  const total = counts.reduce((a, b) => a + b, 0);

  let offset = (page - 1) * PAGE_SIZE;
  let remaining = PAGE_SIZE;
  const rows = [];

  for (let i = 0; i < types.length && remaining > 0; i++) {
    if (offset >= counts[i]) { offset -= counts[i]; continue; }
    const take = Math.min(remaining, counts[i] - offset);
    const info = infos[i];
    let q = db.from(info.table).select('*');
    q = applyFilters(q, info, types[i], f);
    if (info.columns) q = q.order(qc(findKey(info.columns, types[i])));
    let { data, error } = await q.range(offset, offset + take - 1);
    if (error) {
      console.warn('⚠️ Ordered browse failed, retrying without ORDER BY:', error.message);
      let q2 = applyFilters(db.from(info.table).select('*'), info, types[i], f);
      ({ data, error } = await q2.range(offset, offset + take - 1));
    }
    if (error) throw new Error(`${types[i]} query failed: ${error.message}`);
    rows.push(...(data || []).map((r) => ({ ...r, entityType: types[i] })));
    remaining -= take;
    offset = 0;
  }
  return { rows, total };
}

// ------------------------------------------------------ Exam search (exam.html)
async function matchingCodes(db, entityType, category, term) {
  const kinds = category === 'ug' ? ['ug'] : category === 'pg' ? ['pg'] : ['ug', 'pg'];
  const sets = await Promise.all(
    kinds.map(async (kind) => {
      const ex = await resolveExamTable(db, entityType, kind);
      const rows = await pagedSelect((ord) => {
        const q = db.from(ex.table).select('*').ilike(qc(ex.textCol), `%${lit(term)}%`);
        return ord ? q.order(qc(ex.keyCol)).order(qc(ex.textCol)) : q;
      });
      return rows.map((r) => r[ex.keyCol]);
    })
  );
  return [...new Set(sets.flat())];
}

async function institutionsByCodes(db, entityType, codes, f, limit) {
  const info = await resolveTable(db, entityType);
  if (!info.columns) return { rows: [], truncated: false };
  const keyCol = findKey(info.columns, entityType);
  const groups = chunk(codes, IN_CHUNK);
  const rows = [];
  let i = 0;
  for (; i < groups.length && rows.length < limit; i += 5) {
    const batch = await Promise.all(
      groups.slice(i, i + 5).map(async (g) => {
        let q = db.from(info.table).select('*').in(qc(keyCol), g);
        q = applyFilters(q, info, entityType, f);
        const { data, error } = await q;
        if (error) throw new Error(`${entityType} query failed: ${error.message}`);
        return data || [];
      })
    );
    rows.push(...batch.flat());
  }
  const truncated = rows.length > limit || i < groups.length;
  return { rows: rows.slice(0, limit).map((r) => ({ ...r, entityType })), truncated, keyCol };
}

async function attachExams(db, entityType, items, keyCol) {
  const codes = items.map((it) => it[keyCol]);
  for (const kind of ['ug', 'pg']) {
    const ex = await resolveExamTable(db, entityType, kind);
    const byCode = new Map();
    for (const g of chunk(codes, IN_CHUNK)) {
      const rows = await pagedSelect((ord) => {
        const q = db.from(ex.table).select('*').in(qc(ex.keyCol), g);
        return ord ? q.order(qc(ex.keyCol)).order(qc(ex.textCol)) : q;
      });
      for (const r of rows) {
        if (!byCode.has(r[ex.keyCol])) byCode.set(r[ex.keyCol], []);
        byCode.get(r[ex.keyCol]).push(r[ex.textCol]);
      }
    }
    items.forEach((it) => { it[`${kind}_exams`] = byCode.get(it[keyCol]) || []; });
  }
}

async function searchByExam(db, f, category, term) {
  const types = entityTypes(f);
  let truncated = false;
  const groups = await Promise.all(
    types.map(async (t) => {
      const codes = await matchingCodes(db, t, category, term);
      if (!codes.length) return [];
      const { rows, truncated: tr, keyCol } = await institutionsByCodes(db, t, codes, f, EXAM_RESULT_CAP);
      if (tr) truncated = true;
      await attachExams(db, t, rows, keyCol);
      return rows;
    })
  );
  let rows = groups.flat();
  if (rows.length > EXAM_RESULT_CAP) { rows = rows.slice(0, EXAM_RESULT_CAP); truncated = true; }
  return { rows, truncated };
}

// ---------------------------------------------------------------- Search route
app.get('/api/search', verifyToken, async (req, res) => {
  const { level, state, location_type, univ_type, coll_type, include_exams, exam, exam_category } = req.query;
  const filters = { level, state, location_type, univ_type, coll_type };

  try {
    const db = clientForToken(req.token);

    if (include_exams === 'true') {
      const term = String(exam || '').trim();
      if (!term) return res.json([]);
      const { rows, truncated } = await searchByExam(db, filters, exam_category || 'both', term);
      res.set('X-Truncated', String(truncated));
      res.set('X-Total-Count', String(rows.length));
      return res.json(rows);
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const { rows, total } = await browse(db, filters, page);
    res.set('X-Total-Count', String(total));
    res.set('X-Page', String(page));
    res.set('X-Page-Size', String(PAGE_SIZE));
    res.json(rows);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message || 'Server error processing search' });
  }
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(3000, () => console.log('Scope backend running on http://localhost:3000'));
}

export default app;