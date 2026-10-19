// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ ERROR: Missing SUPABASE_URL or SUPABASE_KEY in .env file.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();
app.use(express.static('./')); 

app.use(cors());
app.use(express.json());

// Sign Up Route
app.post('/api/signup', async (req, res) => {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    res.status(200).json({ message: 'Signup successful! Please check your email for verification.', data });
});

// Login Route
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    res.status(200).json({ token: data.session.access_token, user: data.user });
});

// Middleware Function
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
    }
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
        return res.status(403).json({ error: 'Forbidden: Invalid or expired token' });
    }
    req.user = user;
    next(); 
};

// Search Route (Protected)
app.get('/api/search', verifyToken, async (req, res) => {
    const { level, state, location_type, univ_type, coll_type, include_exams } = req.query;
    let results = [];
    let errorMsg = null;

    const fetchTable = async (primaryTable, fallbackTable, entityType) => {
        const applyFilters = (queryBuilder) => {
            let selectString = '*';
            
            // Relational Join: Fetch nested exam tables if requested by the frontend
            if (include_exams === 'true') {
                if (entityType === 'University') {
                    selectString = '*, university_ug_exams(*), university_pg_exams(*)';
                } else if (entityType === 'College') {
                    selectString = '*, college_ug_exams(*), college_pg_exams(*)';
                }
            }

            let q = queryBuilder.select(selectString).limit(1000);
            
            if (state && state !== 'all') q = q.ilike('State', `%${state}%`);
            if (location_type && location_type !== 'all') q = q.ilike('Location_type', `%${location_type}%`);
            
            if (entityType === 'University' && univ_type && univ_type !== 'all') {
                q = q.ilike('University_Type', `%${univ_type}%`);
            }
            if (entityType === 'College') {
                if (univ_type && univ_type !== 'all') q = q.ilike('University_type', `%${univ_type}%`);
                if (coll_type && coll_type !== 'all') q = q.ilike('College_type', `%${coll_type}%`);
            }
            return q;
        };

        let query = applyFilters(supabase.from(primaryTable));
        let { data, error } = await query;

        // Smart fallback to older table names if the primary ones fail
        if (error) {
            query = applyFilters(supabase.from(fallbackTable));
            const fallbackRes = await query;
            data = fallbackRes.data;
            error = fallbackRes.error;
        }

        if (error) {
            console.error(`Supabase Error on ${entityType}:`, error);
            errorMsg = error.message;
            return [];
        }
        return (data || []).map(item => ({ ...item, entityType }));
    };

    try {
        if (level === 'university') {
            results = await fetchTable('universities', 'University_rows', 'University');
        } else if (level === 'college') {
            results = await fetchTable('colleges', 'College_rows', 'College');
        } else {
            const [univs, colls] = await Promise.all([
                fetchTable('universities', 'University_rows', 'University'),
                fetchTable('colleges', 'College_rows', 'College')
            ]);
            results = [...univs, ...colls];
        }

        if (errorMsg && results.length === 0) return res.status(500).json({ error: errorMsg });
        res.json(results);

    } catch (err) {
        res.status(500).json({ error: 'Server error processing search' });
    }
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(3000, () => console.log('Scope backend running on port 3000'));
}

export default app;
