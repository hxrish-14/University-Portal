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

  // Matches scripts/provision-auth-users.mjs exactly — a bare Staff/Admin
  // login_id (e.g. "Staff") maps to this domain; a full email (e.g.
  // "Admin@exampleedu.com") is used as-is.
  loginEmailDomain: "portal.local",

  tables: {
    profiles: "profiles", courses: "courses", subjects: "subjects",
    results: "results", arrearApplications: "arrear_exam_applications",
    feeRecords: "fee_records", portalSettings: "portal_settings",
    examTimetable: "exam_timetable", announcements: "announcements"
  },
  roles: { student: "student", staff: "staff", admin: "admin" }
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
      .eq("is_active", true)
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

// Shared by BOTH Staff and Admin — both are real Supabase Auth accounts,
// distinguished only by profiles.role after sign-in. A bare identifier
// (e.g. "Staff") is mapped to an email exactly the way
// scripts/provision-auth-users.mjs maps it when creating the account;
// a full email (e.g. "Admin@exampleedu.com") is used as typed.
function loginIdToEmail(identifier) {
  const trimmed = String(identifier).trim();
  return trimmed.includes("@") ? trimmed : `${trimmed.toLowerCase()}@${CONFIG.loginEmailDomain}`;
}

async function handleStaffLogin(e) {
  e.preventDefault();
  const identifier = document.getElementById("staffEmail").value.trim();
  const password = document.getElementById("staffPassword").value;
  const messageEl = document.getElementById("loginMessage");
  const btn = document.getElementById("staffLoginBtn");

  setLoginMessage(messageEl, "", "");
  if (!identifier || !password) {
    setLoginMessage(messageEl, "Please enter your ID/email and password.", "error");
    return;
  }

  setButtonBusy(btn, true, "Signing in…");
  try {
    const sb = getSupabase();
    if (!sb) throw new AppError("The portal isn't configured correctly. Please try again later.");

    const { data, error } = await sb.auth.signInWithPassword({ email: loginIdToEmail(identifier), password });
    if (error) throw new AppError("Invalid ID/email or password.", error);
    await resolveSessionAndRoute(data.user);
  } catch (err) {
    setLoginMessage(messageEl, err.userMessage || "Invalid ID/email or password.", "error");
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

  if (profile.is_active === false) {
    await handleLogout("This account has been deactivated. Please contact the portal administrator.");
    return;
  }

  APP.profile = profile;
  APP.role = profile.role === CONFIG.roles.admin ? CONFIG.roles.admin
    : profile.role === CONFIG.roles.staff ? CONFIG.roles.staff
    : CONFIG.roles.student;

  SessionManager.start(() => handleLogout("Your session expired due to inactivity. Please log in again."));

  if (APP.role === CONFIG.roles.admin) await renderAdminShell();
  else if (APP.role === CONFIG.roles.staff) await renderStaffShell();
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
          <button type="button" data-tab="staff" role="tab">Staff / Admin</button>
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
              <label for="staffEmail">Staff ID or Admin Email</label>
              <input type="text" id="staffEmail" placeholder="e.g. Staff or Admin@exampleedu.com" autocomplete="username" required>
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

// Shared by Staff's "Students" page (read-only) and Admin's "Students"
// page (full CRUD) via the `adminMode` flag — one table/search/paginate
// implementation, not two. StaffState.adminMode also gates which
// buttons render, never which DATA loads: the real permission boundary
// is server-side RLS (is_admin()), not this flag.
const StaffState = { page: 0, pageSize: 10, search: "", totalCount: 0, rows: [], selectedIds: new Set(), adminMode: false };

async function renderStaffShell() {
  mountAppShell({
    navItems: [
      { key: "dashboard", label: "Dashboard" },
      { key: "students", label: "Students" },
      { key: "reports", label: "Reports" },
      { key: "profile", label: "Profile" },
      { key: "help", label: "Help" }
    ],
    onNav: (key) => showStaffView(key)
  });
  showStaffView("dashboard");
}

function showStaffView(key) {
  setActiveNav(key);
  const main = document.getElementById("mainContent");
  if (key === "dashboard") return renderStaffDashboard(main);
  if (key === "students") { StaffState.adminMode = false; return renderStaffStudents(main); }
  if (key === "reports") return renderStaffResultExport(main);
  if (key === "profile") return renderStaffAdminProfile(main);
  if (key === "help") return renderHelpPage(main);
}

// Staff's own dashboard — deliberately NOT the student dashboard.
// No Current Semester / Attendance / CGPA / Arrears / Fees Pending
// here; those are student-only concepts and this account isn't
// enrolled as a student. Reused as-is by Admin's dashboard below.
async function renderStaffDashboard(main) {
  main.innerHTML = `
    <div class="container">
      <div class="page-head">
        <span class="eyebrow">Staff Dashboard</span>
        <h1>Welcome, ${escapeHtml(APP.profile.name)}</h1>
        <p>${CONFIG.collegeName}</p>
      </div>
      <div id="dashboardWidgets" class="loading-block"><div class="spinner"></div></div>
    </div>
  `;
  await renderOperationalDashboardWidgets(document.getElementById("dashboardWidgets"), { extraKpis: [] });
}

// The actual widget set (KPI + admissions chart + class chart +
// timetable + announcements), built from real `profiles`/`exam_timetable`/
// `announcements` data only — nothing here is fabricated. Shared by
// Staff and Admin dashboards; `extraKpis` lets Admin add its own cards
// without forking this function.
async function renderOperationalDashboardWidgets(container, { extraKpis = [] } = {}) {
  try {
    const sb = getSupabase();

    const [{ data: students, error: studentsError }, { data: timetable }, { data: news }] = await Promise.all([
      sb.from(CONFIG.tables.profiles).select("batch, year").eq("role", CONFIG.roles.student).eq("is_active", true),
      sb.from(CONFIG.tables.examTimetable).select("*, subjects(subject_name), courses(name)").gte("exam_date", new Date().toISOString().slice(0, 10)).order("exam_date", { ascending: true }).limit(5),
      sb.from(CONFIG.tables.announcements).select("*").eq("is_active", true).order("created_at", { ascending: false }).limit(5)
    ]);
    if (studentsError) throw new AppError("We couldn't load the dashboard right now.", studentsError);

    const rows = students || [];

    // Admissions by Year — parsed from the existing `batch` field
    // (e.g. "2023-2026" -> 2023). No new table, no invented numbers;
    // if batch is missing/unparseable for a student, they're simply
    // excluded from this chart rather than guessed at.
    const admissionCounts = new Map();
    rows.forEach((s) => {
      const match = String(s.batch || "").match(/^(\d{4})/);
      if (!match) return;
      const year = match[1];
      admissionCounts.set(year, (admissionCounts.get(year) || 0) + 1);
    });
    const admissionPairs = [...admissionCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    // Students by Year — from the existing `year` field.
    const yearCounts = new Map();
    rows.forEach((s) => { const y = s.year || "Unspecified"; yearCounts.set(y, (yearCounts.get(y) || 0) + 1); });
    const yearPairs = [...yearCounts.entries()];

    container.innerHTML = `
      <div class="stat-grid" style="margin-bottom:28px;">
        <div class="stat-card"><div class="stat-label">Active Students</div><div class="stat-value">${rows.length}</div></div>
        ${extraKpis.map((k) => `<div class="stat-card${k.seal ? " seal-card" : ""}"><div class="stat-label">${escapeHtml(k.label)}</div><div class="stat-value">${k.value}</div></div>`).join("")}
      </div>

      <div class="section-card">
        <h2>Admissions by Year</h2>
        ${admissionPairs.length
          ? renderBarChart(admissionPairs)
          : `<div class="empty-state"><div class="glyph">＋</div><h3>No Admissions Data Yet</h3><p>This chart is built from each student's <code>batch</code> field (e.g. "2023-2026"). Seed or edit student batches to populate it.</p></div>`}
      </div>

      <div class="section-card">
        <h2>Students by Year</h2>
        ${yearPairs.length
          ? renderBarChart(yearPairs, { barColor: "var(--accent-secondary)" })
          : `<div class="empty-state"><h3>No Student Data Yet</h3></div>`}
      </div>

      <div class="section-card">
        <h2>Upcoming Examination Timetable</h2>
        ${(timetable && timetable.length) ? `
          <div style="display:flex; flex-direction:column; gap:10px;">
            ${timetable.map((t) => `
              <div class="quick-link-card" style="text-align:left; cursor:default;">
                <div class="stat-label">${formatDate(t.exam_date)}${t.exam_time ? " · " + escapeHtml(t.exam_time) : ""}</div>
                <strong>${escapeHtml(t.subjects?.subject_name || "Subject TBD")}</strong>
                <div style="color:var(--text-muted); font-size:13px; margin-top:4px;">${escapeHtml(t.courses?.name || "")}${t.semester ? " · Semester " + t.semester : ""}${t.venue ? " · " + escapeHtml(t.venue) : ""}</div>
              </div>
            `).join("")}
          </div>
        ` : `<div class="empty-state"><div class="glyph">＋</div><h3>No Upcoming Exams Scheduled</h3><p>Add rows to <code>exam_timetable</code> to populate this section.</p></div>`}
      </div>

      <div class="section-card" id="announcementsCard">
        <h2>News &amp; Announcements</h2>
        <div id="announcementsList">
          ${(news && news.length) ? news.map((n) => `
            <div class="quick-link-card" style="text-align:left; cursor:default; margin-bottom:10px;">
              <strong>${escapeHtml(n.title)}</strong>
              <p style="color:var(--text-secondary); font-size:13.5px; margin-top:6px;">${escapeHtml(n.body)}</p>
              <div style="color:var(--text-muted); font-size:12px; margin-top:6px;">${formatDate(n.created_at)}</div>
            </div>
          `).join("") : `<div class="empty-state"><div class="glyph">＋</div><h3>No Announcements Yet</h3><p>Nothing posted yet.</p></div>`}
        </div>
        <div id="postAnnouncementSlot"></div>
      </div>
    `;

    if (APP.role === CONFIG.roles.admin) renderPostAnnouncementForm(document.getElementById("postAnnouncementSlot"));
  } catch (err) {
    handleAppError(err);
    container.innerHTML = `<div class="empty-state"><h3>Unable to load dashboard</h3><p>Please try again.</p></div>`;
  }
}

function renderPostAnnouncementForm(slot) {
  if (!slot) return;
  slot.innerHTML = `
    <form id="announcementForm" style="margin-top:18px; border-top:1px solid var(--border); padding-top:18px;">
      <div class="field"><label for="announcementTitle">Post an Announcement</label><input type="text" id="announcementTitle" placeholder="Title" required></div>
      <div class="field"><textarea id="announcementBody" rows="3" placeholder="Details" required style="padding:12px 16px; border-radius:var(--radius-sm); border:1px solid var(--border); background:var(--bg-secondary); color:var(--text); font-family:inherit; font-size:14px; resize:vertical;"></textarea></div>
      <button type="submit" class="btn btn-primary" id="announcementSubmitBtn">Post</button>
    </form>
  `;
  document.getElementById("announcementForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("announcementSubmitBtn");
    btn.disabled = true;
    try {
      const sb = getSupabase();
      const { error } = await sb.from(CONFIG.tables.announcements).insert({
        title: document.getElementById("announcementTitle").value.trim(),
        body: document.getElementById("announcementBody").value.trim(),
        posted_by: APP.profile.id
      });
      if (error) throw new AppError("Unable to post the announcement.", error);
      showToast("Announcement posted.", "success");
      await showAdminView("dashboard");
    } catch (err) {
      handleAppError(err);
      btn.disabled = false;
    }
  });
}

function renderStaffStudents(main) {
  main.innerHTML = `
    <div class="container">
      <div class="page-head"><span class="eyebrow">${StaffState.adminMode ? "Administration" : "Records"}</span><h1>Student Records</h1><p>${StaffState.adminMode ? "Search, manage, and export student data." : "Search, review, and export student data."}</p></div>

      <div class="results-toolbar">
        <div class="field" style="margin:0; min-width:260px;">
          <input type="text" id="staffSearch" placeholder="Search by register number, name, course, or batch">
        </div>
        <div class="button-row">
          ${StaffState.adminMode ? `<button class="btn btn-primary" id="addStudentBtn" type="button">Add Student</button>` : ""}
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
  document.getElementById("addStudentBtn")?.addEventListener("click", () => openStudentFormModal(null));

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

  const cols = StaffState.adminMode ? "30px 90px 1.2fr 80px 70px 70px 70px 80px 150px" : "30px 90px 1.4fr 90px 80px 80px 80px 90px";

  wrap.innerHTML = `
    <div class="ledger-head" style="grid-template-columns: ${cols};">
      <div></div><div>Reg No</div><div>Name</div><div>Course</div><div>Sem</div><div>CGPA</div><div>Arrears</div><div>Fees</div>${StaffState.adminMode ? "<div>Actions</div>" : ""}
    </div>
    ${StaffState.rows.map((s) => `
      <div class="ledger-row" style="grid-template-columns: ${cols}; ${StaffState.adminMode ? "cursor:default;" : ""}" data-id="${s.id}">
        <div><input type="checkbox" class="staff-select" data-id="${s.id}" ${StaffState.selectedIds.has(s.id) ? "checked" : ""}></div>
        <div class="mono">${escapeHtml(s.register_number)}</div>
        <div class="subject-name">${escapeHtml(s.name)} ${s.is_active === false ? '<span class="badge badge-fail" style="margin-left:6px;">INACTIVE</span>' : ""}</div>
        <div>${escapeHtml(s.course)}</div>
        <div>${s.current_semester ?? "—"}</div>
        <div class="mono">${s.cgpa != null ? Number(s.cgpa).toFixed(2) : "—"}</div>
        <div>${s.arrears ?? 0}</div>
        <div class="mono">${formatCurrency(s.fees_pending)}</div>
        ${StaffState.adminMode ? `
          <div class="button-row" style="gap:6px;">
            <button class="btn btn-ghost" style="height:32px; padding:0 10px; font-size:12.5px;" data-view="${s.id}">View</button>
            <button class="btn btn-ghost" style="height:32px; padding:0 10px; font-size:12.5px;" data-edit="${s.id}">Edit</button>
            <button class="btn btn-ghost" style="height:32px; padding:0 10px; font-size:12.5px; color:var(--danger);" data-toggle="${s.id}">${s.is_active === false ? "Reactivate" : "Deactivate"}</button>
          </div>
        ` : ""}
      </div>
    `).join("")}
  `;

  if (!StaffState.adminMode) {
    wrap.querySelectorAll(".ledger-row").forEach((row) => {
      row.addEventListener("click", (e) => { if (!e.target.classList.contains("staff-select")) openStudentDetail(Number(row.dataset.id)); });
    });
  } else {
    wrap.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => openStudentDetail(Number(b.dataset.view))));
    wrap.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openStudentFormModal(StaffState.rows.find((s) => s.id === Number(b.dataset.edit)))));
    wrap.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => toggleStudentActive(StaffState.rows.find((s) => s.id === Number(b.dataset.toggle)))));
  }

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
      ${infoItem("Status", student.is_active === false ? "Inactive" : "Active")}
    </div>
    <div class="button-row" style="margin-top:20px;">
      <button class="btn btn-primary" id="detailPdfBtn">Download Record PDF</button>
      ${StaffState.adminMode ? `<button class="btn btn-outline" id="detailEditBtn">Edit Student</button>` : ""}
    </div>
  `);

  document.getElementById("detailPdfBtn").addEventListener("click", () => exportStudentRecordPdf(student));
  document.getElementById("detailEditBtn")?.addEventListener("click", () => openStudentFormModal(student));
  loadAvatarInto(document.querySelector("#modalBody .avatar img"), student);
}

// ADMIN ONLY — reached only via a button rendered when StaffState.adminMode
// is true, which is only ever set when showAdminView("students") runs
// (itself only reachable through the Admin shell). The real boundary is still
// server-side: every write below goes through RLS's is_admin() check,
// so even a manually-triggered call from a non-admin session is
// rejected at the database regardless of what the UI shows.
function openStudentFormModal(student) {
  const isEdit = !!student;
  showModal(`
    <div class="modal-head"><h3>${isEdit ? "Edit Student" : "Add Student"}</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>
    <form id="studentForm" style="display:flex; flex-direction:column; gap:14px;">
      <div class="field"><label>Register Number (4 digits)</label><input type="text" id="f_register_number" value="${escapeHtml(student?.register_number || "")}" maxlength="4" pattern="\\d{4}" required></div>
      <div class="field"><label>Name</label><input type="text" id="f_name" value="${escapeHtml(student?.name || "")}" required></div>
      <div class="field"><label>Gender</label><input type="text" id="f_gender" value="${escapeHtml(student?.gender || "")}"></div>
      <div class="field"><label>Date of Birth</label><input type="date" id="f_dob" value="${student?.dob || ""}" required></div>
      <div class="field"><label>Phone</label><input type="text" id="f_phone" value="${escapeHtml(student?.phone || "")}"></div>
      <div class="field"><label>Parent Phone</label><input type="text" id="f_parent_phone" value="${escapeHtml(student?.parent_phone || "")}"></div>
      <div class="field"><label>Guardian</label><input type="text" id="f_guardian" value="${escapeHtml(student?.guardian || "")}"></div>
      <div class="field"><label>Address</label><input type="text" id="f_address" value="${escapeHtml(student?.address || "")}"></div>
      <div class="field"><label>Blood Group</label><input type="text" id="f_blood_group" value="${escapeHtml(student?.blood_group || "")}"></div>
      <div class="field"><label>Course</label><input type="text" id="f_course" value="${escapeHtml(student?.course || "BCA")}" required></div>
      <div class="field"><label>Batch</label><input type="text" id="f_batch" value="${escapeHtml(student?.batch || "")}" placeholder="e.g. 2024-2027"></div>
      <div class="field"><label>Year</label><input type="text" id="f_year" value="${escapeHtml(student?.year || "")}" placeholder="e.g. I Year"></div>
      <div class="field"><label>Current Semester</label><input type="number" id="f_current_semester" min="1" max="8" value="${student?.current_semester ?? ""}"></div>
      <div class="field"><label>Attendance %</label><input type="number" id="f_attendance" min="0" max="100" step="0.01" value="${student?.attendance_percentage ?? ""}"></div>
      ${isEdit ? `<div class="field"><label>Change Photo</label><input type="file" id="f_photo" accept="image/png,image/jpeg,image/webp"></div>` : ""}
      <p id="studentFormMessage" style="color:var(--danger); font-size:13px; min-height:1em;"></p>
      <div class="button-row">
        <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary" id="studentFormSubmit">${isEdit ? "Save Changes" : "Add Student"}</button>
      </div>
    </form>
  `);

  document.getElementById("studentForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("studentFormSubmit");
    const msg = document.getElementById("studentFormMessage");
    btn.disabled = true;
    msg.textContent = "";

    const payload = {
      register_number: document.getElementById("f_register_number").value.trim(),
      name: document.getElementById("f_name").value.trim(),
      gender: document.getElementById("f_gender").value.trim() || null,
      dob: document.getElementById("f_dob").value,
      phone: document.getElementById("f_phone").value.trim() || null,
      parent_phone: document.getElementById("f_parent_phone").value.trim() || null,
      guardian: document.getElementById("f_guardian").value.trim() || null,
      address: document.getElementById("f_address").value.trim() || null,
      blood_group: document.getElementById("f_blood_group").value.trim() || null,
      course: document.getElementById("f_course").value.trim(),
      batch: document.getElementById("f_batch").value.trim() || null,
      year: document.getElementById("f_year").value.trim() || null,
      current_semester: document.getElementById("f_current_semester").value ? Number(document.getElementById("f_current_semester").value) : null,
      attendance_percentage: document.getElementById("f_attendance").value ? Number(document.getElementById("f_attendance").value) : null
    };

    try {
      const sb = getSupabase();
      let targetId = student?.id;

      if (isEdit) {
        const { error } = await sb.from(CONFIG.tables.profiles).update(payload).eq("id", student.id);
        if (error) throw error;
      } else {
        payload.role = CONFIG.roles.student;
        const { data, error } = await sb.from(CONFIG.tables.profiles).insert(payload).select("id").single();
        if (error) throw error;
        targetId = data.id;
      }

      const photoFile = document.getElementById("f_photo")?.files?.[0];
      if (photoFile) await uploadAvatar(photoFile, { id: targetId, role: "student" });

      showToast(isEdit ? "Student updated." : "Student added.", "success");
      closeModal();
      loadStaffStudents();
    } catch (err) {
      msg.textContent = err.message?.includes("register_number")
        ? "That register number is already in use or isn't exactly 4 digits."
        : (err.message || "Unable to save. Please check the form and try again.");
      btn.disabled = false;
    }
  });
}

async function toggleStudentActive(student) {
  if (!student) return;
  const action = student.is_active === false ? "reactivate" : "deactivate";
  if (!confirm(`${action === "deactivate" ? "Deactivate" : "Reactivate"} ${student.name} (${student.register_number})?`)) return;

  try {
    const sb = getSupabase();
    const { error } = await sb.from(CONFIG.tables.profiles).update({ is_active: action === "reactivate" }).eq("id", student.id);
    if (error) throw error;
    showToast(`Student ${action}d.`, "success");
    loadStaffStudents();
  } catch (err) {
    showToast(err.message || "Unable to update this student.", "error");
  }
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

/* ================================ ADMIN ================================ */

async function renderAdminShell() {
  mountAppShell({
    navItems: [
      { key: "dashboard", label: "Dashboard" },
      { key: "students", label: "Students" },
      { key: "staff", label: "Staff" },
      { key: "reports", label: "Reports" },
      { key: "profile", label: "Profile" },
      { key: "help", label: "Help" }
    ],
    onNav: (key) => showAdminView(key)
  });
  showAdminView("dashboard");
}

function showAdminView(key) {
  setActiveNav(key);
  const main = document.getElementById("mainContent");
  if (key === "dashboard") return renderAdminDashboard(main);
  if (key === "students") { StaffState.adminMode = true; return renderStaffStudents(main); }
  if (key === "staff") return renderAdminStaffManagement(main);
  if (key === "reports") return renderStaffResultExport(main);
  if (key === "profile") return renderStaffAdminProfile(main);
  if (key === "help") return renderHelpPage(main);
}

async function renderAdminDashboard(main) {
  main.innerHTML = `
    <div class="container">
      <div class="page-head">
        <span class="eyebrow">Admin Dashboard</span>
        <h1>Welcome, ${escapeHtml(APP.profile.name)}</h1>
        <p>${CONFIG.collegeName}</p>
      </div>
      <div id="dashboardWidgets" class="loading-block"><div class="spinner"></div></div>
    </div>
  `;

  let extraKpis = [];
  try {
    const sb = getSupabase();
    const { data: staffAndAdmins } = await sb.from(CONFIG.tables.profiles).select("role").in("role", [CONFIG.roles.staff, CONFIG.roles.admin]).eq("is_active", true);
    const staffCount = (staffAndAdmins || []).filter((p) => p.role === CONFIG.roles.staff).length;
    const adminCount = (staffAndAdmins || []).filter((p) => p.role === CONFIG.roles.admin).length;
    extraKpis = [
      { label: "Active Staff", value: staffCount },
      { label: "Active Admins", value: adminCount, seal: true }
    ];
  } catch (err) {
    console.error(err);
  }

  await renderOperationalDashboardWidgets(document.getElementById("dashboardWidgets"), { extraKpis });
}

// Staff + Admin accounts only (role IN staff/admin) — students are
// managed on the Students page, not here.
async function renderAdminStaffManagement(main) {
  main.innerHTML = `
    <div class="container">
      <div class="page-head"><span class="eyebrow">Administration</span><h1>Staff &amp; Admin Accounts</h1><p>Manage staff/admin profiles. Creating a record here does not by itself create a login — see the note after adding one.</p></div>
      <div class="results-toolbar"><div></div><div class="button-row"><button class="btn btn-primary" id="addStaffBtn" type="button">Add Staff/Admin</button></div></div>
      <div class="ledger" id="staffMgmtWrap"><div class="loading-block"><div class="spinner"></div></div></div>
    </div>
  `;

  document.getElementById("addStaffBtn").addEventListener("click", () => openStaffFormModal(null));
  await loadStaffAccounts();
}

async function loadStaffAccounts() {
  const wrap = document.getElementById("staffMgmtWrap");
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from(CONFIG.tables.profiles).select("*").in("role", [CONFIG.roles.staff, CONFIG.roles.admin]).order("role").order("name");
    if (error) throw new AppError("We couldn't load staff accounts right now.", error);

    if (!data.length) { wrap.innerHTML = `<div class="empty-state"><h3>No Staff/Admin Accounts</h3></div>`; return; }

    wrap.innerHTML = `
      <div class="ledger-head" style="grid-template-columns: 1.3fr 110px 100px 90px 230px;"><div>Name</div><div>Login ID</div><div>Role</div><div>Status</div><div>Actions</div></div>
      ${data.map((p) => `
        <div class="ledger-row" style="grid-template-columns: 1.3fr 110px 100px 90px 230px; cursor:default;">
          <div class="subject-name">${escapeHtml(p.name)}</div>
          <div class="mono">${escapeHtml(p.login_id || "—")}</div>
          <div><span class="badge ${p.role === "admin" ? "badge-pass" : "badge-fail"}" style="background:var(--bg-secondary); color:var(--text);">${p.role.toUpperCase()}</span></div>
          <div>${p.is_active === false ? '<span class="badge badge-fail">INACTIVE</span>' : '<span class="badge badge-pass">ACTIVE</span>'}</div>
          <div class="button-row" style="gap:6px;">
            <button class="btn btn-ghost" style="height:32px; padding:0 10px; font-size:12.5px;" data-edit="${p.id}">Edit</button>
            <button class="btn btn-ghost" style="height:32px; padding:0 10px; font-size:12.5px;" data-reset="${p.id}">Reset Password</button>
            <button class="btn btn-ghost" style="height:32px; padding:0 10px; font-size:12.5px; color:var(--danger);" data-toggle="${p.id}">${p.is_active === false ? "Reactivate" : "Deactivate"}</button>
          </div>
        </div>
      `).join("")}
    `;

    wrap.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openStaffFormModal(data.find((p) => p.id === Number(b.dataset.edit)))));
    wrap.querySelectorAll("[data-reset]").forEach((b) => b.addEventListener("click", () => openResetPasswordInfoModal(data.find((p) => p.id === Number(b.dataset.reset)))));
    wrap.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => toggleStaffActive(data.find((p) => p.id === Number(b.dataset.toggle)))));
  } catch (err) {
    handleAppError(err);
    wrap.innerHTML = `<div class="empty-state"><h3>Unable to load staff accounts</h3></div>`;
  }
}

function openStaffFormModal(staff) {
  const isEdit = !!staff;
  showModal(`
    <div class="modal-head"><h3>${isEdit ? "Edit Staff/Admin" : "Add Staff/Admin"}</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>
    <form id="staffForm" style="display:flex; flex-direction:column; gap:14px;">
      <div class="field"><label>Display Name</label><input type="text" id="s_name" value="${escapeHtml(staff?.name || "")}" required></div>
      <div class="field"><label>Login ID ${isEdit ? "" : "(no spaces — this is what they'll type to log in)"}</label><input type="text" id="s_login_id" value="${escapeHtml(staff?.login_id || "")}" ${isEdit ? "readonly" : ""} required></div>
      <div class="field"><label>Role</label>
        <select id="s_role">
          <option value="staff" ${staff?.role === "staff" ? "selected" : ""}>Staff</option>
          <option value="admin" ${staff?.role === "admin" ? "selected" : ""}>Admin</option>
        </select>
      </div>
      ${isEdit ? `<div class="field"><label>Change Photo</label><input type="file" id="s_photo" accept="image/png,image/jpeg,image/webp"></div>` : ""}
      ${!isEdit ? `<p style="color:var(--text-muted); font-size:12.5px;">This creates the profile record only. To actually activate their login, run on a secure machine: <code>node scripts/provision-auth-users.mjs</code> (picks up every staff/admin profile missing a login automatically).</p>` : ""}
      <p id="staffFormMessage" style="color:var(--danger); font-size:13px; min-height:1em;"></p>
      <div class="button-row">
        <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary" id="staffFormSubmit">${isEdit ? "Save Changes" : "Add Account"}</button>
      </div>
    </form>
  `);

  document.getElementById("staffForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("staffFormSubmit");
    const msg = document.getElementById("staffFormMessage");
    btn.disabled = true;
    msg.textContent = "";

    try {
      const sb = getSupabase();
      const name = document.getElementById("s_name").value.trim();
      const role = document.getElementById("s_role").value;
      let targetId = staff?.id;

      if (isEdit) {
        const { error } = await sb.from(CONFIG.tables.profiles).update({ name, role }).eq("id", staff.id);
        if (error) throw error;
      } else {
        const login_id = document.getElementById("s_login_id").value.trim();
        const { data, error } = await sb.from(CONFIG.tables.profiles).insert({ role, login_id, name, college: CONFIG.collegeName, university: CONFIG.universityName }).select("id").single();
        if (error) throw error;
        targetId = data.id;
      }

      const photoFile = document.getElementById("s_photo")?.files?.[0];
      if (photoFile) await uploadAvatar(photoFile, { id: targetId, role, auth_user_id: staff?.auth_user_id });

      showToast(isEdit ? "Account updated." : "Account added — remember to run the provisioning script.", "success");
      closeModal();
      loadStaffAccounts();
    } catch (err) {
      msg.textContent = err.message?.includes("last active admin")
        ? "Cannot change the last active admin's role."
        : (err.message || "Unable to save. Please try again.");
      btn.disabled = false;
    }
  });
}

async function toggleStaffActive(staff) {
  if (!staff) return;
  const action = staff.is_active === false ? "reactivate" : "deactivate";
  if (!confirm(`${action === "deactivate" ? "Deactivate" : "Reactivate"} ${staff.name} (${staff.login_id})?`)) return;

  try {
    const sb = getSupabase();
    const { error } = await sb.from(CONFIG.tables.profiles).update({ is_active: action === "reactivate" }).eq("id", staff.id);
    if (error) throw error;
    showToast(`Account ${action}d.`, "success");
    loadStaffAccounts();
  } catch (err) {
    // Surfaces the database trigger's own message when it's the
    // last-admin guard firing — not a generic failure.
    showToast(err.message?.includes("last active admin") ? err.message : (err.message || "Unable to update this account."), "error");
  }
}

// Admin resetting SOMEONE ELSE's password genuinely cannot be done
// from the browser — it requires the Supabase service-role key, which
// must never be shipped to client code. This is the honest UI for
// that limitation: it tells the admin exactly what to run, rather
// than pretending a button here could do it.
function openResetPasswordInfoModal(staff) {
  showModal(`
    <div class="modal-head"><h3>Reset Password</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>
    <p style="color:var(--text-secondary); margin-bottom:14px;">Resetting ${escapeHtml(staff.name)}'s password requires the Supabase service-role key, which never runs in the browser. On a secure machine with that key set, run:</p>
    <pre style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-sm); padding:14px; font-family:var(--font-mono); font-size:12.5px; overflow-x:auto;">node scripts/provision-auth-users.mjs --reset-password ${escapeHtml(staff.login_id || "")} &lt;new-password&gt;</pre>
    <div class="button-row" style="margin-top:16px;"><button class="btn btn-primary" onclick="closeModal()">Got it</button></div>
  `);
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

// Redesigned Fees page: a clear top-level summary (billed/paid/pending),
// then fee records grouped by semester (falling back to an "Other Fees"
// group for records with no semester — see add-fee-semester.sql) so the
// page reads as an organized statement instead of one flat table.
// Reuses the same .section-card / .ledger / .badge / .stat-card
// components the rest of the portal already uses — no new visual
// language introduced, per the "preserve existing portal visual
// language" requirement.
async function renderStudentFees(main) {
  main.innerHTML = `
    <div class="container">
      <div class="page-head"><span class="eyebrow">Finance</span><h1>Fees</h1><p>Your fee records and current balance, grouped by semester.</p></div>
      <div id="feesContent" class="loading-block"><div class="spinner"></div></div>
    </div>
  `;

  try {
    const sb = getSupabase();
    const { data, error } = await sb.from(CONFIG.tables.feeRecords).select("*").eq("student_id", APP.profile.id)
      .order("semester", { ascending: true, nullsFirst: false }).order("due_date", { ascending: true });
    if (error) throw new AppError("We couldn't load your fee records right now.", error);

    const container = document.getElementById("feesContent");
    if (!data || data.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="glyph">₹</div><h3>No Fee Records</h3><p>No fee records are available yet.</p></div>`;
      return;
    }

    const totalBilled = data.reduce((sum, f) => sum + Number(f.amount || 0), 0);
    const totalPaid = data.reduce((sum, f) => sum + Number(f.paid_amount || 0), 0);
    const totalPending = data.reduce((sum, f) => sum + Number(f.pending_amount || 0), 0);

    // Group by semester; records with no semester (e.g. a one-off exam
    // fee) land in a trailing "Other Fees" group rather than being
    // hidden or forced into a guessed semester.
    const groups = new Map();
    data.forEach((f) => {
      const key = f.semester != null ? f.semester : "other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    });
    const orderedKeys = [...groups.keys()].sort((a, b) => {
      if (a === "other") return 1;
      if (b === "other") return -1;
      return a - b;
    });

    const todayIso = new Date().toISOString().slice(0, 10);
    const feeRow = (f) => {
      const isPaid = f.status === "paid";
      const isOverdue = !isPaid && f.due_date && f.due_date < todayIso;
      const label = isPaid ? "PAID" : isOverdue ? "OVERDUE" : "PENDING";
      return `
        <div class="ledger-row" style="grid-template-columns: 1.4fr 100px 100px 100px 100px 110px; cursor:default;">
          <div class="subject-name">${escapeHtml(f.fee_type)}</div>
          <div class="mono">${formatCurrency(f.amount)}</div>
          <div class="mono">${formatCurrency(f.paid_amount)}</div>
          <div class="mono">${formatCurrency(f.pending_amount)}</div>
          <div><span class="badge ${isPaid ? "badge-pass" : "badge-fail"}">${label}</span></div>
          <div class="mono">${f.due_date ? formatDate(f.due_date) : "—"}</div>
        </div>`;
    };

    const groupsHtml = orderedKeys.map((key) => {
      const rows = groups.get(key);
      const title = key === "other" ? "Other Fees" : `Semester ${key}`;
      const groupPending = rows.reduce((sum, f) => sum + Number(f.pending_amount || 0), 0);
      return `
        <div class="section-card">
          <h2 style="display:flex; align-items:baseline; justify-content:space-between; gap:12px; flex-wrap:wrap;">
            <span>${title}</span>
            <span class="mono" style="font-size:13px; font-weight:600; color:${groupPending > 0 ? "var(--danger)" : "var(--accent-secondary)"};">
              ${groupPending > 0 ? `${formatCurrency(groupPending)} pending` : "Fully paid"}
            </span>
          </h2>
          <div class="ledger">
            <div class="ledger-head" style="grid-template-columns: 1.4fr 100px 100px 100px 100px 110px;">
              <div>Fee Type</div><div>Amount</div><div>Paid</div><div>Pending</div><div>Status</div><div>Due Date</div>
            </div>
            <div>${rows.map(feeRow).join("")}</div>
          </div>
        </div>`;
    }).join("");

    container.innerHTML = `
      <div class="stat-grid" style="margin-bottom:28px;">
        <div class="stat-card"><div class="stat-label">Total Billed</div><div class="stat-value">${formatCurrency(totalBilled)}</div></div>
        <div class="stat-card"><div class="stat-label">Total Paid</div><div class="stat-value">${formatCurrency(totalPaid)}</div></div>
        <div class="seal-card stat-card"><div class="stat-label">Total Pending</div><div class="stat-value">${formatCurrency(totalPending)}</div></div>
      </div>
      ${groupsHtml}
      <p style="color:var(--text-muted); font-size:13px;">Online payment isn't wired up in this demo — see the accounts office to settle a pending balance.</p>
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
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(profile.name || "User")}&background=9A5B12&color=fff8ec&size=200`;
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

// Where a profile's photo lives in storage. Students (no auth.uid(),
// see AUTH section) are keyed by their profile id under a `students/`
// prefix, matching the anon storage policies in
// add-admin-staff-roles.sql. Staff/Admin (real auth.uid()) are keyed
// by that uid, matching the original, fully-secure self-only storage
// policies from database.sql. A staff/admin profile Admin has just
// created but not yet provisioned (no auth_user_id yet) falls back to
// an id-based path — the admin-bypass storage policy covers writing
// there regardless.
function avatarPathFor(profile) {
  if (profile.role === CONFIG.roles.student) return `students/${profile.id}/avatar`;
  if (profile.auth_user_id) return `${profile.auth_user_id}/avatar`;
  return `staff/${profile.id}/avatar`;
}

// `targetProfile` defaults to the caller's own profile (self-service
// upload — the overwhelmingly common case: a student or staff/admin
// changing their own photo). Admin management screens pass a specific
// OTHER profile explicitly; the data write still goes through RLS
// (is_admin() required for anyone but the row's own owner), so passing
// an arbitrary target here does not itself grant access.
async function uploadAvatar(file, targetProfile = APP.profile) {
  if (!CONFIG.allowedAvatarTypes.includes(file.type)) { showToast("Please upload a JPG, PNG, or WEBP image.", "error"); return; }
  if (file.size > CONFIG.maxAvatarSizeBytes) { showToast("Image is too large. Please choose a file under 2MB.", "error"); return; }

  const isSelf = targetProfile.id === APP.profile.id;
  showToast("Uploading photo…", "info");

  try {
    const sb = getSupabase();
    const ext = file.name.split(".").pop();
    const path = `${avatarPathFor(targetProfile)}.${ext}`;

    const { error: uploadError } = await sb.storage.from(CONFIG.avatarBucket).upload(path, file, { upsert: true, cacheControl: "3600" });
    if (uploadError) throw new AppError("Unable to upload the photo. Please try again.", uploadError);

    const { error: updateError } = await sb.from(CONFIG.tables.profiles).update({ profile_photo_path: path }).eq("id", targetProfile.id);
    if (updateError) throw new AppError("Photo uploaded, but we couldn't save it to the profile.", updateError);

    if (isSelf) {
      APP.profile.profile_photo_path = path;
      await loadAvatarInto(document.getElementById("avatarImg"), APP.profile);
    }
    showToast("Profile photo updated.", "success");
  } catch (err) {
    handleAppError(err);
  }
}

// Student Profile — trimmed to genuinely profile-level information.
// CGPA/Arrears/Attendance live on Dashboard, full results on Results,
// balance on Fees — not repeated here, per the "don't duplicate
// information that already belongs to a dedicated page" requirement.
// Personal → Academic (context only) → Institution, in that order,
// plus an editable Display Name.
function renderStudentProfile(main) {
  const p = APP.profile;
  main.innerHTML = `
    <div class="container">
      <div class="page-head"><span class="eyebrow">Profile</span><h1 id="studentProfileHeading">${escapeHtml(p.name)}</h1><p>Your personal and academic details.</p></div>

      <div class="profile-strip">
        <div class="avatar"><img id="avatarImg" alt="Profile photo" src="${resolveAvatarUrl(p)}" loading="lazy"></div>
        <div>
          <h2 id="studentDisplayName">${escapeHtml(p.name)}</h2>
          <div class="profile-meta"><span>Reg. No <strong class="mono">${escapeHtml(p.register_number)}</strong></span></div>
          <div class="button-row" style="margin-top:14px;">
            <label class="btn btn-outline" style="cursor:pointer;">Change Photo<input type="file" id="avatarInput" accept="image/png,image/jpeg,image/webp" style="display:none;"></label>
          </div>
        </div>
      </div>

      <div class="section-card">
        <h2>Display Name</h2>
        <form id="nameForm" class="button-row" style="align-items:flex-end;">
          <div class="field" style="flex:1; margin:0;"><label for="nameInput">Name</label><input type="text" id="nameInput" value="${escapeHtml(p.name)}" required></div>
          <button type="submit" class="btn btn-primary">Save</button>
        </form>
      </div>

      <div class="section-card">
        <h2>Personal Information</h2>
        <div class="info-grid">
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
        <h2>Academic Context</h2>
        <div class="info-grid">
          ${infoItem("Course", p.course)}
          ${infoItem("Batch", p.batch)}
          ${infoItem("Year", p.year)}
          ${infoItem("Current Semester", p.current_semester)}
        </div>
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

  document.getElementById("nameForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const newName = document.getElementById("nameInput").value.trim();
    if (!newName) return;
    try {
      const sb = getSupabase();
      const { error } = await sb.from(CONFIG.tables.profiles).update({ name: newName }).eq("id", p.id);
      if (error) throw error;
      APP.profile.name = newName;
      document.getElementById("studentDisplayName").textContent = newName;
      document.getElementById("studentProfileHeading").textContent = newName;
      showToast("Name updated.", "success");
    } catch (err) {
      showToast(err.message || "Unable to update name.", "error");
    }
  });
}

// Staff/Admin Profile — deliberately simple: photo, display name,
// password change, institution, logout. No fees/results/CGPA/
// attendance/arrears/register-number — those are student-only
// concepts this account doesn't have.
function renderStaffAdminProfile(main) {
  const p = APP.profile;
  main.innerHTML = `
    <div class="container">
      <div class="page-head"><span class="eyebrow">Profile</span><h1 id="staffProfileHeading">${escapeHtml(p.name)}</h1><p>${p.role === CONFIG.roles.admin ? "Administrator" : "Staff"} account.</p></div>

      <div class="profile-strip">
        <div class="avatar"><img id="avatarImg" alt="Profile photo" src="${resolveAvatarUrl(p)}" loading="lazy"></div>
        <div>
          <h2 id="staffDisplayName">${escapeHtml(p.name)}</h2>
          <div class="profile-meta"><span>Login ID <strong class="mono">${escapeHtml(p.login_id || "—")}</strong></span></div>
          <div class="button-row" style="margin-top:14px;">
            <label class="btn btn-outline" style="cursor:pointer;">Change Photo<input type="file" id="avatarInput" accept="image/png,image/jpeg,image/webp" style="display:none;"></label>
          </div>
        </div>
      </div>

      <div class="section-card">
        <h2>Display Name</h2>
        <form id="nameForm" class="button-row" style="align-items:flex-end;">
          <div class="field" style="flex:1; margin:0;"><label for="nameInput">Name</label><input type="text" id="nameInput" value="${escapeHtml(p.name)}" required></div>
          <button type="submit" class="btn btn-primary">Save</button>
        </form>
      </div>

      <div class="section-card">
        <h2>Change Password</h2>
        <form id="passwordForm" style="display:flex; flex-direction:column; gap:14px; max-width:360px;">
          <div class="field"><label for="newPassword">New Password</label><input type="password" id="newPassword" minlength="6" required></div>
          <div class="field"><label for="confirmPassword">Confirm Password</label><input type="password" id="confirmPassword" minlength="6" required></div>
          <p id="passwordMessage" style="font-size:13px; min-height:1em;"></p>
          <button type="submit" class="btn btn-primary" id="passwordSubmitBtn" style="align-self:flex-start;">Update Password</button>
        </form>
      </div>

      <div class="section-card">
        <h2>Institution</h2>
        <div class="info-grid">
          ${infoItem("College", p.college || CONFIG.collegeName)}
          ${infoItem("University", p.university || CONFIG.universityName)}
        </div>
      </div>

      <div class="button-row"><button class="btn btn-outline" id="profileLogoutBtn" type="button">Logout</button></div>
    </div>
  `;

  document.getElementById("avatarInput")?.addEventListener("change", (e) => { const file = e.target.files?.[0]; if (file) uploadAvatar(file); });
  loadAvatarInto(document.getElementById("avatarImg"), p);

  document.getElementById("nameForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const newName = document.getElementById("nameInput").value.trim();
    if (!newName) return;
    try {
      const sb = getSupabase();
      const { error } = await sb.from(CONFIG.tables.profiles).update({ name: newName }).eq("id", p.id);
      if (error) throw error;
      APP.profile.name = newName;
      document.getElementById("staffDisplayName").textContent = newName;
      document.getElementById("staffProfileHeading").textContent = newName;
      showToast("Name updated.", "success");
    } catch (err) {
      showToast(err.message || "Unable to update name.", "error");
    }
  });

  document.getElementById("passwordForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("passwordMessage");
    const btn = document.getElementById("passwordSubmitBtn");
    const pw = document.getElementById("newPassword").value;
    const confirmPw = document.getElementById("confirmPassword").value;
    msg.style.color = "var(--danger)";

    if (pw !== confirmPw) { msg.textContent = "Passwords don't match."; return; }
    if (pw.length < 6) { msg.textContent = "Password must be at least 6 characters."; return; }

    btn.disabled = true;
    msg.textContent = "";
    try {
      const sb = getSupabase();
      // Operates on the CURRENT authenticated session — this is
      // exactly the "require current authentication" rule: it's only
      // callable at all because a valid Supabase Auth session already
      // exists for this user.
      const { error } = await sb.auth.updateUser({ password: pw });
      if (error) throw error;
      msg.style.color = "var(--accent-secondary)";
      msg.textContent = "Password updated.";
      document.getElementById("passwordForm").reset();
    } catch (err) {
      msg.textContent = err.message || "Unable to update password.";
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("profileLogoutBtn").addEventListener("click", () => handleLogout());
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

// Minimal inline-SVG bar chart — no charting library. `pairs` is an
// array of [label, value]. Colors use style="" (not the fill=
// attribute) because CSS var() only resolves inside an actual style
// context, not a raw SVG presentation attribute.
function renderBarChart(pairs, { width = 560, height = 200, barColor = "var(--accent)" } = {}) {
  if (!pairs.length) return "";
  const max = Math.max(...pairs.map((p) => Number(p[1]) || 0), 1);
  const barWidth = Math.max(24, Math.min(56, (width - 20) / pairs.length - 14));
  const gap = (width - pairs.length * barWidth) / (pairs.length + 1);

  const bars = pairs.map(([label, value], i) => {
    const barHeight = Math.round((Number(value) / max) * (height - 46));
    const x = gap + i * (barWidth + gap);
    const y = height - 28 - barHeight;
    return `
      <rect x="${x}" y="${y}" width="${barWidth}" height="${Math.max(barHeight, 2)}" rx="4" style="fill:${barColor}"></rect>
      <text x="${x + barWidth / 2}" y="${height - 10}" text-anchor="middle" font-size="11" style="fill:var(--text-muted)">${escapeHtml(label)}</text>
      <text x="${x + barWidth / 2}" y="${y - 6}" text-anchor="middle" font-size="11" font-weight="700" style="fill:var(--text)">${value}</text>
    `;
  }).join("");

  return `<svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; max-height:220px; display:block;" role="img" aria-label="Bar chart">${bars}</svg>`;
}

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

// Casual deterrent ONLY — disables the right-click context menu so
// browsing feels less "inspectable" at a glance. This is NOT security:
// DevTools (F12 / Ctrl+Shift+I), view-source, and the Network tab all
// remain fully available to anyone who wants them — no client-side
// JavaScript can prevent that. Real protection for this app lives
// entirely in RLS + the profile-field-protection trigger server-side,
// not here.
function initContextMenuDeterrent() {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
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
  initContextMenuDeterrent();
  await bootstrapAuth();
  initTheme();
});
