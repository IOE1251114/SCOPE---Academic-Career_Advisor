// app.js

const API_URL = "/api";

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
        const response = await fetch(`${API_URL}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: emailInput.value,
            password: passwordInput.value,
          }),
        });

        const text = await response.text(); 
        let result;
        
        try {
          result = JSON.parse(text);
        } catch (e) {
          console.error("Server returned non-JSON response:", text);
          throw new Error("Server error: Received an invalid response format.");
        }

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            localStorage.removeItem("scope_token"); 
            alert("Your session has expired. Please sign in again.");
            window.location.href = "login.html"; 
            return;
          }
          throw new Error(result.error || "Authentication failed");
        }

        if (endpoint === "/login") {
          localStorage.setItem("scope_token", result.token);
          window.location.href = "college.html";
        } else {
          authError.style.color = "#00E5FF";
          authError.textContent = result.message || "Sign up successful! Please Sign In.";
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
    const token = localStorage.getItem("scope_token");
    if (!token) {
      alert("Please sign in to access the database.");
      window.location.href = "login.html";
      return;
    }

    const list = document.getElementById("college-list");
    const levelFilter = document.getElementById("level-filter");
    const collTypeFilter = document.getElementById("coll-type-filter");
    const ugExamFilter = document.getElementById("ug-exam-filter");
    const pgExamFilter = document.getElementById("pg-exam-filter");

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
      const ugExam = ugExamFilter ? ugExamFilter.value.trim() : "";
      const pgExam = pgExamFilter ? pgExamFilter.value.trim() : "";

      const params = new URLSearchParams();
      if (level !== "all") params.append("level", level);
      if (state !== "all") params.append("state", state);
      if (univType !== "all") params.append("univ_type", univType);
      if (collType !== "all" && level !== "university") params.append("coll_type", collType);
      
      // Note: location_type, ug_exam, and pg_exam are deliberately omitted from params 
      // to prevent backend SQL column errors. They are filtered client-side below.

      list.innerHTML = '<p style="color:#00E5FF; text-align:center; grid-column: 1 / -1;">Loading institutions...</p>';

      try {
        const response = await fetch(`${API_URL}/search?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        const text = await response.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          throw new Error("Failed to parse search results from server.");
        }

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            localStorage.removeItem("scope_token"); 
            alert("Your session has expired. Please sign in again.");
            window.location.href = "login.html"; 
            return;
          }
          throw new Error(data.error || "Failed to fetch");
        }

        // --- CLIENT SIDE FILTERING (Bypasses Backend Column Errors) ---
        if (location !== "all") {
            data = data.filter(item => item.Location_type && item.Location_type.toLowerCase().includes(location.toLowerCase()));
        }

        if (ugExam || pgExam) {
            data = data.filter(item => {
                const isUniv = item.entityType === "University" || !item.College_type;
                const ugExams = isUniv ? item.university_ug_exams : item.college_ug_exams;
                const pgExams = isUniv ? item.university_pg_exams : item.college_pg_exams;
                
                const checkExam = (arr, search) => {
                    if (!arr) return false;
                    return arr.some(obj => {
                        const keys = Object.keys(obj).filter(k => !k.includes('CODE') && !k.includes('id'));
                        return keys.some(k => obj[k] && obj[k].toString().toLowerCase().includes(search.toLowerCase()));
                    });
                };

                let pass = true;
                if (ugExam && !checkExam(ugExams, ugExam)) pass = false;
                if (pgExam && !checkExam(pgExams, pgExam)) pass = false;
                return pass;
            });
        }
        // --------------------------------------------------------------

        if (data.length === 0) {
          list.innerHTML = '<p style="color:#ccc; text-align:center; grid-column: 1 / -1;">No institutions match your filters.</p>';
          return;
        }

        const extractExams = (examArray) => {
            if (!examArray || examArray.length === 0) return "Not Specified";
            const names = examArray.map(obj => {
                const keys = Object.keys(obj).filter(k => !k.includes('CODE') && !k.includes('id'));
                return obj[keys[0]]; 
            }).filter(Boolean);
            return names.join(", ") || "Not Specified";
        };

        list.innerHTML = data.map((item) => {
            const isUniversity = item.entityType === "University" || !item.College_type;
            const badgeLabel = isUniversity ? "University" : "College";
            const badgeClass = isUniversity ? "badge-univ" : "badge-coll";

            const name = item.Name || item.University_name || "Unknown Institution";
            const estYear = item.Established_year || item.Establishment_year || "N/A";
            const instType = isUniversity ? item.University_Type : item.College_type;
            
            const ugExamsList = isUniversity ? extractExams(item.university_ug_exams) : extractExams(item.college_ug_exams);
            const pgExamsList = isUniversity ? extractExams(item.university_pg_exams) : extractExams(item.college_pg_exams);

            const siteUrl = item.Website && item.Website !== "-" ? item.Website : null;
            const websiteHtml = siteUrl
              ? `<a href="${siteUrl.startsWith("http") ? siteUrl : "https://" + siteUrl}" target="_blank" class="website-link">Visit Website</a>`
              : `<span class="no-website">No website available</span>`;

            return `
                    <div class="college-card">
                        <span class="badge ${badgeClass}">${badgeLabel}</span>
                        <h3>${name}</h3>
                        <div class="card-details">
                            ${!isUniversity && item.University_name ? `<p><strong>Affiliated To:</strong> ${item.University_name}</p>` : ""}
                            <p><strong>Established:</strong> ${estYear}</p>
                            <p><strong>Type:</strong> ${instType || "N/A"}</p>
                            <p><strong>Location:</strong> ${item.Location_type || "N/A"}, ${item.State || "N/A"}</p>
                            <div style="margin-top: 10px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 5px;">
                                <p style="color: #00E5FF; margin-bottom: 3px;"><strong>UG Exams:</strong> ${ugExamsList}</p>
                                <p style="color: #00E5FF;"><strong>PG Exams:</strong> ${pgExamsList}</p>
                            </div>
                        </div>
                        ${websiteHtml}
                    </div>
                    `;
          }).join("");
      } catch (error) {
        console.error("Search error:", error);
        list.innerHTML = `<p style="color:#ff4444; text-align:center; grid-column: 1 / -1;">Error: ${error.message}</p>`;
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
      
      if (document.body.classList.contains("invert-theme")) {
        localStorage.setItem("scope_theme", "inverted");
      } else {
        localStorage.setItem("scope_theme", "normal");
      }
    });
  }

  // ==========================================
  // 5. EXAM DATABASE LOGIC (exam.html)
  // ==========================================
  const applyExamFiltersBtn = document.getElementById("apply-exam-filters-btn");

  if (applyExamFiltersBtn) {
    const token = localStorage.getItem("scope_token");
    if (!token) {
      alert("Please sign in to access the database.");
      window.location.href = "login.html";
      return;
    }

    const examList = document.getElementById("exam-results-list");

    const fetchExamData = async () => {
      const examName = document.getElementById("exam-search-input").value.trim();
      const examCategory = document.getElementById("exam-category-filter").value;
      const instLevel = document.getElementById("exam-inst-level").value;
      const state = document.getElementById("exam-state-filter").value;

      if (!examName) {
        examList.innerHTML = '<p style="color:#ff4444; text-align:center; grid-column: 1 / -1;">Please enter an exam name to search.</p>';
        return;
      }

      const params = new URLSearchParams();
      if (instLevel !== "all") params.append("level", instLevel);
      if (state !== "all") params.append("state", state);
      
      // Note: ug_exam and pg_exam are deliberately omitted from params 
      // to prevent backend SQL column errors. They are filtered client-side below.

      examList.innerHTML = '<p style="color:#00E5FF; text-align:center; grid-column: 1 / -1;">Searching for institutions...</p>';

      try {
        const response = await fetch(`${API_URL}/search?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        let data = await response.json();
        
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            localStorage.removeItem("scope_token"); 
            alert("Your session has expired. Please sign in again.");
            window.location.href = "login.html";
            return;
          }
          throw new Error(data.error || "Failed to fetch");
        }

        // --- CLIENT SIDE FILTERING FOR EXAMS ---
        data = data.filter(item => {
            const isUniv = item.entityType === "University" || !item.College_type;
            const ugExams = isUniv ? item.university_ug_exams : item.college_ug_exams;
            const pgExams = isUniv ? item.university_pg_exams : item.college_pg_exams;
            
            const checkExam = (arr, search) => {
                if (!arr) return false;
                return arr.some(obj => {
                    const keys = Object.keys(obj).filter(k => !k.includes('CODE') && !k.includes('id'));
                    return keys.some(k => obj[k] && obj[k].toString().toLowerCase().includes(search.toLowerCase()));
                });
            };

            if (examCategory === "both") {
                return checkExam(ugExams, examName) || checkExam(pgExams, examName);
            } else if (examCategory === "ug") {
                return checkExam(ugExams, examName);
            } else {
                return checkExam(pgExams, examName);
            }
        });
        // ---------------------------------------

        if (data.length === 0) {
          examList.innerHTML = '<p style="color:#ccc; text-align:center; grid-column: 1 / -1;">No institutions found accepting this exam.</p>';
          return;
        }

        const extractExams = (examArray) => {
            if (!examArray || examArray.length === 0) return "Not Specified";
            return examArray.map(obj => {
                const keys = Object.keys(obj).filter(k => !k.includes('CODE') && !k.includes('id'));
                return obj[keys[0]]; 
            }).filter(Boolean).join(", ") || "Not Specified";
        };

        examList.innerHTML = data.map((item) => {
            const isUniv = item.entityType === "University" || !item.College_type;
            const ugExamsList = extractExams(isUniv ? item.university_ug_exams : item.college_ug_exams);
            const pgExamsList = extractExams(isUniv ? item.university_pg_exams : item.college_pg_exams);
            
            const siteUrl = item.Website && item.Website !== "-" ? item.Website : null;
            const websiteHtml = siteUrl
              ? `<a href="${siteUrl.startsWith("http") ? siteUrl : "https://" + siteUrl}" target="_blank" class="website-link">Visit Website</a>`
              : `<span class="no-website">No website available</span>`;

            return `
                <div class="college-card">
                    <span class="badge ${isUniv ? 'badge-univ' : 'badge-coll'}">${isUniv ? 'University' : 'College'}</span>
                    <h3>${item.Name || item.University_name}</h3>
                    <div class="card-details">
                        <p><strong>State:</strong> ${item.State}</p>
                        <div style="margin-top: 10px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 5px;">
                            <p style="color: #00E5FF; margin-bottom: 3px;"><strong>UG Exams:</strong> ${ugExamsList}</p>
                            <p style="color: #00E5FF;"><strong>PG Exams:</strong> ${pgExamsList}</p>
                        </div>
                    </div>
                    ${websiteHtml}
                </div>
            `;
        }).join("");
      } catch (error) {
        examList.innerHTML = `<p style="color:#ff4444; text-align:center; grid-column: 1 / -1;">Error: ${error.message}</p>`;
      }
    };

    applyExamFiltersBtn.addEventListener("click", fetchExamData);
  }
});
