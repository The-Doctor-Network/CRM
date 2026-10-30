import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { TC_VERSION, AGREEMENT_PAGE_BASE } from "../_shared/candidate-terms.ts";

// Called by the CRM's "Send T&Cs" / "Resend" button on a doctor profile (signed-in users only).
//   body: { doctorId }
// - If the doctor has an unsigned agreement link already, it is re-sent (same link) and its
//   send count bumped - so "Resend" never leaves two live links floating around.
// - Otherwise (never sent, or the last one is already signed) a new link is created.
// Emails go out via Resend from the signed-in user's own "from" address with their signature,
// exactly like send-email. The link needs no login; it's a long random token.

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
  const doctorId = String(body.doctorId || "").trim();
  if (!doctorId) return json({ error: "Missing doctor" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Who is sending (verify_jwt guarantees a valid CRM session got here)
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: userData } = await userClient.auth.getUser();
  const userId = userData?.user?.id || null;
  const userEmail = userData?.user?.email || null;
  if (!userId) return json({ error: "Please sign in again." }, 401);

  const { data: doc } = await admin.from("doctors").select("id, name, first_name, email, email_blocked").eq("id", doctorId).maybeSingle();
  if (!doc) return json({ error: "Doctor not found." }, 404);
  const to = String(doc.email || "").trim().toLowerCase();
  if (!to || !to.includes("@")) return json({ error: "This doctor has no email address on file." }, 400);
  if (doc.email_blocked) return json({ error: "This doctor is currently blocked from email sends." }, 409);
  const { data: optOut } = await admin.from("email_optouts").select("email").eq("email", to).maybeSingle();
  if (optOut) return json({ error: "This doctor has unsubscribed from emails, so the T&Cs can't be emailed. Send them the link another way if they've asked for it." }, 409);

  // Sender: the signed-in user's from-address + signature (same rules as send-email)
  const { data: me } = await admin.from("user_settings").select("send_from_email, display_name, email_signature_html").eq("id", userId).maybeSingle();
  let from = RESEND_FROM_EMAIL || ""; let replyTo: string | undefined;
  if (me?.send_from_email){ from = me.display_name ? `${me.display_name} <${me.send_from_email}>` : me.send_from_email; replyTo = me.send_from_email; }
  if (!from) return json({ error: "Set a sending address in Settings first." }, 500);
  const signatureHtml = me?.email_signature_html || "";

  // Reuse the open (unsigned) link if there is one, otherwise create a fresh one.
  const { data: latest } = await admin.from("candidate_agreements").select("*").eq("doctor_id", doctorId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  let agr: any;
  const nowIso = new Date().toISOString();
  if (latest && latest.status !== "signed"){
    const { data, error } = await admin.from("candidate_agreements").update({
      sent_to_email: to, send_count: (latest.send_count || 1) + 1, last_sent_at: nowIso, tc_version: TC_VERSION
    }).eq("id", latest.id).select("*").single();
    if (error) return json({ error: "Could not update the signing link." }, 500);
    agr = data;
  } else {
    const { data, error } = await admin.from("candidate_agreements").insert({
      doctor_id: doctorId, tc_version: TC_VERSION, status: "sent", sent_to_email: to,
      sent_by: userEmail, sent_by_user_id: userId, sent_at: nowIso, last_sent_at: nowIso
    }).select("*").single();
    if (error) return json({ error: "Could not create the signing link." }, 500);
    agr = data;
  }

  const link = `${AGREEMENT_PAGE_BASE}?token=${agr.token}`;
  const first = (doc.first_name || String(doc.name || "").split(/\s+/)[0] || "").trim();
  const isReminder = (agr.send_count || 1) > 1;
  const subject = isReminder ? "Reminder: your TDN candidate agreement to sign" : "Your TDN candidate agreement to sign";
  const html =
    `<p>Hi${first ? " " + esc(first) : ""},</p>` +
    (isReminder ? `<p>Just a quick reminder about our candidate paperwork - it's still waiting for your signature.</p>` : `<p>Thanks for registering with The Doctor Network!</p>`) +
    `<p>Before we can represent you, we need you to read and sign our Candidate Terms &amp; Conditions, Consent and Disclosure Form and Signature Authorisation Form. It only takes a few minutes, there's no login, and it works on your phone.</p>` +
    `<p style="margin:22px 0;"><a href="${link}" style="display:inline-block;background:#F76747;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px;">Review and sign</a></p>` +
    `<p style="font-size:12px;color:#6B7478;">Or copy this link into your browser: <a href="${link}" style="color:#1F574C;">${link}</a></p>` +
    `<p>Once you've signed, we'll email you a copy for your records. Any questions, just reply to this email.</p>` +
    (signatureHtml ? `<div style="margin-top:20px;">${signatureHtml}</div>` : "");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject, html })
  });
  const rj = await res.json().catch(() => ({} as any));
  await admin.from("sent_emails").insert({
    linked_type: "doctor", linked_id: doctorId, to_email: to, subject,
    resend_message_id: rj?.id || null, status: res.ok ? "sent" : "failed", sent_by: userEmail, error: res.ok ? null : JSON.stringify(rj)
  });
  if (!res.ok) return json({ error: rj?.message || "Failed to send email" }, 502);

  await admin.from("candidate_agreements").update({ resend_message_id: rj.id }).eq("id", agr.id);
  const { data: fresh } = await admin.from("candidate_agreements").select("*").eq("id", agr.id).single();
  return json({ ok: true, agreement: fresh, reminder: isReminder });
});
