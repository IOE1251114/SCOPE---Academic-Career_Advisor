// app.js
const authForm = document.getElementById('auth-form');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const authMessage = document.getElementById('auth-message');
const authContainer = document.getElementById('auth-container');
const dashboardContainer = document.getElementById('dashboard-container');
const signupBtn = document.getElementById('signup-btn');
const logoutBtn = document.getElementById('logout-btn');

// Change from 'http://localhost:3000/api' to relative path
const API_URL = '/api'; 


// Handle Login
authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await authenticate('/login');
});

// Handle Signup
signupBtn.addEventListener('click', async () => {
    if (!emailInput.value || !passwordInput.value) {
        authMessage.textContent = "Please enter both email and password to sign up.";
        return;
    }
    await authenticate('/signup');
});

// Authentication Function
async function authenticate(endpoint) {
    try {
        const response = await fetch(`${API_URL}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: emailInput.value,
                password: passwordInput.value
            })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Authentication failed');
        }

        if (endpoint === '/login') {
            localStorage.setItem('scope_token', result.token);
            authMessage.style.color = 'green';
            authMessage.textContent = 'Login successful!';
            showDashboard();
        } else {
            authMessage.style.color = 'green';
            authMessage.textContent = result.message;
        }
    } catch (error) {
        authMessage.style.color = 'red';
        authMessage.textContent = error.message;
    }
}

// Handle UI State
function showDashboard() {
    authContainer.style.display = 'none';
    dashboardContainer.style.display = 'block';
    fetchFilteredData(); 
}

// Handle Logout
logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('scope_token');
    authContainer.style.display = 'block';
    dashboardContainer.style.display = 'none';
    emailInput.value = '';
    passwordInput.value = '';
    authMessage.textContent = '';
});

// Filter UI Logic
const filterLevelDropdown = document.getElementById('filter-level');
const collTypeDropdown = document.getElementById('filter-coll-type');
const collTypeLabel = document.querySelector('label[for="filter-coll-type"]');

filterLevelDropdown.addEventListener('change', (e) => {
    if (e.target.value === 'university') {
        collTypeDropdown.style.display = 'none';
        collTypeLabel.style.display = 'none';
        collTypeDropdown.value = ''; 
    } else {
        collTypeDropdown.style.display = 'block';
        collTypeLabel.style.display = 'block';
    }
});

// Single Event Listener for Data Fetching
document.getElementById('apply-filters-btn').addEventListener('click', fetchFilteredData);

async function fetchFilteredData() {
    const token = localStorage.getItem('scope_token');
    if (!token) return;

    const level = document.getElementById('filter-level').value;
    const state = document.getElementById('filter-state').value;
    const location = document.getElementById('filter-location').value;
    const univType = document.getElementById('filter-univ-type').value;
    const collType = document.getElementById('filter-coll-type').value;

    const params = new URLSearchParams();
    if (level !== 'both') params.append('level', level);
    if (state) params.append('state', state);
    if (location) params.append('location_type', location);
    if (univType) params.append('univ_type', univType);
    if (collType && level !== 'university') params.append('coll_type', collType);

    const loader = document.getElementById('loading-indicator');
    const list = document.getElementById('college-list');
    
    loader.style.display = 'block';
    list.innerHTML = '';

    try {
        const response = await fetch(`${API_URL}/search?${params.toString()}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await response.json();
        loader.style.display = 'none';

        if (!response.ok) throw new Error(data.error || 'Failed to fetch');
        
        if (data.length === 0) {
            list.innerHTML = '<p>No institutions match your filters.</p>';
            return;
        }

        list.innerHTML = data.map(item => {
            const isUniversity = item.entityType === 'University' || !item.College_type;
            const badgeLabel = isUniversity ? 'University' : 'College';
            
            return `
            <div class="college-card">
                <span class="badge ${isUniversity ? 'badge-univ' : 'badge-coll'}">${badgeLabel}</span>
                <h3>${item.Name}</h3>
                <div class="card-details">
                    ${item.University_name ? `<p><strong>Affiliated To:</strong> ${item.University_name}</p>` : ''}
                    <p><strong>Established:</strong> ${item.Established_year || item.Establishment_year || 'N/A'}</p>
                    <p><strong>Type:</strong> ${isUniversity ? item.University_Type : item.College_type}</p>
                    <p><strong>Location:</strong> ${item.Location_type}, ${item.State}</p>
                </div>
                ${item.Website && item.Website !== '-' 
                    ? `<a href="${item.Website.startsWith('http') ? item.Website : 'https://' + item.Website}" target="_blank" class="website-link">Visit Website</a>` 
                    : `<span class="no-website">No website available</span>`
                }
            </div>
            `;
        }).join('');

    } catch (error) {
        console.error('Search error:', error);
        loader.style.display = 'none';
        list.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
    }
}

window.onload = () => {
    if (localStorage.getItem('scope_token')) {
        showDashboard();
    }
};
