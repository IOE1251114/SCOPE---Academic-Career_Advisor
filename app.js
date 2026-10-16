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
    // If the user is already logged in, redirect them immediately to the database
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

        // Read response safely as text once to avoid body locking errors
        const text = await response.text(); 
        let result;
        
        try {
          result = JSON.parse(text);
        } catch (e) {
          console.error("Server returned non-JSON response:", text);
          throw new Error("Server error: Received an invalid response format.");
        }

        if (!response.ok) {
          throw new Error(result.error || "Authentication failed");
        }

        if (endpoint === "/login") {
          // Save token and jump to database
          localStorage.setItem("scope_token", result.token);
          window.location.href = "college.html";
        } else {
          authError.style.color = "#00E5FF";
          authError.textContent =
            result.message || "Sign up successful! Please Sign In.";
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
    // Enforce Authentication: Kick users back to login if they have no token
    const token = localStorage.getItem("scope_token");
    if (!token) {
      alert("Please sign in to access the database.");
      window.location.href = "login.html";
      return;
    }

    const list = document.getElementById("college-list");
    const levelFilter = document.getElementById("level-filter");
    const collTypeFilter = document.getElementById("coll-type-filter");

    // Dynamic Filter Adjustment: Hide "College Type" if "University" is selected
    levelFilter.addEventListener("change", (e) => {
      if (e.target.value === "university") {
        collTypeFilter.parentElement.style.display = "none";
        collTypeFilter.value = "all";
      } else {
        collTypeFilter.parentElement.style.display = "flex";
      }
    });

    // Search and Render Function
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
      if (collType !== "all" && level !== "university")
        params.append("coll_type", collType);

      list.innerHTML =
        '<p style="color:#00E5FF; text-align:center; grid-column: 1 / -1;">Loading institutions...</p>';

      try {
        // Fetch data using the secure token
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

        if (!response.ok) throw new Error(data.error || "Failed to fetch");

        if (data.length === 0) {
          list.innerHTML =
            '<p style="color:#ccc; text-align:center; grid-column: 1 / -1;">No institutions match your filters.</p>';
          return;
        }

        // Render Results
        list.innerHTML = data
          .map((item) => {
            const isUniversity =
              item.entityType === "University" || !item.College_type;
            const badgeLabel = isUniversity ? "University" : "College";
            const badgeClass = isUniversity ? "badge-univ" : "badge-coll";

            const name =
              item.Name || item.University_name || "Unknown Institution";
            const estYear =
              item.Established_year || item.Establishment_year || "N/A";
            const instType = isUniversity
              ? item.University_Type
              : item.College_type;

            const siteUrl =
              item.Website && item.Website !== "-" ? item.Website : null;
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
                        </div>
                        ${websiteHtml}
                    </div>
                    `;
          })
          .join("");
      } catch (error) {
        console.error("Search error:", error);
        list.innerHTML = `<p style="color:#ff4444; text-align:center; grid-column: 1 / -1;">Error: ${error.message}</p>`;
      }
    };

    applyFiltersBtn.addEventListener("click", fetchFilteredData);

    // Auto-load data immediately when the college database page opens
    fetchFilteredData();
  }
});
