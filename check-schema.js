// check-schema.js  — compares your real Supabase tables with the CSV exports.
// Run:  CHECK_EMAIL=you@mail.com CHECK_PASSWORD=yourpass node check-schema.js
// (needs SUPABASE_URL and SUPABASE_KEY in .env, same as the server)
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const EXPECTED = {
  universities:        { rows: 1421,  cols: ['AISHE_Code','Name','State','District','Location_Type','Website','Establishment_Year','University_Type'] },
  colleges:            { rows: 53556, cols: ['College - AISHE_CODE','Name','State','District','Website','Established_year','Location_type','College_type','Management','University - AISHE_CODE','University_name'] },
  university_ug_exams: { rows: 2765,  cols: ['AISHE_Code','UG_Exam'] },
  university_pg_exams: { rows: 3822,  cols: ['AISHE_Code','PG_Exam'] },
  college_ug_exams:    { rows: 72312, cols: ['College - AISHE_CODE','UG_Exam'] },
  college_pg_exams:    { rows: 69028, cols: ['College - AISHE_CODE','PG_Exam'] },
};

const { SUPABASE_URL, SUPABASE_KEY, CHECK_EMAIL, CHECK_PASSWORD } = process.env;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Set SUPABASE_URL and SUPABASE_KEY in .env'); process.exit(1); }

const opts = { auth: { persistSession: false } };
let db = createClient(SUPABASE_URL, SUPABASE_KEY, opts);

if (CHECK_EMAIL && CHECK_PASSWORD) {
  const { data, error } = await db.auth.signInWithPassword({ email: CHECK_EMAIL, password: CHECK_PASSWORD });
  if (error) { console.error('Login failed:', error.message); process.exit(1); }
  db = createClient(SUPABASE_URL, SUPABASE_KEY, { ...opts, global: { headers: { Authorization: `Bearer ${data.session.access_token}` } } });
  console.log('Logged in as', CHECK_EMAIL, '(queries run as the "authenticated" role, like your website)\n');
} else {
  console.log('No CHECK_EMAIL / CHECK_PASSWORD given: queries run as "anon".\n');
}

for (const [table, exp] of Object.entries(EXPECTED)) {
  console.log(`── ${table}`);
  const { count, error: cErr } = await db.from(table).select('*', { count: 'exact', head: true });
  if (cErr) { console.log(`   ✗ cannot read table: ${cErr.message}\n`); continue; }
  console.log(`   rows in Supabase: ${count}   (CSV has ${exp.rows})${count === 0 ? '   ← 0 rows: table empty or RLS has no SELECT policy' : count < exp.rows ? '   ← fewer than CSV' : ''}`);
  const { data } = await db.from(table).select('*').limit(1);
  if (!data?.length) { console.log('   (no sample row, cannot compare columns)\n'); continue; }
  const actual = Object.keys(data[0]);
  console.log(`   columns: ${actual.join(' | ')}`);
  const missing = exp.cols.filter((c) => !actual.includes(c));
  const extra = actual.filter((c) => !exp.cols.includes(c));
  console.log(missing.length || extra.length
    ? `   ✗ differs from CSV → missing: [${missing.join(', ')}]  extra: [${extra.join(', ')}]\n`
    : '   ✓ columns identical to the CSV\n');
}