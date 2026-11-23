import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Public, no-login JSON API behind each doctor's personal "job radar" link (?token=...). The
// token is a permanent per-doctor value (doctors.job_radar_token) - one link works forever.
//
// GET returns the doctor's current preferences plus the Open jobs that match them.
//
// POST actions:
//   - update_preferences: saves specialty / sub_specialty / job type(s) / availability window,
//     then (if anything actually changed) tells the doctor's assigned recruiter: an "Update" note
//     on the doctor's profile listing what changed, a Home task due today linked to the doctor,
//     and an email. Returns the refreshed matching job list.
//   - express_interest: records the click in job_interests and emails the job's recruiter.
//
// Jobs can come from the CRM (added by hand) or from the "TDN Job Board inbox sync" scheduled
// task (source = 'Email alert', source_ref = the TDN-xxxx Job Board ID). Email-alert roles are
// often advertised to several agencies, so the recruiter email flags that the hospital may not
// be an existing client yet.
//
// Matching rules (forgiving so a thin profile still sees relevant roles):
//   - specialty: hard filter once set.
//   - sub_specialty: only excludes jobs with a DIFFERENT stated sub-specialty.
//   - job type(s): only applied once the doctor has picked at least one.
//   - availability: only applied once a full date range is set; undated jobs always show.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL");

const CRM_BASE = "https://the-doctor-network.github.io/CRM/";
const FALLBACK_RECRUITER_EMAIL = "cydney@thedoctornetwork.com.au";

const SPECIALTY_OPTIONS = ["Anesthetist","Emergency","Intensive Care","Medicine","Obstetrics and Gynaecology","Ophthalmology","Paediatrics","Psychiatry","Surgery","Radiographer","Radiology","General Practice"];
const JOB_TYPE_OPTIONS = ["Contract","Locum","Permanent","Fixed Term"];
// Mirrors SUBSPECIALTY_MAP in the CRM's index.html - keep the two in sync.
const SUBSPECIALTY_MAP: Record<string, string[]> = {
  "Psychiatry": ["Child & Adolescent Psychiatry","Perinatal & Infant Psychiatry","Forensic Psychiatry","Older Persons Psychiatry","Community Psychiatry","Addiction / Drug & Alcohol Psychiatry","Rehabilitation & Neuropsychiatry","Consultation-Liaison Psychiatry","Indigenous Mental Health","Mental Health","General Adult Psychiatry"]
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function json(obj: unknown, status = 200){
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}
function escapeHtml(s: unknown){
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtDate(iso: string | null | undefined){
  if (!iso) return "";
  try {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  } catch { return iso; }
}
function locationOf(rec: any){
  const parts = [];
  if (rec?.city) parts.push(rec.city);
  if (rec?.region) parts.push(rec.region);
  return parts.join(", ");
}
function sydneyToday(){
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
}
function randomId(prefix: string){
  return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

async function sendNotification(admin: any, opts: { to: string; subject: string; html: string; linkedType?: string; linkedId?: string; }){
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) return { ok: false };
  try {
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: [opts.to], subject: opts.subject, html: opts.html })
    });
    const resendJson = await resendRes.json().catch(() => ({} as any));
    await admin.from("sent_emails").insert({
      linked_type: opts.linkedType || null, linked_id: opts.linkedId || null, to_email: opts.to, subject: opts.subject,
      resend_message_id: resendJson?.id || null, status: resendRes.ok ? "sent" : "failed",
      sent_by: "system", error: resendRes.ok ? null : JSON.stringify(resendJson)
    });
    return { ok: resendRes.ok };
  } catch (e) {
    console.error("sendNotification failed", e);
    return { ok: false };
  }
}

async function agencyEmail(admin: any){
  const { data: agencyRows } = await admin.from("agency_settings").select("email").limit(1);
  const e = agencyRows && agencyRows[0] && agencyRows[0].email;
  return e || FALLBACK_RECRUITER_EMAIL;
}

// The job's assigned recruiter's CRM login email, else the agency email, else the fallback.
async function recruiterEmailForJob(admin: any, job: any){
  if (job?.recruiter_user_id){
    const { data: userRow } = await admin.from("user_settings").select("send_from_email").eq("id", job.recruiter_user_id).maybeSingle();
    if (userRow?.send_from_email) return userRow.send_from_email;
  }
  return await agencyEmail(admin);
}

// Doctors store their recruiter as a free-text name (doctors.recruiter). Match it to a CRM login
// by display name (exact, then first name), else fall back to the agency email.
async function recruiterEmailForDoctor(admin: any, doctor: any){
  const name = String(doctor?.recruiter || "").trim().toLowerCase();
  if (name){
    const { data: users } = await admin.from("user_settings").select("display_name,send_from_email");
    const list = (users || []).filter((u: any) => u.send_from_email);
    const first = name.split(/\s+/)[0];
    const exact = list.find((u: any) => String(u.display_name || "").trim().toLowerCase() === name);
    if (exact) return exact.send_from_email;
    const byFirst = list.filter((u: any) => String(u.display_name || "").trim().toLowerCase().split(/[\s@]+/)[0] === first);
    if (byFirst.length === 1) return byFirst[0].send_from_email;
  }
  return await agencyEmail(admin);
}

function jobMatchesDoctor(job: any, doctor: any){
  if (job.status !== "Open") return false;
  if (doctor.specialty && job.specialty !== doctor.specialty) return false;
  if (doctor.sub_specialty && job.sub_specialty && job.sub_specialty !== doctor.sub_specialty) return false;
  const prefTypes: string[] = Array.isArray(doctor.pref_job_types) ? doctor.pref_job_types : [];
  if (prefTypes.length && job.job_type && prefTypes.indexOf(job.job_type) === -1) return false;
  if (doctor.pref_availability_start && doctor.pref_availability_end && job.start_date){
    const jobEnd = job.end_date || job.start_date;
    if (job.start_date > doctor.pref_availability_end) return false;
    if (jobEnd < doctor.pref_availability_start) return false;
  }
  return true;
}

async function matchingJobsFor(admin: any, doctor: any){
  const { data: jobs } = await admin.from("jobs")
    .select("id,title,hospital_id,specialty,sub_specialty,job_type,description,start_date,end_date,city,region,status,rate,created_at,recruiter_user_id")
    .eq("status", "Open");
  const list = (jobs || []).filter((j: any) => jobMatchesDoctor(j, doctor));
  const hospitalIds = Array.from(new Set(list.map((j: any) => j.hospital_id).filter(Boolean)));
  const hospitalsById: Record<string, any> = {};
  if (hospitalIds.length){
    const { data: hospitals } = await admin.from("hospitals").select("id,name,city,region").in("id", hospitalIds);
    for (const h of hospitals || []) hospitalsById[h.id] = h;
  }
  const { data: interestRows } = await admin.from("job_interests").select("job_id").eq("doctor_id", doctor.id);
  const interestedIds = new Set((interestRows || []).map((r: any) => r.job_id));

  return list
    .sort((a: any, b: any) => (b.created_at || "").localeCompare(a.created_at || ""))
    .map((j: any) => {
      const h = hospitalsById[j.hospital_id];
      return {
        id: j.id, title: j.title, hospitalName: h ? h.name : "", location: locationOf(j) || locationOf(h),
        specialty: j.specialty || "", subSpecialty: j.sub_specialty || "", jobType: j.job_type || "",
        startDate: j.start_date || null, endDate: j.end_date || null, description: j.description || "",
        rate: j.rate || "", interested: interestedIds.has(j.id)
      };
    });
}

function preferencesPayload(doctor: any){
  return {
    doctorName: doctor.name || "Doctor",
    firstName: doctor.first_name || "",
    specialty: doctor.specialty || "", subSpecialty: doctor.sub_specialty || "",
    jobTypes: Array.isArray(doctor.pref_job_types) ? doctor.pref_job_types : [],
    availabilityStart: doctor.pref_availability_start || null, availabilityEnd: doctor.pref_availability_end || null,
    specialtyOptions: SPECIALTY_OPTIONS, jobTypeOptions: JOB_TYPE_OPTIONS, subSpecialtyMap: SUBSPECIALTY_MAP
  };
}

// Plain-language list of what changed between the old and new doctor rows.
function describeChanges(before: any, after: any): string[] {
  const out: string[] = [];
  const show = (v: any) => (v === null || v === undefined || v === "") ? "not set" : String(v);
  if ((before.specialty || "") !== (after.specialty || "")) out.push(`Specialty: ${show(before.specialty)} → ${show(after.specialty)}`);
  if ((before.sub_specialty || "") !== (after.sub_specialty || "")) out.push(`Sub-specialty: ${show(before.sub_specialty)} → ${show(after.sub_specialty)}`);
  const oldTypes: string[] = Array.isArray(before.pref_job_types) ? before.pref_job_types : [];
  const newTypes: string[] = Array.isArray(after.pref_job_types) ? after.pref_job_types : [];
  const added = newTypes.filter(t => oldTypes.indexOf(t) === -1);
  const removed = oldTypes.filter(t => newTypes.indexOf(t) === -1);
  if (added.length || removed.length){
    const bits = [];
    if (added.length) bits.push("added " + added.join(", "));
    if (removed.length) bits.push("removed " + removed.join(", "));
    out.push(`Job types: ${bits.join("; ")} (now ${newTypes.length ? newTypes.join(", ") : "any"})`);
  }
  const oldAv = (before.pref_availability_start || "") + "|" + (before.pref_availability_end || "");
  const newAv = (after.pref_availability_start || "") + "|" + (after.pref_availability_end || "");
  if (oldAv !== newAv){
    const fmt = (s: any, e: any) => (s || e) ? `${s ? fmtDate(s) : "?"} – ${e ? fmtDate(e) : "?"}` : "not set";
    out.push(`Availability: ${fmt(before.pref_availability_start, before.pref_availability_end)} → ${fmt(after.pref_availability_start, after.pref_availability_end)}`);
  }
  return out;
}

async function notifyRecruiterOfPreferenceChange(admin: any, before: any, after: any, matchCount: number){
  const changes = describeChanges(before, after);
  if (!changes.length) return;
  const name = after.name || "A doctor";
  const today = sydneyToday();
  const summary = changes.join("; ");

  try {
    await admin.from("notes").insert({
      id: randomId("note_radar"), linked_type: "doctor", linked_id: after.id, note_type: "Update",
      text: `Updated their job radar preferences: ${summary}. Now matching ${matchCount} open job${matchCount === 1 ? "" : "s"}.`,
      date: new Date().toISOString(), created_by: "Job radar"
    });
  } catch (e) { console.error("note insert failed", e); }

  try {
    await admin.from("tasks").insert({
      id: randomId("task_radar"), title: `${name} updated their job radar preferences: ${summary}`,
      due_date: today, done: false, linked_type: "doctor", linked_id: after.id
    });
  } catch (e) { console.error("task insert failed", e); }

  const to = await recruiterEmailForDoctor(admin, after);
  const contact = [after.email, after.mobile || after.phone].filter(Boolean).map(escapeHtml).join(" &middot; ");
  await sendNotification(admin, {
    to,
    subject: `${name} updated their job radar preferences`,
    html: `<p>Hi,</p><p><strong>${escapeHtml(name)}</strong> just updated their job radar preferences:</p>` +
      `<ul>${changes.map(c => `<li>${escapeHtml(c)}</li>`).join("")}</ul>` +
      `<p>They now match <strong>${matchCount}</strong> open job${matchCount === 1 ? "" : "s"} in the CRM.</p>` +
      (contact ? `<p>Contact: ${contact}</p>` : "") +
      `<p><a href="${CRM_BASE}#/doctors/${encodeURIComponent(after.id)}/snapshot">View ${escapeHtml(name)} in the CRM</a></p>`,
    linkedType: "doctor", linkedId: after.id
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const url = new URL(req.url);
  const token = (url.searchParams.get("token") || "").trim();
  if (!token) return json({ error: "This link is missing its access token." }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: doctor } = await admin.from("doctors").select("*").eq("job_radar_token", token).maybeSingle();
  if (!doctor) return json({ error: "This link is invalid. Please ask The Doctor Network to resend it." }, 404);

  if (req.method === "GET"){
    const jobs = await matchingJobsFor(admin, doctor);
    return json({ ...preferencesPayload(doctor), jobs });
  }

  if (req.method === "POST"){
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const action = String(body.action || "");

    if (action === "update_preferences"){
      const specialty = String(body.specialty || "").trim();
      const subSpecialty = String(body.subSpecialty || "").trim();
      const jobTypes = Array.isArray(body.jobTypes) ? body.jobTypes.filter((t: any) => JOB_TYPE_OPTIONS.indexOf(t) !== -1) : [];
      const availabilityStart = body.availabilityStart ? String(body.availabilityStart) : null;
      const availabilityEnd = body.availabilityEnd ? String(body.availabilityEnd) : null;
      if (specialty && SPECIALTY_OPTIONS.indexOf(specialty) === -1) return json({ error: "That specialty isn't recognised." }, 400);

      const { data: updated, error: updErr } = await admin.from("doctors").update({
        specialty: specialty || null, sub_specialty: subSpecialty || null,
        pref_job_types: jobTypes, pref_availability_start: availabilityStart, pref_availability_end: availabilityEnd
      }).eq("id", doctor.id).select("*").maybeSingle();
      if (updErr){ console.error("preference update failed", updErr); return json({ error: "We couldn't save your preferences right now. Please try again shortly." }, 500); }

      const jobs = await matchingJobsFor(admin, updated);
      try { await notifyRecruiterOfPreferenceChange(admin, doctor, updated, jobs.length); }
      catch (e) { console.error("recruiter notify failed", e); }
      return json({ ok: true, ...preferencesPayload(updated), jobs });
    }

    if (action === "express_interest"){
      const jobId = String(body.jobId || "").trim();
      if (!jobId) return json({ error: "Missing job." }, 400);
      const { data: job } = await admin.from("jobs").select("*").eq("id", jobId).maybeSingle();
      if (!job) return json({ error: "This role is no longer available." }, 404);

      const { error: upsertErr } = await admin.from("job_interests")
        .upsert({ job_id: jobId, doctor_id: doctor.id, expressed_at: new Date().toISOString() }, { onConflict: "job_id,doctor_id" });
      if (upsertErr){ console.error("interest upsert failed", upsertErr); return json({ error: "We couldn't record your interest right now. Please try again shortly." }, 500); }

      const { data: hospital } = job.hospital_id ? await admin.from("hospitals").select("name,city,region").eq("id", job.hospital_id).maybeSingle() : { data: null };
      const to = await recruiterEmailForJob(admin, job);
      const doctorContact = [doctor.email, doctor.mobile || doctor.phone].filter(Boolean).map(escapeHtml).join(" &middot; ");
      const where = hospital ? " at " + escapeHtml(hospital.name) : (locationOf(job) ? " in " + escapeHtml(locationOf(job)) : "");
      const emailAlertNote = job.source === "Email alert"
        ? `<p style="color:#B4553F;"><strong>Heads up:</strong> this role came in through the agency job-alert feed${job.source_ref ? " (" + escapeHtml(job.source_ref) + ")" : ""}, so the hospital may not be a TDN client yet. Check you can represent the doctor there before submitting them.</p>`
        : "";
      await sendNotification(admin, {
        to,
        subject: `${doctor.name || "A doctor"} is interested in ${job.title}`,
        html: `<p>Hi,</p><p><strong>${escapeHtml(doctor.name)}</strong> just expressed interest in <strong>${escapeHtml(job.title)}</strong>${where} via their job radar link.</p>` +
          (job.rate ? `<p>Rate: ${escapeHtml(job.rate)}</p>` : "") +
          emailAlertNote +
          (doctorContact ? `<p>Contact: ${doctorContact}</p>` : "") +
          `<p><a href="${CRM_BASE}#/doctors/${encodeURIComponent(doctor.id)}/snapshot">View ${escapeHtml(doctor.name)} in the CRM</a> &middot; <a href="${CRM_BASE}#/jobs/${encodeURIComponent(job.id)}">View the job</a></p>`,
        linkedType: "doctor", linkedId: doctor.id
      });
      await admin.from("job_interests").update({ notified: true }).eq("job_id", jobId).eq("doctor_id", doctor.id);

      return json({ ok: true });
    }

    return json({ error: "This endpoint doesn't support that request." }, 400);
  }

  return json({ error: "This endpoint doesn't support that request." }, 404);
});
