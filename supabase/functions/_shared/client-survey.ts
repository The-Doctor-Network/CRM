// The Doctor Network - Client Service Survey (questions shared by send-client-survey,
// survey-portal and, by copy, survey.html / index.html).
// Supports NSW Health Audit Guide 2.5, 2.7.3 and 2.8 and Manual Section 16.12.
// Changing a question? Bump SURVEY_VERSION so stored responses can be read against the
// wording that was actually shown.

export const SURVEY_VERSION = "2026-11 v1.0";
export const SURVEY_PAGE_BASE = "https://the-doctor-network.github.io/CRM/survey.html";

export type Question = { id: string; text: string };

export const QUESTIONS: Question[] = [
  { id: "q1", text: "How quickly did we respond to your requests for doctors (Orders)?" },
  { id: "q2", text: "How well did the doctors we put forward match the role (skills, experience, dates and times)?" },
  { id: "q3", text: "How complete and accurate was the credentialing information we provided with each doctor?" },
  { id: "q4", text: "How clinically competent were the doctors we supplied?" },
  { id: "q5", text: "How professional were our doctors (punctuality, communication, teamwork)?" },
  { id: "q6", text: "How well did we keep you informed about the status of your requests?" },
  { id: "q7", text: "How easy were we to reach, including after hours, weekends and public holidays?" },
  { id: "q8", text: "How well did we handle any concerns or complaints you raised?" },
  { id: "q9", text: "How accurate and timely were our invoices?" },
  { id: "q10", text: "Overall, how satisfied are you with our service?" },
];

export const RATING_LABELS: Record<number, string> = {
  1: "Very poor", 2: "Poor", 3: "Satisfactory", 4: "Good", 5: "Excellent",
};

export const COMMENT_FIELDS = [
  { id: "wellDone", text: "What did we do well?" },
  { id: "improve", text: "What should we improve?" },
  { id: "locumFeedback", text: "Is there anything about a specific doctor you'd like us to know? (This is handled under our complaints procedure.)" },
];
