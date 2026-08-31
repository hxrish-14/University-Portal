/* =========================================================================
   UNIVERSITY PORTAL — app.js
   One file, clearly segmented. Each section owns one concern; nothing
   below mixes unrelated logic into another section's block.
   ========================================================================= */

/* ============================== CONFIG ============================== */

const CONFIG = Object.freeze({
  supabaseUrl: "https://yydcbfrrsicqchgumhjr.supabase.co",
  supabaseAnonKey: "sb_publishable_HIABykMzBRENxXJxlTKATg_4QtyDgIV",

  collegeName: "Global Arts and Science College, Thiruvallur",
  universityName: "Thiruvallur University",
  courseName: "BCA — Bachelor of Computer Applications",

  inactivityTimeoutMs: 10 * 60 * 1000, // exactly 10 minutes
  inactivityWarningMs: 60 * 1000,

  courseSemesterCounts: { BCA: 6, ENGINEERING: 8 },
  defaultCourseCode: "BCA",

  avatarBucket: "avatars",
  maxAvatarSizeBytes: 2 * 1024 * 1024,
  allowedAvatarTypes: ["image/jpeg", "image/png", "image/webp"],

  tables: {
    profiles: "profiles", courses: "courses", subjects: "subjects",
    results: "results", arrearApplications: "arrear_exam_applications",
    feeRecords: "fee_records", portalSettings: "portal_settings"
  },
  roles: { student: "student", staff: "staff" }
});

// Runtime app state — never trusted for authorization, only for what to
// render. Every real permission check happens server-side via RLS.
const APP = { user: null, profile: null, role: null };

/* ================================ AUTH ================================ */

let supabaseClient = null;

function getSupabase() {
  if (supabaseClient) return supabaseClient;
  if (typeof supabase === "undefined" || !supabase.createClient) {
    console.error("Supabase library failed to load.");
    return null;
  }
  supabaseClient = supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
    auth: {
      // sessionStorage, not localStorage — closing the tab/browser must
      // require login again. See SESSION section for the inactivity side.
      storage: window.sessionStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  });
  return supabaseClient;
}

// Student login is a DIRECT TABLE LOOKUP against `profiles` — no
// Supabase Auth user is created or required for students. The register
// number + DOB the student types are matched straight against the
// seeded row. This is intentionally simpler than the staff path below,
// per the current requirement to drop Supabase Auth for students
// entirely. See the "Required Supabase changes" note shipped alongside
// this file for the RLS this depends on (anon SELECT access needed on
// `profiles`/`results`/`fee_records`/`arrear_exam_applications`/
// `subjects`/`courses`/`portal_settings` since there is no auth session
// to scope by) — and the real security trade-off that comes with it.
async function handleStudentLogin(e) {
  e.preventDefault();
  const regno = document.getElementById("studentRegno").value.trim();
  const dob = document.getElementById("studentDob").value;
  const messageEl = document.getElementById("loginMessage");
  const btn = document.getElementById("studentLoginBtn");

  setLoginMessage(messageEl, "", "");
  if (!regno || !dob) {
    setLoginMessage(messageEl, "Please enter your register number and date of birth.", "error");
    return;
  }

  setButtonBusy(btn, true, "Signing in…");
  try {
    const sb = getSupabase();
    if (!sb) throw new AppError("The portal isn't configured correctly. Please try again later.");

    const { data, error } = await sb
      .from(CONFIG.tables.profiles)
      .select("*")
      .eq("register_number", regno)
      .eq("dob", dob)
      .eq("role", CONFIG.roles.student)
      .maybeSingle();

    if (error) throw new AppError("Unable to connect to the server. Please check your internet connection.", error);
    if (!data) throw new AppError("Invalid register number or password.");

    startStudentSession(data);
    await renderStudentShell();
  } catch (err) {
    setLoginMessage(messageEl, err.userMessage || "Invalid register number or password.", "error");
    if (!(err instanceof AppError)) console.error(err);
  } finally {
    setButtonBusy(btn, false, "Log in");
  }
}

async function handleStaffLogin(e) {
  e.preventDefault();
  const email = document.getElementById("staffEmail").value.trim();
  const password = document.getElementById("staffPassword").value;
  const messageEl = document.getElementById("loginMessage");
  const btn = document.getElementById("staffLoginBtn");

  setLoginMessage(messageEl, "", "");
  if (!email || !password) {
    setLoginMessage(messageEl, "Please enter your email and password.", "error");
    return;
  }

  setButtonBusy(btn, true, "Signing in…");
  try {
    const sb = getSupabase();
    if (!sb) throw new AppError("The portal isn't configured correctly. Please try again later.");

    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new AppError("Invalid email or password.", error);
    await resolveSessionAndRoute(data.user);
  } catch (err) {
    setLoginMessage(messageEl, err.userMessage || "Invalid email or password.", "error");
    if (!(err instanceof AppError)) console.error(err);
  } finally {
    setButtonBusy(btn, false, "Log in");
  }
}

function setButtonBusy(btn, busy, label) {
  btn.disabled = busy;
  btn.innerHTML = busy ? `<span class="spinner" aria-hidden="true" style="width:16px;height:16px;border-width:2px;"></span> ${label}` : label;
}

function setLoginMessage(el, text, type) {
  el.textContent = text;
  el.className = type || "";
}

// Handles logout for BOTH session types. sb.auth.signOut() is a no-op
// (and never throws to the caller, since it's wrapped) when the current
// session is a student's — students never had a Supabase Auth session
// to sign out of. sessionStorage.clear() removes the student session
// key AND Supabase's own persisted staff session in one step.
async function handleLogout(message) {
  SessionManager.stop();
  const sb = getSupabase();
  try { if (sb) await sb.auth.signOut(); } catch (err) { console.error("Sign-out error:", err); }
  APP.user = null; APP.profile = null; APP.role = null;
  sessionStorage.clear();
  renderLoginScreen(message || null);
}

// STAFF ONLY: fetches the caller's own profile (RLS-restricted to their
// own row) using the real Supabase Auth user id, and uses its `role`
// column as the only source of truth for what the UI shows — the
// frontend never decides this on its own. Students never reach this
// function; see handleStudentLogin() + startStudentSession() instead.
async function resolveSessionAndRoute(user) {
  const sb = getSupabase();
  APP.user = user;

  const { data: profile, error } = await sb
    .from(CONFIG.tables.profiles)
    .select("*")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (error || !profile) {
    await handleLogout("Your account isn't fully set up yet. Please contact the portal administrator.");
    return;
  }

  APP.profile = profile;
  APP.role = profile.role === CONFIG.roles.staff ? CONFIG.roles.staff : CONFIG.roles.student;

  SessionManager.start(() => handleLogout("Your session expired due to inactivity. Please log in again."));

  if (APP.role === CONFIG.roles.staff) await renderStaffShell();
  else await renderStudentShell();
}

/* =============================== SESSION =============================== */

// One centralized inactivity manager — no page implements its own timer.
const SessionManager = (() => {
  let timeoutId = null;
  let warningId = null;
  let onExpire = null;

  const activityEvents = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "click"];

  function start(expireCallback) {
    onExpire = expireCallback;
    resetTimer();
    activityEvents.forEach((evt) => window.addEventListener(evt, resetTimer, { passive: true }));
  }

  function stop() {
    clearTimeout(timeoutId);
    clearTimeout(warningId);
    activityEvents.forEach((evt) => window.removeEventListener(evt, resetTimer));
  }

  function resetTimer() {
    clearTimeout(timeoutId);
    clearTimeout(warningId);
    warningId = setTimeout(() => showToast("You'll be signed out soon due to inactivity.", "info"),
      CONFIG.inactivityTimeoutMs - CONFIG.inactivityWarningMs);
    timeoutId = setTimeout(() => { if (typeof onExpire === "function") onExpire(); }, CONFIG.inactivityTimeoutMs);
  }

  return { start, stop };
})();

// A student "session" is just the fetched profile row, cached in
// sessionStorage (not localStorage, so closing the tab/browser clears
// it — same guarantee Supabase Auth gives the staff path). This is the
// entire session mechanism for students: no token, no Supabase Auth
// user, just this row plus the inactivity timer above.
const STUDENT_SESSION_KEY = "up_student_session";

function startStudentSession(profile) {
  APP.user = null;
  APP.profile = profile;
  APP.role = CONFIG.roles.student;
  sessionStorage.setItem(STUDENT_SESSION_KEY, JSON.stringify(profile));
  SessionManager.start(() => handleLogout("Your session expired due to inactivity. Please log in again."));
}

function getStoredStudentSession() {
  const raw = sessionStorage.getItem(STUDENT_SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* =============================== ROUTING =============================== */

function renderLoginScreen(message) {
  document.getElementById("authGate").classList.add("hidden");
  document.getElementById("appShell").classList.add("hidden");

  const login = document.getElementById("loginScreen");
  login.classList.remove("hidden");

  // Deliberately no college/university name here — login shows only the
  // portal identity and the two credential forms.
  login.innerHTML = `
    <div class="login-shell">
      <div class="login-blobs"><span></span><span></span><span></span></div>
      <div class="theme-toggle-standalone"><button class="theme-toggle" id="themeToggleLogin" type="button"></button></div>

      <div class="login-card">
        <h1>University Portal</h1>
        <p class="sub">Sign in to continue.</p>

        <div class="login-tabs" role="tablist">
          <button type="button" data-tab="student" class="active" role="tab">Student</button>
          <button type="button" data-tab="staff" role="tab">Staff</button>
        </div>

        <div class="login-form-panel active" data-panel="student">
          <form id="studentLoginForm" novalidate>
            <div class="field">
              <label for="studentRegno">Register Number</label>
              <input type="text" id="studentRegno" placeholder="e.g. 1001" autocomplete="username" required>
            </div>
            <div class="field">
              <label for="studentDob">Date of Birth</label>
              <input type="date" id="studentDob" autocomplete="off" required>
            </div>
            <button type="submit" class="btn btn-primary btn-block" id="studentLoginBtn">Log in</button>
          </form>
        </div>

        <div class="login-form-panel" data-panel="staff">
          <form id="staffLoginForm" novalidate>
            <div class="field">
              <label for="staffEmail">Email</label>
              <input type="email" id="staffEmail" placeholder="staff@exampleedu.com" autocomplete="username" required>
            </div>
            <div class="field">
              <label for="staffPassword">Password</label>
              <input type="password" id="staffPassword" autocomplete="current-password" required>
            </div>
            <button type="submit" class="btn btn-primary btn-block" id="staffLoginBtn">Log in</button>
          </form>
        </div>

        <p id="loginMessage" role="alert"></p>
      </div>
    </div>
  `;

  document.getElementById("studentLoginForm").addEventListener("submit", handleStudentLogin);
  document.getElementById("staffLoginForm").addEventListener("submit", handleStaffLogin);

  login.querySelectorAll("[data-tab]").forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      login.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b === tabBtn));
      login.querySelectorAll("[data-panel]").forEach((p) => p.classList.toggle("active", p.dataset.panel === tabBtn.dataset.tab));
      setLoginMessage(document.getElementById("loginMessage"), "", "");
    });
  });

  const toggle = document.getElementById("themeToggleLogin");
  syncToggleIcon(toggle);
  toggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    applyTheme(current === "dark" ? "light" : "dark");
  });

  if (message) setTimeout(() => showToast(message, "info"), 50);
}

// Mounts the authenticated shell (header nav + footer) for a role, then
// hands off to that role's default view. Nothing renders here without a
// resolved profile/role from AUTH — see resolveSessionAndRoute().
function mountAppShell({ navItems, onNav }) {
  document.getElementById("authGate").classList.add("hidden");
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("appShell").classList.remove("hidden");

  const nav = document.getElementById("appNav");
  nav.innerHTML = `<span class="nav-indicator" id="navIndicator" aria-hidden="true"></span>` +
    navItems.map((item) => `<a href="#" data-view-link="${item.key}"><span class="nav-label">${escapeHtml(item.label)}</span></a>`).join("");

  nav.querySelectorAll("[data-view-link]").forEach((link) => {
    link.addEventListener("click", (e) => { e.preventDefault(); onNav(link.dataset.viewLink); });
  });

  document.getElementById("logoutBtn").onclick = () => handleLogout();
  document.querySelector(".foot-left").textContent = CONFIG.collegeName;
  document.querySelector(".foot-right").textContent = APP.role === CONFIG.roles.staff ? "Staff Portal" : "Student Portal";

  syncToggleIcon(document.getElementById("themeToggle"));
  window.addEventListener("resize", positionNavIndicator);
  window.addEventListener("scroll", () => {
    document.getElementById("appHeader")?.classList.toggle("scrolled", window.scrollY > 8);
  }, { passive: true });
}

function setActiveNav(key) {
  document.querySelectorAll("[data-view-link]").forEach((link) => link.classList.toggle("active", link.dataset.viewLink === key));
  positionNavIndicator();
  window.scrollTo({ top: 0 });
}

function positionNavIndicator() {
  const active = document.querySelector("[data-view-link].active");
  const indicator = document.getElementById("navIndicator");
  if (!active || !indicator) return;
  const parentRect = active.parentElement.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  indicator.style.width = `${rect.width}px`;
  indicator.style.transform = `translateX(${rect.left - parentRect.left}px)`;
}

async function bootstrapAuth() {
  const sb = getSupabase();
  if (!sb) { renderLoginScreen("The portal isn't configured correctly. Please try again later."); return; }

  // Only ever tears down a STAFF session. Students never have a
  // Supabase Auth session, so this event never legitimately fires for
  // them — the role guard is still here defensively so a stray event
  // can never wipe a student session that was just restored below.
  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT" && APP.role === CONFIG.roles.staff) {
      APP.user = null; APP.profile = null; APP.role = null;
      SessionManager.stop();
      renderLoginScreen();
    }
  });

  // 1. Staff: a real Supabase Auth session, if one exists.
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) {
    await resolveSessionAndRoute(session.user);
    return;
  }

  // 2. Student: a session-scoped table lookup result restored from a
  //    prior handleStudentLogin() call in this same browser tab session.
  const storedStudent = getStoredStudentSession();
  if (storedStudent) {
    startStudentSession(storedStudent);
    await renderStudentShell();
    return;
  }

  // 3. Neither — show the login screen.
  renderLoginScreen();
}

/* =============================== STUDENT =============================== */

const StudentState = { courseSemesterCount: CONFIG.courseSemesterCounts[CONFIG.defaultCourseCode] };

async function renderStudentShell() {
  mountAppShell({
    navItems: [
      { key: "dashboard", label: "Dashboard" },
      { key: "results", label: "Result" },
      { key: "fees", label: "Fees" },
      { key: "help", label: "Help" },
      { key: "online", label: "Online" },
      { key: "profile", label: "Profile" }
    ],
    onNav: (key) => showStudentView(key)
  });

  await loadCourseSemesterCount();
  showStudentView("dashboard");
}

async function loadCourseSemesterCount() {
  try {
    const sb = getSupabase();
    const { data } = await sb.from(CONFIG.tables.courses).select("duration_semesters").eq("code", APP.profile.course).maybeSingle();
    StudentState.courseSemesterCount = data?.duration_semesters
      || CONFIG.courseSemesterCounts[APP.profile.course]
      || CONFIG.courseSemesterCounts[CONFIG.defaultCourseCode];
  } catch {
    StudentState.courseSemesterCount = CONFIG.courseSemesterCounts[CONFIG.defaultCourseCode];
  }
}

function showStudentView(key) {
  setActiveNav(key);
  const main = document.getElementById("mainContent");
  if (key === "dashboard") return renderStudentDashboard(main);
  if (key === "results") return renderStudentResults(main);
  if (key === "fees") return renderStudentFees(main);
  if (key === "help") return renderHelpPage(main);
  if (key === "online") return renderOnlinePage(main);
  if (key === "profile") return renderStudentProfile(main);
}

function renderStudentDashboard(main) {
  const p = APP.profile;
  main.innerHTML = `
    <div class="container">
      <div class="page-head reveal in">
        <span class="eyebrow">Overview</span>
        <h1>Welcome, ${escapeHtml(p.name)}</h1>
        <p>${escapeHtml(p.course || "—")} · Batch ${escapeHtml(p.batch || "—")}</p>
      </div>

      <div class="stat-grid">
        <div class="stat-card"><div class="stat-label">Current Semester</div><div class="stat-value">${p.current_semester ?? "—"}</div></div>
        <div class="stat-card"><div class="stat-label">Attendance</div><div class="stat-value">${p.attendance_percentage != null ? p.attendance_percentage + "%" : "—"}</div></div>
        <div class="seal-card stat-card"><div class="stat-label">CGPA</div><div class="stat-value">${p.cgpa != null ? Number(p.cgpa).toFixed(2) : "—"}</div></div>
        <div class="stat-card"><div class="stat-label">Arrears</div><div class="stat-value">${p.arrears ?? 0}</div></div>
        <div class="stat-card"><div class="stat-label">Fees Pending</div><div class="stat-value">${formatCurrency(p.fees_pending)}</div></div>
      </div>

      <div class="section-card">
        <h2>Quick Links</h2>
        <div class="quick-link-grid">
          <button class="quick-link-card" data-goto="results"><div class="stat-label">Results</div>View semester marks & CGPA</button>
          <button class="quick-link-card" data-goto="fees"><div class="stat-label">Fees</div>Check pending balance</button>
          <button class="quick-link-card" data-goto="profile"><div class="stat-label">Profile</div>View & update your details</button>
        </div>
      </div>
    </div>
  `;
  main.querySelectorAll("[data-goto]").forEach((btn) => btn.addEventListener("click", () => showStudentView(btn.dataset.goto)));
}

// ---- Online: a small, honest quick-access hub. No fabricated external
// services are linked — only real portal pages plus a genuine connectivity
// indicator (navigator.onLine is a real browser API, not decoration).
function renderOnlinePage(main) {
  const isOnline = navigator.onLine;
  main.innerHTML = `
    <div class="container">
      <div class="page-head">
        <span class="eyebrow">Online</span>
        <h1>Online</h1>
        <p>Your connection status and quick access to portal services.</p>
      </div>
      <div class="section-card">
        <div class="status-badge-inline">
          <span class="status-dot ${isOnline ? "" : "off"}"></span>
          ${isOnline ? "Connected" : "No connection detected"}
        </div>
      </div>
      <div class="section-card">
        <h2>Quick Access</h2>
        <div class="quick-link-grid">
          <button class="quick-link-card" data-goto="results"><div class="stat-label">Results</div>Semester marks & CGPA</button>
          <button class="quick-link-card" data-goto="fees"><div class="stat-label">Fees</div>Pending balance</button>
          <button class="quick-link-card" data-goto="help"><div class="stat-label">Help</div>Portal information</button>
        </div>
      </div>
    </div>
  `;
  main.querySelectorAll("[data-goto]").forEach((btn) => btn.addEventListener("click", () => showStudentView(btn.dataset.goto)));
}

function renderHelpPage(main) {
  main.innerHTML = `
    <div class="container">
      <div class="page-head"><span class="eyebrow">Help</span><h1>Help</h1><p>Information about University Portal and how to use it.</p></div>

      <div class="section-card">
        <h2>University Portal</h2>
        <p style="color:var(--text-secondary); line-height:1.7;">University Portal lets students view their profile, semester-wise results, attendance, CGPA, arrears, and fees, apply for arrear exams, and lets staff manage student records.</p>
      </div>

      <div class="section-card">
        <h2>Student Services</h2>
        <div class="info-grid">
          ${infoItem("Dashboard", "Your academic summary")}
          ${infoItem("Profile", "Your full personal & academic details, photo")}
          ${infoItem("Results", "Semester-wise marks, SGPA, and CGPA")}
          ${infoItem("Fees", "Fee records and pending balance")}
          ${infoItem("Arrears", "Subjects not yet cleared, with exam application")}
          ${infoItem("Online", "Connection status and quick links")}
        </div>
      </div>

      <div class="section-card">
        <h2>Institution</h2>
        <div class="info-grid">
          ${infoItem("College", CONFIG.collegeName)}
          ${infoItem("University", CONFIG.universityName)}
          ${infoItem("Course", CONFIG.courseName)}
        </div>
      </div>

      <div class="section-card">
        <h2>General Academic Information</h2>
        <p style="color:var(--text-muted); font-size:12.5px; margin-bottom:14px;">General portal guidance only — not an official regulation document. Confirm exact rules with your department office.</p>
        <ul style="color:var(--text-secondary); line-height:1.9; padding-left:20px;">
          <li>Regular attendance is expected each semester; check your Dashboard for your recorded percentage.</li>
          <li>Semester progression generally requires clearing the previous semester's core subjects.</li>
          <li>A subject marked as an arrear can usually be cleared through an arrear examination — apply from the Results page.</li>
          <li>Results are published on the Result Released Date shown against each semester.</li>
          <li>Settle pending fees before the due date shown on the Fees page to avoid late charges.</li>
        </ul>
      </div>
    </div>
  `;
}

/* ================================ STAFF ================================ */

const StaffState = { page: 0, pageSize: 10, search: "", totalCount: 0, rows: [], selectedIds: new Set() };

async function renderStaffShell() {
  mountAppShell({
    navItems: [
      { key: "students", label: "Students" },
      { key: "resultExport", label: "Result Export" },
      { key: "help", label: "Help" }
    ],
    onNav: (key) => showStaffView(key)
  });
  showStaffView("students");
}

function showStaffView(key) {
  setActiveNav(key);
  const main = document.getElementById("mainContent");
  if (key === "students") return renderStaffStudents(main);
  if (key === "resultExport") return renderStaffResultExport(main);
  if (key === "help") return renderHelpPage(main);
}

function renderStaffStudents(main) {
  main.innerHTML = `
    <div class="container">
      <div class="page-head"><span class="eyebrow">Administration</span><h1>Student Records</h1><p>Search, review, and export student data.</p></div>

      <div class="results-toolbar">
        <div class="field" style="margin:0; min-width:260px;">
          <input type="text" id="staffSearch" placeholder="Search by register number, name, course, or batch">
        </div>
        <div class="button-row">
          <button class="btn btn-outline" id="exportExcelBtn" type="button">Export Excel</button>
          <button class="btn btn-outline" id="exportPdfBtn" type="button">Export Selected PDF</button>
        </div>
      </div>

      <div class="ledger" id="staffTableWrap"><div class="loading-block"><div class="spinner"></div></div></div>
      <div class="button-row" style="justify-content:center; margin-top:20px;" id="pagination"></div>
    </div>
  `;

  document.getElementById("staffSearch").addEventListener("input", debounce((e) => {
    StaffState.search = e.target.value.trim();
    StaffState.page = 0;
    loadStaffStudents();
  }, 350));

  document.getElementById("exportExcelBtn").addEventListener("click", () => exportStudentsExcel());
  document.getElementById("exportPdfBtn").addEventListener("click", () => exportSelectedStudentsPdf());

  loadStaffStudents();
}

async function loadStaffStudents() {
  const wrap = document.getElementById("staffTableWrap");
  wrap.innerHTML = `<div class="loading-block"><div class="spinner"></div></div>`;

  try {
    const sb = getSupabase();
    let query = sb.from(CONFIG.tables.profiles).select("*", { count: "exact" })
      .eq("role", CONFIG.roles.student).order("register_number", { ascending: true });

    if (StaffState.search) {
      const s = StaffState.search.replace(/[%_]/g, "");
      query = query.or(`name.ilike.%${s}%,register_number.ilike.%${s}%,course.ilike.%${s}%,batch.ilike.%${s}%`);
    }

    const from = StaffState.page * StaffState.pageSize;
    query = query.range(from, from + StaffState.pageSize - 1);

    const { data, count, error } = await query;
    if (error) throw new AppError("We couldn't load student records right now.", error);

    StaffState.rows = data || [];
    StaffState.totalCount = count || 0;
    renderStaffTable();
    renderPagination();
  } catch (err) {
    handleAppError(err);
    wrap.innerHTML = `<div class="empty-state"><h3>Unable to load records</h3><p>Please try again.</p></div>`;
  }
}

function renderStaffTable() {
  const wrap = document.getElementById("staffTableWrap");
  if (!StaffState.rows.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="glyph">＋</div><h3>No Students Found</h3><p>Try a different search term.</p></div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="ledger-head" style="grid-template-columns: 30px 90px 1.4fr 90px 80px 80px 80px 90px;">
      <div></div><div>Reg No</div><div>Name</div><div>Course</div><div>Sem</div><div>CGPA</div><div>Arrears</div><div>Fees</div>
    </div>
    ${StaffState.rows.map((s) => `
      <div class="ledger-row" style="grid-template-columns: 30px 90px 1.4fr 90px 80px 80px 80px 90px;" data-id="${s.id}">
        <div><input type="checkbox" class="staff-select" data-id="${s.id}" ${StaffState.selectedIds.has(s.id) ? "checked" : ""}></div>
        <div class="mono">${escapeHtml(s.register_number)}</div>
        <div class="subject-name">${escapeHtml(s.name)}</div>
        <div>${escapeHtml(s.course)}</div>
        <div>${s.current_semester ?? "—"}</div>
        <div class="mono">${s.cgpa != null ? Number(s.cgpa).toFixed(2) : "—"}</div>
        <div>${s.arrears ?? 0}</div>
        <div class="mono">${formatCurrency(s.fees_pending)}</div>
      </div>
    `).join("")}
  `;

  wrap.querySelectorAll(".ledger-row").forEach((row) => {
    row.addEventListener("click", (e) => { if (!e.target.classList.contains("staff-select")) openStudentDetail(Number(row.dataset.id)); });
  });
  wrap.querySelectorAll(".staff-select").forEach((cb) => {
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", (e) => {
      const id = Number(e.target.dataset.id);
      e.target.checked ? StaffState.selectedIds.add(id) : StaffState.selectedIds.delete(id);
    });
  });
}

function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(StaffState.totalCount / StaffState.pageSize));
  const el = document.getElementById("pagination");
  el.innerHTML = `
    <button class="btn btn-ghost" id="prevPage" ${StaffState.page === 0 ? "disabled" : ""}>Previous</button>
    <span class="mono" style="align-self:center; color:var(--text-muted); font-size:13px;">Page ${StaffState.page + 1} of ${totalPages}</span>
    <button class="btn btn-ghost" id="nextPage" ${StaffState.page >= totalPages - 1 ? "disabled" : ""}>Next</button>
  `;
  document.getElementById("prevPage")?.addEventListener("click", () => { StaffState.page--; loadStaffStudents(); });
  document.getElementById("nextPage")?.addEventListener("click", () => { StaffState.page++; loadStaffStudents(); });
}

async function openStudentDetail(profileId) {
  const student = StaffState.rows.find((s) => s.id === profileId);
  if (!student) return;

  showModal(`
    <div class="modal-head"><h3>${escapeHtml(student.name)}</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>
    <div class="avatar" style="width:72px;height:72px;margin-bottom:16px;"><img src="${resolveAvatarUrl(student)}" alt=""></div>
    <div class="info-grid">
      ${infoItem("Register Number", student.register_number)}
      ${infoItem("Gender", student.gender)}
      ${infoItem("Date of Birth", student.dob ? formatDate(student.dob) : "—")}
      ${infoItem("Blood Group", student.blood_group)}
      ${infoItem("Phone", student.phone)}
      ${infoItem("Parent Phone", student.parent_phone)}
      ${infoItem("Guardian", student.guardian)}
      ${infoItem("Address", student.address)}
      ${infoItem("Course", student.course)}
      ${infoItem("Batch", student.batch)}
      ${infoItem("Year", student.year)}
      ${infoItem("Current Semester", student.current_semester)}
      ${infoItem("Attendance", student.attendance_percentage != null ? student.attendance_percentage + "%" : "—")}
      ${infoItem("CGPA", student.cgpa != null ? Number(student.cgpa).toFixed(2) : "—")}
      ${infoItem("Arrears", student.arrears ?? 0)}
      ${infoItem("Fees Pending", formatCurrency(student.fees_pending))}
      ${infoItem("College", student.college || CONFIG.collegeName)}
      ${infoItem("University", student.university || CONFIG.universityName)}
    </div>
    <div class="button-row" style="margin-top:20px;">
      <button class="btn btn-primary" id="detailPdfBtn">Download Record PDF</button>
    </div>
  `);

  document.getElementById("detailPdfBtn").addEventListener("click", () => exportStudentRecordPdf(student));
  loadAvatarInto(document.querySelector("#modalBody .avatar img"), student);
}

function renderStaffResultExport(main) {
  main.innerHTML = `
    <div class="container">
      <div class="page-head"><span class="eyebrow">Reports</span><h1>Result Export</h1><p>Generate a professional result PDF for any student and semester.</p></div>

      <div class="section-card">
        <div class="field"><label for="exportSearch">Student</label><input type="text" id="exportSearch" placeholder="Search by register number or name"></div>
        <div id="exportSearchResults" style="display:flex; flex-direction:column; gap:6px; margin-bottom:16px;"></div>
        <div id="exportSelectedStudent" class="empty-state hidden" style="padding:20px;"><p id="exportSelectedLabel"></p></div>
        <div class="field" id="exportSemesterField" style="display:none;"><label for="exportSemester">Semester</label><select id="exportSemester"></select></div>
        <div class="button-row" id="exportActions" style="display:none;">
          <button class="btn btn-primary" id="exportSemesterPdfBtn">Download Semester PDF</button>
          <button class="btn btn-outline" id="exportAllPdfBtn">Download All Semesters (combined)</button>
        </div>
      </div>
    </div>
  `;

  let selectedStudent = null;

  document.getElementById("exportSearch").addEventListener("input", debounce(async (e) => {
    const term = e.target.value.trim();
    const resultsEl = document.getElementById("exportSearchResults");
    if (term.length < 2) { resultsEl.innerHTML = ""; return; }

    const sb = getSupabase();
    const { data } = await sb.from(CONFIG.tables.profiles).select("id, name, register_number, course, current_semester")
      .eq("role", CONFIG.roles.student).or(`name.ilike.%${term}%,register_number.ilike.%${term}%`).limit(8);

    resultsEl.innerHTML = (data || []).map((s) => `<button type="button" class="btn btn-outline" data-pick="${s.id}" style="justify-content:flex-start;">${escapeHtml(s.register_number)} — ${escapeHtml(s.name)}</button>`).join("")
      || `<p style="color:var(--text-muted); font-size:13px;">No matching students.</p>`;

    resultsEl.querySelectorAll("[data-pick]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        selectedStudent = data.find((s) => s.id === Number(btn.dataset.pick));
        document.getElementById("exportSelectedStudent").classList.remove("hidden");
        document.getElementById("exportSelectedLabel").textContent = `${selectedStudent.register_number} — ${selectedStudent.name} (${selectedStudent.course})`;

        const { data: course } = await sb.from(CONFIG.tables.courses).select("duration_semesters").eq("code", selectedStudent.course).maybeSingle();
        const count = course?.duration_semesters || CONFIG.courseSemesterCounts[selectedStudent.course] || 6;
        document.getElementById("exportSemester").innerHTML = Array.from({ length: count }, (_, i) => i + 1)
          .map((n) => `<option value="${n}" ${n === selectedStudent.current_semester ? "selected" : ""}>Semester ${n}</option>`).join("");

        document.getElementById("exportSemesterField").style.display = "flex";
        document.getElementById("exportActions").style.display = "flex";
        resultsEl.innerHTML = "";
        document.getElementById("exportSearch").value = "";
      });
    });
  }, 300));

  document.getElementById("exportSemesterPdfBtn").addEventListener("click", () => {
    if (selectedStudent) exportStaffSemesterPdf(selectedStudent, Number(document.getElementById("exportSemester").value));
  });
  document.getElementById("exportAllPdfBtn").addEventListener("click", () => {
    if (selectedStudent) exportStaffAllSemestersPdf(selectedStudent);
  });
}

/* =============================== RESULTS =============================== */

const ResultsState = { activeSemester: null, currentResults: [] };

function renderStudentResults(main) {
  const semesters = Array.from({ length: StudentState.courseSemesterCount }, (_, i) => i + 1);

  main.innerHTML = `
    <div class="container">
      <div class="page-head"><span class="eyebrow">Academic Record</span><h1>Semester Results</h1><p>Select a semester to view subject-wise marks, grade, and status.</p></div>

      <div class="results-toolbar">
        <div class="semester-tabs" id="semesterTabs" role="tablist"></div>
        <div class="button-row">
          <button class="btn btn-outline" id="arrearBtn" type="button" style="display:none;">Apply for Arrear Exam</button>
          <button class="btn btn-primary" id="downloadPdfBtn" type="button">Download PDF</button>
        </div>
      </div>

      <div id="resultReleased" class="mono" style="color:var(--text-muted); font-size:12.5px; margin-bottom:12px;"></div>

      <div class="ledger" id="resultContainer">
        <div class="ledger-head"><div>Code</div><div>Subject</div><div>Credits</div><div>Internal</div><div>External</div><div>Total</div><div>Grade</div><div>Result</div></div>
        <div id="ledgerLoading" class="hidden">
          <div class="skeleton-row"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
          <div class="skeleton-row"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
        </div>
        <div id="ledgerBody"></div>
        <div id="ledgerEmpty" class="empty-state hidden"><div class="glyph">＋</div><h3>No Results Yet</h3><p>No academic result is available for this semester.</p></div>
      </div>

      <div class="summary-row">
        <div class="stat-card"><div class="stat-label">Credits</div><div class="stat-value" id="summaryCredits">0</div></div>
        <div class="stat-card"><div class="stat-label">Passed</div><div class="stat-value" id="summaryPassed">0</div></div>
        <div class="stat-card"><div class="stat-label">Arrears</div><div class="stat-value" id="summaryFailed">0</div></div>
        <div class="seal-card stat-card"><div class="stat-label">Semester SGPA</div><div class="stat-value" id="summarySgpa">0.00</div></div>
        <div class="seal-card stat-card"><div class="stat-label">Overall CGPA</div><div class="stat-value" id="summaryCgpa">0.00</div></div>
      </div>
    </div>
  `;

  document.getElementById("semesterTabs").innerHTML = semesters.map((s) => `<button type="button" data-semester="${s}">Sem ${s}</button>`).join("");
  document.querySelectorAll("#semesterTabs button").forEach((btn) => btn.addEventListener("click", () => loadStudentSemester(Number(btn.dataset.semester))));
  document.getElementById("downloadPdfBtn").addEventListener("click", () => downloadStudentResultPdf());
  document.getElementById("arrearBtn").addEventListener("click", () => openArrearModal());

  loadStudentSemester(APP.profile.current_semester || 1);
}

async function loadStudentSemester(semester) {
  ResultsState.activeSemester = semester;
  document.querySelectorAll("#semesterTabs button").forEach((b) => b.classList.toggle("active", Number(b.dataset.semester) === semester));
  document.getElementById("ledgerLoading").classList.remove("hidden");
  document.getElementById("ledgerBody").classList.add("hidden");

  try {
    const sb = getSupabase();
    const { data, error } = await sb.from(CONFIG.tables.results).select("*, subjects(subject_code, subject_name, credits)")
      .eq("student_id", APP.profile.id).eq("semester", semester).order("id");
    if (error) throw new AppError("We couldn't retrieve your academic records. Please try again.", error);

    const rows = (data || []).sort((a, b) => (a.subjects?.subject_code || "").localeCompare(b.subjects?.subject_code || ""));
    ResultsState.currentResults = rows;
    renderResultLedger(rows, semester);
    await refreshCgpaBadge();
  } catch (err) {
    handleAppError(err);
    renderResultLedger([], semester);
  } finally {
    document.getElementById("ledgerLoading").classList.add("hidden");
    document.getElementById("ledgerBody").classList.remove("hidden");
  }
}

function renderResultLedger(rows, semester) {
  const empty = document.getElementById("ledgerEmpty");
  const body = document.getElementById("ledgerBody");
  empty.classList.toggle("hidden", rows.length > 0);
  body.classList.toggle("hidden", rows.length === 0);

  const releaseDate = rows.find((r) => r.result_released_date)?.result_released_date;
  document.getElementById("resultReleased").textContent = releaseDate ? `Result Released: ${formatDate(releaseDate)}` : "";

  body.innerHTML = rows.map((r) => {
    const subj = r.subjects || {};
    const pass = (r.status || "").toUpperCase() === "PASS";
    const total = r.total_marks ?? ((r.internal_marks || 0) + (r.external_marks || 0));
    return `
      <div class="ledger-row reveal in" role="button" tabindex="0" data-id="${r.id}">
        <div class="subject-code">${escapeHtml(subj.subject_code)}</div>
        <div>
          <div class="subject-name">${escapeHtml(subj.subject_name)}</div>
          <div class="marks-line">
            <span>Int ${r.internal_marks ?? 0}</span><span>Ext ${r.external_marks ?? 0}</span>
            <span class="mono">Total ${total}</span><span class="grade-tag">${escapeHtml(r.grade || "—")}</span>
          </div>
        </div>
        <div class="cell-credits">${subj.credits ?? "—"}</div>
        <div class="cell-internal">${r.internal_marks ?? 0}</div>
        <div class="cell-external">${r.external_marks ?? 0}</div>
        <div class="cell-total mono">${total}</div>
        <div class="grade-tag">${escapeHtml(r.grade || "—")}</div>
        <div><span class="badge ${pass ? "badge-pass" : "badge-fail"}">${pass ? "PASS" : "ARREAR"}</span></div>
      </div>
    `;
  }).join("");

  document.querySelectorAll(".ledger-row[data-id]").forEach((row) => {
    row.addEventListener("click", () => openSubjectModal(rows.find((r) => r.id === Number(row.dataset.id))));
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSubjectModal(rows.find((r) => r.id === Number(row.dataset.id))); } });
  });

  const credits = rows.reduce((sum, r) => sum + Number(r.subjects?.credits || 0), 0);
  const passed = rows.filter((r) => (r.status || "").toUpperCase() === "PASS").length;
  document.getElementById("summaryCredits").textContent = credits;
  document.getElementById("summaryPassed").textContent = passed;
  document.getElementById("summaryFailed").textContent = rows.length - passed;
  document.getElementById("summarySgpa").textContent = calcWeightedGpa(rows);
  document.getElementById("arrearBtn").style.display = (rows.length - passed) > 0 ? "inline-flex" : "none";
}

function openSubjectModal(subject) {
  if (!subject) return;
  const total = subject.total_marks ?? ((subject.internal_marks || 0) + (subject.external_marks || 0));
  showModal(`
    <div class="modal-head"><h3>Subject Details</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>
    <div class="info-grid">
      ${infoItem("Subject Code", subject.subjects?.subject_code)}
      ${infoItem("Subject Name", subject.subjects?.subject_name)}
      ${infoItem("Credits", subject.subjects?.credits)}
      ${infoItem("Internal", subject.internal_marks ?? 0)}
      ${infoItem("External", subject.external_marks ?? 0)}
      ${infoItem("Total", total)}
      ${infoItem("Grade", subject.grade)}
      ${infoItem("Grade Point", subject.grade_point)}
      ${infoItem("Result", (subject.status || "PASS").toUpperCase())}
    </div>
  `);
}

function calcWeightedGpa(rows) {
  const withCredits = rows.filter((r) => Number(r.subjects?.credits) > 0);
  if (!withCredits.length) return "0.00";
  const totalCredits = withCredits.reduce((sum, r) => sum + Number(r.subjects.credits), 0);
  const weighted = withCredits.reduce((sum, r) => sum + Number(r.grade_point || 0) * Number(r.subjects.credits), 0);
  return totalCredits > 0 ? (weighted / totalCredits).toFixed(2) : "0.00";
}

async function refreshCgpaBadge() {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from(CONFIG.tables.results).select("grade_point, subjects(credits)").eq("student_id", APP.profile.id);
    if (error) throw error;
    document.getElementById("summaryCgpa").textContent = calcWeightedGpa(data || []);
  } catch (err) { console.error(err); }
}

async function fetchStudentResults(studentId, semester) {
  const sb = getSupabase();
  let query = sb.from(CONFIG.tables.results).select("*, subjects(subject_code, subject_name, credits)").eq("student_id", studentId);
  if (semester) query = query.eq("semester", semester);
  const { data, error } = await query;
  if (error) throw new AppError("Unable to load results for export.", error);
  return (data || []).sort((a, b) => (a.subjects?.subject_code || "").localeCompare(b.subjects?.subject_code || ""));
}

/* ================================ FEES ================================ */

async function renderStudentFees(main) {
  main.innerHTML = `
    <div class="container">
      <div class="page-head"><span class="eyebrow">Finance</span><h1>Fees</h1><p>Your fee records and current balance.</p></div>
      <div id="feesContent" class="loading-block"><div class="spinner"></div></div>
    </div>
  `;

  try {
    const sb = getSupabase();
    const { data, error } = await sb.from(CONFIG.tables.feeRecords).select("*").eq("student_id", APP.profile.id).order("due_date", { ascending: true });
    if (error) throw new AppError("We couldn't load your fee records right now.", error);

    const container = document.getElementById("feesContent");
    if (!data || data.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="glyph">₹</div><h3>No Fee Records</h3><p>No fee records are available yet.</p></div>`;
      return;
    }

    const totalPending = data.reduce((sum, f) => sum + Number(f.pending_amount || 0), 0);
    container.innerHTML = `
      <div class="stat-grid" style="margin-bottom:24px;"><div class="seal-card stat-card"><div class="stat-label">Total Pending</div><div class="stat-value">${formatCurrency(totalPending)}</div></div></div>
      <div class="ledger">
        <div class="ledger-head" style="grid-template-columns: 1.4fr 100px 100px 100px 90px 110px;"><div>Fee Type</div><div>Amount</div><div>Paid</div><div>Pending</div><div>Status</div><div>Due Date</div></div>
        <div>${data.map((f) => `
          <div class="ledger-row" style="grid-template-columns: 1.4fr 100px 100px 100px 90px 110px; cursor:default;">
            <div class="subject-name">${escapeHtml(f.fee_type)}</div>
            <div class="mono">${formatCurrency(f.amount)}</div>
            <div class="mono">${formatCurrency(f.paid_amount)}</div>
            <div class="mono">${formatCurrency(f.pending_amount)}</div>
            <div><span class="badge ${f.status === "paid" ? "badge-pass" : "badge-fail"}">${escapeHtml((f.status || "").toUpperCase())}</span></div>
            <div class="mono">${formatDate(f.due_date)}</div>
          </div>`).join("")}
        </div>
      </div>
      <p style="margin-top:16px; color:var(--text-muted); font-size:13px;">Online payment isn't wired up in this demo — see the accounts office to settle a pending balance.</p>
    `;
  } catch (err) {
    handleAppError(err);
    document.getElementById("feesContent").innerHTML = `<div class="empty-state"><h3>Unable to load fees</h3><p>Please try again shortly.</p></div>`;
  }
}

/* =============================== ARREARS =============================== */

let arrearFeeCache = null;

async function openArrearModal() {
  const failedResults = ResultsState.currentResults.filter((r) => (r.status || "").toUpperCase() !== "PASS");
  if (!failedResults.length) return;

  const sb = getSupabase();
  try {
    if (arrearFeeCache == null) {
      const { data } = await sb.from(CONFIG.tables.portalSettings).select("value").eq("key", "arrear_exam_fee").maybeSingle();
      arrearFeeCache = Number(data?.value || 500);
    }

    const { data: existingApps } = await sb.from(CONFIG.tables.arrearApplications).select("result_id").eq("student_id", APP.profile.id);
    const appliedIds = new Set((existingApps || []).map((a) => a.result_id));

    const rowsHtml = failedResults.map((r) => {
      const already = appliedIds.has(r.id);
      return `<label class="field" style="flex-direction:row; align-items:center; gap:10px;">
        <input type="checkbox" data-result-id="${r.id}" ${already ? "disabled checked" : ""} style="width:16px;height:16px;">
        <span>${escapeHtml(r.subjects?.subject_code)} — ${escapeHtml(r.subjects?.subject_name)} ${already ? "(already applied)" : ""}</span>
      </label>`;
    }).join("");

    showModal(`
      <div class="modal-head"><h3>Apply for Arrear Exam</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>
      <div class="info-grid" style="margin-bottom:16px;">
        ${infoItem("Student", APP.profile.name)}
        ${infoItem("Register Number", APP.profile.register_number)}
        ${infoItem("Current Semester", APP.profile.current_semester)}
        ${infoItem("Fee per subject", formatCurrency(arrearFeeCache))}
      </div>
      <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:20px;">${rowsHtml}</div>
      <p id="arrearTotal" class="mono" style="margin-bottom:16px; font-weight:600;"></p>
      <div class="button-row">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" id="confirmArrearBtn">Submit Application</button>
      </div>
    `);

    const checkboxes = document.querySelectorAll('#modalBody input[type="checkbox"]:not([disabled])');
    const updateTotal = () => {
      const count = Array.from(checkboxes).filter((c) => c.checked).length;
      document.getElementById("arrearTotal").textContent = `Total fee: ${formatCurrency(count * arrearFeeCache)}`;
    };
    checkboxes.forEach((c) => c.addEventListener("change", updateTotal));
    updateTotal();
    document.getElementById("confirmArrearBtn").addEventListener("click", () => submitArrearApplication(checkboxes));
  } catch (err) {
    handleAppError(err, "Unable to open the arrear application right now.");
  }
}

async function submitArrearApplication(checkboxes) {
  const selected = Array.from(checkboxes).filter((c) => c.checked).map((c) => Number(c.dataset.resultId));
  if (!selected.length) { showToast("Select at least one subject to apply.", "error"); return; }

  const btn = document.getElementById("confirmArrearBtn");
  btn.disabled = true;
  btn.textContent = "Submitting…";

  try {
    const sb = getSupabase();
    const rows = selected.map((resultId) => ({ student_id: APP.profile.id, result_id: resultId, fee_amount: arrearFeeCache, status: "pending" }));
    const { error } = await sb.from(CONFIG.tables.arrearApplications).insert(rows);
    if (error) throw new AppError("Unable to submit your application. Please try again.", error);
    showToast("Arrear exam application submitted.", "success");
    closeModal();
  } catch (err) {
    handleAppError(err);
    btn.disabled = false;
    btn.textContent = "Submit Application";
  }
}

/* =============================== PROFILE =============================== */

function resolveAvatarUrl(profile) {
  // Synchronous fallback shown immediately; loadAvatarInto() upgrades it
  // to the real photo (a signed URL) once fetched.
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(profile.name || "Student")}&background=9A5B12&color=fff8ec&size=200`;
}

async function loadAvatarInto(imgEl, profile) {
  if (!imgEl || !profile?.profile_photo_path) return;
  try {
    const sb = getSupabase();
    const { data, error } = await sb.storage.from(CONFIG.avatarBucket).createSignedUrl(profile.profile_photo_path, 3600);
    if (error || !data?.signedUrl) return;
    imgEl.src = data.signedUrl;
  } catch (err) { console.warn("Avatar load skipped:", err.message); }
}

async function uploadAvatar(file) {
  if (!CONFIG.allowedAvatarTypes.includes(file.type)) { showToast("Please upload a JPG, PNG, or WEBP image.", "error"); return; }
  if (file.size > CONFIG.maxAvatarSizeBytes) { showToast("Image is too large. Please choose a file under 2MB.", "error"); return; }

  showToast("Uploading photo…", "info");
  try {
    const sb = getSupabase();
    const ext = file.name.split(".").pop();
    const path = `${APP.user.id}/avatar.${ext}`;

    const { error: uploadError } = await sb.storage.from(CONFIG.avatarBucket).upload(path, file, { upsert: true, cacheControl: "3600" });
    if (uploadError) throw new AppError("Unable to upload your photo. Please try again.", uploadError);

    const { error: updateError } = await sb.from(CONFIG.tables.profiles).update({ profile_photo_path: path }).eq("id", APP.profile.id);
    if (updateError) throw new AppError("Photo uploaded, but we couldn't save it to your profile.", updateError);

    APP.profile.profile_photo_path = path;
    await loadAvatarInto(document.getElementById("avatarImg"), APP.profile);
    showToast("Profile photo updated.", "success");
  } catch (err) {
    handleAppError(err);
  }
}

// Personal → Academic → Financial → Institution, in that exact order.
function renderStudentProfile(main) {
  const p = APP.profile;
  main.innerHTML = `
    <div class="container">
      <div class="page-head"><span class="eyebrow">Profile</span><h1>${escapeHtml(p.name)}</h1><p>Your personal, academic, and institution details.</p></div>

      <div class="profile-strip">
        <div class="avatar"><img id="avatarImg" alt="Profile photo" src="${resolveAvatarUrl(p)}" loading="lazy"></div>
        <div>
          <h2>${escapeHtml(p.name)}</h2>
          <div class="profile-meta"><span>Reg. No <strong class="mono">${escapeHtml(p.register_number)}</strong></span></div>
          <div class="button-row" style="margin-top:14px;">
            <label class="btn btn-outline" style="cursor:pointer;">Change Photo<input type="file" id="avatarInput" accept="image/png,image/jpeg,image/webp" style="display:none;"></label>
          </div>
        </div>
      </div>

      <div class="section-card">
        <h2>Personal Information</h2>
        <div class="info-grid">
          ${infoItem("Register Number", p.register_number)}
          ${infoItem("Name", p.name)}
          ${infoItem("Gender", p.gender)}
          ${infoItem("Date of Birth", p.dob ? formatDate(p.dob) : "—")}
          ${infoItem("Blood Group", p.blood_group)}
          ${infoItem("Phone Number", p.phone)}
          ${infoItem("Parent Phone Number", p.parent_phone)}
          ${infoItem("Guardian", p.guardian)}
          ${infoItem("Address", p.address)}
        </div>
      </div>

      <div class="section-card">
        <h2>Academic Information</h2>
        <div class="info-grid">
          ${infoItem("Course", p.course)}
          ${infoItem("Batch", p.batch)}
          ${infoItem("Year", p.year)}
          ${infoItem("Current Semester", p.current_semester)}
          ${infoItem("Attendance", p.attendance_percentage != null ? p.attendance_percentage + "%" : "—")}
          ${infoItem("CGPA", p.cgpa != null ? Number(p.cgpa).toFixed(2) : "—")}
          ${infoItem("Arrears", p.arrears ?? 0)}
        </div>
      </div>

      <div class="section-card">
        <h2>Financial Information</h2>
        <div class="info-grid">${infoItem("Fees Pending", formatCurrency(p.fees_pending))}</div>
      </div>

      <div class="section-card">
        <h2>Institution Information</h2>
        <div class="info-grid">
          ${infoItem("College", p.college || CONFIG.collegeName)}
          ${infoItem("University", p.university || CONFIG.universityName)}
        </div>
      </div>
    </div>
  `;

  document.getElementById("avatarInput")?.addEventListener("change", (e) => { const file = e.target.files?.[0]; if (file) uploadAvatar(file); });
  loadAvatarInto(document.getElementById("avatarImg"), p);
}

/* =============================== EXPORTS =============================== */

const libState = { jspdf: false, xlsx: false };

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function ensureJsPdf() { if (!libState.jspdf) { await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"); libState.jspdf = true; } return true; }
async function ensureXlsx() { if (!libState.xlsx) { await loadScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"); libState.xlsx = true; } return true; }
function newPdf() { const { jsPDF } = window.jspdf; return new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" }); }

function pdfLetterhead(pdf, title) {
  const pageWidth = pdf.internal.pageSize.getWidth();
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(14);
  pdf.text("University Portal", pageWidth / 2, 16, { align: "center" });
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(10);
  pdf.text(CONFIG.collegeName, pageWidth / 2, 22, { align: "center" });
  pdf.text(CONFIG.universityName, pageWidth / 2, 27, { align: "center" });
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(12);
  pdf.text(title, pageWidth / 2, 35, { align: "center" });
  pdf.setDrawColor(180); pdf.line(16, 39, pageWidth - 16, 39);
  return 46;
}

function pdfFooter(pdf) {
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const count = pdf.internal.getNumberOfPages();
  for (let i = 1; i <= count; i++) {
    pdf.setPage(i); pdf.setFontSize(8); pdf.setTextColor(130);
    pdf.text(`Page ${i} of ${count} · Generated ${new Date().toLocaleDateString()}`, pageWidth / 2, pageHeight - 8, { align: "center" });
  }
}

async function exportResultPdf({ profile, semester, rows, sgpa, cgpa }) {
  try {
    await ensureJsPdf();
    const pdf = newPdf();
    drawResultReport(pdf, profile, semester, rows, sgpa, cgpa);
    pdfFooter(pdf);
    pdf.save(`Semester_${semester}_Result_${profile.register_number}.pdf`);
    showToast("PDF downloaded.", "success");
  } catch (err) { console.error(err); showToast("Unable to generate PDF. Please try again.", "error"); }
}

function drawResultReport(pdf, profile, semester, rows, sgpa, cgpa, startNewPage = false) {
  if (startNewPage) pdf.addPage();
  const pageWidth = pdf.internal.pageSize.getWidth();
  let y = pdfLetterhead(pdf, `Semester ${semester} Result`);

  pdf.setFont("helvetica", "bold"); pdf.setFontSize(10);
  [`Student: ${profile.name}`, `Register No: ${profile.register_number}`, `Course: ${profile.course || "—"}   Batch: ${profile.batch || "—"}`]
    .forEach((line) => { pdf.text(line, 16, y); y += 5.5; });

  const releaseDate = rows.find((r) => r.result_released_date)?.result_released_date;
  if (releaseDate) { pdf.text(`Result Released: ${formatDate(releaseDate)}`, 16, y); y += 5.5; }

  y += 3;
  const cols = ["Code", "Subject", "Cr", "Int", "Ext", "Total", "Grade", "Result"];
  const colX = [16, 34, 92, 102, 114, 126, 142, 158];
  pdf.setFontSize(9);
  cols.forEach((c, i) => pdf.text(c, colX[i], y));
  y += 3.5; pdf.line(16, y, pageWidth - 16, y); y += 5;

  pdf.setFont("helvetica", "normal");
  rows.forEach((r) => {
    if (y > 270) { pdf.addPage(); y = 20; }
    const subj = r.subjects || {};
    const total = r.total_marks ?? ((r.internal_marks || 0) + (r.external_marks || 0));
    [subj.subject_code || "-", (subj.subject_name || "-").slice(0, 30), String(subj.credits ?? "-"),
      String(r.internal_marks ?? 0), String(r.external_marks ?? 0), String(total), r.grade || "-", (r.status || "PASS").toUpperCase()]
      .forEach((v, i) => pdf.text(v, colX[i], y));
    y += 6;
  });

  y += 6; pdf.line(16, y, pageWidth - 16, y); y += 8;
  pdf.setFont("helvetica", "bold");
  pdf.text(`SGPA: ${sgpa}`, 16, y);
  pdf.text(`CGPA: ${cgpa}`, 70, y);
  pdf.text(`Arrears: ${rows.filter((r) => (r.status || "").toUpperCase() !== "PASS").length}`, 124, y);
}

async function exportStaffSemesterPdf(student, semester) {
  try {
    const rows = await fetchStudentResults(student.id, semester);
    if (!rows.length) { showToast(`No results found for Semester ${semester}.`, "error"); return; }
    const sgpa = calcWeightedGpa(rows);
    const cgpa = calcWeightedGpa(await fetchStudentResults(student.id, null));

    await ensureJsPdf();
    const pdf = newPdf();
    drawResultReport(pdf, student, semester, rows, sgpa, cgpa);
    pdfFooter(pdf);
    pdf.save(`Semester_${semester}_Result_${student.register_number}.pdf`);
    showToast("PDF downloaded.", "success");
  } catch (err) { handleAppError(err, "Unable to generate the result PDF."); }
}

async function exportStaffAllSemestersPdf(student) {
  try {
    const allRows = await fetchStudentResults(student.id, null);
    if (!allRows.length) { showToast("No results found for this student.", "error"); return; }
    const semesters = [...new Set(allRows.map((r) => r.semester))].sort((a, b) => a - b);
    const cgpa = calcWeightedGpa(allRows);

    await ensureJsPdf();
    const pdf = newPdf();
    semesters.forEach((sem, idx) => drawResultReport(pdf, student, sem, allRows.filter((r) => r.semester === sem), calcWeightedGpa(allRows.filter((r) => r.semester === sem)), cgpa, idx > 0));
    pdfFooter(pdf);
    pdf.save(`All_Semesters_Result_${student.register_number}.pdf`);
    showToast("PDF downloaded.", "success");
  } catch (err) { handleAppError(err, "Unable to generate the combined result PDF."); }
}

function drawStudentRecordPage(pdf, student, startNewPage) {
  if (startNewPage) pdf.addPage();
  let y = pdfLetterhead(pdf, "Student Record");
  const fields = [
    ["Register Number", student.register_number], ["Name", student.name], ["Gender", student.gender],
    ["Date of Birth", student.dob ? formatDate(student.dob) : "—"], ["Blood Group", student.blood_group],
    ["Phone", student.phone], ["Parent Phone", student.parent_phone], ["Guardian", student.guardian],
    ["Address", student.address], ["Course", student.course], ["Batch", student.batch],
    ["Year", student.year], ["Current Semester", student.current_semester],
    ["Attendance", student.attendance_percentage != null ? student.attendance_percentage + "%" : "—"],
    ["CGPA", student.cgpa != null ? Number(student.cgpa).toFixed(2) : "—"], ["Arrears", student.arrears ?? 0],
    ["Fees Pending", formatCurrency(student.fees_pending)], ["College", student.college || CONFIG.collegeName],
    ["University", student.university || CONFIG.universityName]
  ];
  pdf.setFontSize(10);
  fields.forEach(([label, value]) => {
    pdf.setFont("helvetica", "bold"); pdf.text(`${label}:`, 16, y);
    pdf.setFont("helvetica", "normal"); pdf.text(String(value ?? "—"), 70, y);
    y += 7;
  });
}

async function exportStudentRecordPdf(student) {
  try {
    await ensureJsPdf();
    const pdf = newPdf();
    drawStudentRecordPage(pdf, student, false);
    pdfFooter(pdf);
    pdf.save(`Student_Record_${student.register_number}.pdf`);
    showToast("PDF downloaded.", "success");
  } catch (err) { handleAppError(err, "Unable to generate the record PDF."); }
}

async function exportSelectedStudentsPdf() {
  const ids = Array.from(StaffState.selectedIds);
  const rows = ids.length ? StaffState.rows.filter((s) => ids.includes(s.id)) : StaffState.rows;
  if (!rows.length) { showToast("No students to export.", "error"); return; }
  try {
    await ensureJsPdf();
    const pdf = newPdf();
    rows.forEach((student, idx) => drawStudentRecordPage(pdf, student, idx > 0));
    pdfFooter(pdf);
    pdf.save(`Student_Records_${new Date().toISOString().slice(0, 10)}.pdf`);
    showToast("PDF downloaded.", "success");
  } catch (err) { handleAppError(err, "Unable to generate the records PDF."); }
}

async function exportStudentsExcel() {
  try {
    const sb = getSupabase();
    let query = sb.from(CONFIG.tables.profiles).select("*").eq("role", CONFIG.roles.student).order("register_number");
    if (StaffState.search) {
      const s = StaffState.search.replace(/[%_]/g, "");
      query = query.or(`name.ilike.%${s}%,register_number.ilike.%${s}%,course.ilike.%${s}%,batch.ilike.%${s}%`);
    }
    const { data, error } = await query;
    if (error) throw new AppError("Unable to export student records.", error);
    if (!data.length) { showToast("No students to export.", "error"); return; }

    await ensureXlsx();
    const sheetRows = data.map((s) => ({
      "Register Number": s.register_number, "Name": s.name, "Gender": s.gender, "Course": s.course,
      "Year": s.year, "Current Semester": s.current_semester, "Attendance %": s.attendance_percentage,
      "CGPA": s.cgpa, "Arrears": s.arrears, "DOB": s.dob, "Phone": s.phone, "Parent Phone": s.parent_phone,
      "Guardian": s.guardian, "Address": s.address, "Blood Group": s.blood_group, "Batch": s.batch,
      "Fees Pending": s.fees_pending, "College": s.college || CONFIG.collegeName, "University": s.university || CONFIG.universityName
    }));
    const ws = XLSX.utils.json_to_sheet(sheetRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Students");
    XLSX.writeFile(wb, `Student_Records_${new Date().toISOString().slice(0, 10)}.xlsx`);
    showToast("Excel file downloaded.", "success");
  } catch (err) { handleAppError(err, "Unable to export student records."); }
}

async function downloadStudentResultPdf() {
  if (!ResultsState.currentResults.length) { showToast("There's nothing to export for this semester yet.", "error"); return; }
  await exportResultPdf({
    profile: APP.profile, semester: ResultsState.activeSemester, rows: ResultsState.currentResults,
    sgpa: document.getElementById("summarySgpa").textContent, cgpa: document.getElementById("summaryCgpa").textContent
  });
}

/* ================================ THEME ================================ */

const ICONS = {
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/></svg>'
};

function initTheme() {
  document.getElementById("themeToggle")?.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    applyTheme(current === "dark" ? "light" : "dark");
  });
}

function applyTheme(theme) {
  if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  localStorage.setItem("up_theme", theme); // UI preference only — never used for auth/session
  document.querySelectorAll(".theme-toggle").forEach(syncToggleIcon);
}

function syncToggleIcon(toggle) {
  if (!toggle) return;
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  toggle.innerHTML = isDark ? ICONS.sun : ICONS.moon;
  toggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
  toggle.setAttribute("aria-pressed", String(isDark));
}

/* ================================= UI ================================= */

function showToast(message, type = "info") {
  const stack = document.getElementById("toastStack");
  if (!stack) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.setAttribute("role", "status");
  toast.textContent = message;
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => { toast.classList.remove("show"); setTimeout(() => toast.remove(), 350); }, 3800);
}

function showModal(html) {
  document.getElementById("modalBody").innerHTML = html;
  document.getElementById("modalOverlay").classList.add("active");
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("active");
  document.getElementById("modalBody").innerHTML = "";
}

function initModal() {
  document.getElementById("modalOverlay").addEventListener("click", (e) => { if (e.target.id === "modalOverlay") closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.getElementById("modalOverlay").classList.contains("active")) closeModal(); });
}

function infoItem(label, value) {
  return `<div class="info-item"><div class="info-title">${escapeHtml(label)}</div><div class="info-value">${escapeHtml(value ?? "—") || "—"}</div></div>`;
}

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDate(isoDate) {
  if (!isoDate) return "—";
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return String(isoDate);
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function formatCurrency(amount) {
  return `₹${Number(amount || 0).toLocaleString("en-IN")}`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ============================ ERROR HANDLING ============================ */

class AppError extends Error {
  constructor(userMessage, cause) { super(userMessage); this.userMessage = userMessage; this.cause = cause; }
}

function handleAppError(err, fallback = "Something went wrong. Please try again.") {
  showToast(err instanceof AppError ? err.userMessage : fallback, "error");
  console.error(err instanceof AppError ? (err.cause || err) : err);
}

function initGlobalErrorHandlers() {
  window.addEventListener("error", (e) => console.error("Global error:", e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => console.error("Unhandled rejection:", e.reason));
}

/* =============================== BOOTSTRAP =============================== */

document.addEventListener("DOMContentLoaded", async () => {
  initGlobalErrorHandlers();
  initModal();
  await bootstrapAuth();
  initTheme();
});
