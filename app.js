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

// Exam names arrive as plain arrays of strings from the server
const examList = (arr) => {
  const labels = [...new Set((arr || []).filter(Boolean))];
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
  data.meta = {
    total: Number(response.headers.get("X-Total-Count")) || data.length,
    page: Number(response.headers.get("X-Page")) || 1,
    pageSize: Number(response.headers.get("X-Page-Size")) || data.length,
    truncated: response.headers.get("X-Truncated") === "true",
  };
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

    const stateFilter = document.getElementById("state-filter");
    const districtFilter = document.getElementById("district-filter");
    const managementFilter = document.getElementById("management-filter");
    const univTypeFilter = document.getElementById("univ-type-filter");
    const nameSearch = document.getElementById("name-search");
    const sortFilter = document.getElementById("sort-filter");

    // College-only filters hide for "Universities only"; university-only filter hides for "Colleges only"
    levelFilter.addEventListener("change", (e) => {
      const lvl = e.target.value;
      const toggle = (el, show) => {
        el.parentElement.style.display = show ? "flex" : "none";
        if (!show) el.value = "all";
      };
      toggle(collTypeFilter, lvl !== "university");
      toggle(managementFilter, lvl !== "university");
      toggle(univTypeFilter, lvl !== "college");
    });

    // District list for the chosen state (static file generated from the database)
    let filterData = null;
    const loadFilterData = async () => {
      if (filterData) return filterData;
      try {
        const r = await fetch("filters.json");
        filterData = r.ok ? await r.json() : { districts: {} };
      } catch (e) {
        filterData = { districts: {} };
      }
      return filterData;
    };

    stateFilter.addEventListener("change", async () => {
      districtFilter.innerHTML = '<option value="all">All Districts</option>';
      if (stateFilter.value === "all") return;
      const fd = await loadFilterData();
      const wanted = stateFilter.value.toLowerCase();
      const found = new Set();
      Object.entries(fd.districts || {}).forEach(([st, ds]) => {
        if (st.toLowerCase().includes(wanted)) ds.forEach((d) => found.add(d));
      });
      [...found]
        .sort((a, b) => a.trim().localeCompare(b.trim()))
        .forEach((d) => {
          const o = document.createElement("option");
          o.value = d;
          o.textContent = d.trim();
          districtFilter.appendChild(o);
        });
    });

    // Pagination controls (created here so no HTML change is needed)
    let page = 1;
    const pager = document.createElement("div");
    pager.style.cssText = "display:flex;justify-content:center;align-items:center;gap:15px;margin:25px 0;font-family:Arial,sans-serif;font-size:13px;";
    list.after(pager);

    const renderPager = (meta) => {
      const pages = Math.max(1, Math.ceil(meta.total / (meta.pageSize || 1)));
      if (pages <= 1) { pager.innerHTML = `<span style="color:#aaa">${meta.total} institution(s)</span>`; return; }
      pager.innerHTML = `
        <button id="prev-page" ${page <= 1 ? "disabled" : ""}>← Previous</button>
        <span style="color:#aaa">Page ${page} of ${pages} · ${meta.total} institutions</span>
        <button id="next-page" ${page >= pages ? "disabled" : ""}>Next →</button>`;
      document.getElementById("prev-page").onclick = () => { page--; fetchFilteredData(); window.scrollTo({ top: 250, behavior: "smooth" }); };
      document.getElementById("next-page").onclick = () => { page++; fetchFilteredData(); window.scrollTo({ top: 250, behavior: "smooth" }); };
    };

    const fetchFilteredData = async () => {
      const level = levelFilter.value;
      const state = stateFilter.value;
      const district = districtFilter.value;
      const location = document.getElementById("location-filter").value;
      const univType = univTypeFilter.value;
      const collType = collTypeFilter.value;
      const management = managementFilter.value;
      const nameQuery = nameSearch.value.trim();

      const params = new URLSearchParams();
      if (level !== "all") params.append("level", level);
      if (state !== "all") params.append("state", state);
      if (district !== "all") params.append("district", district);
      if (management !== "all" && level !== "university") params.append("management", management);
      if (nameQuery) params.append("q", nameQuery);
      params.append("sort", sortFilter.value);
      if (location !== "all") params.append("location_type", location);
      if (univType !== "all") params.append("univ_type", univType);
      if (collType !== "all" && level !== "university") params.append("coll_type", collType);
      params.append("page", page);

      list.innerHTML = '<p style="color:#00E5FF; text-align:center; grid-column: 1 / -1;">Loading institutions...</p>';
      pager.innerHTML = "";

      try {
        const data = await authedSearch(params);
        if (!data) return;

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
            const st = getField(item, "State") || "N/A";
            const district = getField(item, "District");
            const management = !isUniversity ? getField(item, "Management") : null;
            const affiliated = !isUniversity ? getField(item, "University_name") : null;

            return `
              <div class="college-card">
                <span class="badge ${badgeClass}">${badgeLabel}</span>
                <h3>${esc(name)}</h3>
                <div class="card-details">
                  ${affiliated ? `<p><strong>Affiliated To:</strong> ${esc(affiliated)}</p>` : ""}
                  ${management ? `<p><strong>Management:</strong> ${esc(management)}</p>` : ""}
                  <p><strong>Established:</strong> ${esc(estYear)}</p>
                  <p><strong>Type:</strong> ${esc(instType)}</p>
                  <p><strong>Location:</strong> ${esc(loc)}, ${district ? esc(district) + ", " : ""}${esc(st)}</p>
                </div>
                ${websiteHtml(item)}
              </div>`;
          })
          .join("");
        renderPager(data.meta);
      } catch (error) {
        console.error("Search error:", error);
        list.innerHTML = `<p style="color:#ff4444; text-align:center; grid-column: 1 / -1;">Error: ${esc(error.message)}</p>`;
      }
    };

    applyFiltersBtn.addEventListener("click", () => { page = 1; fetchFilteredData(); });
    nameSearch.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { page = 1; fetchFilteredData(); }
    });
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
      const examName = examInput.value; // <select>: value is the search term
      const examCategory = examInput.selectedOptions[0]?.dataset.cat || "both"; // ug / pg comes from the option group
      const instLevel = document.getElementById("exam-inst-level").value;
      const state = document.getElementById("exam-state-filter").value;

      if (!examName) {
        examListEl.innerHTML = '<p style="color:#ff4444; text-align:center; grid-column: 1 / -1;">Please select an exam to search.</p>';
        return;
      }

      const params = new URLSearchParams();
      if (instLevel !== "all") params.append("level", instLevel);
      if (state !== "all") params.append("state", state);
      params.append("include_exams", "true"); // server looks the exam up in the exam tables
      params.append("exam", examName);
      params.append("exam_category", examCategory);

      examListEl.innerHTML = '<p style="color:#00E5FF; text-align:center; grid-column: 1 / -1;">Searching for institutions...</p>';

      try {
        const data = await authedSearch(params);
        if (!data) return;

        if (data.length === 0) {
          examListEl.innerHTML = '<p style="color:#ccc; text-align:center; grid-column: 1 / -1;">No institutions found accepting this exam.</p>';
          return;
        }

        const note = data.meta.truncated
          ? `<p style="color:#ffb300; text-align:center; grid-column: 1 / -1; font-family:Arial,sans-serif; font-size:13px;">Showing the first ${data.length} matches. Pick a state or institution level to narrow the results.</p>`
          : `<p style="color:#aaa; text-align:center; grid-column: 1 / -1; font-family:Arial,sans-serif; font-size:13px;">${data.length} institution(s) found.</p>`;

        examListEl.innerHTML = note + data
          .map((item) => {
            const isUniv = item.entityType === "University";
            const ugExams = examList(item.ug_exams);
            const pgExams = examList(item.pg_exams);
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
    examInput.addEventListener("change", fetchExamData); // search as soon as an exam is picked
  }
});