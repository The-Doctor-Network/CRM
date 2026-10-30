import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "npm:pdf-lib@1.17.1";
import { SECTIONS, TC_VERSION, canonicalText, sha256Hex, AGREEMENT_DOC_CATEGORY, type Block } from "../_shared/candidate-terms.ts";

// Public, no-login JSON API behind agreement.html (GitHub Pages) - same pattern as
// timesheet-portal: the static page renders, this function holds the data and does the work.
//
//   GET  ?token=...  -> the agreement text + candidate name; marks the link "opened"
//   POST ?token=...  -> { typedName, agreedTerms, agreedConsent, agreedSignatureAuth, signaturePng }
//                       records the signature (timestamp, IP, browser), builds the signed PDF with
//                       an audit page, files it on the doctor's Documents tab under the
//                       "Candidate agreement" credentialing category, emails the candidate their
//                       copy (from the recruiter who sent the link) and lets the recruiter know.
//
// Secrets: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto), RESEND_API_KEY / RESEND_FROM_EMAIL
// (same as send-email).

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
function clientIp(req: Request){
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "";
}
function sydney(d: Date, withTime = true){
  try {
    return d.toLocaleString("en-AU", withTime
      ? { timeZone: "Australia/Sydney", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short" }
      : { timeZone: "Australia/Sydney", day: "numeric", month: "long", year: "numeric" });
  } catch { return d.toISOString(); }
}
function firstNameOf(doc: any){
  if (doc?.first_name) return String(doc.first_name).trim();
  return String(doc?.name || "").trim().split(/\s+/)[0] || "";
}

/* ---------------- PDF ---------------- */

const INK = rgb(0x14 / 255, 0x23 / 255, 0x28 / 255);
const CORAL = rgb(0xF7 / 255, 0x67 / 255, 0x47 / 255);
const GREEN = rgb(0x1F / 255, 0x57 / 255, 0x4C / 255);
const MUTED = rgb(0.42, 0.47, 0.49);
const RULE = rgb(0.86, 0.85, 0.82);
const CREAM = rgb(0xFA / 255, 0xF9 / 255, 0xF6 / 255);

// Standard PDF fonts only cover Latin-1 (WinAnsi). Fold accents (é -> e) and replace anything
// else so an unusual character in a typed name can never break PDF generation.
function pdfSafe(s: string){
  return String(s ?? "")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E\xA0-\xFF•]/g, (ch) => {
      const folded = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
      return /^[\x20-\x7E\xA0-\xFF]+$/.test(folded) ? folded : "?";
    });
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = pdfSafe(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words){
    const trial = line ? line + " " + w : w;
    if (font.widthOfTextAtSize(trial, size) <= maxWidth) { line = trial; continue; }
    if (line) lines.push(line);
    line = w;
  }
  if (line) lines.push(line);
  return lines;
}

type Audit = {
  agreementId: string; doctorName: string; sentTo: string; sentBy: string;
  sentAt: Date; openedAt: Date | null; signedAt: Date; ip: string; userAgent: string;
  typedName: string; version: string; contentSha: string;
};

async function buildPdf(typedName: string, signaturePng: Uint8Array, audit: Audit){
  const pdf = await PDFDocument.create();
  pdf.setTitle(`TDN Candidate Terms & Conditions - ${pdfSafe(typedName)}`);
  pdf.setAuthor("The Doctor Network Aus Pty Ltd");
  pdf.setSubject(`Signed candidate agreement (${audit.version})`);
  pdf.setCreator("The Doctor Network CRM");
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const sig = await pdf.embedPng(signaturePng);

  const W = 595.28, H = 841.89, M = 54, CW = W - M * 2;
  const TOP = H - 92, BOTTOM = 70;
  let page: PDFPage; let y = TOP;

  function header(p: PDFPage){
    // Wordmark: "The Doctor Network" with the two o's of "Doctor" in coral and a coral smile arc
    // running underneath from one o to the other.
    let x = M; const yy = H - 50; const size = 15;
    const parts: [string, any][] = [["The D", INK], ["o", CORAL], ["ct", INK], ["o", CORAL], ["r Network", INK]];
    for (const [t, c] of parts){ p.drawText(t, { x, y: yy, size, font: bold, color: c }); x += bold.widthOfTextAtSize(t, size); }
    const o1 = M + bold.widthOfTextAtSize("The D", size);
    const o2End = M + bold.widthOfTextAtSize("The Doctor", size) - bold.widthOfTextAtSize("r", size);
    const arcW = o2End - o1;
    p.drawSvgPath(`M 0 0 Q ${arcW / 2} 6 ${arcW} 0`, { x: o1, y: yy - 4, borderColor: CORAL, borderWidth: 1.4 });
    const right = "Candidate Terms & Conditions";
    p.drawText(right, { x: W - M - reg.widthOfTextAtSize(right, 8.5), y: yy + 2, size: 8.5, font: reg, color: MUTED });
    p.drawLine({ start: { x: M, y: H - 64 }, end: { x: W - M, y: H - 64 }, thickness: 0.6, color: RULE });
  }
  function newPage(){ page = pdf.addPage([W, H]); header(page); y = TOP; }
  function ensure(h: number){ if (y - h < BOTTOM) newPage(); }
  function para(text: string, opts: { size?: number; font?: PDFFont; color?: any; indent?: number; gap?: number } = {}){
    const size = opts.size ?? 9.6, font = opts.font ?? reg, indent = opts.indent ?? 0, lh = size * 1.42;
    for (const ln of wrap(text, font, size, CW - indent)){
      ensure(lh); page.drawText(ln, { x: M + indent, y: y - size, size, font, color: opts.color ?? INK }); y -= lh;
    }
    y -= opts.gap ?? 6;
  }
  function bulletList(items: string[], ordered: boolean){
    const size = 9.6, lh = size * 1.42, ind = 16;
    items.forEach((it, i) => {
      const lines = wrap(it, reg, size, CW - ind);
      ensure(lh);
      page.drawText(ordered ? `${i + 1}.` : "•", { x: M + 3, y: y - size, size, font: ordered ? bold : reg, color: ordered ? GREEN : CORAL });
      lines.forEach((ln) => { ensure(lh); page.drawText(ln, { x: M + ind, y: y - size, size, font: reg, color: INK }); y -= lh; });
      y -= 2.5;
    });
    y -= 4;
  }
  function blocks(bs: Block[]){
    for (const b of bs){
      if ("h" in b){ ensure(34); y -= 6; page.drawText(pdfSafe(b.h), { x: M, y: y - 11.5, size: 11.5, font: bold, color: GREEN }); y -= 21; }
      else if ("p" in b) para(b.p.replace("{name}", typedName));
      else if ("ul" in b) bulletList(b.ul, false);
      else if ("ol" in b) bulletList(b.ol, true);
    }
  }
  function signatureBlock(agreeLabel: string){
    const blockH = 150;
    ensure(blockH); y -= 8;
    page.drawRectangle({ x: M, y: y - blockH + 10, width: CW, height: blockH - 10, color: CREAM, borderColor: RULE, borderWidth: 0.6 });
    let by = y - 22;
    // ticked box
    page.drawRectangle({ x: M + 14, y: by - 2, width: 10, height: 10, borderColor: GREEN, borderWidth: 1 });
    page.drawText("X", { x: M + 16.2, y: by - 0.2, size: 8.5, font: bold, color: GREEN });
    const labelLines = wrap(agreeLabel, bold, 9.2, CW - 50);
    labelLines.forEach((ln, i) => page.drawText(ln, { x: M + 32, y: by - i * 12.5, size: 9.2, font: bold, color: INK }));
    by -= labelLines.length * 12.5 + 14;
    const colW = (CW - 28) / 3;
    const cols = [
      { label: "Full name", value: typedName },
      { label: "Signature", value: "" },
      { label: "Date", value: sydney(audit.signedAt, false) },
    ];
    cols.forEach((c, i) => {
      const cx = M + 14 + i * colW;
      const lineY = by - 44;
      if (c.label === "Signature"){
        const dims = sig.scaleToFit(colW - 16, 44);
        page.drawImage(sig, { x: cx, y: lineY + 2, width: dims.width, height: dims.height });
      } else {
        const vl = wrap(c.value, reg, 10, colW - 16).slice(0, 2);
        vl.forEach((ln, k) => page.drawText(ln, { x: cx, y: lineY + 6 + (vl.length - 1 - k) * 12, size: 10, font: reg, color: INK }));
      }
      page.drawLine({ start: { x: cx, y: lineY }, end: { x: cx + colW - 16, y: lineY }, thickness: 0.6, color: MUTED });
      page.drawText(c.label, { x: cx, y: lineY - 11, size: 7.8, font: reg, color: MUTED });
    });
    page.drawText(pdfSafe(`Signed electronically - see signing certificate (Agreement ID ${audit.agreementId})`), { x: M + 14, y: y - blockH + 20, size: 7, font: reg, color: MUTED });
    y -= blockH + 6;
  }

  // Content: each section starts on a new page, like the original document.
  for (const s of SECTIONS){
    newPage();
    page!.drawText(pdfSafe(s.kicker.toUpperCase()), { x: M, y: y - 9, size: 8.5, font: bold, color: CORAL });
    y -= 22;
    page!.drawText(pdfSafe(s.title), { x: M, y: y - 20, size: 20, font: bold, color: INK });
    y -= 34;
    blocks(s.blocks);
    signatureBlock(s.agreeLabel);
  }

  // Signing certificate / audit trail
  newPage();
  page!.drawText("AUDIT TRAIL", { x: M, y: y - 9, size: 8.5, font: bold, color: CORAL });
  y -= 22;
  page!.drawText("Signing certificate", { x: M, y: y - 20, size: 20, font: bold, color: INK });
  y -= 40;
  const rows: [string, string][] = [
    ["Agreement ID", audit.agreementId],
    ["Document", "TDN Candidate Terms & Conditions, Form 1 Consent and Disclosure Form, Form 2 Signature Authorisation Form"],
    ["Version", audit.version],
    ["Candidate (CRM record)", audit.doctorName],
    ["Name typed by signer", audit.typedName],
    ["Signing link sent to", audit.sentTo],
    ["Sent by", audit.sentBy || "The Doctor Network"],
    ["Link sent", `${sydney(audit.sentAt)}  (${audit.sentAt.toISOString()})`],
    ["Link first opened", audit.openedAt ? `${sydney(audit.openedAt)}  (${audit.openedAt.toISOString()})` : "-"],
    ["Signed", `${sydney(audit.signedAt)}  (${audit.signedAt.toISOString()})`],
    ["IP address", audit.ip || "Not available"],
    ["Browser / device", audit.userAgent || "Not available"],
    ["Agreements ticked", "Candidate Terms & Conditions; Consent and Disclosure Form; Signature Authorisation Form"],
    ["Method", "Unique no-login link emailed to the candidate; typed full name, an 'I agree' tick for each form, and a hand-drawn signature."],
    ["Content fingerprint (SHA-256)", audit.contentSha],
  ];
  const labelW = 150;
  for (const [k, v] of rows){
    const lines = wrap(v, reg, 9, CW - labelW);
    const h = Math.max(lines.length, 1) * 12.6 + 8;
    ensure(h);
    page!.drawText(pdfSafe(k), { x: M, y: y - 9, size: 8.6, font: bold, color: GREEN });
    lines.forEach((ln, i) => page!.drawText(ln, { x: M + labelW, y: y - 9 - i * 12.6, size: 9, font: reg, color: INK }));
    y -= h;
    page!.drawLine({ start: { x: M, y: y + 3 }, end: { x: W - M, y: y + 3 }, thickness: 0.4, color: RULE });
  }
  y -= 14;
  ensure(70);
  page!.drawText("Signature captured", { x: M, y: y - 9, size: 8.6, font: bold, color: GREEN });
  const d2 = sig.scaleToFit(200, 60);
  page!.drawImage(sig, { x: M + labelW, y: y - 62, width: d2.width, height: d2.height });
  y -= 80;
  para("The content fingerprint is a SHA-256 hash of the exact wording the candidate was shown and agreed to. Any change to that wording produces a different fingerprint.", { size: 8, color: MUTED });

  // Footers with page numbers
  const pages = pdf.getPages();
  const foot = "The Doctor Network Aus Pty Ltd · ABN 68 702 173 297 · hello@thedoctornetwork.com.au · thedoctornetwork.com.au";
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 48 }, end: { x: W - M, y: 48 }, thickness: 0.5, color: RULE });
    p.drawText(pdfSafe(foot), { x: M, y: 36, size: 7.2, font: reg, color: MUTED });
    const pn = `Page ${i + 1} of ${pages.length}`;
    p.drawText(pn, { x: W - M - reg.widthOfTextAtSize(pn, 7.2), y: 36, size: 7.2, font: reg, color: MUTED });
    p.drawText(pdfSafe(`Agreement ID ${audit.agreementId} · ${audit.version}`), { x: M, y: 25, size: 6.5, font: reg, color: MUTED });
  });

  return await pdf.save();
}

/* ---------------- email ---------------- */

function toBase64(bytes: Uint8Array){
  let bin = ""; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

async function senderFor(admin: any, userId: string | null){
  let from = RESEND_FROM_EMAIL || ""; let replyTo: string | undefined; let signatureHtml = ""; let notifyEmail = FALLBACK_RECRUITER_EMAIL;
  if (userId){
    const { data: s } = await admin.from("user_settings").select("send_from_email, display_name, email_signature_html").eq("id", userId).maybeSingle();
    if (s?.send_from_email){
      from = s.display_name ? `${s.display_name} <${s.send_from_email}>` : s.send_from_email;
      replyTo = s.send_from_email; notifyEmail = s.send_from_email;
    }
    if (s?.email_signature_html) signatureHtml = s.email_signature_html;
  }
  return { from, replyTo, signatureHtml, notifyEmail };
}

async function sendEmail(admin: any, opts: { from: string; to: string; replyTo?: string; subject: string; html: string; attachments?: any[]; linkedId: string; sentBy: string }){
  if (!RESEND_API_KEY || !opts.from) return { ok: false };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: opts.from, to: [opts.to], reply_to: opts.replyTo, subject: opts.subject, html: opts.html, attachments: opts.attachments })
    });
    const body = await res.json().catch(() => ({} as any));
    await admin.from("sent_emails").insert({
      linked_type: "doctor", linked_id: opts.linkedId, to_email: opts.to, subject: opts.subject,
      resend_message_id: body?.id || null, status: res.ok ? "sent" : "failed", sent_by: opts.sentBy, error: res.ok ? null : JSON.stringify(body)
    });
    return { ok: res.ok };
  } catch (e){ console.error("email failed", e); return { ok: false }; }
}

const BTN = "display:inline-block;background:#F76747;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px;";

/* ---------------- handler ---------------- */

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const token = (url.searchParams.get("token") || "").trim();
  if (!token || !/^[a-f0-9]{32,64}$/.test(token)) return json({ error: "This link is missing or incomplete. Please ask The Doctor Network to resend it." }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: agr } = await admin.from("candidate_agreements").select("*").eq("token", token).maybeSingle();
  if (!agr) return json({ error: "This link is invalid or has been replaced by a newer one. Please ask The Doctor Network to resend it." }, 404);
  const { data: doc } = await admin.from("doctors").select("id, name, first_name, last_name, email").eq("id", agr.doctor_id).maybeSingle();
  const doctorName = doc?.name || "";

  if (req.method === "GET"){
    if (agr.status === "signed"){
      return json({ mode: "signed", doctorName, firstName: firstNameOf(doc), signedAt: agr.signed_at, typedName: agr.typed_name, version: agr.tc_version });
    }
    const now = new Date().toISOString();
    await admin.from("candidate_agreements").update({
      status: "opened", opened_at: agr.opened_at || now, open_count: (agr.open_count || 0) + 1
    }).eq("id", agr.id);
    return json({ mode: "sign", doctorName, firstName: firstNameOf(doc), version: TC_VERSION, sections: SECTIONS });
  }

  if (req.method !== "POST") return json({ error: "Not supported." }, 405);
  if (agr.status === "signed") return json({ error: "This agreement has already been signed - thank you!", mode: "signed" }, 409);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "Something went wrong reading your submission. Please try again." }, 400); }

  const typedName = String(body.typedName || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (typedName.length < 3) return json({ error: "Please type your full name." }, 400);
  if (!(body.agreedTerms === true && body.agreedConsent === true && body.agreedSignatureAuth === true)){
    return json({ error: "Please tick 'I agree' for all three forms before signing." }, 400);
  }
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.signaturePng || ""));
  if (!m) return json({ error: "Please draw your signature in the box." }, 400);
  let sigBytes: Uint8Array;
  try { sigBytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)); } catch { return json({ error: "Please draw your signature again." }, 400); }
  if (sigBytes.length < 300 || sigBytes.length > 600_000 || sigBytes[0] !== 0x89 || sigBytes[1] !== 0x50){
    return json({ error: "Please draw your signature again." }, 400);
  }

  const signedAt = new Date();
  const ip = clientIp(req);
  const userAgent = (req.headers.get("user-agent") || "").slice(0, 400);
  const contentSha = await sha256Hex(canonicalText());

  // Claim the row first (status guard) so a double-click can't produce two signed copies.
  const { data: claimed, error: claimErr } = await admin.from("candidate_agreements").update({
    status: "signed", signed_at: signedAt.toISOString(), signed_ip: ip, signed_user_agent: userAgent,
    typed_name: typedName, agreed_terms: true, agreed_consent: true, agreed_signature_auth: true,
    content_sha256: contentSha, tc_version: TC_VERSION
  }).eq("id", agr.id).neq("status", "signed").select("id");
  if (claimErr || !claimed || !claimed.length){
    return json({ error: "This agreement has already been signed - thank you!", mode: "signed" }, 409);
  }

  try {
    const pdfBytes = await buildPdf(typedName, sigBytes, {
      agreementId: agr.id, doctorName, sentTo: agr.sent_to_email || "", sentBy: agr.sent_by || "",
      sentAt: new Date(agr.sent_at), openedAt: agr.opened_at ? new Date(agr.opened_at) : null,
      signedAt, ip, userAgent, typedName, version: TC_VERSION, contentSha
    });

    const dateStamp = signedAt.toISOString().slice(0, 10);
    const safeName = (doctorName || typedName).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "Candidate";
    const fileName = `TDN_Candidate_Agreement_${safeName}_${dateStamp}.pdf`;
    const docId = "doc_file_agr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    const storagePath = `doctor/${agr.doctor_id}/${docId}_${fileName}`;
    const sigPath = `doctor/${agr.doctor_id}/${agr.id}_signature.png`;

    const up = await admin.storage.from("documents").upload(storagePath, pdfBytes, { contentType: "application/pdf", upsert: false });
    if (up.error) throw up.error;
    await admin.storage.from("documents").upload(sigPath, sigBytes, { contentType: "image/png", upsert: true });

    const { error: docErr } = await admin.from("documents").insert({
      id: docId, linked_type: "doctor", linked_id: agr.doctor_id, name: fileName, mime_type: "application/pdf",
      size: pdfBytes.length, uploaded_at: signedAt.toISOString(), uploaded_by: "E-signature", storage_path: storagePath,
      category: AGREEMENT_DOC_CATEGORY
    });
    if (docErr) throw docErr;

    await admin.from("candidate_agreements").update({ document_id: docId, storage_path: storagePath, signature_storage_path: sigPath }).eq("id", agr.id);

    await admin.from("notes").insert({
      id: "note_agr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10), linked_type: "doctor", linked_id: agr.doctor_id,
      note_type: "Update", text: `Signed the TDN Candidate T&Cs, Consent & Disclosure Form and Signature Authorisation Form (${TC_VERSION}) by e-signature as "${typedName}". Signed PDF saved to Documents.`,
      date: signedAt.toISOString(), created_by: "E-signature", created_at: signedAt.toISOString()
    });

    // Emails: candidate's copy (from the recruiter who sent the link), plus a heads-up to that recruiter.
    const sender = await senderFor(admin, agr.sent_by_user_id || null);
    const first = firstNameOf(doc) || typedName.split(" ")[0];
    const to = doc?.email || agr.sent_to_email;
    if (to){
      const html =
        `<p>Hi ${esc(first)},</p>` +
        `<p>Thanks for signing! Your signed copy of The Doctor Network's Candidate Terms &amp; Conditions, Consent and Disclosure Form and Signature Authorisation Form is attached for your records.</p>` +
        `<p>If anything in your circumstances changes, just reply to this email and let us know.</p>` +
        (sender.signatureHtml ? `<div style="margin-top:20px;">${sender.signatureHtml}</div>` : `<p>The Doctor Network</p>`);
      const r = await sendEmail(admin, {
        from: sender.from, to, replyTo: sender.replyTo, subject: "Your signed TDN candidate agreement", html,
        attachments: [{ filename: fileName, content: toBase64(pdfBytes) }], linkedId: agr.doctor_id, sentBy: "system"
      });
      if (r.ok) await admin.from("candidate_agreements").update({ copy_emailed_at: new Date().toISOString() }).eq("id", agr.id);
    }
    await sendEmail(admin, {
      from: RESEND_FROM_EMAIL || sender.from, to: sender.notifyEmail,
      subject: `Signed: ${doctorName || typedName} has signed the TDN T&Cs`,
      html: `<p>${esc(doctorName || typedName)} signed the candidate T&amp;Cs, consent form and signature authorisation on ${esc(sydney(signedAt))}.</p><p>The signed PDF is on their Documents tab and the "Candidate agreement" checklist item is ticked.</p><p><a href="${CRM_BASE}#/doctors/${encodeURIComponent(agr.doctor_id)}">Open their profile</a></p>`,
      linkedId: agr.doctor_id, sentBy: "system"
    });

    return json({ ok: true, firstName: first, signedAt: signedAt.toISOString(), emailedTo: to || null });
  } catch (e){
    console.error("post-sign processing failed", e);
    // The signature itself is recorded; flag the follow-up failure for the recruiter rather than
    // asking the candidate to sign again.
    await admin.from("notes").insert({
      id: "note_agr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10), linked_type: "doctor", linked_id: agr.doctor_id,
      note_type: "Update", text: `Signed the TDN Candidate T&Cs by e-signature as "${typedName}", but the signed PDF could not be generated/saved automatically (${String((e as any)?.message || e).slice(0, 160)}). Ask Claude to regenerate it from agreement ${agr.id}.`,
      date: signedAt.toISOString(), created_by: "E-signature", created_at: signedAt.toISOString()
    });
    return json({ ok: true, firstName: firstNameOf(doc), signedAt: signedAt.toISOString(), emailedTo: null, copyDelayed: true });
  }
});
