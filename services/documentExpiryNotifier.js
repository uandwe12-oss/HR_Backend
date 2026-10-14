const cron = require('node-cron');
const getDriver = require('../lib/neo4j');
const { sendEmail } = require('./emailService');

function parseDateRobust(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const trimmed = dateStr.trim();
  const dmyMatch = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10) - 1;
    const year = parseInt(dmyMatch[3], 10);
    const d = new Date(year, month, day);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(trimmed);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Checks all DocumentFolder nodes for files/documents nearing expiration (within 2 months / 60 days).
 * Sends a notification email to administrators and marks the item so duplicate emails are prevented.
 */
async function checkAndSendDocumentExpiryNotifications(options = {}) {
  const driver = getDriver();
  const session = driver.session();
  const force = options && options.force === true;

  try {
    console.log(`🔍 [Document Expiry Notifier] Checking for documents expiring in the next 2 months...${force ? ' (Force mode: including previously notified)' : ''}`);

    // 1. Fetch all active files/documents with an endDate
    const query = `
      MATCH (f:DocumentFolder)
      WHERE f.endDate IS NOT NULL 
        AND trim(f.endDate) <> ""
        AND (f.status IS NULL OR f.status = "Active")
        ${force ? "" : "AND (f.expiryNotificationSent IS NULL OR f.expiryNotificationSent = false)"}
      OPTIONAL MATCH (parent:DocumentFolder)-[:HAS_SUBFOLDER]->(f)
      OPTIONAL MATCH (f)-[:CONTAINS_DOCUMENT]->(doc:DocumentItem)
      RETURN f, parent.name as parentName, collect(DISTINCT doc.name) as documentNames
    `;

    const result = await session.run(query);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const expiringItems = [];

    for (const record of result.records) {
      const f = record.get("f").properties;
      const parentName = record.get("parentName") || null;
      const documentNames = record.get("documentNames") || [];

      if (!f.endDate) continue;

      const endDate = parseDateRobust(f.endDate);
      if (!endDate) continue;
      endDate.setHours(0, 0, 0, 0);

      // Difference in days
      const diffMs = endDate.getTime() - today.getTime();
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

      // 2 months notice window: between 0 and 62 days before endDate (covers 2 full calendar months)
      if (diffDays >= 0 && diffDays <= 62) {
        expiringItems.push({
          id: f.id,
          name: f.name,
          category: f.category || 'General',
          startDate: f.startDate || 'N/A',
          endDate: f.endDate,
          description: f.description || '',
          parentName: parentName,
          documentNames: documentNames,
          createdBy: f.createdBy,
          diffDays: diffDays
        });
      }
    }

    if (expiringItems.length === 0) {
      console.log('✅ [Document Expiry Notifier] No documents expiring within 2 months found.');
      return { checked: result.records.length, expiring: 0, emailsSent: 0 };
    }

    console.log(`⚠️ [Document Expiry Notifier] Found ${expiringItems.length} document(s) expiring within 2 months.`);

    // 2. Fetch recipient email addresses
    const adminEmails = new Set();

    // === DYNAMIC: Fetch admin-configured recipients from Neo4j first ===
    try {
      const configResult = await session.run(`
        MATCH (n:NotificationConfig { type: 'documentExpiry' })
        RETURN n.emails AS emails
      `);
      if (configResult.records.length > 0) {
        const dbEmails = configResult.records[0].get('emails') || [];
        dbEmails.forEach((email) => {
          const clean = email.trim().toLowerCase();
          if (clean && clean.includes('@')) adminEmails.add(clean);
        });
        console.log(`📋 [Document Expiry Notifier] Loaded ${adminEmails.size} recipient(s) from DB config.`);
      }
    } catch (cfgErr) {
      console.warn('⚠️ [Document Expiry Notifier] Could not load DB recipients:', cfgErr.message);
    }

    // === FALLBACK: Use DOCUMENT_EXPIRY_NOTIFICATION_EMAILS from .env if no DB recipients configured ===
    if (adminEmails.size === 0) {
      const envFallback = process.env.DOCUMENT_EXPIRY_NOTIFICATION_EMAILS || process.env.ADMIN_EMAIL || '';
      envFallback.split(',').forEach((email) => {
        const clean = email.trim().toLowerCase();
        if (clean && clean.includes('@')) adminEmails.add(clean);
      });
      if (adminEmails.size > 0) {
        console.log(`📋 [Document Expiry Notifier] Using env fallback recipients (DOCUMENT_EXPIRY_NOTIFICATION_EMAILS): ${Array.from(adminEmails).join(', ')}`);
      } else {
        console.warn('⚠️ [Document Expiry Notifier] No recipients found in DB or env. Set DOCUMENT_EXPIRY_NOTIFICATION_EMAILS in .env');
      }
    }

    // Plus any configured in .env (ADMIN_EMAIL, DOCUMENT_EXPIRY_NOTIFICATION_EMAILS)
    const envEmails = [
      process.env.ADMIN_EMAIL,
      process.env.DOCUMENT_EXPIRY_NOTIFICATION_EMAILS
    ];
    for (const val of envEmails) {
      if (val && typeof val === 'string') {
        val.split(',').forEach((email) => {
          const clean = email.trim().toLowerCase();
          if (clean && clean.includes('@')) adminEmails.add(clean);
        });
      }
    }

    try {
      const userResult = await session.run(`
        MATCH (u:User)
        WHERE u.role IN ['Admin', 'Management'] AND u.email IS NOT NULL AND trim(u.email) <> ""
        RETURN DISTINCT u.email as email
      `);
      for (const rec of userResult.records) {
        const em = rec.get("email");
        if (em && em.includes('@')) adminEmails.add(em.trim().toLowerCase());
      }
    } catch (userErr) {
      console.warn('⚠️ [Document Expiry Notifier] Could not query admin emails from User nodes:', userErr.message);
    }

    // No emails excluded
    const EXCLUDED_EMAILS = new Set();

    const recipients = Array.from(adminEmails).filter(
      (email) => !EXCLUDED_EMAILS.has(email.toLowerCase())
    );


    if (recipients.length === 0) {
      console.warn('⚠️ [Document Expiry Notifier] No email recipients found.');
      return { checked: result.records.length, expiring: expiringItems.length, emailsSent: 0, error: 'No admin emails configured' };
    }

    // 3. Send email for each expiring document and mark as notified
    let sentCount = 0;

    for (const item of expiringItems) {
      const approxMonths = item.diffDays <= 30 ? '1 month' : '2 months';
      const subject = `⚠️ [2 Months Notice] Document Approaching End Date: ${item.name} (${item.endDate})`;

      const text = `Document Expiration Notice

Hello Administrator,

The following document is approaching its scheduled end date in approximately ${approxMonths} (${item.diffDays} days remaining):

• Document: ${item.name}
• Category: ${item.category}
${item.parentName ? `• Folder: ${item.parentName}\n` : ''}• Start Date: ${item.startDate}
• End Date: ${item.endDate} (${item.diffDays} days remaining)
${item.description ? `• Description: ${item.description}\n` : ''}${item.documentNames && item.documentNames.length > 0 ? `• Attached Files: ${item.documentNames.join(', ')}\n` : ''}
Please review this document in the HR Portal for renewal or required action.

Recruitment & Hiring Portal Document System`;

      const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 24px 12px; color: #1e293b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 620px; margin: 0 auto; background-color: #ffffff; border-radius: 20px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.06);">
    <!-- Header Banner with Gradient -->
    <tr>
      <td style="background: linear-gradient(135deg, #090d16 0%, #1e293b 60%, #1e3a8a 100%); padding: 32px 28px; text-align: left;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td>
              <div style="font-size: 11px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: #93c5fd; margin-bottom: 10px;">
                RECRUITMENT &amp; HIRING PORTAL • DOCUMENT ALERT
              </div>
              <div style="display: inline-block; background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); color: #78350f; font-size: 11px; font-weight: 800; padding: 5px 12px; border-radius: 9999px; margin-bottom: 12px; border: 1px solid #fcd34d;">
                ⏰ 2-MONTH EXPIRATION NOTICE
              </div>
              <h1 style="margin: 0 0 6px 0; font-size: 22px; font-weight: 800; color: #ffffff; letter-spacing: -0.02em;">
                Document Approaching End Date
              </h1>
              <p style="margin: 0; font-size: 13px; color: #cbd5e1; line-height: 1.4;">
                This document is scheduled to end in <strong>${item.diffDays} days</strong> (${approxMonths}). Action may be required.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Main Content Area -->
    <tr>
      <td style="padding: 28px;">
        <p style="margin-top: 0; margin-bottom: 20px; font-size: 14px; line-height: 1.6; color: #334155;">
          Hello Administrator,<br><br>
          This is an automated compliance notification that the following file/document in your portal is reaching its validity end date. Please review this document for extension, renewal, or required action.
        </p>

        <!-- Highlight Card -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; margin-bottom: 22px;">
          <tr>
            <td style="padding: 18px 20px;">
              <div style="font-size: 17px; font-weight: 800; color: #0f172a; margin-bottom: 8px;">
                📄 ${item.name}
              </div>
              <div>
                <span style="display: inline-block; background-color: #ede9fe; color: #6d28d9; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 9999px; border: 1px solid #ddd6fe; margin-right: 6px;">
                  ${item.category}
                </span>
                <span style="display: inline-block; background-color: #fee2e2; color: #991b1b; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 9999px; border: 1px solid #fecaca; margin-right: 6px;">
                  ⏰ ${item.diffDays} Days Remaining
                </span>
                ${item.parentName ? `
                <span style="display: inline-block; background-color: #e0f2fe; color: #0369a1; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 9999px; border: 1px solid #bae6fd;">
                  📁 ${item.parentName}
                </span>` : ''}
              </div>
            </td>
          </tr>
        </table>

        <!-- Two Column Date Highlights -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 22px;">
          <tr>
            <td width="48%" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px 16px; vertical-align: top;">
              <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #64748b; margin-bottom: 4px;">
                Start Date
              </div>
              <div style="font-size: 15px; font-weight: 800; color: #0f172a;">
                ${item.startDate || 'N/A'}
              </div>
            </td>
            <td width="4%"></td>
            <td width="48%" style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 12px; padding: 14px 16px; vertical-align: top;">
              <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #b91c1c; margin-bottom: 4px;">
                End Date (Expiry)
              </div>
              <div style="font-size: 15px; font-weight: 800; color: #dc2626;">
                ${item.endDate}
              </div>
            </td>
          </tr>
        </table>

        <!-- Detailed Specifications Table -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; margin-bottom: 24px; font-size: 13px;">
          <tr style="border-top: 1px solid #f1f5f9; border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 12px; font-weight: 700; color: #64748b; background-color: #f8fafc; width: 35%;">Document Name</td>
            <td style="padding: 10px 12px; color: #0f172a; font-weight: 700;">${item.name}</td>
          </tr>
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 12px; font-weight: 700; color: #64748b; background-color: #f8fafc;">Category</td>
            <td style="padding: 10px 12px; color: #0f172a;">${item.category}</td>
          </tr>
          ${item.parentName ? `
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 12px; font-weight: 700; color: #64748b; background-color: #f8fafc;">Folder Location</td>
            <td style="padding: 10px 12px; color: #0f172a;">📁 ${item.parentName}</td>
          </tr>` : ''}
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 12px; font-weight: 700; color: #64748b; background-color: #f8fafc;">Validity Window</td>
            <td style="padding: 10px 12px; color: #0f172a;">${item.startDate} &rarr; <span style="color: #dc2626; font-weight: 700;">${item.endDate}</span></td>
          </tr>
          ${item.description ? `
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 12px; font-weight: 700; color: #64748b; background-color: #f8fafc;">Description</td>
            <td style="padding: 10px 12px; color: #0f172a;">${item.description}</td>
          </tr>` : ''}
          ${item.documentNames && item.documentNames.length > 0 ? `
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 12px; font-weight: 700; color: #64748b; background-color: #f8fafc;">Attached Files</td>
            <td style="padding: 10px 12px; color: #0f172a;">${item.documentNames.join(', ')}</td>
          </tr>` : ''}
        </table>

        <!-- Call To Action Button -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
          <tr>
            <td align="center">
              <a href="http://localhost:5173/admin/documents" target="_blank" style="display: inline-block; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: #ffffff; font-size: 14px; font-weight: 800; text-decoration: none; padding: 14px 32px; border-radius: 12px; box-shadow: 0 4px 14px rgba(37, 99, 235, 0.35);">
                Open Document in Portal &rarr;
              </a>
            </td>
          </tr>
        </table>

        <!-- Security / Renewal Note -->
        <div style="background-color: #eff6ff; border-left: 3px solid #3b82f6; padding: 12px 16px; border-radius: 0 8px 8px 0; font-size: 12px; color: #1e40af; line-height: 1.5;">
          <strong>Tip:</strong> If this document has already been renewed or extended, please update its <strong>End Date</strong> in the portal. The system will automatically update the notification tracking.
        </div>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="background-color: #f8fafc; padding: 20px 28px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #94a3b8; line-height: 1.5;">
        Recruitment &amp; Hiring Portal • Document Compliance Notification<br>
        &copy; ${new Date().getFullYear()} All rights reserved.
      </td>
    </tr>
  </table>
</body>
</html>
`;

      // Send to all target recipients
      let docMailSentSuccessfully = false;
      for (const to of recipients) {
        try {
          const mailRes = await sendEmail({
            to,
            subject,
            text,
            html
          });
          if (mailRes && mailRes.success) {
            docMailSentSuccessfully = true;
          }
        } catch (sendErr) {
          console.error(`❌ [Document Expiry Notifier] Error sending to ${to}:`, sendErr.message);
        }
      }

      if (!docMailSentSuccessfully) {
        console.warn(`⚠️ [Document Expiry Notifier] Did NOT mark "${item.name}" as notified because email delivery failed. Will retry on next check.`);
        continue;
      }

      // Mark the item as notified in Neo4j to prevent duplicate emails
      await session.run(`
        MATCH (f:DocumentFolder { id: $id })
        SET f.expiryNotificationSent = true,
            f.expiryNotificationSentAt = datetime(),
            f.updatedAt = datetime()
      `, { id: item.id });

      sentCount++;
      console.log(`📧 [Document Expiry Notifier] Sent 2-month expiry notification for "${item.name}" (expires ${item.endDate}) to: ${recipients.join(', ')}`);
    }

    return {
      checked: result.records.length,
      expiring: expiringItems.length,
      emailsSent: sentCount,
      recipients: recipients
    };
  } catch (err) {
    console.error('❌ [Document Expiry Notifier] Error during document expiry check:', err);
    throw err;
  } finally {
    await session.close();
  }
}

/**
 * Initializes the daily cron schedule for document expiry notifications
 */
function startDocumentExpiryScheduler() {
  // Run daily at 09:00 AM (Asia/Kolkata)
  cron.schedule('0 9 * * *', async () => {
    console.log('🕒 [CRON] Running daily document expiry notification check...');
    try {
      await checkAndSendDocumentExpiryNotifications();
    } catch (e) {
      console.error('❌ [CRON] Failed to check document expirations:', e.message);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });

  console.log('⏰ Document Expiry Scheduler initialized (Runs daily at 09:00 AM Asia/Kolkata)');
}

/**
 * Sends a test/sample 2-month expiry notification email to verify SMTP and mailbox receipt.
 */
async function sendSampleDocumentExpiryEmail(customRecipients = null) {
  const recipients = customRecipients && customRecipients.length > 0 
    ? customRecipients 
    : ['bharathibharathi06733@gmail.com', 'bharill@kyotralis.com'];

  const sampleItem = {
    name: 'Sample NDA & Service Agreement (TEST)',
    category: 'PPO',
    parentName: 'Corporate Agreements 2026',
    startDate: '2025-12-14',
    endDate: '2026-12-14',
    diffDays: 60,
    description: 'This is a test notification verifying that the 2-month document expiration email system is working properly.',
    documentNames: ['Agreement_Signed.pdf', 'Terms_Schedule.docx']
  };

  const subject = `[HR Portal] [TEST ALERT] Document Expiration Notice: "${sampleItem.name}" expires in 2 months (60 days)`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; color: #1e293b; }
        .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
        .header { background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%); color: #ffffff; padding: 28px 24px; text-align: left; }
        .header h1 { margin: 0 0 6px 0; font-size: 20px; font-weight: 700; }
        .header p { margin: 0; font-size: 13px; color: #93c5fd; }
        .badge { display: inline-block; background: #fef3c7; color: #92400e; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 9999px; margin-bottom: 12px; border: 1px solid #fde68a; }
        .content { padding: 24px; }
        .intro { font-size: 14px; line-height: 1.6; color: #334155; margin-bottom: 20px; }
        .details-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px; }
        .details-table td { padding: 12px 14px; border-bottom: 1px solid #f1f5f9; }
        .details-table td.label { width: 35%; font-weight: 600; color: #64748b; background-color: #f8fafc; }
        .details-table td.value { width: 65%; color: #0f172a; font-weight: 500; }
        .highlight-expiry { color: #dc2626; font-weight: 700; }
        .footer { background: #f8fafc; padding: 18px 24px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <span class="badge">⏰ 2 Months Expiry Notice (TEST)</span>
          <h1>Document Approaching End Date</h1>
          <p>HR Portal Document Management System Alert</p>
        </div>
        <div class="content">
          <p class="intro">
            Hello Administrator,<br><br>
            This is a <strong>test verification notification</strong> confirming that your automated 2-month document expiration mail alert system is active and sending correctly to <strong>${recipients.join(', ')}</strong>.
          </p>

          <table class="details-table">
            <tr>
              <td class="label">Document Name</td>
              <td class="value"><strong>${sampleItem.name}</strong></td>
            </tr>
            <tr>
              <td class="label">Category</td>
              <td class="value">${sampleItem.category}</td>
            </tr>
            <tr>
              <td class="label">Folder / Location</td>
              <td class="value">📁 ${sampleItem.parentName}</td>
            </tr>
            <tr>
              <td class="label">Start Date</td>
              <td class="value">${sampleItem.startDate}</td>
            </tr>
            <tr>
              <td class="label">End Date (Expiry)</td>
              <td class="value highlight-expiry">${sampleItem.endDate} (60 days remaining)</td>
            </tr>
            <tr>
              <td class="label">Description</td>
              <td class="value">${sampleItem.description}</td>
            </tr>
            <tr>
              <td class="label">Attached Files</td>
              <td class="value">${sampleItem.documentNames.join(', ')}</td>
            </tr>
          </table>

          <p style="font-size: 13px; color: #475569; line-height: 1.5;">
            ✅ <strong>Status:</strong> Mail delivery configuration is working correctly!
          </p>
        </div>
        <div class="footer">
          This is an automated notification from the Recruitment & Hiring Portal Document System.<br>
          © ${new Date().getFullYear()} HR Portal. All rights reserved.
        </div>
      </div>
    </body>
    </html>
  `;

  const results = [];
  for (const to of recipients) {
    try {
      const res = await sendEmail({ to, subject, html });
      results.push({ to, success: res.success !== false, error: res.error || null });
    } catch (err) {
      results.push({ to, success: false, error: err.message });
    }
  }

  return { success: true, recipients, results };
}

module.exports = {
  checkAndSendDocumentExpiryNotifications,
  startDocumentExpiryScheduler,
  sendSampleDocumentExpiryEmail
};
