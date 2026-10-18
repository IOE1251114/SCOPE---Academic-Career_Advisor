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
    const { level, state, univ_type, coll_type } = req.query;
    
    let results = [];
    let errorMsg = null;

    const fetchTable = async (tableName) => {
        // Fast query: Select columns from the main table without heavy multi-table joins causing timeouts
        let query = supabase
            .from(tableName)
            .select('*')
            .limit(1000); // Capped to prevent timeouts and payload overload
        
        if (state && state !== 'all') {
            query = query.ilike('State', `%${state}%`);
        }
        
        if (tableName === 'universities' && univ_type && univ_type !== 'all') {
            query = query.ilike('University_Type', `%${univ_type}%`);
        }
        if (tableName === 'colleges') {
            if (univ_type && univ_type !== 'all') query = query.ilike('University_type', `%${univ_type}%`);
            if (coll_type && coll_type !== 'all') query = query.ilike('College_type', `%${coll_type}%`);
        }
        
        const { data, error } = await query;
        if (error) {
            console.error("Supabase Error:", error);
            errorMsg = error.message;
        }
        return data || [];
    };

    try {
        if (level === 'university') {
            results = await fetchTable('universities');
            results = results.map(u => ({ ...u, entityType: 'University' }));
        } else if (level === 'college') {
            results = await fetchTable('colleges');
            results = results.map(c => ({ ...c, entityType: 'College' }));
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
