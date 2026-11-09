import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { SURVEY_VERSION, SURVEY_PAGE_BASE } from "../_shared/client-survey.ts";

// Called by the CRM's "Send survey" / "Resend survey" button on a client profile (signed-in users only).
//   body: { clientId }
// - If the client has an uncompleted survey link already, it is re-sent (same link) and its send
//   count bumped, so there is only ever one live link per client.
// - Otherwise (never sent, or the last one is completed) a new link is created.
// Emails go out via Resend from the signed-in user's own "from" address with their signature,
// exactly like send-candidate-agreement. The link needs no login; it's a long random token.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function json(obj: unknown, status = 200){
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function esc(s: unknown){
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!RESEND_API_KEY) return json({ error: "Email sending is not configured yet - RESEND_API_KEY secret is missing." }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const clientId = String(body.clientId || "").trim();
  if (!clientId) return json({ error: "Missing client" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: userData } = await userClient.auth.getUser();
  const userId = userData?.user?.id || null;
  const userEmail = userData?.user?.email || null;
  if (!userId) return json({ error: "Please sign in again." }, 401);

  const { data: cl } = await admin.from("clients").select("id, name, first_name, email, hospital_id").eq("id", clientId).maybeSingle();
  if (!cl) return json({ error: "Client not found." }, 404);
  const to = String(cl.email || "").trim().toLowerCase();
  if (!to || !to.includes("@")) return json({ error: "This client has no email address on file." }, 400);
  const { data: optOut } = await admin.from("email_optouts").select("email").eq("email", to).maybeSingle();
  if (optOut) return json({ error: "This client has unsubscribed from emails, so the survey can't be emailed. Copy the link and send it another way if they've asked for it." }, 409);

  let orgName = "";
  if (cl.hospital_id){
    const { data: h } = await admin.from("hospitals").select("name").eq("id", cl.hospital_id).maybeSingle();
    orgName = h?.name || "";
  }

  const { data: me } = await admin.from("user_settings").select("send_from_email, display_name, email_signature_html").eq("id", userId).maybeSingle();
  let from = RESEND_FROM_EMAIL || ""; let replyTo: string | undefined;
  if (me?.send_from_email){ from = me.display_name ? `${me.display_name} <${me.send_from_email}>` : me.send_from_email; replyTo = me.send_from_email; }
  if (!from) return json({ error: "Set a sending address in Settings first." }, 500);
  const signatureHtml = me?.email_signature_html || "";

  const { data: latest } = await admin.from("client_surveys").select("*").eq("client_id", clientId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  let srv: any;
  const nowIso = new Date().toISOString();
  if (latest && latest.status !== "completed"){
    const { data, error } = await admin.from("client_surveys").update({
      sent_to_email: to, send_count: (latest.send_count || 1) + 1, last_sent_at: nowIso, survey_version: SURVEY_VERSION
    }).eq("id", latest.id).select("*").single();
    if (error) return json({ error: "Could not update the survey link." }, 500);
    srv = data;
  } else {
    const { data, error } = await admin.from("client_surveys").insert({
      client_id: clientId, hospital_id: cl.hospital_id || null, survey_version: SURVEY_VERSION, status: "sent",
      sent_to_email: to, sent_by: userEmail, sent_by_user_id: userId, sent_at: nowIso, last_sent_at: nowIso
    }).select("*").single();
    if (error) return json({ error: "Could not create the survey link." }, 500);
    srv = data;
  }

  const link = `${SURVEY_PAGE_BASE}?token=${srv.token}`;
  const first = (cl.first_name || String(cl.name || "").split(/\s+/)[0] || "").trim();
  const isReminder = (srv.send_count || 1) > 1;
  const subject = isReminder ? "Reminder: 3 minutes to tell us how we're doing?" : "How are we doing? A 3-minute survey from The Doctor Network";
  const html =
    `<p>Hi${first ? " " + esc(first) : ""},</p>` +
    (isReminder ? `<p>Just a gentle nudge on our service survey, in case it got buried.</p>` : `<p>Thanks for working with The Doctor Network${orgName ? " at " + esc(orgName) : ""}.</p>`) +
    `<p>We'd really value your honest feedback on our service: how quickly we respond, the doctors we put forward and how easy we are to work with. It's 10 quick ratings plus optional comments, takes about 3 minutes, and needs no login.</p>` +
    `<p style="margin:22px 0;"><a href="${link}" style="display:inline-block;background:#F76747;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px;">Take the survey</a></p>` +
    `<p style="font-size:12px;color:#6B7478;">Or copy this link into your browser: <a href="${link}" style="color:#1F574C;">${link}</a></p>` +
    `<p>Every response is read, and anything we can do better gets actioned. Thank you!</p>` +
    (signatureHtml ? `<div style="margin-top:20px;">${signatureHtml}</div>` : "");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject, html })
  });
  const rj = await res.json().catch(() => ({} as any));
  await admin.from("sent_emails").insert({
    linked_type: "client", linked_id: clientId, to_email: to, subject,
    resend_message_id: rj?.id || null, status: res.ok ? "sent" : "failed", sent_by: userEmail, error: res.ok ? null : JSON.stringify(rj)
  });
  if (!res.ok) return json({ error: rj?.message || "Failed to send email" }, 502);

  await admin.from("client_surveys").update({ resend_message_id: rj.id }).eq("id", srv.id);
  const { data: fresh } = await admin.from("client_surveys").select("*").eq("id", srv.id).single();
  return json({ ok: true, survey: fresh, reminder: isReminder });
});
