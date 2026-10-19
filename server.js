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

const EXAM_RELATIONS = {
  University: 'university_ug_exams(*), university_pg_exams(*)',
  College: 'college_ug_exams(*), college_pg_exams(*)',
};

const PAGE_SIZE = 1000;                                           // Supabase's max rows per request
const MAX_ROWS = Number(process.env.MAX_ROWS_PER_TABLE) || 1000;  // normal browsing
const EXAM_SCAN_CAP = Number(process.env.EXAM_SCAN_CAP) || 10000; // exam search scans more rows

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const toArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

// Postgres column names are case-sensitive ("Location_Type" != "Location_type").
// Look at a real row to learn the exact names instead of guessing.
const schemaCache = new Map();

async function resolveTable(db, entityType) {
  if (schemaCache.has(entityType)) return schemaCache.get(entityType);

  let lastError = null;
  let emptyTable = null;

  for (const table of TABLES[entityType]) {
    const { data, error } = await db.from(table).select('*').limit(1);
    if (error) { lastError = error; continue; }
    if (!data || data.length === 0) {
      // Empty table OR Row Level Security hiding every row from this user.
      console.warn(`⚠️ Table "${table}" returned 0 rows. If it has data, check its RLS SELECT policy.`);
      emptyTable = emptyTable || { table, columns: null };
      continue;
    }
    const info = { table, columns: Object.keys(data[0]) };
    schemaCache.set(entityType, info);
    return info;
  }
  if (emptyTable) return emptyTable; // not cached, so we retry next time
  throw new Error(`Could not read ${entityType} table (${lastError?.message || 'unknown error'})`);
}

const resolveColumn = (info, wanted) => {
  if (!info.columns) return wanted; // schema unknown, use the name as given
  return info.columns.find((c) => norm(c) === norm(wanted)) || null;
};

async function fetchTable(db, entityType, f, cap) {
  const info = await resolveTable(db, entityType);

  const filters = [
    ['State', f.state],
    ['Location_Type', f.location_type],
    ['University_Type', f.univ_type],
  ];
  if (entityType === 'College') filters.push(['College_Type', f.coll_type]);

  const active = filters
    .filter(([, value]) => value && value !== 'all')
    .map(([name, value]) => ({ column: resolveColumn(info, name), name, value }));

  active.filter((a) => !a.column).forEach((a) =>
    console.warn(`⚠️ Column "${a.name}" not found in "${info.table}"; skipping that filter.`)
  );

  const select = f.includeExams ? `*, ${EXAM_RELATIONS[entityType]}` : '*';
  const rows = [];

  for (let from = 0; from < cap; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, cap) - 1;
    let q = db.from(info.table).select(select).range(from, to);
    if (info.columns && cap > PAGE_SIZE) q = q.order(info.columns[0]); // stable paging
    for (const a of active) if (a.column) q = q.ilike(a.column, `%${a.value}%`);

    const { data, error } = await q;
    if (error) {
      const hint = f.includeExams
        ? ' (exam tables must have a foreign key to this table and be named ' + EXAM_RELATIONS[entityType] + ')'
        : '';
      throw new Error(`${entityType} query failed: ${error.message}${hint}`);
    }
    rows.push(...(data || []));
    if (!data || data.length < to - from + 1) break; // last page
  }

  return rows.map((item) => ({ ...item, entityType }));
}

// Exam rows: ignore id / code / timestamp columns, look at the text columns.
const META_KEY = /(^id$|_id$|^id_|code|created|updated)/i;
const examTexts = (rowsOrObj) =>
  toArray(rowsOrObj).flatMap((o) =>
    Object.entries(o)
      .filter(([k, v]) => !META_KEY.test(k) && v !== null && typeof v !== 'object')
      .map(([, v]) => String(v).toLowerCase())
  );

function acceptsExam(item, category, term) {
  const isUniv = item.entityType === 'University';
  const ug = examTexts(isUniv ? item.university_ug_exams : item.college_ug_exams);
  const pg = examTexts(isUniv ? item.university_pg_exams : item.college_pg_exams);
  const pool = category === 'ug' ? ug : category === 'pg' ? pg : [...ug, ...pg];
  return pool.some((t) => t.includes(term));
}

// ---------------------------------------------------------------- Search route
app.get('/api/search', verifyToken, async (req, res) => {
  const { level, state, location_type, univ_type, coll_type, include_exams, exam, exam_category } = req.query;
  const includeExams = include_exams === 'true';
  const examTerm = String(exam || '').trim().toLowerCase();
  const filters = { state, location_type, univ_type, coll_type, includeExams };
  const cap = includeExams ? EXAM_SCAN_CAP : MAX_ROWS;

  try {
    const db = clientForToken(req.token);
    const jobs = [];
    if (level !== 'college') jobs.push(fetchTable(db, 'University', filters, cap));
    if (level !== 'university') jobs.push(fetchTable(db, 'College', filters, cap));

    let results = (await Promise.all(jobs)).flat();

    // Exam matching happens here so it covers every row, not just the first 1000
    if (includeExams && examTerm) {
      results = results.filter((item) => acceptsExam(item, exam_category || 'both', examTerm));
    }

    res.json(results);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message || 'Server error processing search' });
  }
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(3000, () => console.log('Scope backend running on http://localhost:3000'));
}

export default app;