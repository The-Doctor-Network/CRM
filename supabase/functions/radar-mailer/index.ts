import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Jobs Radar emails, sent by the CRM itself so every email carries the doctor's own radar link
// and the "already saved" check happens at the moment of sending.
//
// Every call needs header x-radar-secret = app_secrets.radar_mailer (read by the service role;
// the weekly pg_cron job reads it from the same table). POST JSON body:
//
//   { "mode": "weekly" }                     Thursday radar email: new matching roles only.
//   { "mode": "launch", "step": 1|2|3,       Launch sequence to psychiatrists who haven't saved.
//     "limit": 630, "dryRun": true }         dryRun returns counts without sending.
//   { "mode": "test", "template": "launch1"|"launch2"|"launch3"|"weekly",
//     "doctorId": "...", "to": "you@..." }   One preview to a TDN inbox, using that doctor's data.
//
// Who never gets radar emails: no valid email, blocked (until the block ends), in email_optouts,
// or radar_unsubscribed. Launch emails also skip anyone with radar_saved_at (they've saved).
// Step 2 and 3 only go to doctors who got step 1 at least 7 / 14 days earlier.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

const RADAR_BASE = "https://the-doctor-network.github.io/CRM/job-radar.html";
const SITE = "https://thedoctornetwork.com.au";
const JOBS_BOARD = SITE + "/opportunities.html";
const FROM_TEAM = "The Doctor Network <hello@thedoctornetwork.com.au>";
const FROM_FOUNDER = "Cydney Hughes, The Doctor Network <hello@thedoctornetwork.com.au>";
const REPLY_TO = "hello@thedoctornetwork.com.au";
const TEST_RECIPIENTS = /^[^@\s]+@thedoctornetwork\.com\.au$|^cydneyhughes@hotmail\.com$/i;
const PERTH = /perth|fremantle|joondalup|rockingham|armadale|midland|mandurah|murdoch|nedlands|subiaco|osborne park|bentley|fiona stanley|sir charles gairdner|graylands|bayswater|cannington|swan|kalamunda|wanneroo/i;

const ink = "#142328", coral = "#F76747", quiet = "#5B6B70", line = "#E7E3DA";

function json(obj: unknown, status = 200){ return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } }); }
function esc(s: unknown){ return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function sydneyToday(){ return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date()); }
function fmtDate(iso: string | null){
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}
function radarLink(d: any, src: string){ return `${RADAR_BASE}?token=${encodeURIComponent(d.job_radar_token)}&src=${src}`; }
function stopLink(d: any){ return `${RADAR_BASE}?token=${encodeURIComponent(d.job_radar_token)}&stop=1`; }
function hi(d: any){ const f = String(d.first_name || "").trim(); return f ? `Hi Dr ${f},` : "Hi there,"; }

function shell(bodyHtml: string, d: any){
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:${ink};font-size:15px;line-height:1.6;max-width:560px;">${bodyHtml}` +
    `<hr style="border:none;border-top:1px solid ${line};margin:28px 0 12px;">` +
    `<p style="font-size:12px;color:${quiet};margin:0;">The Doctor Network &middot; <a href="${stopLink(d)}" style="color:${quiet};">Stop Jobs Radar emails</a></p></div>`;
}
function button(href: string, label: string){
  return `<p style="margin:22px 0;"><a href="${href}" style="display:inline-block;background:${coral};color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:999px;">${label}</a></p>`;
}
function textFooter(d: any){ return `\n\n---\nThe Doctor Network\nStop Jobs Radar emails: ${stopLink(d)}`; }

// ---------- launch templates (founder voice) ----------
function launch1(d: any){
  const link = radarLink(d, "email1");
  const html = shell(
    `<p>${esc(hi(d))}</p>` +
    `<p>I'll keep this short, because I know your inbox is full.</p>` +
    `<p>That's actually the problem. After 6.5 years recruiting psychiatrists, I hear the same thing every week: &ldquo;I get so many job emails, and almost none of them are for me.&rdquo; Wrong sub-specialty. Wrong state. No rate. Roles that filled a month ago.</p>` +
    `<p>So for the past 12 months, we've been building something better.</p>` +
    `<p><strong>It's called Jobs Radar.</strong> It's a private page just for you. Tell us once what you'd consider: your sub-specialty, locum or permanent, where you'd work and when you're free. Every Thursday, you'll get only the new roles that match. Rates and dates included. Nothing else.</p>` +
    `<p>Happy where you are? It still works. Leave your dates open and you'll only hear about roles worth a second look.</p>` +
    button(link, "Set up your Jobs Radar &rarr;") +
    `<p>It takes about a minute, and you can change it any time.</p>` +
    `<p>Cydney Hughes<br>Founder, The Doctor Network</p>` +
    `<p style="font-size:13px;color:${quiet};">P.S. This link is private to you, so please don't forward it. If it doesn't work, just reply and I'll sort it.</p>`, d);
  const text = `${hi(d)}\n\nI'll keep this short, because I know your inbox is full.\n\nThat's actually the problem. After 6.5 years recruiting psychiatrists, I hear the same thing every week: "I get so many job emails, and almost none of them are for me." Wrong sub-specialty. Wrong state. No rate. Roles that filled a month ago.\n\nSo for the past 12 months, we've been building something better.\n\nIt's called Jobs Radar. It's a private page just for you. Tell us once what you'd consider: your sub-specialty, locum or permanent, where you'd work and when you're free. Every Thursday, you'll get only the new roles that match. Rates and dates included. Nothing else.\n\nHappy where you are? It still works. Leave your dates open and you'll only hear about roles worth a second look.\n\nSet up your Jobs Radar: ${link}\n\nIt takes about a minute, and you can change it any time.\n\nCydney Hughes\nFounder, The Doctor Network\n\nP.S. This link is private to you, so please don't forward it. If it doesn't work, just reply and I'll sort it.` + textFooter(d);
  return { from: FROM_FOUNDER, subject: "I built this because job emails are broken", html, text };
}
function launch2(d: any){
  const link = radarLink(d, "email2");
  const html = shell(
    `<p>${esc(hi(d))}</p>` +
    `<p>Quick follow-up on Jobs Radar.</p>` +
    `<p>Plenty of doctors aren't actively looking. They're happy where they are, but they'd take the right locum or the right permanent role if it came along.</p>` +
    `<p>That's exactly who it's built for. Tell us what &ldquo;right&rdquo; looks like, and we'll only send you roles that fit.</p>` +
    button(link, "Set up your Jobs Radar &rarr;") +
    `<p>One minute. No CV. Change it whenever you like.</p>` +
    `<p>Cydney</p>`, d);
  const text = `${hi(d)}\n\nQuick follow-up on Jobs Radar.\n\nPlenty of doctors aren't actively looking. They're happy where they are, but they'd take the right locum or the right permanent role if it came along.\n\nThat's exactly who it's built for. Tell us what "right" looks like, and we'll only send you roles that fit.\n\nSet up your Jobs Radar: ${link}\n\nOne minute. No CV. Change it whenever you like.\n\nCydney` + textFooter(d);
  return { from: FROM_FOUNDER, subject: "Not looking? This is still for you", html, text };
}
function launch3(d: any){
  const link = radarLink(d, "email3");
  const html = shell(
    `<p>${esc(hi(d))}</p>` +
    `<p>I won't keep asking about Jobs Radar, so this is the last one.</p>` +
    `<p>If you'd like to hear only about roles that match you, every Thursday, your private link is here:</p>` +
    button(link, "Set up your Jobs Radar &rarr;") +
    `<p>If not, no problem. You'll keep getting our fortnightly <a href="${JOBS_BOARD}" style="color:${coral};font-weight:bold;">jobs board</a>, and you can set up your radar any time from the link above.</p>` +
    `<p>Cydney</p>`, d);
  const text = `${hi(d)}\n\nI won't keep asking about Jobs Radar, so this is the last one.\n\nIf you'd like to hear only about roles that match you, every Thursday, your private link is here:\n${link}\n\nIf not, no problem. You'll keep getting our fortnightly jobs board (${JOBS_BOARD}), and you can set up your radar any time from the link above.\n\nCydney` + textFooter(d);
  return { from: FROM_FOUNDER, subject: "Last one from me on this", html, text };
}
const LAUNCH: Record<number, (d: any) => any> = { 1: launch1, 2: launch2, 3: launch3 };

// ---------- weekly radar email ----------
function displayLocation(j: any){
  if (String(j.region || "").toUpperCase() === "WA" && !PERTH.test(String(j.city || ""))) return "Regional WA";
  return [j.city, j.region].filter(Boolean).join(" ");
}
function shortTitle(j: any){
  const t = String(j.title || "Role");
  const kind = j.job_type ? String(j.job_type).toLowerCase() : "";
  const base = /consultant/i.test(t) ? "Consultant" : /registrar/i.test(t) ? "Registrar" : /trainee/i.test(t) ? "Trainee" : t;
  return `${base}${kind ? " " + kind : ""}`;
}
function weekly(d: any, jobs: any[], more: number, pages: Record<string, string>){
  const link = radarLink(d, "weekly");
  const today = sydneyToday();
  const stale = d.pref_availability_end && d.pref_availability_end < today;
  const first = jobs[0];
  const firstLoc = displayLocation(first);
  const total = jobs.length + more;
  const subject = total === 1
    ? `New on your radar: ${shortTitle(first)}, ${firstLoc}`
    : `${shortTitle(first)} in ${firstLoc} + ${total - 1} more on your radar`;
  const roleUrl = (j: any) => (j.source_ref && pages[j.source_ref]) ? `${SITE}/${pages[j.source_ref]}` : link;
  const dates = (j: any) => j.start_date ? (fmtDate(j.start_date) + (j.end_date ? ` to ${fmtDate(j.end_date)}` : " onwards")) : "";
  const rolesHtml = jobs.map((j: any) =>
    `<div style="border:1px solid ${line};border-radius:14px;padding:14px 16px;margin:0 0 12px;">` +
      `<div style="font-weight:bold;font-size:16px;">${esc(j.title)}, ${esc(displayLocation(j))}</div>` +
      `<div style="color:${quiet};font-size:14px;margin:2px 0 6px;">${esc([j.job_type, dates(j)].filter(Boolean).join(" · "))}${j.rate ? ` &middot; <strong style="color:${ink};">${esc(j.rate)}</strong>` : ""}</div>` +
      `<a href="${roleUrl(j)}" style="color:${coral};font-weight:bold;text-decoration:none;">View role &rarr;</a>` +
    `</div>`).join("");
  const staleHtml = stale ? `<p style="background:#FDE3DC;border-radius:10px;padding:10px 12px;font-size:14px;">Your availability on file ended on ${esc(fmtDate(d.pref_availability_end))}. <a href="${link}" style="color:#B83F22;font-weight:bold;">Update your dates</a> so we can keep sending roles that fit.</p>` : "";
  const html = shell(
    staleHtml +
    `<p>${esc(hi(d))}</p>` +
    `<p>Hope your week's going well! Here's what's new on your radar.</p>` +
    rolesHtml +
    (more > 0 ? `<p style="color:${quiet};">+ ${more} more on your radar.</p>` : "") +
    button(link, "See everything on your radar &rarr;") +
    `<p>Interested in one? Tap &ldquo;I'm interested&rdquo; on your radar or just reply to this email, and we'll call you to talk it through.</p>` +
    `<p>Plans changed? <a href="${link}" style="color:${coral};font-weight:bold;">Update your preferences</a> any time.</p>` +
    `<p>Thanks,<br>The Doctor Network Team<br><span style="color:${quiet};">Doctors are better connected.</span></p>`, d);
  const text = (stale ? `Your availability on file ended on ${fmtDate(d.pref_availability_end)}. Update your dates: ${link}\n\n` : "") +
    `${hi(d)}\n\nHope your week's going well! Here's what's new on your radar.\n\n` +
    jobs.map((j: any) => `${j.title}, ${displayLocation(j)}\n${[j.job_type, dates(j), j.rate].filter(Boolean).join(" · ")}\nView role: ${roleUrl(j)}`).join("\n\n") +
    (more > 0 ? `\n\n+ ${more} more on your radar.` : "") +
    `\n\nSee everything on your radar: ${link}\n\nInterested in one? Tap "I'm interested" on your radar or just reply to this email, and we'll call you to talk it through.\n\nPlans changed? Update your preferences any time: ${link}\n\nThanks,\nThe Doctor Network Team\nDoctors are better connected.` + textFooter(d);
  return { from: FROM_TEAM, subject, html, text };
}

// Same rules as the radar page (job-radar-portal), keep in step.
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

// ---------- audience ----------
async function fetchAll(q: () => any){
  const out: any[] = [];
  for (let from = 0; ; from += 1000){
    const { data, error } = await q().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
async function emailableFilter(admin: any, doctors: any[]){
  const optouts = new Set((await fetchAll(() => admin.from("email_optouts").select("email").order("email"))).map((r: any) => String(r.email).trim().toLowerCase()));
  const today = sydneyToday();
  const seen = new Set<string>();
  return doctors.filter((d: any) => {
    const e = String(d.email || "").trim().toLowerCase();
    if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return false;
    if (d.email_blocked && (!d.email_blocked_until || d.email_blocked_until >= today)) return false;
    if (optouts.has(e) || d.radar_unsubscribed || !d.job_radar_token) return false;
    if (seen.has(e)) return false; // same email on two records: send once
    seen.add(e);
    return true;
  });
}
const DOC_COLS = "id,name,first_name,email,email_blocked,email_blocked_until,job_radar_token,specialty,sub_specialty,pref_job_types,pref_states,grade,pref_availability_start,pref_availability_end,radar_saved_at,radar_unsubscribed,recruiter";

// ---------- sending ----------
async function sendBatch(admin: any, items: { doctor: any; msg: any; tag: string }[]){
  const ids: (string | null)[] = [];
  for (let i = 0; i < items.length; i += 100){
    const chunk = items.slice(i, i + 100);
    const payload = chunk.map(({ doctor, msg }) => ({
      from: msg.from, to: [String(doctor.email).trim()], reply_to: REPLY_TO, subject: msg.subject, html: msg.html, text: msg.text,
      headers: { "List-Unsubscribe": `<${stopLink(doctor)}>` }
    }));
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST", headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(payload)
    });
    const body = await res.json().catch(() => ({} as any));
    const got = res.ok && Array.isArray(body?.data) ? body.data.map((x: any) => x?.id || null) : chunk.map(() => null);
    ids.push(...got);
    await admin.from("sent_emails").insert(chunk.map(({ doctor, msg, tag }, k) => ({
      linked_type: "doctor", linked_id: doctor.id, to_email: String(doctor.email).trim(), subject: msg.subject,
      resend_message_id: got[k], status: res.ok ? "sent" : "failed", sent_by: tag, error: res.ok ? null : JSON.stringify(body)
    })));
    if (!res.ok) { console.error("batch failed", body); break; }
  }
  return ids;
}

async function jobPages(): Promise<Record<string, string>> {
  try {
    const r = await fetch(SITE + "/job-pages.json");
    const j = await r.json();
    const out: Record<string, string> = {};
    for (const k of Object.keys(j || {})) if (j[k]?.page) out[k] = j[k].page;
    return out;
  } catch { return {}; }
}

async function runWeekly(admin: any, dryRun: boolean){
  const doctors = await emailableFilter(admin, await fetchAll(() => admin.from("doctors").select(DOC_COLS).not("radar_saved_at", "is", null).order("id")));
  const jobs = await fetchAll(() => admin.from("jobs").select("id,title,specialty,sub_specialty,job_type,city,region,status,rate,grade,start_date,end_date,source_ref,created_at").eq("status", "Open").order("id"));
  const sent = await fetchAll(() => admin.from("radar_sent_jobs").select("doctor_id,job_id").order("doctor_id"));
  const sentSet = new Set(sent.map((r: any) => r.doctor_id + "|" + r.job_id));
  const pages = await jobPages();
  const items: any[] = []; const sentRows: any[] = [];
  for (const d of doctors){
    const fresh = jobs.filter((j: any) => jobMatchesDoctor(j, d) && !sentSet.has(d.id + "|" + j.id))
      .sort((a: any, b: any) => (b.created_at || "").localeCompare(a.created_at || ""));
    if (!fresh.length) continue; // no empty emails
    const show = fresh.slice(0, 5);
    items.push({ doctor: d, msg: weekly(d, show, fresh.length - show.length, pages), tag: "Jobs Radar weekly" });
    for (const j of fresh) sentRows.push({ doctor_id: d.id, job_id: j.id });
  }
  if (dryRun) return { mode: "weekly", eligibleDoctors: doctors.length, wouldEmail: items.length };
  const ids = await sendBatch(admin, items);
  const okDoctors = new Set(items.filter((_, k) => ids[k]).map(it => it.doctor.id));
  const rows = sentRows.filter(r => okDoctors.has(r.doctor_id));
  for (let i = 0; i < rows.length; i += 1000) await admin.from("radar_sent_jobs").upsert(rows.slice(i, i + 1000), { onConflict: "doctor_id,job_id" });
  if (okDoctors.size) await admin.from("doctors").update({ radar_last_emailed_at: new Date().toISOString() }).in("id", Array.from(okDoctors));
  return { mode: "weekly", eligibleDoctors: doctors.length, emailed: okDoctors.size, failed: items.length - okDoctors.size };
}

async function runLaunch(admin: any, step: number, limit: number, dryRun: boolean){
  const all = await fetchAll(() => admin.from("doctors").select(DOC_COLS).eq("specialty", "Psychiatry").is("radar_saved_at", null).order("id"));
  let pool = await emailableFilter(admin, all);
  const sends = await fetchAll(() => admin.from("radar_campaign_sends").select("doctor_id,step,sent_at").order("doctor_id"));
  const byStep: Record<number, Map<string, string>> = { 1: new Map(), 2: new Map(), 3: new Map() };
  for (const s of sends) byStep[s.step]?.set(s.doctor_id, s.sent_at);
  pool = pool.filter((d: any) => !byStep[step].has(d.id));
  if (step > 1){
    const minDays = step === 2 ? 7 : 14;
    const cutoff = Date.now() - minDays * 864e5 + 6 * 3600e3; // a few hours' grace
    pool = pool.filter((d: any) => byStep[1].has(d.id) && Date.parse(byStep[1].get(d.id)!) <= cutoff);
  }
  // Warmest first: assigned to a recruiter, then anyone who has opened a TDN email.
  const opened = new Set((await fetchAll(() => admin.from("sent_emails").select("linked_id").eq("linked_type", "doctor").not("opened_at", "is", null).order("linked_id"))).map((r: any) => r.linked_id));
  const warmth = (d: any) => (d.recruiter ? 2 : 0) + (opened.has(d.id) ? 1 : 0);
  pool.sort((a: any, b: any) => warmth(b) - warmth(a));
  const batch = pool.slice(0, Math.max(0, Math.min(limit, 2000)));
  if (dryRun) return { mode: "launch", step, remaining: pool.length, wouldSend: batch.length };
  const items = batch.map((d: any) => ({ doctor: d, msg: LAUNCH[step](d), tag: `Jobs Radar launch ${step}` }));
  const ids = await sendBatch(admin, items);
  const rows = items.map((it, k) => ids[k] ? { doctor_id: it.doctor.id, step, resend_message_id: ids[k] } : null).filter(Boolean);
  for (let i = 0; i < rows.length; i += 1000) await admin.from("radar_campaign_sends").upsert(rows.slice(i, i + 1000) as any[], { onConflict: "doctor_id,step" });
  return { mode: "launch", step, sent: rows.length, failed: items.length - rows.length, remainingAfter: pool.length - rows.length };
}

async function runTest(admin: any, template: string, doctorId: string, to: string){
  if (!TEST_RECIPIENTS.test(to)) return json({ error: "Test emails only go to a TDN inbox." }, 400);
  const { data: d } = await admin.from("doctors").select(DOC_COLS).eq("id", doctorId).maybeSingle();
  if (!d) return json({ error: "No such doctor." }, 404);
  let msg: any;
  if (template === "weekly"){
    const jobs = (await fetchAll(() => admin.from("jobs").select("id,title,specialty,sub_specialty,job_type,city,region,status,rate,grade,start_date,end_date,source_ref,created_at").eq("status", "Open").order("id")))
      .filter((j: any) => jobMatchesDoctor(j, d)).sort((a: any, b: any) => (b.created_at || "").localeCompare(a.created_at || ""));
    if (!jobs.length) return json({ error: "That doctor has no matching roles to preview." }, 400);
    msg = weekly(d, jobs.slice(0, 5), Math.max(0, jobs.length - 5), await jobPages());
  } else {
    const step = Number(template.replace("launch", ""));
    if (!LAUNCH[step]) return json({ error: "Unknown template." }, 400);
    msg = LAUNCH[step](d);
  }
  msg = { ...msg, subject: "TEST: " + msg.subject };
  const ids = await sendBatch(admin, [{ doctor: { ...d, email: to }, msg, tag: "Jobs Radar test" }]);
  return json({ ok: !!ids[0], id: ids[0] });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: secretRow } = await admin.from("app_secrets").select("value").eq("name", "radar_mailer").maybeSingle();
  if (!secretRow?.value || req.headers.get("x-radar-secret") !== secretRow.value) return json({ error: "Not allowed" }, 403);
  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  try {
    if (body.mode === "weekly") return json(await runWeekly(admin, !!body.dryRun));
    if (body.mode === "launch") return json(await runLaunch(admin, Number(body.step), Number(body.limit || 630), !!body.dryRun));
    if (body.mode === "test") return await runTest(admin, String(body.template || ""), String(body.doctorId || ""), String(body.to || ""));
    return json({ error: "Unknown mode" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});
