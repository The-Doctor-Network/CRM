import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Called by the CRM's "Send confirmation" button on a placement (signed-in users only), after the
// recruiter has reviewed and edited the email. Nothing is ever sent automatically.
//   body: { placementId, party: "client"|"doctor", toName, toEmail, cc, subject, bodyHtml }
// Creates a placement_confirmations row with a private accept link, emails the (edited) body with
// an "Accept booking" button from the signed-in user's own address + signature, logs it to
// sent_emails and adds a note to the placement.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CONFIRM_PAGE = "https://the-doctor-network.github.io/CRM/confirm.html";

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
// The body comes from the CRM's editor; keep formatting, drop anything active.
function sanitize(html: string){
  return String(html || "")
    .replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|meta|link)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|meta|link)[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*(javascript|data|vbscript):[^"']*\2/gi, '$1="#"');
}
function emailList(s: string){
  return String(s || "").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!RESEND_API_KEY) return json({ error: "Email sending is not configured yet - RESEND_API_KEY secret is missing." }, 500);

  let b: any; try { b = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const placementId = String(b.placementId || "");
  const party = b.party === "client" ? "client" : b.party === "doctor" ? "doctor" : "";
  const to = emailList(b.toEmail)[0];
  const cc = emailList(b.cc).filter((e) => e !== to);
  const subject = String(b.subject || "").trim();
  const bodyHtml = sanitize(b.bodyHtml);
  if (!placementId || !party) return json({ error: "Missing placement" }, 400);
  if (!to) return json({ error: "Please enter a valid email address to send to." }, 400);
  if (!subject || !bodyHtml.replace(/<[^>]+>/g, "").trim()) return json({ error: "The subject and email can't be empty." }, 400);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: userData } = await userClient.auth.getUser();
  const userId = userData?.user?.id || null, userEmail = userData?.user?.email || null;
  if (!userId) return json({ error: "Please sign in again." }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: p } = await admin.from("placements").select("id, doctor_id, hospital_id").eq("id", placementId).maybeSingle();
  if (!p) return json({ error: "Placement not found." }, 404);

  const { data: me } = await admin.from("user_settings").select("send_from_email, display_name, email_signature_html").eq("id", userId).maybeSingle();
  let from = RESEND_FROM_EMAIL || ""; let replyTo: string | undefined;
  if (me?.send_from_email){ from = me.display_name ? `${me.display_name} <${me.send_from_email}>` : me.send_from_email; replyTo = me.send_from_email; }
  if (!from) return json({ error: "Set a sending address in Settings first." }, 500);

  const { data: conf, error: insErr } = await admin.from("placement_confirmations").insert({
    placement_id: placementId, party, to_name: String(b.toName || "").trim() || null, to_email: to, cc: cc.join(", ") || null,
    subject, body_html: bodyHtml, sent_by: userEmail, sent_by_user_id: userId
  }).select("*").single();
  if (insErr || !conf) return json({ error: "Could not create the confirmation link." }, 500);

  const link = `${CONFIRM_PAGE}?token=${conf.token}`;
  const button = `<p style="margin:24px 0;"><a href="${link}" style="display:inline-block;background:#2F5D46;color:#ffffff;text-decoration:none;font-weight:bold;padding:13px 26px;border-radius:999px;font-size:15px;">Accept booking</a></p>` +
    `<p style="font-size:12px;color:#6B7478;margin-top:-8px;">Or open this link: <a href="${link}" style="color:#2F5D46;">${link}</a></p>`;
  // The Accept button goes straight after the "Please ... Accept ..." line if there is one, so the
  // recipient sees it before the detail; otherwise at the end.
  let html = bodyHtml;
  const m = html.match(/<(p|div)[^>]*>[^<]*(?:<[^>]+>[^<]*)*?accept[\s\S]*?<\/\1>/i);
  html = m && m.index !== undefined ? html.slice(0, m.index + m[0].length) + button + html.slice(m.index + m[0].length) : html + button;
  if (me?.email_signature_html) html += `<div style="margin-top:14px;">${me.email_signature_html}</div>`;
  html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1F2A24;">${html}</div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], cc: cc.length ? cc : undefined, reply_to: replyTo, subject, html })
  });
  const rj = await res.json().catch(() => ({} as any));
  await admin.from("sent_emails").insert({
    linked_type: party === "doctor" ? "doctor" : "placement", linked_id: party === "doctor" ? p.doctor_id : placementId, to_email: to, subject,
    resend_message_id: rj?.id || null, status: res.ok ? "sent" : "failed", sent_by: userEmail, error: res.ok ? null : JSON.stringify(rj)
  });
  if (!res.ok){
    await admin.from("placement_confirmations").delete().eq("id", conf.id);
    return json({ error: rj?.message || "Failed to send email" }, 502);
  }
  await admin.from("placement_confirmations").update({ resend_message_id: rj.id }).eq("id", conf.id);
  await admin.from("notes").insert({
    id: "note_conf_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12), linked_type: "placement", linked_id: placementId, note_type: "Update",
    text: `${party === "client" ? "Client" : "Doctor"} placement confirmation sent to ${b.toName ? b.toName + " " : ""}<${to}>${cc.length ? " (cc " + cc.join(", ") + ")" : ""} for acceptance.`,
    date: new Date().toISOString().slice(0, 10), created_by: userEmail, created_at: new Date().toISOString()
  });
  const { data: fresh } = await admin.from("placement_confirmations").select("id, placement_id, party, to_name, to_email, cc, subject, status, sent_at, opened_at, accepted_at, accepted_name, sent_by").eq("id", conf.id).single();
  return json({ ok: true, confirmation: fresh });
});
