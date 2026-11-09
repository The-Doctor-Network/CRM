import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { QUESTIONS, COMMENT_FIELDS, RATING_LABELS, SURVEY_VERSION } from "../_shared/client-survey.ts";

// Public, no-login JSON API behind survey.html (GitHub Pages) - same pattern as agreement-portal.
//
//   GET  ?token=...  -> survey questions + client first name / organisation; marks the link "opened"
//   POST ?token=...  -> { ratings: {q1..q10: 1-5 | null}, comments: {...}, respondentName,
//                         respondentRole, organisation, periodCovered, mayContact }
//                       stores the response, adds a note on the client profile and emails the
//                       recruiter who sent it (flagged if any score is 1-2 or a doctor concern is raised).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL");
const CRM_BASE = "https://the-doctor-network.github.io/CRM/";
const FALLBACK_RECRUITER_EMAIL = "cydney@thedoctornetwork.com.au";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
function json(obj: unknown, status = 200){
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
}
function esc(s: unknown){
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function clean(s: unknown, max: number){
  return String(s ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim().slice(0, max);
}
function clientIp(req: Request){
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "";
}
function sydney(d: Date){
  try {
    return d.toLocaleString("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" });
  } catch { return d.toISOString(); }
}

async function notifyEmailFor(admin: any, userId: string | null){
  if (!userId) return FALLBACK_RECRUITER_EMAIL;
  const { data: s } = await admin.from("user_settings").select("send_from_email").eq("id", userId).maybeSingle();
  return s?.send_from_email || FALLBACK_RECRUITER_EMAIL;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const token = (url.searchParams.get("token") || "").trim();
  if (!token || !/^[a-f0-9]{32,64}$/.test(token)) return json({ error: "This link is missing or incomplete. Please ask The Doctor Network to resend it." }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: srv } = await admin.from("client_surveys").select("*").eq("token", token).maybeSingle();
  if (!srv) return json({ error: "This link is invalid or has been replaced by a newer one. Please ask The Doctor Network to resend it." }, 404);
  const { data: cl } = await admin.from("clients").select("id, name, first_name, job_title, hospital_id").eq("id", srv.client_id).maybeSingle();
  let orgName = "";
  const hospId = srv.hospital_id || cl?.hospital_id;
  if (hospId){
    const { data: h } = await admin.from("hospitals").select("name").eq("id", hospId).maybeSingle();
    orgName = h?.name || "";
  }
  const firstName = (cl?.first_name || String(cl?.name || "").split(/\s+/)[0] || "").trim();

  if (req.method === "GET"){
    if (srv.status === "completed"){
      return json({ mode: "completed", firstName, completedAt: srv.completed_at });
    }
    const now = new Date().toISOString();
    await admin.from("client_surveys").update({
      status: "opened", opened_at: srv.opened_at || now, open_count: (srv.open_count || 0) + 1
    }).eq("id", srv.id);
    return json({
      mode: "survey", firstName, clientName: cl?.name || "", jobTitle: cl?.job_title || "", organisation: orgName,
      version: SURVEY_VERSION, questions: QUESTIONS, comments: COMMENT_FIELDS, ratingLabels: RATING_LABELS
    });
  }

  if (req.method !== "POST") return json({ error: "Not supported." }, 405);
  if (srv.status === "completed") return json({ error: "This survey has already been completed - thank you!", mode: "completed" }, 409);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "Something went wrong reading your answers. Please try again." }, 400); }

  const ratingsIn = body.ratings || {};
  const ratings: Record<string, number | null> = {};
  let answered = 0;
  for (const q of QUESTIONS){
    const v = ratingsIn[q.id];
    if (v === null || v === "na"){ ratings[q.id] = null; answered++; continue; }
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 5) return json({ error: "Please choose a rating (or N/A) for every question." }, 400);
    ratings[q.id] = n; answered++;
  }
  if (answered !== QUESTIONS.length) return json({ error: "Please choose a rating (or N/A) for every question." }, 400);

  const comments: Record<string, string> = {};
  for (const c of COMMENT_FIELDS) comments[c.id] = clean(body.comments?.[c.id], 3000);

  const scored = Object.values(ratings).filter((v): v is number => typeof v === "number");
  const average = scored.length ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 100) / 100 : null;
  const lowScores = QUESTIONS.filter((q) => typeof ratings[q.id] === "number" && (ratings[q.id] as number) <= 2);
  const flagged = lowScores.length > 0 || !!comments.locumFeedback;

  const completedAt = new Date();
  const respondentName = clean(body.respondentName, 120);
  const respondentRole = clean(body.respondentRole, 120);
  const organisation = clean(body.organisation, 160) || orgName;
  const periodCovered = clean(body.periodCovered, 80);
  const mayContact = body.mayContact === true ? true : body.mayContact === false ? false : null;

  // Claim the row first (status guard) so a double-click can't record two responses.
  const { data: claimed, error: claimErr } = await admin.from("client_surveys").update({
    status: "completed", completed_at: completedAt.toISOString(),
    responses: { version: SURVEY_VERSION, ratings, comments }, average_score: average, low_score: flagged,
    respondent_name: respondentName || null, respondent_role: respondentRole || null, organisation: organisation || null,
    period_covered: periodCovered || null, may_contact: mayContact,
    submitted_ip: clientIp(req), submitted_user_agent: (req.headers.get("user-agent") || "").slice(0, 400)
  }).eq("id", srv.id).neq("status", "completed").select("id");
  if (claimErr || !claimed || !claimed.length){
    return json({ error: "This survey has already been completed - thank you!", mode: "completed" }, 409);
  }

  // Note on the client profile (this is the Feedback log evidence for the audit).
  const lines: string[] = [];
  lines.push(`Completed the TDN Client Service Survey (${SURVEY_VERSION})${respondentName ? " - " + respondentName + (respondentRole ? ", " + respondentRole : "") : ""}${organisation ? " (" + organisation + ")" : ""}.`);
  lines.push(`Average score: ${average === null ? "n/a" : average.toFixed(2) + "/5"}.`);
  QUESTIONS.forEach((q, i) => {
    const v = ratings[q.id];
    lines.push(`${i + 1}. ${q.text} ${v === null ? "N/A" : v + " (" + RATING_LABELS[v as number] + ")"}`);
  });
  for (const c of COMMENT_FIELDS) if (comments[c.id]) lines.push(`${c.text} ${comments[c.id]}`);
  if (periodCovered) lines.push(`Period covered: ${periodCovered}.`);
  if (mayContact !== null) lines.push(`Happy to be contacted: ${mayContact ? "Yes" : "No"}.`);
  if (flagged) lines.push(`ACTION: ${lowScores.length ? "score of 1-2 given" : ""}${lowScores.length && comments.locumFeedback ? " and " : ""}${comments.locumFeedback ? "concern raised about a doctor" : ""}. Raise a corrective action and follow up within 5 business days (Manual 16.12, Section 8).`);
  await admin.from("notes").insert({
    id: "note_srv_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10), linked_type: "client", linked_id: srv.client_id,
    note_type: "Update", text: lines.join("\n"),
    date: completedAt.toISOString(), created_by: "Client survey", created_at: completedAt.toISOString()
  });

  // Heads-up to the recruiter who sent it.
  if (RESEND_API_KEY){
    const to = await notifyEmailFor(admin, srv.sent_by_user_id || null);
    const who = cl?.name || respondentName || "A client";
    const subject = flagged ? `ACTION NEEDED: survey response from ${who}` : `Survey completed: ${who}`;
    const rows = QUESTIONS.map((q, i) => {
      const v = ratings[q.id];
      const cell = v === null ? "N/A" : `${v} - ${RATING_LABELS[v as number]}`;
      const bad = typeof v === "number" && v <= 2;
      return `<tr><td style="padding:4px 10px 4px 0;">${i + 1}. ${esc(q.text)}</td><td style="padding:4px 0;font-weight:bold;${bad ? "color:#B23B21;" : ""}">${esc(cell)}</td></tr>`;
    }).join("");
    const commentHtml = COMMENT_FIELDS.filter((c) => comments[c.id]).map((c) => `<p><strong>${esc(c.text)}</strong><br>${esc(comments[c.id]).replace(/\n/g, "<br>")}</p>`).join("");
    const html =
      `<p>${esc(who)}${organisation ? " (" + esc(organisation) + ")" : ""} completed the client service survey on ${esc(sydney(completedAt))}. Average score: <strong>${average === null ? "n/a" : average.toFixed(2) + "/5"}</strong>.</p>` +
      (flagged ? `<p style="color:#B23B21;font-weight:bold;">This response needs follow-up: add it to the Corrective Actions register and contact the client within 5 business days.</p>` : "") +
      `<table style="border-collapse:collapse;font-size:14px;">${rows}</table>` + commentHtml +
      `<p><a href="${CRM_BASE}#/clients/${encodeURIComponent(srv.client_id)}/snapshot">Open their profile</a></p>`;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: RESEND_FROM_EMAIL || to, to: [to], subject, html })
      });
      const rj = await res.json().catch(() => ({} as any));
      await admin.from("sent_emails").insert({
        linked_type: "client", linked_id: srv.client_id, to_email: to, subject,
        resend_message_id: rj?.id || null, status: res.ok ? "sent" : "failed", sent_by: "system", error: res.ok ? null : JSON.stringify(rj)
      });
    } catch (e){ console.error("notify failed", e); }
  }

  return json({ ok: true, firstName, completedAt: completedAt.toISOString() });
});
