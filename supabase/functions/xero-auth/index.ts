import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Xero sends the user back here after they approve the CRM connection (the app's Redirect URI).
// No Supabase login on this request - it's trusted via the one-time `state` the CRM created
// through xero-api (action "authorize") for a signed-in user, valid for 15 minutes.
// Exchanges the code for tokens, picks the connected organisation and stores it, then sends the
// user back to CRM Settings.

const XERO_CLIENT_ID = Deno.env.get("XERO_CLIENT_ID") || "";
const XERO_CLIENT_SECRET = Deno.env.get("XERO_CLIENT_SECRET") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/xero-auth`;
const CRM_URL = "https://the-doctor-network.github.io/CRM/";

function back(result: string, detail = ""){
  const url = `${CRM_URL}?xero=${encodeURIComponent(result)}${detail ? "&xero_detail=" + encodeURIComponent(detail.slice(0, 200)) : ""}#/settings`;
  return new Response(null, { status: 302, headers: { Location: url } });
}

Deno.serve(async (req: Request) => {
  const u = new URL(req.url);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  const err = u.searchParams.get("error");
  if (err) return back("cancelled", err);
  if (!code || !state) return back("error", "Missing code or state");

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: st } = await admin.from("xero_oauth_states").select("*").eq("state", state).maybeSingle();
  await admin.from("xero_oauth_states").delete().eq("state", state);
  if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60 * 1000) return back("error", "This connect link has expired - please try again from Settings.");

  const tokRes = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI })
  });
  const tok = await tokRes.json().catch(() => ({}));
  if (!tokRes.ok || !tok.access_token) return back("error", tok.error || "Token exchange failed");

  const conRes = await fetch("https://api.xero.com/connections", { headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" } });
  const cons = await conRes.json().catch(() => []);
  const org = Array.isArray(cons) ? (cons.find((c: any) => c.tenantType === "ORGANISATION") || cons[0]) : null;
  if (!org) return back("error", "No Xero organisation was selected");

  await admin.from("xero_connection").upsert({
    id: "main", tenant_id: org.tenantId, tenant_name: org.tenantName || "",
    access_token: tok.access_token, refresh_token: tok.refresh_token,
    expires_at: new Date(Date.now() + (tok.expires_in || 1800) * 1000).toISOString(),
    connected_by: st.user_email || null, connected_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  return back("connected", org.tenantName || "");
});
