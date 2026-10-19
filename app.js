// app.js

const API_URL = "/api";

// ==========================================
// HELPERS
// ==========================================
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

// Escape database text before putting it into innerHTML
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Case/underscore-insensitive field lookup: getField(row, "Location_Type")
// also finds "location_type", "Location_type", "LocationType", ...
const getField = (item, ...names) => {
  const keys = Object.keys(item);
  for (const name of names) {
    const key = keys.find((k) => norm(k) === norm(name));
    if (key !== undefined && item[key] !== null && item[key] !== "") return item[key];
  }
  return null;
};

// Safety-net filter: if the row has no such field we can't judge it, so keep it
const matches = (item, names, value) => {
  const v = getField(item, ...names);
  return v === null || String(v).toLowerCase().includes(value.toLowerCase());
};

const safeUrl = (u) => {
  const url = String(u).trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null; // blocks javascript:, data:, ...
  return "https://" + url;
};

const websiteHtml = (item) => {
  const raw = getField(item, "Website");
  const url = raw && raw !== "-" ? safeUrl(raw) : null;
  return url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="website-link">Visit Website</a>`
    : `<span class="no-website">No website available</span>`;
};

// PostgREST returns an array for one-to-many joins but a single object for one-to-one
const toArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

const META_KEY = /(^id$|_id$|^id_|code|created|updated)/i;
const examLabel = (obj) => {
  const entries = Object.entries(obj).filter(
    ([k, v]) => !META_KEY.test(k) && v !== null && v !== "" && typeof v !== "object"
  );
  const preferred = entries.find(([k]) => /exam/i.test(k)) || entries[0];
  return preferred ? String(preferred[1]) : null;
};
const examList = (rows) => {
  const labels = [...new Set(toArray(rows).map(examLabel).filter(Boolean))];
  return labels.length ? labels.join(", ") : "Not Specified";
};

// fetch + safe JSON parsing with a useful error message
async function apiRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, options);
  } catch (e) {
    throw new Error("Cannot reach the server. Check your connection or that the backend is running.");
  }
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error(`Non-JSON response from ${path} (HTTP ${response.status}):`, text.slice(0, 300));
    throw new Error(`The API returned an unexpected response (HTTP ${response.status}). The backend may not be deployed correctly.`);
  }
  return { response, data };
}

function handleExpiredSession() {
  localStorage.removeItem("scope_token");
  alert("Your session has expired. Please sign in again.");
  window.location.href = "login.html";
}

// Authenticated GET /api/search. Returns null if the session expired (already redirected).
async function authedSearch(params) {
  const token = localStorage.getItem("scope_token");
  const { response, data } = await apiRequest(`/search?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      handleExpiredSession();
      return null;
    }
    throw new Error(data.error || "Failed to fetch data");
  }
  if (!Array.isArray(data)) throw new Error("Unexpected data format received from server.");
  return data;
}

document.addEventListener("DOMContentLoaded", () => {
  // ==========================================
  // 1. LANDING PAGE LOGIC (index.html)
  // ==========================================
  const navSignInBtn = document.getElementById("nav-signin-btn");
  if (navSignInBtn) {
    navSignInBtn.addEventListener("click", () => {
      window.location.href = "login.html";
    });
  }

  // ==========================================
  // 2. AUTHENTICATION LOGIC (login.html)
  // ==========================================
  const loginBtn = document.getElementById("login-btn");
  const signupBtn = document.getElementById("signup-btn");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const authError = document.getElementById("auth-error");

  if (loginBtn && signupBtn) {
    if (localStorage.getItem("scope_token")) {
      window.location.href = "college.html";
    }

    const authenticate = async (endpoint) => {
      if (!emailInput.value || !passwordInput.value) {
        authError.style.color = "#ff4444";
        authError.textContent = "Please enter both email and password.";
        return;
      }

      try {
        const { response, data } = await apiRequest(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: emailInput.value, password: passwordInput.value }),
        });

        if (!response.ok) throw new Error(data.error || "Authentication failed");

        if (endpoint === "/login") {
          localStorage.setItem("scope_token", data.token);
          window.location.href = "college.html";
        } else {
          authError.style.color = "#00E5FF";
          authError.textContent = data.message || "Sign up successful! Please Sign In.";
        }
      } catch (error) {
        authError.style.color = "#ff4444";
        authError.textContent = error.message;
      }
    };

    loginBtn.addEventListener("click", () => authenticate("/login"));
    signupBtn.addEventListener("click", () => authenticate("/signup"));
  }

  // ==========================================
  // 3. DATABASE & FILTER LOGIC (college.html)
  // ==========================================
  const applyFiltersBtn = document.getElementById("apply-filters-btn");

  if (applyFiltersBtn) {
    if (!localStorage.getItem("scope_token")) {
      alert("Please sign in to access the database.");
      window.location.href = "login.html";
      return;
    }

    const list = document.getElementById("college-list");
    const levelFilter = document.getElementById("level-filter");
    const collTypeFilter = document.getElementById("coll-type-filter");

    levelFilter.addEventListener("change", (e) => {
      if (e.target.value === "university") {
        collTypeFilter.parentElement.style.display = "none";
        collTypeFilter.value = "all";
      } else {
        collTypeFilter.parentElement.style.display = "flex";
      }
    });

    const fetchFilteredData = async () => {
      const level = levelFilter.value;
      const state = document.getElementById("state-filter").value;
      const location = document.getElementById("location-filter").value;
      const univType = document.getElementById("univ-type-filter").value;
      const collType = collTypeFilter.value;

      const params = new URLSearchParams();
      if (level !== "all") params.append("level", level);
      if (state !== "all") params.append("state", state);
      if (location !== "all") params.append("location_type", location);
      if (univType !== "all") params.append("univ_type", univType);
      if (collType !== "all" && level !== "university") params.append("coll_type", collType);

      list.innerHTML = '<p style="color:#00E5FF; text-align:center; grid-column: 1 / -1;">Loading institutions...</p>';

      try {
        let data = await authedSearch(params);
        if (!data) return;

        // Safety-net filtering (server already filters; this only trims anything it couldn't)
        if (univType !== "all") data = data.filter((i) => matches(i, ["University_Type"], univType));
        if (location !== "all") data = data.filter((i) => matches(i, ["Location_Type", "Location"], location));
        if (collType !== "all" && level !== "university") {
          data = data.filter((i) => i.entityType === "University" || matches(i, ["College_Type"], collType));
        }

        if (data.length === 0) {
          list.innerHTML = '<p style="color:#ccc; text-align:center; grid-column: 1 / -1;">No institutions match your filters.</p>';
          return;
        }

        list.innerHTML = data
          .map((item) => {
            const isUniversity = item.entityType === "University";
            const badgeLabel = isUniversity ? "University" : "College";
            const badgeClass = isUniversity ? "badge-univ" : "badge-coll";

            const name = getField(item, "Name", "University_name") || "Unknown Institution";
            const estYear = getField(item, "Establishment_Year", "Established_year") || "N/A";
            const instType = getField(item, isUniversity ? "University_Type" : "College_Type") || "N/A";
            const loc = getField(item, "Location_Type", "Location") || "N/A";
            const state = getField(item, "State") || "N/A";
            const affiliated = !isUniversity ? getField(item, "University_name") : null;

            return `
              <div class="college-card">
                <span class="badge ${badgeClass}">${badgeLabel}</span>
                <h3>${esc(name)}</h3>
                <div class="card-details">
                  ${affiliated ? `<p><strong>Affiliated To:</strong> ${esc(affiliated)}</p>` : ""}
                  <p><strong>Established:</strong> ${esc(estYear)}</p>
                  <p><strong>Type:</strong> ${esc(instType)}</p>
                  <p><strong>Location:</strong> ${esc(loc)}, ${esc(state)}</p>
                </div>
                ${websiteHtml(item)}
              </div>`;
          })
          .join("");
      } catch (error) {
        console.error("Search error:", error);
        list.innerHTML = `<p style="color:#ff4444; text-align:center; grid-column: 1 / -1;">Error: ${esc(error.message)}</p>`;
      }
    };

    applyFiltersBtn.addEventListener("click", fetchFilteredData);
    fetchFilteredData();
  }

  // ==========================================
  // 4. THEME TOGGLE LOGIC
  // ==========================================
  const themeToggleBtn = document.getElementById("theme-toggle");

  if (localStorage.getItem("scope_theme") === "inverted") {
    document.body.classList.add("invert-theme");
  }

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
      document.body.classList.toggle("invert-theme");
      localStorage.setItem("scope_theme", document.body.classList.contains("invert-theme") ? "inverted" : "normal");
    });
  }

  // ==========================================
  // 5. EXAM DATABASE LOGIC (exam.html)
  // ==========================================
  const applyExamFiltersBtn = document.getElementById("apply-exam-filters-btn");

  if (applyExamFiltersBtn) {
    if (!localStorage.getItem("scope_token")) {
      alert("Please sign in to access the database.");
      window.location.href = "login.html";
      return;
    }

    const examListEl = document.getElementById("exam-results-list");
    const examInput = document.getElementById("exam-search-input");

    const fetchExamData = async () => {
      const examName = examInput.value.trim();
      const examCategory = document.getElementById("exam-category-filter").value;
      const instLevel = document.getElementById("exam-inst-level").value;
      const state = document.getElementById("exam-state-filter").value;

      if (!examName) {
        examListEl.innerHTML = '<p style="color:#ff4444; text-align:center; grid-column: 1 / -1;">Please enter an exam name to search.</p>';
        return;
      }

      const params = new URLSearchParams();
      if (instLevel !== "all") params.append("level", instLevel);
      if (state !== "all") params.append("state", state);
      params.append("include_exams", "true"); // server joins the exam tables...
      params.append("exam", examName); //        ...and filters on this term
      params.append("exam_category", examCategory);

      examListEl.innerHTML = '<p style="color:#00E5FF; text-align:center; grid-column: 1 / -1;">Searching for institutions...</p>';

      try {
        const data = await authedSearch(params);
        if (!data) return;

        if (data.length === 0) {
          examListEl.innerHTML = '<p style="color:#ccc; text-align:center; grid-column: 1 / -1;">No institutions found accepting this exam.</p>';
          return;
        }

        examListEl.innerHTML = data
          .map((item) => {
            const isUniv = item.entityType === "University";
            const ugExams = examList(isUniv ? item.university_ug_exams : item.college_ug_exams);
            const pgExams = examList(isUniv ? item.university_pg_exams : item.college_pg_exams);
            const name = getField(item, "Name", "University_name") || "Unknown Institution";

            return `
              <div class="college-card">
                <span class="badge ${isUniv ? "badge-univ" : "badge-coll"}">${isUniv ? "University" : "College"}</span>
                <h3>${esc(name)}</h3>
                <div class="card-details">
                  <p><strong>State:</strong> ${esc(getField(item, "State") || "N/A")}</p>
                  <div style="margin-top: 10px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 5px;">
                    <p style="color: #00E5FF; margin-bottom: 3px;"><strong>UG Exams:</strong> ${esc(ugExams)}</p>
                    <p style="color: #00E5FF;"><strong>PG Exams:</strong> ${esc(pgExams)}</p>
                  </div>
                </div>
                ${websiteHtml(item)}
              </div>`;
          })
          .join("");
      } catch (error) {
        console.error("Exam search error:", error);
        examListEl.innerHTML = `<p style="color:#ff4444; text-align:center; grid-column: 1 / -1;">Error: ${esc(error.message)}</p>`;
      }
    };

    applyExamFiltersBtn.addEventListener("click", fetchExamData);
    examInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") fetchExamData();
    });
  }
});