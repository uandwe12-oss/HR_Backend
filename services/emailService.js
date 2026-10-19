const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
dotenv.config();

function getTransporter() {
  // Reload .env so changes are picked up immediately without restarting server
  dotenv.config({ override: true });

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
    const fromName = (process.env.SMTP_FROM_NAME || 'UANDWE Team').trim();
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
  `;

  return await sendEmail({
    to: adminEmail,
    subject,
    html
  });
};

module.exports = {
  sendEmail,
  sendSalaryAdvanceEmail
};
