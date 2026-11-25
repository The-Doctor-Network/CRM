import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Public, no-login JSON API behind confirm.html (GitHub Pages).
//   GET  ?token=...  -> the confirmation exactly as emailed; marks it "opened"
//   POST ?token=...  -> { name, agree: true } accepts the booking: records name, time, IP and
//                       browser, adds a note to the placement and emails the recruiter.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL");
const CRM_BASE = "https://the-doctor-network.github.io/CRM/";
const FALLBACK_RECRUITER_EMAIL = "cydney@thedoctornetwork.com.au";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
function json(obj: unknown, status = 200){ return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } }); }
function esc(s: unknown){ return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function clientIp(req: Request){
  const xf = req.headers.get("x-forwarded-for"); if (xf) return xf.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "";
}
function sydney(d: Date){
  try { return d.toLocaleString("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }); }
  catch { return d.toISOString(); }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const token = new URL(req.url).searchParams.get("token") || "";
  if (!/^[a-f0-9]{32,64}$/.test(token)) return json({ error: "This link isn't valid." }, 404);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: c } = await admin.from("placement_confirmations").select("*").eq("token", token).maybeSingle();
  if (!c) return json({ error: "This link isn't valid or has been replaced by a newer one." }, 404);

  const { data: ag } = await admin.from("agency_settings").select("name").limit(1).maybeSingle();
  const view = () => ({
    party: c.party, subject: c.subject, bodyHtml: c.body_html, toName: c.to_name || "",
    status: c.status, acceptedAt: c.accepted_at, acceptedName: c.accepted_name, agencyName: ag?.name || "The Doctor Network"
  });

  if (req.method === "GET"){
    if (!c.opened_at){ await admin.from("placement_confirmations").update({ opened_at: new Date().toISOString(), status: c.status === "sent" ? "opened" : c.status }).eq("id", c.id); if (c.status === "sent") c.status = "opened"; }
    return json(view());
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (c.status === "accepted") return json(view());
  let b: any; try { b = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const name = String(b.name || "").trim().slice(0, 120);
  if (name.length < 2) return json({ error: "Please type your full name." }, 400);
  if (b.agree !== true) return json({ error: "Please tick the box to confirm." }, 400);

  const now = new Date();
  const upd = { status: "accepted", accepted_at: now.toISOString(), accepted_name: name, accepted_ip: clientIp(req), accepted_user_agent: (req.headers.get("user-agent") || "").slice(0, 300) };
  const { error } = await admin.from("placement_confirmations").update(upd).eq("id", c.id).neq("status", "accepted");
  if (error) return json({ error: "Couldn't record your acceptance - please try again." }, 500);
  Object.assign(c, upd);

  const who = c.party === "client" ? "Client" : "Doctor";
  await admin.from("notes").insert({
    id: "note_conf_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12), linked_type: "placement", linked_id: c.placement_id, note_type: "Update",
    text: `${who} confirmation ACCEPTED by ${name} (${c.to_email}) on ${sydney(now)}.`,
    date: now.toISOString().slice(0, 10), created_by: "Placement confirmation", created_at: now.toISOString()
  });

  // Let the recruiter who sent it know
  if (RESEND_API_KEY){
    let recruiter = c.sent_by || FALLBACK_RECRUITER_EMAIL, from = RESEND_FROM_EMAIL || "";
    if (c.sent_by_user_id){
      const { data: me } = await admin.from("user_settings").select("send_from_email, display_name").eq("id", c.sent_by_user_id).maybeSingle();
      if (me?.send_from_email){ recruiter = me.send_from_email; from = me.display_name ? `${me.display_name} <${me.send_from_email}>` : me.send_from_email; }
    }
    if (from){
      await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [recruiter], subject: `Accepted: ${c.subject}`,
          html: `<p><strong>${esc(name)}</strong> (${esc(c.to_email)}) accepted the ${who.toLowerCase()} confirmation <strong>${esc(c.subject)}</strong> on ${esc(sydney(now))}.</p>` +
            `<p><a href="${CRM_BASE}#/placements/${encodeURIComponent(c.placement_id)}">Open the placement in the CRM</a></p>` })
      }).catch(() => null);
    }
  }
  return json(view());
});
