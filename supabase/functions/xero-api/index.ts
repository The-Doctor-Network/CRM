import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Everything the CRM asks of Xero (signed-in CRM users only). body: { action, ... }
//   status        -> { connected, tenantName, connectedAt, connectedBy }
//   authorize     -> { url }  (open it to approve the connection; Xero returns to xero-auth)
//   options       -> revenue accounts, branding themes, tracking categories for Settings
//   create_accounts { accounts:[{code,name,type}], trackingOption } -> creates missing accounts + "Recruiter" tracking
//   create_draft  { invoiceId } -> creates (or updates, while still a draft) a DRAFT invoice in Xero
//   sync          -> pulls status / paid date for every CRM invoice linked to Xero
//   disconnect
// Tokens live in xero_connection (no client access) and are refreshed here as needed.

const XERO_CLIENT_ID = Deno.env.get("XERO_CLIENT_ID") || "";
const XERO_CLIENT_SECRET = Deno.env.get("XERO_CLIENT_SECRET") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/xero-auth`;
const SCOPES = "offline_access openid profile email accounting.invoices accounting.payments.read accounting.contacts accounting.settings";
const API = "https://api.xero.com/api.xro/2.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function json(obj: unknown, status = 200){
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
class UserError extends Error {}

// "/Date(1700000000000+0000)/" -> ISO
function xeroDate(v: any): string | null {
  if (!v) return null;
  const m = String(v).match(/\/Date\((\d+)/);
  if (m) return new Date(Number(m[1])).toISOString();
  const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString();
}

async function getConnection(admin: any){
  const { data: c } = await admin.from("xero_connection").select("*").eq("id", "main").maybeSingle();
  if (!c || !c.refresh_token) throw new UserError("Xero isn't connected yet - connect it in Settings first.");
  if (c.expires_at && new Date(c.expires_at).getTime() - Date.now() > 120000) return c;
  const r = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refresh_token })
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new UserError("The Xero connection has expired - please reconnect Xero in Settings.");
  const upd = { access_token: t.access_token, refresh_token: t.refresh_token || c.refresh_token,
    expires_at: new Date(Date.now() + (t.expires_in || 1800) * 1000).toISOString(), updated_at: new Date().toISOString() };
  await admin.from("xero_connection").update(upd).eq("id", "main");
  return { ...c, ...upd };
}
async function xero(conn: any, method: string, path: string, body?: unknown){
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${conn.access_token}`, "xero-tenant-id": conn.tenant_id, Accept: "application/json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data: any = null; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok){
    const v = data?.Elements?.[0]?.ValidationErrors?.map((e: any) => e.Message).join("; ");
    throw new UserError("Xero said: " + (v || data?.Message || data?.Detail || text.slice(0, 200) || r.status));
  }
  return data;
}

function accountForPlacement(p: any, s: any){
  if (!p) return s.account_locum_fees || s.account_locum_billings;
  if (p.placement_type === "Permanent") return s.account_perm_fees;
  if (/other agency invoices/i.test(p.booking_route || "")) return s.account_split_income || s.account_locum_fees;
  if (p.payment_model === "Hospital pays doctor directly") return s.account_locum_fees;
  return s.account_locum_billings;
}

async function findOrCreateContact(conn: any, name: string, email: string){
  const q = await xero(conn, "GET", "/Contacts?searchTerm=" + encodeURIComponent(name) + "&summaryOnly=true");
  const hit = (q.Contacts || []).find((c: any) => (c.Name || "").trim().toLowerCase() === name.trim().toLowerCase() && c.ContactStatus !== "ARCHIVED");
  if (hit) return hit.ContactID;
  const created = await xero(conn, "POST", "/Contacts", { Contacts: [{ Name: name, EmailAddress: email || undefined }] });
  return created.Contacts[0].ContactID;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!XERO_CLIENT_ID || !XERO_CLIENT_SECRET) return json({ error: "Xero isn't set up yet - XERO_CLIENT_ID / XERO_CLIENT_SECRET secrets are missing." }, 500);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: userData } = await userClient.auth.getUser();
  if (!userData?.user) return json({ error: "Please sign in again." }, 401);
  const userEmail = userData.user.email || "";

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    switch (body.action){
      case "status": {
        const { data: c } = await admin.from("xero_connection").select("tenant_name, connected_at, connected_by, refresh_token").eq("id", "main").maybeSingle();
        return json({ connected: !!(c && c.refresh_token), tenantName: c?.tenant_name || "", connectedAt: c?.connected_at || null, connectedBy: c?.connected_by || "" });
      }
      case "authorize": {
        const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
        await admin.from("xero_oauth_states").delete().lt("created_at", new Date(Date.now() - 3600000).toISOString());
        await admin.from("xero_oauth_states").insert({ state, user_email: userEmail });
        const url = "https://login.xero.com/identity/connect/authorize?" + new URLSearchParams({
          response_type: "code", client_id: XERO_CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPES, state
        }).toString();
        return json({ url });
      }
      case "disconnect": {
        const { data: c } = await admin.from("xero_connection").select("*").eq("id", "main").maybeSingle();
        if (c?.refresh_token){
          await fetch("https://identity.xero.com/connect/revocation", {
            method: "POST",
            headers: { Authorization: "Basic " + btoa(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`), "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: c.refresh_token })
          }).catch(() => null);
        }
        await admin.from("xero_connection").delete().eq("id", "main");
        return json({ ok: true });
      }
      case "options": {
        const conn = await getConnection(admin);
        const [acc, themes, tracking] = await Promise.all([
          xero(conn, "GET", "/Accounts"),
          xero(conn, "GET", "/BrandingThemes"),
          xero(conn, "GET", "/TrackingCategories")
        ]);
        return json({
          tenantName: conn.tenant_name,
          accounts: (acc.Accounts || []).filter((a: any) => a.Status === "ACTIVE" && (a.Class === "REVENUE" || a.Type === "REVENUE" || a.Type === "SALES" || a.Type === "OTHERINCOME"))
            .map((a: any) => ({ code: a.Code, name: a.Name, type: a.Type })),
          brandingThemes: (themes.BrandingThemes || []).map((b: any) => ({ id: b.BrandingThemeID, name: b.Name, sortOrder: b.SortOrder })),
          trackingCategories: (tracking.TrackingCategories || []).map((t: any) => ({ name: t.Name, options: (t.Options || []).map((o: any) => o.Name) }))
        });
      }
      case "create_accounts": {
        const conn = await getConnection(admin);
        const existing = (await xero(conn, "GET", "/Accounts")).Accounts || [];
        const codes = new Set(existing.map((a: any) => String(a.Code)));
        const made: string[] = [], skipped: string[] = [];
        for (const a of (body.accounts || [])){
          if (codes.has(String(a.code))){ skipped.push(a.code + " " + a.name); continue; }
          await xero(conn, "PUT", "/Accounts", { Code: String(a.code), Name: a.name, Type: a.type || "REVENUE", TaxType: a.type === "DIRECTCOSTS" ? "INPUT" : "OUTPUT" });
          made.push(a.code + " " + a.name);
        }
        let tracking = "";
        if (body.trackingOption){
          const cats = (await xero(conn, "GET", "/TrackingCategories")).TrackingCategories || [];
          let cat = cats.find((c: any) => c.Name === "Recruiter");
          if (!cat){ cat = (await xero(conn, "PUT", "/TrackingCategories", { Name: "Recruiter" })).TrackingCategories[0]; tracking = "Created Recruiter tracking category"; }
          if (!(cat.Options || []).some((o: any) => o.Name === body.trackingOption)){
            await xero(conn, "PUT", `/TrackingCategories/${cat.TrackingCategoryID}/Options`, { Name: body.trackingOption });
            tracking = (tracking ? tracking + " with option " : "Added option ") + body.trackingOption;
          }
        }
        return json({ made, skipped, tracking });
      }
      case "create_draft": {
        const conn = await getConnection(admin);
        const { data: inv } = await admin.from("invoices").select("*").eq("id", String(body.invoiceId || "")).maybeSingle();
        if (!inv) throw new UserError("Invoice not found.");
        if (inv.type !== "agency") throw new UserError("Only TDN (agency fee) invoices go to Xero - doctor wage invoices are the doctor's own.");
        const lines = (inv.line_items || []).filter((li: any) => (li.description || "").trim() || Number(li.unitPrice));
        if (!lines.length) throw new UserError("This invoice has no line items yet.");
        const { data: s } = await admin.from("xero_settings").select("*").eq("id", "main").maybeSingle();
        const { data: p } = inv.placement_id ? await admin.from("placements").select("*").eq("id", inv.placement_id).maybeSingle() : { data: null };
        const account = accountForPlacement(p, s || {});
        if (!account) throw new UserError("Choose which Xero revenue accounts to use in Settings -> Xero first.");
        const to = inv.to_snapshot || {};
        const contactName = (to.name || "").trim();
        if (!contactName) throw new UserError("This invoice has no client name in its 'To' details.");
        const contactId = await findOrCreateContact(conn, contactName, to.email || p?.billing_email || "");

        let tracking: any[] | undefined;
        const recruiter = (p?.recruiter || "").trim();
        if (recruiter && s?.tracking_category_name){
          const cats = (await xero(conn, "GET", "/TrackingCategories")).TrackingCategories || [];
          const cat = cats.find((c: any) => c.Name === s.tracking_category_name);
          if (cat && (cat.Options || []).some((o: any) => o.Name === recruiter)) tracking = [{ Name: cat.Name, Option: recruiter }];
        }
        const payload: any = {
          Type: "ACCREC", Status: "DRAFT", LineAmountTypes: "Exclusive",
          Contact: { ContactID: contactId },
          Date: inv.issue_date || new Date().toISOString().slice(0, 10),
          DueDate: inv.due_date || undefined,
          InvoiceNumber: inv.invoice_number || undefined,
          Reference: to.poNumber || p?.po_number || undefined,
          BrandingThemeID: s?.branding_theme_id || undefined,
          LineItems: lines.map((li: any) => ({
            Description: li.description || "", Quantity: Number(li.qty) || 1, UnitAmount: Number(li.unitPrice) || 0,
            AccountCode: account, TaxType: inv.gst_enabled ? "OUTPUT" : "EXEMPTOUTPUT", Tracking: tracking
          }))
        };
        if (inv.xero_invoice_id){
          const cur = await xero(conn, "GET", `/Invoices/${inv.xero_invoice_id}`);
          const st = cur.Invoices?.[0]?.Status;
          if (st && st !== "DRAFT" && st !== "DELETED" && st !== "VOIDED") throw new UserError(`This invoice is already ${st.toLowerCase()} in Xero, so it can't be overwritten from the CRM.`);
          if (st === "DRAFT") payload.InvoiceID = inv.xero_invoice_id;
        }
        const out = await xero(conn, "POST", "/Invoices", { Invoices: [payload] });
        const x = out.Invoices[0];
        await admin.from("invoices").update({ xero_invoice_id: x.InvoiceID, xero_status: x.Status, xero_synced_at: new Date().toISOString() }).eq("id", inv.id);
        return json({ ok: true, xeroInvoiceId: x.InvoiceID, status: x.Status, url: `https://go.xero.com/app/invoicing/edit/${x.InvoiceID}`, updated: !!payload.InvoiceID });
      }
      case "sync": {
        const conn = await getConnection(admin);
        const { data: rows } = await admin.from("invoices").select("id, status, due_date, sent_at, paid_at, xero_invoice_id").not("xero_invoice_id", "is", null);
        let changed = 0;
        const today = new Date().toISOString().slice(0, 10);
        for (let i = 0; i < (rows || []).length; i += 40){
          const chunk = rows!.slice(i, i + 40);
          const res = await xero(conn, "GET", "/Invoices?IDs=" + chunk.map((r: any) => r.xero_invoice_id).join(","));
          for (const x of (res.Invoices || [])){
            const r = chunk.find((c: any) => c.xero_invoice_id === x.InvoiceID); if (!r) continue;
            const upd: any = { xero_status: x.Status, xero_synced_at: new Date().toISOString(), amount_paid: x.AmountPaid ?? null };
            if (x.Status === "PAID"){
              upd.status = "Paid"; upd.paid_at = xeroDate(x.FullyPaidOnDate) || r.paid_at || new Date().toISOString();
              if (!r.sent_at) upd.sent_at = upd.paid_at;
            } else if (x.Status === "AUTHORISED"){
              const due = (xeroDate(x.DueDate) || "").slice(0, 10) || r.due_date;
              upd.status = due && due < today ? "Overdue" : "Sent";
              if (!r.sent_at) upd.sent_at = new Date().toISOString();
              if (due) upd.due_date = due;
            }
            if (upd.status && upd.status !== r.status) changed++;
            await admin.from("invoices").update(upd).eq("id", r.id);
          }
        }
        return json({ ok: true, checked: (rows || []).length, changed });
      }
      default: return json({ error: "Unknown action" }, 400);
    }
  } catch (e){
    if (e instanceof UserError) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: "Something went wrong talking to Xero." }, 500);
  }
});
