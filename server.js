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
app.use(cors());
app.use(express.json());

// Sign Up Route
app.post('/api/signup', async (req, res) => {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signUp({
        email: email,
        password: password,
    });
    
    if (error) return res.status(400).json({ error: error.message });
    res.status(200).json({ message: 'Signup successful! Please check your email for verification.', data });
});

// Login Route
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({
        email: email,
        password: password,
    });
    
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
    const { level, state, location_type, univ_type, coll_type } = req.query;
    
    let results = [];
    let errorMsg = null;

    const fetchTable = async (tableName) => {
        let query = supabase.from(tableName).select('*').limit(100); 
        
        // Using ilike to bypass strict whitespace/casing mismatches in the DB
        if (state) query = query.ilike('State', `%${state}%`);
        if (location_type) query = query.ilike('Location_type', `%${location_type}%`);
        
        if (tableName === 'universities' && univ_type) {
            query = query.ilike('University_Type', `%${univ_type}%`);
        }
        if (tableName === 'colleges') {
            if (univ_type) query = query.ilike('University_type', `%${univ_type}%`);
            if (coll_type) query = query.ilike('College_type', `%${coll_type}%`);
        }
        
        const { data, error } = await query;
        if (error) errorMsg = error.message;
        return data || [];
    };

    try {
        if (level === 'university') {
            results = await fetchTable('universities');
        } else if (level === 'college') {
            results = await fetchTable('colleges');
        } else {
            const [univs, colls] = await Promise.all([
                fetchTable('universities'),
                fetchTable('colleges')
            ]);
            const taggedUnivs = univs.map(u => ({ ...u, entityType: 'University' }));
            const taggedColls = colls.map(c => ({ ...c, entityType: 'College' }));
            results = [...taggedUnivs, ...taggedColls];
        }

        if (errorMsg) return res.status(500).json({ error: errorMsg });
        res.json(results);

    } catch (err) {
        res.status(500).json({ error: 'Server error processing search' });
    }
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(3000, () => console.log('Scope backend running on port 3000'));
}

export default app;