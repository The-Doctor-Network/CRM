import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Public endpoint behind the "Get your job radar" form on thedoctornetwork.com.au/jobs-radar.html.
// POST JSON { firstName, lastName, email, specialty, grade, mobile?, consent, website (honeypot), src? }
//
// Always answers { ok: true } for a valid request, so the form never reveals whether an email
// is already in the CRM. What happens behind it:
//   - email already in the CRM, emails allowed -> their existing radar link is emailed to the
//     address on file, plus an "Update" note on their profile
//   - email in the CRM but blocked / unsubscribed from TDN emails -> nothing sent, Home task
//   - new email -> new doctor record (source "Website - Job radar", consent logged in a note),
//     link emailed (psychiatry) or a "we'll be in touch" email (other specialties), Home task
//     to check for a duplicate under another email
// The same email can only trigger one email every 10 minutes.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

const RADAR_BASE = "https://the-doctor-network.github.io/CRM/job-radar.html";
const FROM = "The Doctor Network <hello@thedoctornetwork.com.au>";
const REPLY_TO = "hello@thedoctornetwork.com.au";
const ink = "#142328", coral = "#F76747", quiet = "#5B6B70", line = "#E7E3DA";
const ALLOWED_ORIGINS = ["https://thedoctornetwork.com.au", "https://www.thedoctornetwork.com.au", "https://cydneylocum.github.io"];
const GRADES = ["Consultant", "Registrar", "CMO"];
const SPECIALTIES: Record<string, string | null> = { "Psychiatry": "Psychiatry", "General Practice": "General Practice", "Other": null };

function cors(req: Request){
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin"
  };
}
function esc(s: unknown){ return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function sydneyToday(){ return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date()); }
function rid(p: string){ return p + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7); }
function clean(v: unknown, max = 120){ return String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max); }

async function send(admin: any, doctor: any, to: string, subject: string, html: string, text: string){
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject, html, text })
  });
  const body = await res.json().catch(() => ({} as any));
  await admin.from("sent_emails").insert({
    linked_type: "doctor", linked_id: doctor.id, to_email: to, subject, resend_message_id: body?.id || null,
    status: res.ok ? "sent" : "failed", sent_by: "Job radar request", error: res.ok ? null : JSON.stringify(body)
  });
  return res.ok;
}

function linkEmail(doctor: any, src: string){
  const first = String(doctor.first_name || "").trim();
  const hi = first ? `Hi Dr ${first},` : "Hi there,";
  const link = `${RADAR_BASE}?token=${encodeURIComponent(doctor.job_radar_token)}&src=${src || "web"}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:${ink};font-size:15px;line-height:1.6;max-width:560px;">` +
    `<p>${esc(hi)}</p>` +
    `<p>Here's your personalised job radar. It's private to you, so keep this email handy.</p>` +
    `<p>Tell us what you'd consider: your sub-specialty, level, locum or permanent, where you'd work and when you're free. From then on, every Thursday you'll get only the roles that match. Nothing else.</p>` +
    `<p style="margin:22px 0;"><a href="${link}" style="display:inline-block;background:${coral};color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:999px;">Set up your job radar &rarr;</a></p>` +
    `<p>It takes about a minute, and you can change it or pause it any time.</p>` +
    `<p>Questions? Just reply to this email.</p>` +
    `<p>Thanks,<br>The Doctor Network Team<br><span style="color:${quiet};">Doctors are better connected.</span></p>` +
    `<hr style="border:none;border-top:1px solid ${line};margin:28px 0 12px;"><p style="font-size:12px;color:${quiet};margin:0;">The Doctor Network &middot; You're getting this because you asked for your job radar link on thedoctornetwork.com.au.</p></div>`;
  const text = `${hi}\n\nHere's your personalised job radar. It's private to you, so keep this email handy.\n\nTell us what you'd consider: your sub-specialty, level, locum or permanent, where you'd work and when you're free. From then on, every Thursday you'll get only the roles that match. Nothing else.\n\nSet up your job radar: ${link}\n\nIt takes about a minute, and you can change it or pause it any time.\n\nQuestions? Just reply to this email.\n\nThanks,\nThe Doctor Network Team\nDoctors are better connected.\n\n---\nThe Doctor Network. You're getting this because you asked for your job radar link on thedoctornetwork.com.au.`;
  return { subject: "Your personalised job radar", html, text };
}

function otherSpecialtyEmail(doctor: any){
  const first = String(doctor.first_name || "").trim();
  const hi = first ? `Hi Dr ${first},` : "Hi there,";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:${ink};font-size:15px;line-height:1.6;max-width:560px;">` +
    `<p>${esc(hi)}</p>` +
    `<p>Thanks for getting in touch. Personalised job radars are live for psychiatrists right now, and we're bringing them to other specialties next.</p>` +
    `<p>In the meantime, one of our team will be in touch about the kind of work you're after. Or just reply to this email and tell us.</p>` +
    `<p>Thanks,<br>The Doctor Network Team<br><span style="color:${quiet};">Doctors are better connected.</span></p></div>`;
  const text = `${hi}\n\nThanks for getting in touch. Personalised job radars are live for psychiatrists right now, and we're bringing them to other specialties next.\n\nIn the meantime, one of our team will be in touch about the kind of work you're after. Or just reply to this email and tell us.\n\nThanks,\nThe Doctor Network Team\nDoctors are better connected.`;
  return { subject: "Thanks for getting in touch", html, text };
}

Deno.serve(async (req: Request) => {
  const headers = { "Content-Type": "application/json", ...cors(req) };
  const reply = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);

  let b: any = {};
  try { b = await req.json(); } catch { return reply({ error: "Please try again." }, 400); }
  if (clean(b.website)) return reply({ ok: true }); // honeypot: quietly ignore bots

  const firstName = clean(b.firstName, 60), lastName = clean(b.lastName, 60);
  const email = clean(b.email, 200).toLowerCase();
  const specialtyKey = clean(b.specialty, 40);
  const grade = GRADES.includes(clean(b.grade, 20)) ? clean(b.grade, 20) : null;
  const mobile = clean(b.mobile, 30).replace(/[^0-9+ ()-]/g, "");
  const src = /^[a-z0-9_-]{1,30}$/i.test(clean(b.src, 30)) ? clean(b.src, 30).toLowerCase() : "web";
  if (!firstName || !lastName) return reply({ error: "Please add your first and last name." }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply({ error: "Please check your email address." }, 400);
  if (!(specialtyKey in SPECIALTIES)) return reply({ error: "Please choose your specialty." }, 400);
  if (b.consent !== true) return reply({ error: "Please tick the box so we can email you your link." }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const nowIso = new Date().toISOString();
  const consentNote = `Requested their job radar link on the website (${specialtyKey}${grade ? ", " + grade : ""}). Ticked consent: "Email me my job radar link and roles that match my preferences" at ${nowIso}.`;

  // Throttle: one email per address per 10 minutes.
  const { data: recent } = await admin.from("sent_emails").select("id").eq("sent_by", "Job radar request")
    .ilike("to_email", email).gte("sent_at", new Date(Date.now() - 10 * 60e3).toISOString()).limit(1);
  if (recent && recent.length) return reply({ ok: true });

  const { data: matches } = await admin.from("doctors")
    .select("id,name,first_name,email,email_blocked,email_blocked_until,job_radar_token,specialty,radar_unsubscribed")
    .ilike("email", email).limit(5);
  const existing = (matches || []).find((d: any) => String(d.email || "").trim().toLowerCase() === email);

  if (existing){
    const { data: optout } = await admin.from("email_optouts").select("email").eq("email", email).maybeSingle();
    const blocked = existing.email_blocked && (!existing.email_blocked_until || existing.email_blocked_until >= sydneyToday());
    await admin.from("notes").insert({ id: rid("note_web"), linked_type: "doctor", linked_id: existing.id, note_type: "Update", text: consentNote, date: nowIso, created_by: "Website" });
    if (blocked || optout){
      await admin.from("tasks").insert({ id: rid("task_web"), title: `${existing.name} asked for their job radar link on the website, but their email is ${optout ? "unsubscribed" : "blocked"}. Check before sending.`, due_date: sydneyToday(), done: false, linked_type: "doctor", linked_id: existing.id });
      return reply({ ok: true });
    }
    if (existing.radar_unsubscribed) await admin.from("doctors").update({ radar_unsubscribed: false }).eq("id", existing.id);
    if (existing.specialty === "Psychiatry" || specialtyKey === "Psychiatry"){
      const m = linkEmail(existing, src);
      await send(admin, existing, String(existing.email).trim(), m.subject, m.html, m.text);
    } else {
      const m = otherSpecialtyEmail(existing);
      await send(admin, existing, String(existing.email).trim(), m.subject, m.html, m.text);
      await admin.from("tasks").insert({ id: rid("task_web"), title: `${existing.name} (${specialtyKey}) asked about a job radar on the website. Get in touch.`, due_date: sydneyToday(), done: false, linked_type: "doctor", linked_id: existing.id });
    }
    return reply({ ok: true });
  }

  const name = `${firstName} ${lastName}`;
  const { data: created, error } = await admin.from("doctors").insert({
    id: rid("doc_web"), name, first_name: firstName, last_name: lastName, email, mobile: mobile || null,
    specialty: SPECIALTIES[specialtyKey], grade, source: "Website - Job radar", radar_source: src
  }).select("id,name,first_name,email,job_radar_token,specialty").maybeSingle();
  if (error || !created){ console.error("create failed", error); return reply({ error: "We couldn't send your link just now. Please try again shortly." }, 500); }

  await admin.from("notes").insert({ id: rid("note_web"), linked_type: "doctor", linked_id: created.id, note_type: "Update", text: "New doctor from the website. " + consentNote, date: nowIso, created_by: "Website" });
  await admin.from("tasks").insert({ id: rid("task_web"), title: `New job radar sign-up from the website: ${name} (${specialtyKey}${grade ? ", " + grade : ""}). Check they're not already in the CRM under another email.`, due_date: sydneyToday(), done: false, linked_type: "doctor", linked_id: created.id });
  const m = specialtyKey === "Psychiatry" ? linkEmail(created, src) : otherSpecialtyEmail(created);
  await send(admin, created, email, m.subject, m.html, m.text);
  return reply({ ok: true });
});
