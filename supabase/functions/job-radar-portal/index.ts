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
//   - stop_radar_emails / resume_radar_emails: the "Stop Jobs Radar emails" link in radar emails.
//     Stops radar emails only (doctors.radar_unsubscribed); the jobs board is unaffected.
//
// Doctors also have location (pref_states, empty = anywhere) and grade (Consultant / Registrar /
// CMO) preferences; jobs get a grade from their title (jobs_set_grade trigger). The first save
// sets doctors.radar_saved_at, which takes the doctor out of all radar promotion emails.
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
// Transactional email: sent from the main domain (the CRM's Resend key is limited to it).
const DOCTOR_FROM = "The Doctor Network <hello@thedoctornetwork.com.au>";
const DOCTOR_REPLY_TO = "hello@thedoctornetwork.com.au";
const FALLBACK_RECRUITER_EMAIL = "cydney@thedoctornetwork.com.au";

const SPECIALTY_OPTIONS = ["Anesthetist","Emergency","Intensive Care","Medicine","Obstetrics and Gynaecology","Ophthalmology","Paediatrics","Psychiatry","Surgery","Radiographer","Radiology","General Practice"];
const JOB_TYPE_OPTIONS = ["Contract","Locum","Permanent","Fixed Term"];
const STATE_OPTIONS = ["NSW","VIC","QLD","SA","WA","TAS","NT","ACT"];
const GRADE_OPTIONS = [
  { value: "Consultant", label: "Consultant or specialist" },
  { value: "Registrar", label: "Registrar or advanced trainee" },
  { value: "CMO", label: "CMO or junior" }
];
const GRADE_VALUES = GRADE_OPTIONS.map(g => g.value);
const SOURCE_RE = /^[a-z0-9_-]{1,30}$/;
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
  const prefStates: string[] = Array.isArray(doctor.pref_states) ? doctor.pref_states : [];
  if (prefStates.length && job.region && prefStates.indexOf(String(job.region).toUpperCase()) === -1) return false;
  if (doctor.grade && job.grade && doctor.grade !== job.grade) return false;
  if (doctor.pref_availability_start && doctor.pref_availability_end && job.start_date){
    const jobEnd = job.end_date || job.start_date;
    if (job.start_date > doctor.pref_availability_end) return false;
    if (jobEnd < doctor.pref_availability_start) return false;
  }
  return true;
}

async function matchingJobsFor(admin: any, doctor: any){
  const { data: jobs } = await admin.from("jobs")
    .select("id,title,hospital_id,specialty,sub_specialty,job_type,description,start_date,end_date,city,region,status,rate,grade,created_at,recruiter_user_id")
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
    states: Array.isArray(doctor.pref_states) ? doctor.pref_states : [], grade: doctor.grade || "",
    specialtyOptions: SPECIALTY_OPTIONS, jobTypeOptions: JOB_TYPE_OPTIONS, subSpecialtyMap: SUBSPECIALTY_MAP,
    stateOptions: STATE_OPTIONS, gradeOptions: GRADE_OPTIONS
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
  const oldStates: string[] = Array.isArray(before.pref_states) ? before.pref_states : [];
  const newStates: string[] = Array.isArray(after.pref_states) ? after.pref_states : [];
  if (oldStates.slice().sort().join(",") !== newStates.slice().sort().join(",")){
    out.push(`Locations: ${oldStates.length ? oldStates.join(", ") : "anywhere"} → ${newStates.length ? newStates.join(", ") : "anywhere"}`);
  }
  if ((before.grade || "") !== (after.grade || "")) out.push(`Level: ${show(before.grade)} → ${show(after.grade)}`);
  const oldAv = (before.pref_availability_start || "") + "|" + (before.pref_availability_end || "");
  const newAv = (after.pref_availability_start || "") + "|" + (after.pref_availability_end || "");
  if (oldAv !== newAv){
    const fmt = (s: any, e: any) => (s || e) ? `${s ? fmtDate(s) : "?"} – ${e ? fmtDate(e) : "?"}` : "not set";
    out.push(`Availability: ${fmt(before.pref_availability_start, before.pref_availability_end)} → ${fmt(after.pref_availability_start, after.pref_availability_end)}`);
  }
  return out;
}

function jobsBoardUrlFor(specialty: string){
  return specialty === "General Practice" ? "https://thedoctornetwork.com.au/GPJobsBoard/" : "https://thedoctornetwork.com.au/opportunities.html";
}

// Can we email this doctor? Needs a real address, not blocked in the CRM (or the block has
// expired), and not in email_optouts.
async function canEmailDoctor(admin: any, doctor: any){
  const email = String(doctor?.email || "").trim().toLowerCase();
  if (!email || email.indexOf("@") === -1) return null;
  if (doctor.email_blocked){
    const until = doctor.email_blocked_until;
    if (!until || until >= sydneyToday()) return null;
  }
  const { data: optout } = await admin.from("email_optouts").select("email").eq("email", email).maybeSingle();
  if (optout) return null;
  return String(doctor.email).trim();
}

// Confirmation email to the doctor after they change their preferences (only when something
// actually changed). Signed by the team, replies to hello@.
async function sendDoctorConfirmation(admin: any, doctor: any, jobCount: number){
  if (!RESEND_API_KEY) return;
  const to = await canEmailDoctor(admin, doctor);
  if (!to) return;

  const first = String(doctor.first_name || "").trim();
  const greeting = first ? `Hi Dr ${escapeHtml(first)},` : "Hi there,";
  const greetingText = first ? `Hi Dr ${first},` : "Hi there,";
  const spec = [doctor.specialty, doctor.sub_specialty].filter(Boolean).join(", ") || "Any";
  const types: string[] = Array.isArray(doctor.pref_job_types) ? doctor.pref_job_types : [];
  const typeText = types.length ? types.join(", ") : "Any";
  const st: string[] = Array.isArray(doctor.pref_states) ? doctor.pref_states : [];
  const whereText = st.length ? st.join(", ") : "Anywhere in Australia";
  const gradeText = (GRADE_OPTIONS.find(g => g.value === doctor.grade) || { label: "" }).label;
  const s = doctor.pref_availability_start, e = doctor.pref_availability_end;
  const avail = (s || e) ? `${s ? fmtDate(s) : "Now"} – ${e ? fmtDate(e) : "ongoing"}` : "Flexible";
  const radarUrl = `${CRM_BASE}job-radar.html?token=${encodeURIComponent(doctor.job_radar_token)}`;
  const boardUrl = jobsBoardUrlFor(doctor.specialty || "");
  const unsubUrl = `${radarUrl}&stop=1`;
  const matchLine = jobCount > 0
    ? `Right now, <strong>${jobCount} open role${jobCount === 1 ? "" : "s"}</strong> match what you're after.`
    : `Nothing matches just yet, but new roles come in every day and they'll show up on your radar as soon as they do.`;
  const matchText = jobCount > 0
    ? `Right now, ${jobCount} open role${jobCount === 1 ? "" : "s"} match what you're after.`
    : `Nothing matches just yet, but new roles come in every day and they'll show up on your radar as soon as they do.`;
  const linkLabel = jobCount > 0 ? "See your matching roles &rarr;" : "Open your job radar &rarr;";

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#142328;font-size:15px;line-height:1.6;max-width:560px;">` +
    `<p>${greeting}</p>` +
    `<p>Thanks for updating your job radar! Here's what we've got for you now:</p>` +
    `<ul style="padding-left:20px;margin:0 0 14px;">` +
      `<li><strong>Specialty:</strong> ${escapeHtml(spec)}</li>` +
      `<li><strong>Job type:</strong> ${escapeHtml(typeText)}</li>` +
      `<li><strong>Where:</strong> ${escapeHtml(whereText)}</li>` +
      (gradeText ? `<li><strong>Level:</strong> ${escapeHtml(gradeText)}</li>` : "") +
      `<li><strong>Available:</strong> ${escapeHtml(avail)}</li>` +
    `</ul>` +
    `<p>${matchLine}</p>` +
    `<p><a href="${radarUrl}" style="display:inline-block;background:#F76747;color:#ffffff;text-decoration:none;font-weight:bold;padding:11px 22px;border-radius:999px;">${linkLabel}</a></p>` +
    `<p>New roles come in every day, so your radar keeps updating. If your plans change, you can update your preferences on the same link any time.</p>` +
    `<p>If one of these catches your eye, or you'd like to chat about what's out there, just hit reply.</p>` +
    `<p>You can also browse every role on our <a href="${boardUrl}" style="color:#F76747;font-weight:bold;">jobs board</a>.</p>` +
    `<p>Thanks,<br>The Doctor Network Team<br><span style="color:#5B6B70;">Doctors are better connected.</span></p>` +
    `<hr style="border:none;border-top:1px solid #E7E3DA;margin:24px 0 12px;">` +
    `<p style="font-size:12px;color:#5B6B70;">The Doctor Network &middot; <a href="${unsubUrl}" style="color:#5B6B70;">Stop Jobs Radar emails</a></p>` +
    `</div>`;
  const text = `${greetingText}\n\nThanks for updating your job radar! Here's what we've got for you now:\n\n` +
    `- Specialty: ${spec}\n- Job type: ${typeText}\n- Where: ${whereText}\n${gradeText ? "- Level: " + gradeText + "\n" : ""}- Available: ${avail}\n\n${matchText}\n\n` +
    `${jobCount > 0 ? "See your matching roles" : "Open your job radar"}: ${radarUrl}\n\n` +
    `New roles come in every day, so your radar keeps updating. If your plans change, you can update your preferences on the same link any time.\n\n` +
    `If one of these catches your eye, or you'd like to chat about what's out there, just hit reply.\n\n` +
    `You can also browse every role on our jobs board: ${boardUrl}\n\n` +
    `Thanks,\nThe Doctor Network Team\nDoctors are better connected.\n\n---\nThe Doctor Network\nStop Jobs Radar emails: ${unsubUrl}`;
  const subject = "Your job radar is updated";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: DOCTOR_FROM, to: [to], reply_to: DOCTOR_REPLY_TO, subject, html, text,
        headers: { "List-Unsubscribe": `<${unsubUrl}>` }
      })
    });
    const body = await res.json().catch(() => ({} as any));
    await admin.from("sent_emails").insert({
      linked_type: "doctor", linked_id: doctor.id, to_email: to, subject,
      resend_message_id: body?.id || null, status: res.ok ? "sent" : "failed",
      sent_by: "Job radar", error: res.ok ? null : JSON.stringify(body)
    });
  } catch (err) { console.error("doctor confirmation failed", err); }
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

  const src = (url.searchParams.get("src") || "").trim().toLowerCase();
  if (req.method === "GET"){
    const track: any = {};
    if (!doctor.radar_first_opened_at) track.radar_first_opened_at = new Date().toISOString();
    if (!doctor.radar_source && SOURCE_RE.test(src)) track.radar_source = src;
    if (Object.keys(track).length){
      await admin.from("doctors").update(track).eq("id", doctor.id);
      Object.assign(doctor, track);
    }
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
      const states = Array.isArray(body.states) ? Array.from(new Set(body.states.map((x: any) => String(x).toUpperCase()).filter((x: string) => STATE_OPTIONS.indexOf(x) !== -1))) : (Array.isArray(doctor.pref_states) ? doctor.pref_states : []);
      const grade = body.grade !== undefined ? (GRADE_VALUES.indexOf(String(body.grade)) !== -1 ? String(body.grade) : null) : (doctor.grade || null);

      const patch: any = {
        specialty: specialty || null, sub_specialty: subSpecialty || null,
        pref_job_types: jobTypes, pref_availability_start: availabilityStart, pref_availability_end: availabilityEnd,
        pref_states: states, grade
      };
      if (!doctor.radar_saved_at) patch.radar_saved_at = new Date().toISOString();
      if (!doctor.radar_source && SOURCE_RE.test(src)) patch.radar_source = src;
      if (doctor.radar_unsubscribed) patch.radar_unsubscribed = false;
      const { data: updated, error: updErr } = await admin.from("doctors").update(patch).eq("id", doctor.id).select("*").maybeSingle();
      if (updErr){ console.error("preference update failed", updErr); return json({ error: "We couldn't save your preferences right now. Please try again shortly." }, 500); }

      const jobs = await matchingJobsFor(admin, updated);
      const changed = describeChanges(doctor, updated).length > 0;
      try { await notifyRecruiterOfPreferenceChange(admin, doctor, updated, jobs.length); }
      catch (e) { console.error("recruiter notify failed", e); }
      if (changed){
        try { await sendDoctorConfirmation(admin, updated, jobs.length); }
        catch (e) { console.error("doctor confirmation failed", e); }
      }
      return json({ ok: true, ...preferencesPayload(updated), jobs });
    }

    if (action === "stop_radar_emails" || action === "resume_radar_emails"){
      const stop = action === "stop_radar_emails";
      if (Boolean(doctor.radar_unsubscribed) !== stop){
        await admin.from("doctors").update({ radar_unsubscribed: stop }).eq("id", doctor.id);
        try {
          await admin.from("notes").insert({
            id: randomId("note_radar"), linked_type: "doctor", linked_id: doctor.id, note_type: "Update",
            text: stop ? "Stopped Jobs Radar emails (jobs board emails unaffected)." : "Turned Jobs Radar emails back on.",
            date: new Date().toISOString(), created_by: "Job radar"
          });
        } catch (e) { console.error("note insert failed", e); }
      }
      return json({ ok: true, radarUnsubscribed: stop });
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
