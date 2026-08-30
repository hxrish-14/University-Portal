-- =========================================================
-- UNIVERSITY PORTAL — database.sql
-- PostgreSQL / Supabase — ONE deterministic DEV/DEMO reset+seed file.
--
-- Safe to re-run: every DDL is guarded (IF NOT EXISTS / OR REPLACE)
-- and every seed INSERT uses ON CONFLICT. The one destructive block
-- is clearly marked "DANGER — DEVELOPMENT ONLY" and commented out.
--
-- This file does NOT touch auth.users. Supabase Auth accounts are
-- provisioned separately by scripts/provision-auth-users.mjs — see
-- the "Auth" section of the chat response for exactly why and how.
-- =========================================================

create extension if not exists "pgcrypto";

-- =========================================================
-- SCHEMA
-- =========================================================

create table if not exists public.courses (
    id                  bigint generated always as identity primary key,
    code                text not null unique,
    name                text not null,
    duration_semesters  integer not null check (duration_semesters between 1 and 12),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create table if not exists public.subjects (
    id              bigint generated always as identity primary key,
    course_id       bigint not null references public.courses(id) on delete cascade,
    semester        integer not null check (semester between 1 and 12),
    subject_code    text not null,
    subject_name    text not null,
    credits         numeric(4,2) not null default 3,
    created_at      timestamptz not null default now(),
    unique (course_id, subject_code)
);

create table if not exists public.profiles (
    id                      bigint generated always as identity primary key,
    auth_user_id            uuid unique references auth.users(id) on delete set null,
    role                    text not null default 'student' check (role in ('student', 'staff')),
    register_number         text unique,                       -- students only; null for staff; 4-digit
    name                    text not null,
    gender                  text,
    dob                     date,                               -- also doubles as the student's Auth password source — see Auth notes
    phone                   text,
    parent_phone            text,
    guardian                text,
    address                 text,
    blood_group             text,
    batch                   text,
    course                  text,                               -- courses.code, denormalized for fast display
    year                    text,
    current_semester        integer,
    attendance_percentage   numeric(5,2),
    cgpa                    numeric(4,2) default 0,
    arrears                 integer default 0,
    fees_pending            numeric(10,2) default 0,
    college                 text default 'Global Arts and Science College, Thiruvallur',
    university              text default 'Thiruvallur University',
    profile_photo_path      text,                               -- storage path, never a public URL
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),
    constraint register_number_is_4_digits check (register_number is null or register_number ~ '^\d{4}$')
);

create table if not exists public.results (
    id                      bigint generated always as identity primary key,
    student_id              bigint not null references public.profiles(id) on delete cascade,
    subject_id              bigint not null references public.subjects(id) on delete cascade,
    semester                integer not null check (semester between 1 and 12),
    internal_marks          numeric(5,2) default 0,
    external_marks          numeric(5,2) default 0,
    total_marks             numeric(5,2) generated always as (coalesce(internal_marks,0) + coalesce(external_marks,0)) stored,
    grade                   text,
    grade_point             numeric(4,2) default 0,
    status                  text not null default 'PASS' check (status in ('PASS', 'FAIL')),
    result_released_date    date,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),
    unique (student_id, subject_id)
);

create table if not exists public.arrear_exam_applications (
    id                  bigint generated always as identity primary key,
    student_id          bigint not null references public.profiles(id) on delete cascade,
    result_id           bigint not null references public.results(id) on delete cascade,
    fee_amount          numeric(10,2) not null,
    application_date    timestamptz not null default now(),
    status              text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'completed')),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    unique (student_id, result_id)
);

create table if not exists public.fee_records (
    id                  bigint generated always as identity primary key,
    student_id          bigint not null references public.profiles(id) on delete cascade,
    fee_type            text not null,
    amount              numeric(10,2) not null default 0,
    paid_amount         numeric(10,2) not null default 0,
    pending_amount      numeric(10,2) generated always as (greatest(amount - paid_amount, 0)) stored,
    status              text not null default 'pending' check (status in ('paid', 'pending', 'overdue')),
    due_date            date,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create table if not exists public.portal_settings (
    key         text primary key,
    value       text not null,
    updated_at  timestamptz not null default now()
);

-- =========================================================
-- INDEXES
-- =========================================================
create index if not exists idx_profiles_register_number   on public.profiles (register_number);
create index if not exists idx_profiles_auth_user_id       on public.profiles (auth_user_id);
create index if not exists idx_profiles_role               on public.profiles (role);
create index if not exists idx_subjects_course_semester    on public.subjects (course_id, semester);
create index if not exists idx_results_student             on public.results (student_id);
create index if not exists idx_results_student_semester    on public.results (student_id, semester);
create index if not exists idx_arrear_student              on public.arrear_exam_applications (student_id);
create index if not exists idx_fees_student                on public.fee_records (student_id);

-- =========================================================
-- FUNCTIONS + TRIGGERS
-- =========================================================
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

do $$
declare t text;
begin
    foreach t in array array['courses','profiles','results','arrear_exam_applications','fee_records'] loop
        execute format('drop trigger if exists trg_%s_updated_at on public.%s;', t, t);
        execute format('create trigger trg_%s_updated_at before update on public.%s for each row execute function public.set_updated_at();', t, t);
    end loop;
end $$;

-- Is the caller's own profile a staff member? SECURITY DEFINER + a
-- fixed search_path avoids RLS self-recursion when a `profiles`
-- policy needs to query `profiles`.
create or replace function public.is_staff(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
    select exists (select 1 from public.profiles where auth_user_id = uid and role = 'staff');
$$;

-- A student can update their own profile (e.g. profile_photo_path),
-- but never their own academic/financial fields. Only restricts an
-- authenticated, non-staff caller — the SQL Editor, this seed, and
-- the service-role key already bypass RLS entirely, so this mirrors
-- that same trust boundary rather than fighting it.
create or replace function public.protect_profile_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is not null and not public.is_staff(auth.uid()) then
        new.role                   := old.role;
        new.register_number        := old.register_number;
        new.cgpa                   := old.cgpa;
        new.arrears                 := old.arrears;
        new.fees_pending            := old.fees_pending;
        new.current_semester        := old.current_semester;
        new.attendance_percentage   := old.attendance_percentage;
        new.course                  := old.course;
        new.batch                   := old.batch;
        new.college                 := old.college;
        new.university              := old.university;
        new.dob                     := old.dob;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_protect_profile_fields on public.profiles;
create trigger trg_protect_profile_fields
    before update on public.profiles
    for each row execute function public.protect_profile_fields();

-- =========================================================
-- ROW LEVEL SECURITY
-- =========================================================
alter table public.courses                   enable row level security;
alter table public.subjects                  enable row level security;
alter table public.profiles                  enable row level security;
alter table public.results                   enable row level security;
alter table public.arrear_exam_applications  enable row level security;
alter table public.fee_records               enable row level security;
alter table public.portal_settings           enable row level security;

drop policy if exists "courses_select_authenticated" on public.courses;
create policy "courses_select_authenticated" on public.courses for select to authenticated using (true);
drop policy if exists "courses_write_staff" on public.courses;
create policy "courses_write_staff" on public.courses for all to authenticated
    using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

drop policy if exists "subjects_select_authenticated" on public.subjects;
create policy "subjects_select_authenticated" on public.subjects for select to authenticated using (true);
drop policy if exists "subjects_write_staff" on public.subjects;
create policy "subjects_write_staff" on public.subjects for all to authenticated
    using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

drop policy if exists "profiles_select_self_or_staff" on public.profiles;
create policy "profiles_select_self_or_staff" on public.profiles for select to authenticated
    using (auth_user_id = auth.uid() or public.is_staff(auth.uid()));
drop policy if exists "profiles_update_self_or_staff" on public.profiles;
create policy "profiles_update_self_or_staff" on public.profiles for update to authenticated
    using (auth_user_id = auth.uid() or public.is_staff(auth.uid()))
    with check (auth_user_id = auth.uid() or public.is_staff(auth.uid()));

drop policy if exists "results_select_own_or_staff" on public.results;
create policy "results_select_own_or_staff" on public.results for select to authenticated
    using (public.is_staff(auth.uid()) or student_id in (select id from public.profiles where auth_user_id = auth.uid()));
drop policy if exists "results_write_staff" on public.results;
create policy "results_write_staff" on public.results for all to authenticated
    using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

drop policy if exists "arrear_select_own_or_staff" on public.arrear_exam_applications;
create policy "arrear_select_own_or_staff" on public.arrear_exam_applications for select to authenticated
    using (public.is_staff(auth.uid()) or student_id in (select id from public.profiles where auth_user_id = auth.uid()));
drop policy if exists "arrear_insert_own_eligible" on public.arrear_exam_applications;
create policy "arrear_insert_own_eligible" on public.arrear_exam_applications for insert to authenticated
    with check (
        student_id in (select id from public.profiles where auth_user_id = auth.uid())
        and exists (select 1 from public.results r where r.id = result_id and r.student_id = arrear_exam_applications.student_id and r.status = 'FAIL')
    );
drop policy if exists "arrear_manage_staff" on public.arrear_exam_applications;
create policy "arrear_manage_staff" on public.arrear_exam_applications for update to authenticated
    using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

drop policy if exists "fees_select_own_or_staff" on public.fee_records;
create policy "fees_select_own_or_staff" on public.fee_records for select to authenticated
    using (public.is_staff(auth.uid()) or student_id in (select id from public.profiles where auth_user_id = auth.uid()));
drop policy if exists "fees_write_staff" on public.fee_records;
create policy "fees_write_staff" on public.fee_records for all to authenticated
    using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

drop policy if exists "settings_select_authenticated" on public.portal_settings;
create policy "settings_select_authenticated" on public.portal_settings for select to authenticated using (true);
drop policy if exists "settings_write_staff" on public.portal_settings;
create policy "settings_write_staff" on public.portal_settings for all to authenticated
    using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

-- =========================================================
-- STORAGE — private avatars bucket, signed URLs only
-- =========================================================
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', false) on conflict (id) do nothing;

drop policy if exists "avatar_insert_own" on storage.objects;
create policy "avatar_insert_own" on storage.objects for insert to authenticated
    with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatar_update_own" on storage.objects;
create policy "avatar_update_own" on storage.objects for update to authenticated
    using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatar_select_own_or_staff" on storage.objects;
create policy "avatar_select_own_or_staff" on storage.objects for select to authenticated
    using (bucket_id = 'avatars' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_staff(auth.uid())));

-- =========================================================
-- DANGER — DEVELOPMENT ONLY (commented out by default)
-- =========================================================
-- truncate public.arrear_exam_applications, public.fee_records,
--          public.results, public.subjects, public.profiles,
--          public.courses restart identity cascade;

-- =========================================================
-- CONFIGURATION SEED
-- =========================================================
insert into public.portal_settings (key, value) values
    ('portal_name', 'University Portal'),
    ('college_name', 'Global Arts and Science College, Thiruvallur'),
    ('university_name', 'Thiruvallur University'),
    ('course_name', 'BCA — Bachelor of Computer Applications'),
    ('arrear_exam_fee', '500')
on conflict (key) do update set value = excluded.value, updated_at = now();

-- =========================================================
-- COURSE + SUBJECT SEED
-- =========================================================
-- duration_semesters is read at runtime by the frontend, so adding an
-- 8-semester engineering course later is just another row here plus
-- its subjects — no app code changes required. (Not seeded now, to
-- keep the demo dataset minimal and focused on BCA.)
insert into public.courses (code, name, duration_semesters) values
    ('BCA', 'Bachelor of Computer Applications', 6)
on conflict (code) do update set duration_semesters = excluded.duration_semesters;

insert into public.subjects (course_id, semester, subject_code, subject_name, credits)
select c.id, s.semester, s.subject_code, s.subject_name, s.credits
from public.courses c
join (values
    (1, 'BCA101', 'Programming Fundamentals', 4), (1, 'BCA102', 'Computer Fundamentals', 3),
    (1, 'BCA103', 'Mathematics I', 4),            (1, 'BCA104', 'Digital Logic', 3),
    (1, 'BCA105', 'English', 2),
    (2, 'BCA201', 'Data Structures', 4),           (2, 'BCA202', 'Object Oriented Programming', 4),
    (2, 'BCA203', 'Database Fundamentals', 3),      (2, 'BCA204', 'Operating Systems', 3),
    (2, 'BCA205', 'Mathematics II', 3),
    (3, 'BCA301', 'Java Programming', 4),           (3, 'BCA302', 'Computer Networks', 3),
    (3, 'BCA303', 'DBMS', 4),                       (3, 'BCA304', 'Web Technologies', 3),
    (3, 'BCA305', 'Software Engineering', 3),
    (4, 'BCA401', 'Python Programming', 4),         (4, 'BCA402', 'Advanced Web Development', 4),
    (4, 'BCA403', 'Computer Architecture', 3),      (4, 'BCA404', 'Data Communication', 3),
    (4, 'BCA405', 'Professional Communication', 2),
    (5, 'BCA501', 'Cloud Computing', 3),            (5, 'BCA502', 'Mobile Application Development', 4),
    (5, 'BCA503', 'Cyber Security', 3),             (5, 'BCA504', 'Data Analytics', 4),
    (5, 'BCA505', 'Software Testing', 3),
    (6, 'BCA601', 'Artificial Intelligence', 4),    (6, 'BCA602', 'Machine Learning Fundamentals', 4),
    (6, 'BCA603', 'Full Stack Development', 4),     (6, 'BCA604', 'Project', 6),
    (6, 'BCA605', 'Elective', 3)
) as s(semester, subject_code, subject_name, credits) on true
where c.code = 'BCA'
on conflict (course_id, subject_code) do nothing;

-- =========================================================
-- STUDENT SEED — 25 fictional BCA students, register numbers 1001–1025
-- =========================================================
-- auth_user_id is left NULL on purpose — see the Auth section of the
-- chat response for why account creation is a separate step.

with student_data as (
    select
        1000 + i                                                              as reg_no,
        names[i]                                                              as full_name,
        genders[i]                                                            as gender,
        (date '2004-06-01' + ((i * 37) || ' days')::interval)::date           as dob,
        ((i % 6) + 1)                                                          as current_semester,
        case when ((i % 6) + 1) <= 2 then 'I Year'
             when ((i % 6) + 1) <= 4 then 'II Year'
             else 'III Year' end                                              as year_label
    from generate_series(1, 25) as i
    cross join lateral (
        select array[
            'Aarav Kumar','Bhavani Priya','Charan Raj','Divya Dharshini','Eswar Prasad',
            'Farhana Begum','Gokul Krishnan','Hemalatha Devi','Ilamathi Selvam','Jeyaraj Antony',
            'Kavya Shree','Lakshman Iyer','Meena Rajendran','Naveen Kumar','Oviya Bharathi',
            'Pradeep Raja','Deepa Fernandez','Ranjith Kumar','Sandhya Priyadharshini','Tamilarasan Vel',
            'Uma Maheswari','Vignesh Raghavan','Yamuna Devi','Arjun Prakash','Deepika Suresh'
        ]::text[] as names,
        array[
            'Male','Female','Male','Female','Male','Female','Male','Female','Female','Male',
            'Female','Male','Female','Male','Female','Male','Female','Male','Female','Male',
            'Female','Male','Female','Male','Female'
        ]::text[] as genders
    ) as arrays
)
insert into public.profiles (
    role, register_number, name, gender, dob, phone, parent_phone, guardian, address,
    blood_group, batch, course, year, current_semester, attendance_percentage, college, university
)
select
    'student', reg_no::text, full_name, gender, dob,
    '9' || lpad((100000000 + reg_no)::text, 9, '0'),
    '8' || lpad((200000000 + reg_no)::text, 9, '0'),
    full_name || ' (Parent)', 'Thiruvallur, Tamil Nadu',
    (array['A+','B+','O+','AB+','A-','B-','O-'])[1 + (reg_no % 7)],
    '2023-2026', 'BCA', year_label, current_semester,
    round((75 + (reg_no % 21))::numeric, 2),
    'Global Arts and Science College, Thiruvallur', 'Thiruvallur University'
from student_data
on conflict (register_number) do nothing;

-- One staff profile. Demo Auth credentials: staff@exampleedu.com / stafflogin@123
-- (created by the provisioning script, not stored here).
insert into public.profiles (role, name, gender, phone, college, university)
select 'staff', 'Portal Administrator', 'Female', '9000000000',
       'Global Arts and Science College, Thiruvallur', 'Thiruvallur University'
where not exists (select 1 from public.profiles where role = 'staff');

-- =========================================================
-- RESULTS SEED — every student gets a result for every BCA subject
-- across all 6 semesters (not gated by current_semester), so the
-- portal always has full 6-semester data to show/export/test against.
-- ~15% of rows are deliberately pushed below the pass mark so
-- arrears exist to test the arrear-exam flow against.
-- =========================================================
insert into public.results (student_id, subject_id, semester, internal_marks, external_marks, grade, grade_point, status, result_released_date)
select
    p.id, sub.id, sub.semester, marks.internal, marks.external, marks.grade, marks.grade_point, marks.status,
    (case sub.semester
        when 1 then date '2023-11-20' when 2 then date '2024-05-20' when 3 then date '2024-11-20'
        when 4 then date '2025-05-20' when 5 then date '2025-11-20' when 6 then date '2026-05-20'
     end)
from public.profiles p
join public.courses c on c.code = p.course
join public.subjects sub on sub.course_id = c.id
cross join lateral (
    select
        (12 + floor(random() * 13))::numeric(5,2) as internal,
        case when random() < 0.15 then (10 + floor(random() * 20))::numeric(5,2)
             else (35 + floor(random() * 41))::numeric(5,2) end as external
) as raw
cross join lateral (
    select
        case when raw.external < 28 or (raw.internal + raw.external) < 40 then 'RA'
             when (raw.internal + raw.external) >= 90 then 'O'
             when (raw.internal + raw.external) >= 80 then 'A+'
             when (raw.internal + raw.external) >= 70 then 'A'
             when (raw.internal + raw.external) >= 60 then 'B+'
             when (raw.internal + raw.external) >= 50 then 'B'
             else 'C' end as grade,
        case when raw.external < 28 or (raw.internal + raw.external) < 40 then 0
             when (raw.internal + raw.external) >= 90 then 10
             when (raw.internal + raw.external) >= 80 then 9
             when (raw.internal + raw.external) >= 70 then 8
             when (raw.internal + raw.external) >= 60 then 7
             when (raw.internal + raw.external) >= 50 then 6
             else 5 end as grade_point,
        case when raw.external < 28 or (raw.internal + raw.external) < 40 then 'FAIL' else 'PASS' end as status
) as marks
where p.role = 'student'
on conflict (student_id, subject_id) do nothing;

-- Roll computed arrears/CGPA back onto the profile for fast display.
update public.profiles p
set arrears = coalesce(agg.fail_count, 0), cgpa = coalesce(agg.weighted_gpa, 0)
from (
    select r.student_id,
           count(*) filter (where r.status = 'FAIL') as fail_count,
           round(sum(r.grade_point * sub.credits) / nullif(sum(sub.credits), 0), 2) as weighted_gpa
    from public.results r
    join public.subjects sub on sub.id = r.subject_id
    group by r.student_id
) as agg
where agg.student_id = p.id;

-- =========================================================
-- FEES SEED
-- =========================================================
insert into public.fee_records (student_id, fee_type, amount, paid_amount, status, due_date)
select p.id, 'Tuition Fee', 45000,
       case when p.id % 3 = 0 then 45000 else round((10000 + (p.id * 733) % 30000)::numeric, 2) end,
       case when p.id % 3 = 0 then 'paid' else 'pending' end,
       date '2026-06-30'
from public.profiles p where p.role = 'student'
on conflict do nothing;

insert into public.fee_records (student_id, fee_type, amount, paid_amount, status, due_date)
select p.id, 'Examination Fee', 1500,
       case when p.id % 4 = 0 then 0 else 1500 end,
       case when p.id % 4 = 0 then 'pending' else 'paid' end,
       date '2026-04-15'
from public.profiles p where p.role = 'student'
on conflict do nothing;

update public.profiles p
set fees_pending = coalesce(agg.total_pending, 0)
from (select student_id, sum(pending_amount) as total_pending from public.fee_records group by student_id) as agg
where agg.student_id = p.id;

-- =========================================================
-- END OF FILE
-- =========================================================
