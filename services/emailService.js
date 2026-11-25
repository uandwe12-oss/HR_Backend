const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

function getTransporter() {
  // Reload .env if present so changes are picked up immediately without restarting server
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true });
  }

  const email = (process.env.SMTP_EMAIL || '').trim();
  const rawPass = process.env.SMTP_PASSWORD || '';
  // Clean spaces from 16-letter Google App Password (e.g. "abcd efgh ijkl mnop" -> "abcdefghijklmnop")
  const pass = rawPass.replace(/\s+/g, '').trim();
  const host = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;

  if (host.includes('gmail')) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: email,
        pass: pass
      }
    });
  }

  return nodemailer.createTransport({
    host: host,
    port: port,
    secure: secure,
    auth: {
      user: email,
      pass: pass
    },
    tls: {
      rejectUnauthorized: false
    }
  });
}

/**
 * Reusable function to send an email
 * @param {Object} options - Email options (to, subject, text, html)
 */
const sendEmail = async ({ to, cc, bcc, subject, text, html, attachments, from }) => {
  try {
    const transporter = getTransporter();
    const fromEmail = (process.env.SMTP_EMAIL || '').trim();
    const fromName = (process.env.SMTP_FROM_NAME || 'UANDWE').trim();
    const defaultFrom = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;

    const plainText = text || (html ? html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');

    const mailOptions = {
      from: from || defaultFrom,
      to,
      subject,
      text: plainText,
      html
    };
    if (cc) mailOptions.cc = cc;
    if (bcc) mailOptions.bcc = bcc;
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      mailOptions.attachments = attachments;
    }

    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent successfully to ${to}. Message ID: ${info.messageId}`);
    console.log(`   SMTP Response: ${info.response}`);
    console.log(`   Accepted Recipients: ${JSON.stringify(info.accepted)}`);
    console.log(`   Rejected Recipients: ${JSON.stringify(info.rejected)}`);
    return { success: true, info };
  } catch (error) {
    console.error(`❌ Failed to send email to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Send an email notification to the Admin about a new Salary Advance Request
 * @param {Object} requestDetails - Details of the salary advance request
 */
const sendSalaryAdvanceEmail = async (requestDetails) => {
  const { employeeName, employeeNumber, requestedAmount, reason, submissionDate } = requestDetails;
  
  const adminEmail = process.env.ADMIN_EMAIL;
  
  if (!adminEmail) {
    console.error('❌ ADMIN_EMAIL environment variable is not set. Cannot send salary advance notification.');
    return { success: false, error: 'ADMIN_EMAIL not set' };
  }

  const subject = `New Salary Advance Request: ${employeeName}`;
  const html = `
    <h2>New Salary Advance Request Submitted</h2>
    <p>A new salary advance request requires your attention.</p>
    <table border="1" cellpadding="8" style="border-collapse: collapse;">
      <tr>
        <th style="text-align: left; background-color: #f2f2f2;">Employee Name</th>
        <td>${employeeName}</td>
      </tr>
      <tr>
        <th style="text-align: left; background-color: #f2f2f2;">Employee ID</th>
  <td>${employeeNumber || 'N/A'}</td>      </tr>
      <tr>
        <th style="text-align: left; background-color: #f2f2f2;">Requested Amount</th>
        <td>₹${requestedAmount}</td>
      </tr>
      <tr>
        <th style="text-align: left; background-color: #f2f2f2;">Reason</th>
        <td>${reason}</td>
      </tr>
      <tr>
        <th style="text-align: left; background-color: #f2f2f2;">Submission Date</th>
        <td>${submissionDate || new Date().toLocaleString()}</td>
      </tr>
    </table>
    <br>
    <p>Please log in to the HR Portal Admin Dashboard to approve or reject this request.</p>
    <br>
    <p style="color: #94a3b8; font-size: 11px; margin: 0; font-style: italic;">This is a system generated mail.</p>
  `;

  return await sendEmail({
    to: adminEmail,
    subject,
    html
  });
};

const escapeHtml = (value) => {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const PORTAL_URL = 'https://uandwe.com/myuandwe';
const PORTAL_LINK_HTML = `<a href="${PORTAL_URL}" target="_blank" rel="noopener noreferrer" style="color: #1d4ed8; font-weight: 600; text-decoration: underline;">Knowledge Base</a>`;

/**
 * Send a leave request notification email to Admin or Team Supervisor
 */
const sendLeaveApplicationEmail = async ({
  to,
  recipientRole = 'Admin',
  employeeName,
  employeeNumber,
  company,
  leaveType,
  startDate,
  endDate,
  totalDays,
  isLOP,
  lopDays,
  reason,
  customReason,
  teamName
}) => {
  if (!to) return { success: false, error: 'Recipient email not provided' };

  const safeName = escapeHtml(employeeName || 'Employee');
  const safeLeaveType = escapeHtml(leaveType);
  const roleLabel = recipientRole === 'Supervisor' ? 'Team Leave Request' : 'New Leave Request';
  const subject = `${roleLabel}: ${employeeName || 'Employee'} (${leaveType})`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1f2937;">
      <h2 style="color: #1d4ed8; margin-bottom: 8px;">${roleLabel}</h2>
      <p style="margin-top: 0;">A leave request has been submitted and requires your attention.</p>
      <table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%; border-color: #e5e7eb;">
        <tr>
          <th style="text-align: left; background-color: #f8fafc; width: 38%;">Employee Name</th>
          <td>${safeName}</td>
        </tr>
        <tr>
          <th style="text-align: left; background-color: #f8fafc;">Employee ID</th>
          <td>${escapeHtml(employeeNumber || 'N/A')}</td>
        </tr>
        ${teamName ? `<tr><th style="text-align: left; background-color: #f8fafc;">Team</th><td>${escapeHtml(teamName)}</td></tr>` : ''}
        ${company ? `<tr><th style="text-align: left; background-color: #f8fafc;">Company</th><td>${escapeHtml(company)}</td></tr>` : ''}
        <tr>
          <th style="text-align: left; background-color: #f8fafc;">Leave Type</th>
          <td>${safeLeaveType}</td>
        </tr>
        <tr>
          <th style="text-align: left; background-color: #f8fafc;">Dates</th>
          <td>${escapeHtml(startDate)} to ${escapeHtml(endDate)}</td>
        </tr>
        <tr>
          <th style="text-align: left; background-color: #f8fafc;">Total Days</th>
          <td>${escapeHtml(totalDays)}${isLOP ? ` <strong style="color: #dc2626;">(Includes ${escapeHtml(lopDays)} LOP day(s))</strong>` : ''}</td>
        </tr>
        <tr>
          <th style="text-align: left; background-color: #f8fafc;">Reason</th>
          <td>${escapeHtml(reason || 'N/A')}</td>
        </tr>
        ${customReason ? `<tr><th style="text-align: left; background-color: #f8fafc;">Additional Details</th><td>${escapeHtml(customReason)}</td></tr>` : ''}
      </table>
      <br>
      <p>Please log in to the ${PORTAL_LINK_HTML} to review this leave request.</p>
      <p style="color: #94a3b8; font-size: 11px; margin-top: 16px; font-style: italic;">This is a system generated mail.</p>
    </div>
  `;

  return await sendEmail({ to, subject, html });
};

/**
 * Send a leave status (Approved / Rejected) notification email to the Employee or Team Supervisor
 */
const sendLeaveStatusEmail = async ({
  to,
  recipientRole = 'Employee',
  employeeName,
  leaveType,
  startDate,
  endDate,
  totalDays,
  status,
  isLOP,
  lopDays,
  remarks
}) => {
  if (!to) return { success: false, error: 'Recipient email not provided' };

  const isApproved = status === 'Approved';
  const color = isApproved ? '#16a34a' : '#dc2626';
  const safeName = escapeHtml(employeeName || 'Employee');
  const isSupervisorRecipient = recipientRole === 'Supervisor';
  const subject = isSupervisorRecipient
    ? `Team Leave ${status}: ${employeeName || 'Employee'} (${leaveType}, ${startDate} to ${endDate})`
    : `Leave Request ${status}: ${leaveType} (${startDate} to ${endDate})`;

  const introLine = isSupervisorRecipient
    ? `The leave request submitted by <strong>${safeName}</strong> has been <strong style="color: ${color};">${escapeHtml(status)}</strong>.`
    : `Hi ${safeName}, your leave request has been <strong style="color: ${color};">${escapeHtml(status)}</strong>.`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1f2937;">
      <h2 style="color: ${color}; margin-bottom: 8px;">Leave Request ${escapeHtml(status)}</h2>
      <p style="margin-top: 0;">${introLine}</p>
      <table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%; border-color: #e5e7eb;">
        ${isSupervisorRecipient ? `<tr><th style="text-align: left; background-color: #f8fafc; width: 38%;">Employee Name</th><td>${safeName}</td></tr>` : ''}
        <tr>
          <th style="text-align: left; background-color: #f8fafc; width: 38%;">Status</th>
          <td style="color: ${color}; font-weight: bold;">${escapeHtml(status)}</td>
        </tr>
        <tr>
          <th style="text-align: left; background-color: #f8fafc;">Leave Type</th>
          <td>${escapeHtml(leaveType)}</td>
        </tr>
        <tr>
          <th style="text-align: left; background-color: #f8fafc;">Dates</th>
          <td>${escapeHtml(startDate)} to ${escapeHtml(endDate)}</td>
        </tr>
        <tr>
          <th style="text-align: left; background-color: #f8fafc;">Total Days</th>
          <td>${escapeHtml(totalDays)}</td>
        </tr>
        ${isApproved && isLOP ? `<tr><th style="text-align: left; background-color: #f8fafc;">LOP Note</th><td style="color: #dc2626;">${escapeHtml(lopDays)} day(s) treated as Loss Of Pay (LOP).</td></tr>` : ''}
        ${remarks && remarks.trim() ? `<tr><th style="text-align: left; background-color: #f8fafc;">Remarks</th><td>${escapeHtml(remarks.trim())}</td></tr>` : ''}
      </table>
      <br>
      <p>Please log in to the ${PORTAL_LINK_HTML} for more details.</p>
      <p style="color: #94a3b8; font-size: 11px; margin-top: 16px; font-style: italic;">This is a system generated mail.</p>
    </div>
  `;

  return await sendEmail({ to, subject, html });
};

module.exports = {
  sendEmail,
  sendSalaryAdvanceEmail,
  sendLeaveApplicationEmail,
  sendLeaveStatusEmail
};
