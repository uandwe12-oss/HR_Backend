const nodemailer = require('nodemailer');
require('dotenv').config();

// Create reusable transporter object using Outlook SMTP transport
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.office365.com',
  port: process.env.SMTP_PORT || 587,
  secure: process.env.SMTP_SECURE === 'true', // false for TLS (port 587)
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD,
  },
  tls: {
    ciphers: 'SSLv3'
  }
});

/**
 * Reusable function to send an email
 * @param {Object} options - Email options (to, subject, text, html)
 */
const sendEmail = async ({ to, cc, bcc, subject, text, html }) => {
  try {
    const mailOptions = {
      from: `"HR Portal" <${process.env.SMTP_EMAIL}>`,
      to,
      subject,
      text,
      html
    };
    if (cc) mailOptions.cc = cc;
    if (bcc) mailOptions.bcc = bcc;

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
