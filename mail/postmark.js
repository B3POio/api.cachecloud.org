// mail/postmark.js
import { ServerClient } from "postmark";

let _client = null;
function getClient() {
  const token = process.env.POSTMARK_TOKEN;
  if (!token) {
    throw new Error(
      "Missing POSTMARK_TOKEN. Set it in your environment or .env before calling sendWelcomeEmail()."
    );
  }
  if (!_client) _client = new ServerClient(token);
  return _client;
}

export async function sendWelcomeEmail(to = {}) {
  const client = getClient(); // token checked here (runtime), not at import time
  return client.sendEmail({
    From: process.env.FROM_EMAIL,
    To: to,
    Subject: "Welcome to Trust Church!",
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.5;">
        <h1 style="color:#2c3e50;">Welcome to Trust Church!</h1>
        <p>We’re so glad you’re here.</p>
        <p>
          This is more than just a community—it’s a family rooted in God,
          strengthened by faith, and dedicated to good works and goodwill
          toward all. Here, you’ll find encouragement, purpose, and a place
          to grow alongside others who share the same heart for service and
          connection.
        </p>
        <p>
          Our mission is simple: to walk in love, build each other up, and
          shine light into the world through faith and action. Together,
          we can make a difference.
        </p>
        <p>Thank you for joining us on this journey. We can’t wait to walk alongside you in faith and fellowship.</p>
        <p style="margin-top: 2em;">With gratitude and hope,<br/>Trust Church</p>
      </div>
    `,
    TextBody: `
Welcome to Trust Church!

We’re so glad you’re here.

This is more than just a community—it’s a family rooted in God, strengthened by faith, and dedicated to good works and goodwill toward all. Here, you’ll find encouragement, purpose, and a place to grow alongside others who share the same heart for service and connection.

Our mission is simple: to walk in love, build each other up, and shine light into the world through faith and action. Together, we can make a difference.

Thank you for joining us on this journey. We can’t wait to walk alongside you in faith and fellowship.

With gratitude and hope,  
Trust Church
    `,
    MessageStream: process.env.POSTMARK_MESSAGE_STREAM || "outbound",
  });
}


export async function sendVolunteerApplicationReceipt({ to, firstName, jobTitle, jobId }) {
  const client = getClient();
  const safeTitle = jobTitle || "the volunteer role";
  const safeId = jobId ? ` (${jobId})` : "";

  return client.sendEmail({
  From: process.env.FROM_EMAIL,
  To: to,
  Subject: `We received your application for ${safeTitle}${safeId}`,
  HtmlBody: `
    <div style="font-family: Arial, sans-serif; color:#333; line-height:1.5;">
      <h2 style="margin:0 0 12px;">Thank you ${firstName || ""}!</h2>
      <p>We’re so excited that you’ve applied for <strong>${safeTitle}${safeId}</strong>!</p>
      <p>Our team will carefully review your application and reach out if there’s a fit. In the meantime, we’d love for you to be part of our community:</p>
      <ul>
        <li>👉 Follow us on Instagram: <a href="https://instagram.com/trust_church" style="color:#007bff; text-decoration:none;">@trust_church</a></li>
        <li>🤝 Join our community and stay connected with everything happening at Trust Church</li>
      </ul>
      <p>If you have any questions, just reply to this email — we’d be happy to help!</p>
      <p style="margin-top:18px;">With gratitude,<br>— The Trust Church Team</p>
    </div>
  `,
  TextBody:
`Thank you ${firstName || ""}!
We’re so excited that you’ve applied for ${safeTitle}${safeId}!

Our team will carefully review your application and reach out if there’s a fit. In the meantime, we’d love for you to be part of our community:

👉 Follow us on Instagram: @trust_church  
🤝 Join our community and stay connected with everything happening at Trust Church

If you have any questions, just reply to this email — we’d be happy to help!

— The Trust Church Team`,
  MessageStream: process.env.POSTMARK_MESSAGE_STREAM || "outbound",
});

}

export async function notifyAdminOfVolunteer({ applicant, jobTitle, jobId }) {
  const client = getClient();
  const safeTitle = jobTitle || "Volunteer Role";
  const safeId = jobId || "N/A";
  const {
    id,
    firstName, middleName, lastName,
    phone, email, socials, resumeUrl,
    createdAt
  } = applicant;

  const socialLines = Object.entries(socials || {})
    .map(([k, v]) => `<li><strong>${k}</strong>: ${v}</li>`)
    .join("") || "<li><em>None provided</em></li>";

  return client.sendEmail({
    From: process.env.FROM_EMAIL,
    To: "admin@trustchurch.org",
    Subject: `New Volunteer Application: ${safeTitle} (${safeId})`,
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; color:#333; line-height:1.5;">
        <h2 style="margin:0 0 12px;">New Volunteer Application</h2>
        <p><strong>Job:</strong> ${safeTitle} (${safeId})</p>
        <p><strong>Applicant ID:</strong> ${id}</p>
        <h3 style="margin:16px 0 8px;">Applicant</h3>
        <ul>
          <li><strong>Name:</strong> ${[firstName, middleName, lastName].filter(Boolean).join(" ")}</li>
          <li><strong>Email:</strong> ${email}</li>
          <li><strong>Phone:</strong> ${phone}</li>
          <li><strong>Resume:</strong> ${resumeUrl ? `<a href="${resumeUrl}">View resume</a>` : "Not uploaded"}</li>
          <li><strong>Submitted At:</strong> ${createdAt || "Server Timestamp"}</li>
        </ul>
        <h3 style="margin:16px 0 8px;">Socials</h3>
        <ul>${socialLines}</ul>
      </div>
    `,
    TextBody:
`New Volunteer Application

Job: ${safeTitle} (${safeId})
Applicant ID: ${id}

Applicant
- Name: ${[firstName, middleName, lastName].filter(Boolean).join(" ")}
- Email: ${email}
- Phone: ${phone}
- Resume: ${resumeUrl ? resumeUrl : "Not uploaded"}
- Submitted At: ${createdAt || "Server Timestamp"}

Socials:
${Object.entries(socials || {}).map(([k,v]) => `- ${k}: ${v}`).join("\n") || "- None provided"}
`,
    MessageStream: process.env.POSTMARK_MESSAGE_STREAM || "outbound",
  });
}
