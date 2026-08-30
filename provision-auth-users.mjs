#!/usr/bin/env node
/**
 * scripts/provision-auth-users.mjs
 *
 * The one file outside index.html/style.css/app.js/database.sql this
 * project needs — and it exists for a specific, unavoidable reason:
 * Supabase manages auth.users itself. Inserting rows into it directly
 * with SQL bypasses password hashing and Supabase's own bookkeeping,
 * so it isn't a safe way to create accounts. The Admin API (called
 * here) is correct, but it requires the SERVICE ROLE KEY — a secret
 * that must never reach the browser. That's why this is a separate,
 * local/CI-only Node script and not part of app.js.
 *
 * WHAT IT DOES
 *   - For each seeded student profile (role='student'): creates (or
 *     finds) a Supabase Auth user at {register_number}@<domain>, with
 *     password = that student's own DOB, digits only (e.g. DOB
 *     2004-05-15 -> password "20040515"). This matches the login
 *     screen's Register Number + DOB fields exactly.
 *   - For the staff profile: creates (or finds) staff@exampleedu.com
 *     / stafflogin@123 (override via env vars below).
 *   - Links every created/found auth user id back into
 *     profiles.auth_user_id.
 *
 * USAGE
 *   1. Run database.sql first (creates 25 student profiles + 1 staff
 *      profile with auth_user_id = NULL).
 *   2. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see below) —
 *      never commit real values.
 *   3. node scripts/provision-auth-users.mjs
 *
 * SAFE TO RE-RUN: existing accounts are found, not duplicated;
 * profiles are simply re-linked. Nothing is ever deleted.
 *
 * Requires Node 18+ (for global fetch). No npm install needed.
 *
 * Environment variables:
 *   SUPABASE_URL                (required)
 *   SUPABASE_SERVICE_ROLE_KEY   (required, secret - server/CI only)
 *   STUDENT_EMAIL_DOMAIN        (default: student.gasc-demo.edu)
 *   STAFF_EMAIL                 (default: staff@exampleedu.com)
 *   STAFF_PASSWORD              (default: stafflogin@123)
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STUDENT_EMAIL_DOMAIN = process.env.STUDENT_EMAIL_DOMAIN || "student.gasc-demo.edu";
const STAFF_EMAIL = process.env.STAFF_EMAIL || "staff@exampleedu.com";
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || "stafflogin@123";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.");
  process.exit(1);
}

const adminHeaders = {
  "Content-Type": "application/json",
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`
};

async function restRequest(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...options, headers: { ...adminHeaders, ...(options.headers || {}) } });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${options.method || "GET"} ${path} failed (${res.status}): ${JSON.stringify(body)}`);
  return body;
}

async function findAuthUserByEmail(email) {
  let page = 1;
  while (true) {
    const result = await restRequest(`/auth/v1/admin/users?page=${page}&per_page=200`);
    const match = result.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) return match;
    if (!result.users.length || result.users.length < 200) return null;
    page++;
  }
}

async function createAuthUser(email, password) {
  return restRequest("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email, password, email_confirm: true }) });
}

async function findOrCreateAuthUser(email, password) {
  const existing = await findAuthUserByEmail(email);
  if (existing) return { user: existing, created: false };
  const created = await createAuthUser(email, password);
  return { user: created, created: true };
}

async function fetchProfiles() {
  return restRequest(`/rest/v1/profiles?select=id,role,register_number,dob&order=role.asc,register_number.asc`, {
    headers: { Prefer: "return=representation" }
  });
}

async function linkProfile(profileId, authUserId) {
  await restRequest(`/rest/v1/profiles?id=eq.${profileId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ auth_user_id: authUserId })
  });
}

function dobToPassword(dob) {
  // "2004-05-15" -> "20040515" -- matches app.js's dobToPassword() exactly.
  return String(dob).replace(/-/g, "");
}

async function main() {
  console.log("Fetching seeded profiles...");
  const profiles = await fetchProfiles();

  if (!profiles.length) {
    console.error("No profiles found. Run database.sql first.");
    process.exit(1);
  }

  let created = 0, linked = 0, failed = 0;

  for (const profile of profiles) {
    const isStaff = profile.role === "staff";
    const email = isStaff ? STAFF_EMAIL : `${profile.register_number}@${STUDENT_EMAIL_DOMAIN}`;

    if (!isStaff && !profile.dob) {
      failed++;
      console.error(`SKIPPED ${email}: profile has no dob, cannot derive a password.`);
      continue;
    }

    const password = isStaff ? STAFF_PASSWORD : dobToPassword(profile.dob);

    try {
      const { user, created: wasCreated } = await findOrCreateAuthUser(email, password);
      await linkProfile(profile.id, user.id);
      if (wasCreated) created++;
      linked++;
      console.log(`${wasCreated ? "Created" : "Found  "} + linked  ${email}  ->  profile #${profile.id}`);
    } catch (err) {
      failed++;
      console.error(`FAILED for ${email}:`, err.message);
    }
  }

  console.log("\n---- Summary ----");
  console.log(`Profiles processed: ${profiles.length}`);
  console.log(`Auth users created: ${created}`);
  console.log(`Profiles linked:    ${linked}`);
  console.log(`Failures:           ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Provisioning failed:", err);
  process.exit(1);
});
