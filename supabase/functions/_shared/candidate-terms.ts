// The Doctor Network - Candidate Terms & Conditions, Consent and Disclosure Form, and Signature
// Authorisation Form. Single source of truth for the signing page (served as JSON by
// agreement-portal) AND the signed PDF, so what the candidate reads is exactly what gets signed.
//
// To change the wording: edit the text below, bump TC_VERSION, and redeploy BOTH
// agreement-portal and send-candidate-agreement. Links already sent keep the version they were
// sent with on their candidate_agreements row; the page always shows the version currently
// deployed here, so only ever change the text together with a version bump.

export const TC_VERSION = "2026-10 v1";

export type Block =
  | { h: string }
  | { p: string }
  | { ul: string[] }
  | { ol: string[] };

export type Section = {
  key: "terms" | "consent" | "signature_auth";
  kicker: string;
  title: string;
  blocks: Block[];
  agreeLabel: string;
};

export const SECTIONS: Section[] = [
  {
    key: "terms",
    kicker: "Candidate Agreement",
    title: "Candidate Terms & Conditions",
    blocks: [
      { p: "The Doctor Network Aus Pty Ltd (ABN 68 702 173 297) ('TDN', 'we' or 'us') provides introductory services between candidates ('you') and our clients, organisations and individuals including hospitals, clinics and medical practices ('clients'). This document sets out the terms and conditions upon which our services are provided to you." },
      { p: "TDN identifies candidates and opportunities for the placement of candidates with clients, and assists with checking candidate credentials." },
      { p: "Our clients pay a fee for our services. We will not charge you for placing you with a client. If you request our assistance with migration, medical registration or other services, we may charge you for some or all of these separate services. Whilst TDN may act as your agent for the period that you use our services, including assisting you in negotiating your contractual terms and conditions, we are not your employer. If you obtain a placement with a client, you will be engaged directly by the client either as an employee or independent contractor." },
      { p: "Before commencement of any placement, the client will ask you to abide by the client's policies and procedures and may ask you to sign a written contract. As TDN is not your employer or contracting your services, we are not responsible for payment to you or provision of wages, expense reimbursements, travel costs, sick pay, annual or long service leave, superannuation contributions, workers compensation, medical indemnity insurance, medical registration, education/training fees, or any other cost or expense you may incur." },

      { h: "Checks and disclosure" },
      { p: "As part of our quality assurance processes, we may undertake a range of checks on candidates to help us determine whether a candidate is likely to meet the legislative and registration requirements for the positions to which they may be referred." },
      { p: "We may also conduct checks for good character and clinical and professional competence. You must fully and truthfully disclose all relevant information, and permit us to check that information, including by contacting your referees." },
      { p: "Before we can represent you, we will require that you sign a consent and disclosure form in which you must state any disclosures regarding your medical registration status, professional standing, criminal record, health status and overall fitness to practise." },
      { p: "Candidates may be subject to requirements imposed by regulatory bodies. For example, medical boards will require doctors to provide evidence from current and previous medical registration bodies that they are of good standing and do not have restrictions on practice. You must disclose whether you have ever been investigated by any medical board, health complaints body or other statutory authority, suspended from duty pending investigation, or have had your licence to practise revoked or cancelled or conditions/restrictions imposed for any reason." },
      { p: "We may inquire as to whether you have been investigated by other bodies including, but not limited to, State Health authorities, health complaints bodies, the New Zealand Health and Disability Commissioner and the Medical Practitioners Tribunal of New Zealand." },
      { p: "We may also conduct an internet search based on your name and professional experience to consider whether there are any adverse reports in the public domain that may influence our ability to represent you." },
      { p: "Clients (and, where applicable, regulatory or immigration authorities) may require evidence that you have no material or adverse criminal record, and reserve the right to withdraw an offer of employment, refuse medical registration or refuse a visa depending on the nature of any criminal record. We will obtain your written consent prior to collection, use and disclosure of the results of any criminal record checks and/or working with children checks." },
      { p: "Medical boards require full disclosure of medical conditions and may grant registration with the condition of medical supervision. You must declare any medical conditions (including physical, mental health or substance abuse conditions) that may adversely affect your ability to carry out your clinical duties. If you require a visa to work in Australia or overseas, regulatory authorities will ask about infectious medical conditions that may pose a health risk to the country, or chronic conditions, the treatment of which may place a financial burden on public health services." },
      { p: "You have a duty of continuous disclosure to TDN even after you have been accepted as a candidate and/or (in the case of a locum) placed with a client." },
      { p: "You must inform us immediately of anything that might impact on your ability to carry out your duties, and keep us up to date regarding any changes in your professional circumstances, such as malpractice issues, registration restrictions, suspensions by a health or medical authority, or an illness/disability that impacts upon your ability to practise." },
      { p: "Disclosures must be provided directly to TDN either verbally or in writing. However, any notification given verbally must be confirmed in writing within three business days in accordance with the notice requirements of this document." },

      { h: "Placement costs, registration and indemnity" },
      { p: "TDN does not assist in payment of costs associated with any placement, such as relocation expenses or medical registration costs. Payment of such expenses is a matter for negotiation between the candidate and the client." },
      { p: "If we place you in a position and the client requests us to assist you with the registration and migration process, we may assist with this process to ensure that you are able to take up your position." },
      { p: "We strongly recommend that you have your own professional medical indemnity and medical malpractice insurance at all times, irrespective of whether you are provided with indemnity cover by a client. Please note that there may be specific legislative requirements concerning the type and level of such cover, and that medical registration boards may require written evidence that you have cover meeting these requirements." },
      { p: "If we successfully find you a locum placement, it is important that you are able to fulfil the requirements of the placement. This includes ensuring that you do not have other commitments that conflict with your ability to perform the job, including on-call or other after-hours work requirements. It is also important that you do not take on other commitments that will adversely affect your alertness and the quality of your patient care. As a guide, you should familiarise yourself with the principles set out in the Australian Medical Association's Safe Working Hours Code of Practice (available at www.ama.com.au)." },

      { h: "Privacy and confidentiality" },
      { p: "We understand and respect your need to have your details treated with discretion in the marketplace. The collection of your personal information, our use of it and its disclosure to third parties is governed by Australian privacy law. Other than to obtain legal advice or as required by law, we will not share your personal details, such as your curriculum vitae, or refer you for any roles without obtaining your permission. However, if you permit us to refer any of your personal information to a client, TDN is not responsible for any breach in privacy arising from the conduct of the client. At any time, you may request access to personal information that TDN holds about you. We will process such requests within a reasonable time and will provide access in accordance with the Privacy Act 1988 (Cth). We may charge a fee to cover the costs of verifying the application and retrieving the information requested." },
      { p: "TDN aims to protect the personal information it collects. Personal information will be managed confidentially and securely and destroyed appropriately when no longer required." },
      { p: "The fees that clients pay to TDN are confidential, and you must not solicit or disclose any information in relation to our fees. Our clients are bound by a confidentiality clause that states they must not disclose details relating to our fees to candidates." },
      { p: "You must not use, disclose or retain copies (in any form) of any confidential information of TDN, whether during or after a placement, unless otherwise required by law. The term 'confidential information', as it applies to you in this document, means all information which is not in the public domain, whether oral, in writing or any other visual, machine-readable or other form, relating to the business, affairs, fees, clients, client requirements, candidates, assignments, services, policies or procedures of TDN, or any other matter directed by TDN to be confidential." },
      { p: "By engaging with TDN, you have access to market knowledge, clients and opportunities to which you would not otherwise be privy. We therefore ask you to keep this information confidential and not disclose it to any third parties, including other recruitment agencies, consultants and candidates." },

      { h: "Fees payable by clients" },
      { p: "Our clients will be required to pay TDN a fee for your services if:" },
      { ul: [
        "you secure a private contract with a hospital, clinic, practice or other business, individual or organisation to which or whom you have been referred by TDN; or",
        "you are placed as a locum and then appointed as a substantive within 12 months of the last day of your locum placement."
      ] },
      { p: "The term 'substantive', as it applies to you in this document, means a candidate introduced by TDN who is appointed by the client to a fixed-term or permanent position and paid at an agreed rate." },
      { p: "Both you and the client have an obligation to inform us if either of these events occurs." },

      { h: "Representation, cancellations and liability" },
      { p: "Notwithstanding that you may be accepted as a candidate of TDN, we are under no obligation to represent you, refer you to clients for particular assignments or provide you with work." },
      { p: "TDN may decline or cease to represent you at any time without having to provide notice or reasons." },
      { p: "TDN is not liable for any decision taken by a client to cancel or terminate a placement or your contract with the client." },
      { p: "You agree that TDN and its directors, officers and employees will incur no liability to you if we decline or cease to represent you, do not refer you to assignments, do not provide you with work, or if a client cancels or terminates a placement or your contract." },
      { p: "Where TDN refers your details to clients, the decision to hire remains the decision of the client at all times." },
      { p: "Clients very rarely cancel or terminate locum or other placements, as they are depending on your service. However, they do from time to time request minor changes to an agreement in relation to matters such as work hours and accommodation options. We will always inform you as soon as we can if there are any such changes, cancellations or terminations relating to a placement." },
      { p: "Whilst we may be involved with your contract negotiations, TDN is not responsible for costs (such as accommodation, travel or loss of opportunity costs) incurred as a result of a cancellation or termination of any given placement. Depending upon the terms of your contract with the client, this may be either your or the client's responsibility." },
      { p: "You must inform us immediately if you wish to cancel or terminate a placement or make changes to your contract with a client." },
      { p: "Once you sign a contract with a client, you are bound by law to fulfil the obligations in that contract unless it is nullified by mutual consent or legally terminated. Should your withdrawal from a position be unreasonable, it is the client's prerogative to seek compensation for losses associated with the cost of engaging you and the opportunity cost of not filling the role with another candidate." },

      { h: "Notices and variations" },
      { p: "Any notification that you are required to provide to TDN in accordance with this document must be confirmed in writing, by email to hello@thedoctornetwork.com.au or by letter addressed to 'The Directors' at TDN's current place of business." },
      { p: "This document sets out the entire agreement between you and TDN as to the subject matter it deals with, and overrides any previous representations or agreements to the contrary." },
      { p: "TDN reserves the right to vary or update its Terms and Conditions at any time, and to request that you agree to such terms and conditions as a condition of your continued candidacy with TDN." },
      { p: "Any variation of this document must be verified in writing by TDN." },

      { h: "Acknowledgement" },
      { p: "I have read these Terms and Conditions and I agree to:" },
      { ol: [
        "comply with the Terms & Conditions for the entire period that I remain a candidate of TDN and the entire period of any locum placement that I obtain through TDN; and",
        "TDN's collection, use and disclosure of my personal information for the purposes of assisting me as a candidate."
      ] }
    ],
    agreeLabel: "I have read and agree to the Candidate Terms & Conditions above."
  },
  {
    key: "consent",
    kicker: "Form 1",
    title: "Consent and Disclosure Form",
    blocks: [
      { p: "I acknowledge the following:" },
      { ul: [
        "I am not aware of any investigation into my AHPRA registration.",
        "I have not had my registration cancelled and am not subject to any restrictions.",
        "I have not been investigated or suspended from duty by any medical board or council.",
        "I do not have any health problems that will affect my ability to carry out work.",
        "I have full working rights in Australia and can provide evidence of citizenship or visa.",
        "I am not aware of any outstanding medical negligence claims against me.",
        "I will disclose all current employment commitments to TDN in my CV and inform a TDN representative in writing if there are any changes.",
        "I must inform TDN if I am suspended or terminated from my usual duties at any other medical facility where I am employed.",
        "I will notify my employer of my intention to register with a medical locum agency.",
        "I will consider potential conflicts of interest and work health and safety risks, or risks to the quality of patient care.",
        "I have not been working, and am not working, as a lobbyist.",
        "If I am working through a Pty Ltd company, I have provided Professional Indemnity insurance, Public Liability insurance and WorkCover insurance.",
        "I agree to indemnify TDN against any claim made against it relating to medical negligence, dishonesty or otherwise which may arise in connection with any engagement or employment I may accept which is arranged by TDN.",
        "I will work to the best of my ability, with due diligence, punctuality, honesty, courtesy and care.",
        "I undertake to dress and behave appropriately.",
        "I undertake not to attend work impaired by the effects of alcohol or drugs.",
        "I undertake to notify TDN as soon as possible if an adverse event or situation occurs which could result in any disciplinary or legal action or compromise the status of my medical registration.",
        "I undertake to notify TDN as soon as possible about my inability to work a confirmed shift.",
        "I have no objection to TDN obtaining regular performance appraisal feedback reports from the employing organisation for quality purposes.",
        "I understand my engagement or employment could be terminated if my work or attitude is deemed unsatisfactory by the employer, or if my medical registration is altered or compromised in any way.",
        "I agree to notify TDN if I am charged with or convicted of any offence.",
        "I consent to TDN providing copies of my National Criminal Record Check (NCRC) and my Working With Children Check (WWCC) ID number to prospective employers for the purposes of obtaining work.",
        "I consent to TDN undertaking reference checks with my nominated referees.",
        "I have read the TDN Privacy Policy, available at thedoctornetwork.com.au/privacy.html."
      ] },
      { p: "For NSW Health placements, I agree to and am aware that:" },
      { ul: [
        "I will need to complete the online mandatory training for Locum Medical Officers in HETI Moodle or My Health Learning, and provide TDN with a certificate of completion.",
        "My role may involve the requirement to supervise Junior Medical Officers.",
        "If I am a current NSW Health employee, I must provide documentary evidence of approval to undertake secondary employment.",
        "If I am a current or former NSW Health employee, a NSW Health internal service check will be conducted as part of the pre-placement checks.",
        "I am able to perform an assignment in accordance with accepted medical practice and the direction of a NSW Public Health Organisation Department Head/supervisor."
      ] },
      { h: "Agreement" },
      { p: "I hereby certify that the information supplied above is true and correct. I consent to TDN making any reasonable inquiries to verify my credentials and good clinical standing to ensure that I am suitable for any position I am offered. This includes contacting referees that TDN deems appropriate and checking with any medical boards and licensing bodies with whom I have been registered in the past." },
      { p: "I consent to TDN passing on the results of any Criminal Record Checks and/or Working With Children Checks to employers which I may be required to undertake as part of the employment process, and understand that this is for credentialing purposes." },
      { p: "I agree to immediately inform TDN of any changes in my circumstances that may affect my ability to practise as a doctor. I give TDN unconditional and irrevocable consent to disclose this form (whether in whole or in part) to third parties, including potential employers, contractors and/or regulatory bodies." }
    ],
    agreeLabel: "I confirm the statements in the Consent and Disclosure Form are true and correct, and I give the consents set out above."
  },
  {
    key: "signature_auth",
    kicker: "Form 2",
    title: "Signature Authorisation Form",
    blocks: [
      // "{name}" is replaced with the candidate's typed full name (live on the page, and in the PDF).
      { p: "I, {name} (name), consent to TDN using the signature below as required to facilitate the completion of documentation/requirements for bodies throughout Australia such as (but not limited to):" },
      { ul: [
        "Hospitals",
        "State Health Authorities",
        "Medicare",
        "Local Health Services or Primary Health Networks",
        "Department of Health, Disability and Ageing"
      ] },
      { p: "Please note that any time your electronic signature is used, we will advise you of this and send you an electronic copy of the document." }
    ],
    agreeLabel: "I authorise TDN to use my signature as described in the Signature Authorisation Form."
  }
];

// Stable text used for the content fingerprint recorded on each signature (SHA-256), so the
// audit trail can show exactly which wording was agreed to.
export function canonicalText(): string {
  const out: string[] = [`TDN Candidate Terms & Conditions - ${TC_VERSION}`];
  for (const s of SECTIONS){
    out.push(`## ${s.kicker}: ${s.title}`);
    for (const b of s.blocks){
      if ("h" in b) out.push(`### ${b.h}`);
      else if ("p" in b) out.push(b.p);
      else if ("ul" in b) b.ul.forEach((li) => out.push(`- ${li}`));
      else if ("ol" in b) b.ol.forEach((li, i) => out.push(`${i + 1}. ${li}`));
    }
    out.push(`[x] ${s.agreeLabel}`);
  }
  return out.join("\n");
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Public signing page (GitHub Pages, same host as the CRM and timesheet.html).
export const AGREEMENT_PAGE_BASE = "https://the-doctor-network.github.io/CRM/agreement.html";

// Credentialing checklist category the signed PDF is filed under (matches the CRM's
// CREDENTIALING_SECTIONS key, so filing the PDF there ticks that checklist item).
export const AGREEMENT_DOC_CATEGORY = "candidate_agreement";
