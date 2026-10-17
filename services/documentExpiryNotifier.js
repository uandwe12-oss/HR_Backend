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
 * Checks all DocumentFolder nodes for files/documents nearing expiration (within 60 days).
 * Rules:
 * 1. Initial 60-Day Notice: Sent when a document enters the <= 60 day window.
 * 2. Weekly Monday Reminder: Dispatched every Monday morning (09:00 AM IST) as long as diffDays <= 60.
 * 3. Stop When Closed: If status === 'Closed', no emails are ever sent.
 * 4. Testing Recipient: Strictly bharill@kyotralis.com for current testing phase.
 */
async function checkAndSendDocumentExpiryNotifications(options = {}) {
  const driver = getDriver();
  const session = driver.session();
  const force = options && options.force === true;
  const forceMonday = options && (options.forceMonday === true || options.monday === true || force);

  try {
    // Current date and weekday in Asia/Kolkata
    const istDayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: 'Asia/Kolkata' }); // e.g. "Mon"
    const isMonday = istDayOfWeek === 'Mon' || forceMonday === true;
    const istTodayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD

    console.log(`🔍 [Document Expiry Notifier] Checking documents expiring within 60 days (Today: ${istTodayStr}, Day: ${istDayOfWeek}, IsMonday: ${isMonday})...`);

    // 1. Fetch all documents/folders that have an endDate and are NOT Closed or Archived
    const query = `
      MATCH (f:DocumentFolder)
      WHERE f.endDate IS NOT NULL 
        AND trim(f.endDate) <> ""
        AND (f.status IS NULL OR NOT f.status IN ['Closed', 'Archived'])
      OPTIONAL MATCH (parent:DocumentFolder)-[:HAS_SUBFOLDER]->(f)
      OPTIONAL MATCH (f)-[:CONTAINS_DOCUMENT]->(doc:DocumentItem)
      RETURN f, parent.name as parentName, collect(DISTINCT doc.name) as documentNames
    `;

    const result = await session.run(query);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const itemsToNotify = [];

    for (const record of result.records) {
      const f = record.get("f").properties;
      const parentName = record.get("parentName") || null;
      const documentNames = record.get("documentNames") || [];

      if (!f.endDate) continue;
      if (f.status === 'Closed' || f.status === 'Archived') continue;

      const endDate = parseDateRobust(f.endDate);
      if (!endDate) continue;
      endDate.setHours(0, 0, 0, 0);

      // Difference in days between endDate and today
      const diffMs = endDate.getTime() - today.getTime();
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

      // 60-day window: between 0 and 60 days
      if (diffDays < 0 || diffDays > 60) {
        continue;
      }

      // Check notification triggers:
      // Condition A: Initial 60-day alert (has never been notified)
      const needsInitialNotice = !f.expiryNotificationSent;

      // Condition B: Weekly Monday reminder (already had initial notice, today is Monday, and not yet sent today)
      const needsMondayReminder = f.expiryNotificationSent === true && isMonday && (f.lastExpiryReminderDate !== istTodayStr || force);

      if (!needsInitialNotice && !needsMondayReminder) {
        // Not eligible today (either already notified and today is not Monday, or already notified earlier today)
        continue;
      }

      const noticeType = needsInitialNotice ? 'INITIAL' : 'WEEKLY_REMINDER';

      itemsToNotify.push({
        id: f.id,
        name: f.name,
        category: f.category || 'General',
        startDate: f.startDate || 'N/A',
        endDate: f.endDate,
        description: f.description || '',
        parentName: parentName,
        documentNames: documentNames,
        createdBy: f.createdBy,
        diffDays: diffDays,
        reminderCount: f.reminderCount ? parseInt(f.reminderCount, 10) : 0,
        noticeType: noticeType
      });
    }

    if (itemsToNotify.length === 0) {
      console.log('✅ [Document Expiry Notifier] No documents needing notification today.');
      return { checked: result.records.length, expiring: 0, emailsSent: 0 };
    }

    console.log(`⚠️ [Document Expiry Notifier] Found ${itemsToNotify.length} document(s) needing notification today.`);

    // 2. Fetch all notification recipients configured by Admin in the panel
    const recipientEmails = new Set();

    try {
      const configResult = await session.run(`
        MATCH (n:NotificationConfig { type: 'documentExpiry' })
        RETURN n.emails AS emails
      `);
      if (configResult.records.length > 0) {
        const dbEmails = configResult.records[0].get('emails') || [];
        dbEmails.forEach((email) => {
          const clean = email.trim().toLowerCase();
          if (clean && clean.includes('@')) recipientEmails.add(clean);
        });
        console.log(`📋 [Document Expiry Notifier] Loaded ${recipientEmails.size} recipient(s) from NotificationConfig in DB: ${Array.from(recipientEmails).join(', ')}`);
      }
    } catch (cfgErr) {
      console.warn('⚠️ [Document Expiry Notifier] Could not load DB recipients:', cfgErr.message);
    }

    // Fallback to environment variables if no DB configuration exists yet
    if (recipientEmails.size === 0) {
      const envEmails = [
        process.env.DOCUMENT_EXPIRY_NOTIFICATION_EMAILS,
        process.env.ADMIN_EMAIL
      ];
      for (const val of envEmails) {
        if (val && typeof val === 'string') {
          val.split(',').forEach((email) => {
            const clean = email.trim().toLowerCase();
            if (clean && clean.includes('@')) recipientEmails.add(clean);
          });
        }
      }
    }

    // Hard fallback if empty
    if (recipientEmails.size === 0) {
      recipientEmails.add('bharill@kyotralis.com');
    }

    const recipients = Array.from(recipientEmails);
    console.log(`🎯 [Document Expiry Notifier] Active notification recipients (${recipients.length}): ${recipients.join(', ')}`);

    // 3. Dispatch emails and update Neo4j records
    let sentCount = 0;

    for (const item of itemsToNotify) {
      const isInitial = item.noticeType === 'INITIAL';
      const approxMonths = item.diffDays <= 30 ? 'less than 1 month' : 'approx 2 months';

      // Clean subject and headline: just 'Reminder' or 'Notice'
      const subject = isInitial
        ? `[Notice] Document Approaching End Date: ${item.name} (${item.endDate})`
        : `[Reminder] Document Approaching End Date: ${item.name} (${item.diffDays} days remaining)`;

      const badgeText = isInitial
        ? 'EXPIRATION NOTICE'
        : 'REMINDER';

      const headerTitle = isInitial
        ? 'Document Approaching End Date'
        : 'Document Expiry Reminder';

      const headerSubtitle = isInitial
        ? `This document entered its 60-day expiry window with <strong>${item.diffDays} days remaining</strong> (expires ${item.endDate}).`
        : `This document has <strong>${item.diffDays} days remaining</strong> until ${item.endDate}.`;

      const text = `${isInitial ? 'Document Expiry Notice' : 'Document Expiry Reminder'}

Hello Administrator,

This is an automated notification regarding the following document approaching its end date (${item.diffDays} days remaining):

• Document: ${item.name}
• Category: ${item.category}
${item.parentName ? `• Folder: ${item.parentName}\n` : ''}• Start Date: ${item.startDate}
• End Date: ${item.endDate} (${item.diffDays} days remaining)
${item.description ? `• Description: ${item.description}\n` : ''}${item.documentNames && item.documentNames.length > 0 ? `• Attached Files: ${item.documentNames.join(', ')}\n` : ''}

NOTE:
Please review this document in the HR Portal for renewal, extension, or closure. Once marked as "Closed", reminders will stop.

Portal Document Link: http://localhost:5173/admin/documents

Recruitment & Hiring Portal Document Compliance System`;

      const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f9fafb; margin: 0; padding: 24px 12px; color: #111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 10px; overflow: hidden; border: 1px solid #e5e7eb;">
    <!-- Simple Clean Header -->
    <tr>
      <td style="background-color: #1e293b; padding: 24px 24px; text-align: left;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td>
              <div style="font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #94a3b8; margin-bottom: 8px;">
                DOCUMENT COMPLIANCE • NOTIFICATION
              </div>
              <div style="display: inline-block; background-color: #334155; color: #f8fafc; font-size: 10px; font-weight: 600; padding: 3px 8px; border-radius: 4px; margin-bottom: 10px; letter-spacing: 0.04em;">
                ${badgeText}
              </div>
              <h1 style="margin: 0 0 4px 0; font-size: 18px; font-weight: 700; color: #ffffff; line-height: 1.3;">
                ${headerTitle}
              </h1>
              <p style="margin: 0; font-size: 13px; color: #cbd5e1; line-height: 1.4;">
                ${headerSubtitle}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Main Content Area -->
    <tr>
      <td style="padding: 24px;">
        <p style="margin-top: 0; margin-bottom: 18px; font-size: 13.5px; line-height: 1.6; color: #374151;">
          Hello Administrator,<br><br>
          ${isInitial 
            ? 'This is an automated notification that the following document in your portal has entered its <strong>60-day expiration window</strong>. Please review this document for renewal, extension, or closure.'
            : 'This is a <strong>Reminder</strong> that the following document is approaching its end date. Please review this document in the HR Portal.'}
        </p>

        <!-- Highlight Card (Simple, Neutral) -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 20px;">
          <tr>
            <td style="padding: 16px 18px;">
              <div style="font-size: 15px; font-weight: 700; color: #111827; margin-bottom: 8px;">
                📄 ${item.name}
              </div>
              <div>
                <span style="display: inline-block; background-color: #f3f4f6; color: #4b5563; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; border: 1px solid #e5e7eb; margin-right: 6px;">
                  ${item.category}
                </span>
                <span style="display: inline-block; background-color: #fef2f2; color: #991b1b; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; border: 1px solid #fee2e2; margin-right: 6px;">
                  ${item.diffDays} Days Remaining
                </span>
                ${item.parentName ? `
                <span style="display: inline-block; background-color: #f3f4f6; color: #4b5563; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; border: 1px solid #e5e7eb;">
                  📁 ${item.parentName}
                </span>` : ''}
              </div>
            </td>
          </tr>
        </table>

        <!-- Two Column Date Highlights -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
          <tr>
            <td width="48%" style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 14px; vertical-align: top;">
              <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: #6b7280; margin-bottom: 4px;">
                Start Date
              </div>
              <div style="font-size: 14px; font-weight: 700; color: #111827;">
                ${item.startDate || 'N/A'}
              </div>
            </td>
            <td width="4%"></td>
            <td width="48%" style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 14px; vertical-align: top;">
              <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: #6b7280; margin-bottom: 4px;">
                End Date (Expiry)
              </div>
              <div style="font-size: 14px; font-weight: 700; color: #b91c1c;">
                ${item.endDate}
              </div>
            </td>
          </tr>
        </table>

        <!-- Detailed Specifications Table -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; margin-bottom: 20px; font-size: 13px; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden;">
          <tr style="border-bottom: 1px solid #e5e7eb;">
            <td style="padding: 10px 12px; font-weight: 600; color: #4b5563; background-color: #f9fafb; width: 35%;">Document Name</td>
            <td style="padding: 10px 12px; color: #111827; font-weight: 600;">${item.name}</td>
          </tr>
          <tr style="border-bottom: 1px solid #e5e7eb;">
            <td style="padding: 10px 12px; font-weight: 600; color: #4b5563; background-color: #f9fafb;">Category</td>
            <td style="padding: 10px 12px; color: #111827;">${item.category}</td>
          </tr>
          ${item.parentName ? `
          <tr style="border-bottom: 1px solid #e5e7eb;">
            <td style="padding: 10px 12px; font-weight: 600; color: #4b5563; background-color: #f9fafb;">Folder Location</td>
            <td style="padding: 10px 12px; color: #111827;">📁 ${item.parentName}</td>
          </tr>` : ''}
          <tr style="border-bottom: 1px solid #e5e7eb;">
            <td style="padding: 10px 12px; font-weight: 600; color: #4b5563; background-color: #f9fafb;">Validity Window</td>
            <td style="padding: 10px 12px; color: #111827;">${item.startDate} &rarr; <span style="color: #b91c1c; font-weight: 600;">${item.endDate}</span></td>
          </tr>
          ${item.description ? `
          <tr style="border-bottom: 1px solid #e5e7eb;">
            <td style="padding: 10px 12px; font-weight: 600; color: #4b5563; background-color: #f9fafb;">Description</td>
            <td style="padding: 10px 12px; color: #374151;">${item.description}</td>
          </tr>` : ''}
          ${item.documentNames && item.documentNames.length > 0 ? `
          <tr>
            <td style="padding: 10px 12px; font-weight: 600; color: #4b5563; background-color: #f9fafb;">Attached Files</td>
            <td style="padding: 10px 12px; color: #111827;">${item.documentNames.join(', ')}</td>
          </tr>` : ''}
        </table>

        <!-- Simple, Professional Button -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
          <tr>
            <td align="center">
              <a href="http://localhost:5173/admin/documents" target="_blank" style="display: inline-block; background-color: #1e293b; color: #ffffff; font-size: 13px; font-weight: 600; text-decoration: none; padding: 12px 28px; border-radius: 6px;">
                Open Document in Portal &rarr;
              </a>
            </td>
          </tr>
        </table>

        <!-- Simple Note (No loud colors) -->
        <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; padding: 12px 14px; border-radius: 6px; font-size: 12px; color: #6b7280; line-height: 1.5;">
          <strong>Note:</strong> Once an Administrator marks this document as <strong>"Closed"</strong> in the HR Portal, reminders for this document will stop.
        </div>
      </td>
    </tr>

    <!-- Clean Simple Footer -->
    <tr>
      <td style="background-color: #f9fafb; padding: 16px 24px; border-top: 1px solid #e5e7eb; text-align: center; font-size: 11px; color: #9ca3af; line-height: 1.5;">
        Recruitment &amp; Hiring Portal • Document Compliance Notification<br>
        &copy; ${new Date().getFullYear()} All rights reserved.
      </td>
    </tr>
  </table>
</body>
</html>
`;

      // Send to recipients (bharill@kyotralis.com for testing)
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
        console.warn(`⚠️ [Document Expiry Notifier] Did NOT mark "${item.name}" because email delivery failed. Will retry on next check.`);
        continue;
      }

      // Update node in Neo4j with notification status and reminder tracking
      await session.run(`
        MATCH (f:DocumentFolder { id: $id })
        SET f.expiryNotificationSent = true,
            f.expiryNotificationSentAt = coalesce(f.expiryNotificationSentAt, datetime()),
            f.lastExpiryReminderDate = $todayStr,
            f.lastExpiryReminderAt = datetime(),
            f.reminderCount = coalesce(f.reminderCount, 0) + 1,
            f.updatedAt = datetime()
      `, { id: item.id, todayStr: istTodayStr });

      sentCount++;
      console.log(`📧 [Document Expiry Notifier] Sent ${item.noticeType} notification for "${item.name}" (${item.diffDays} days remaining) to: ${recipients.join(', ')}`);

      // Polite 300ms pause between separate document emails to avoid SMTP connection throttling
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    return {
      checked: result.records.length,
      expiring: itemsToNotify.length,
      emailsSent: sentCount,
      recipients: recipients,
      isMonday: isMonday
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
 * Sends a test/sample expiry notification email to verify SMTP and mailbox receipt.
 */
async function sendSampleDocumentExpiryEmail(customRecipients = null) {
  let recipients = customRecipients && customRecipients.length > 0 ? customRecipients : [];

  if (recipients.length === 0) {
    const driver = getDriver();
    const session = driver.session();
    try {
      const cfgResult = await session.run(`
        MATCH (n:NotificationConfig { type: 'documentExpiry' })
        RETURN n.emails AS emails
      `);
      if (cfgResult.records.length > 0) {
        recipients = cfgResult.records[0].get('emails') || [];
      }
    } catch (e) {
      console.warn('⚠️ Could not load DB recipients for sample email:', e.message);
    } finally {
      await session.close();
    }
  }

  if (recipients.length === 0) {
    recipients = ['swathi@uandwe.com', 'bharill@kyotralis.com', 'ravi@uandwe.com'];
  }

  const sampleItem = {
    name: 'Sample NDA & Service Agreement (TEST)',
    category: 'PPO',
    parentName: 'Corporate Agreements 2026',
    startDate: '2025-12-14',
    endDate: '2026-12-14',
    diffDays: 60,
    description: 'This is a test notification verifying that the 60-day document expiration email system is working properly.',
    documentNames: ['Agreement_Signed.pdf', 'Terms_Schedule.docx']
  };

  const subject = `[HR Portal] [TEST ALERT] Document Expiration Notice: "${sampleItem.name}" (60 days remaining)`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f9fafb; margin: 0; padding: 20px; color: #111827; }
        .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 10px; border: 1px solid #e5e7eb; overflow: hidden; }
        .header { background: #1e293b; color: #ffffff; padding: 24px; text-align: left; }
        .header h1 { margin: 0 0 4px 0; font-size: 18px; font-weight: 700; }
        .header p { margin: 0; font-size: 13px; color: #cbd5e1; }
        .badge { display: inline-block; background: #334155; color: #f8fafc; font-size: 10px; font-weight: 600; padding: 3px 8px; border-radius: 4px; margin-bottom: 10px; }
        .content { padding: 24px; }
        .intro { font-size: 13.5px; line-height: 1.6; color: #374151; margin-bottom: 18px; }
        .details-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 13px; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; }
        .details-table td { padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
        .details-table td.label { width: 35%; font-weight: 600; color: #4b5563; background-color: #f9fafb; }
        .details-table td.value { width: 65%; color: #111827; font-weight: 600; }
        .highlight-expiry { color: #b91c1c; font-weight: 700; }
        .footer { background: #f9fafb; padding: 16px 24px; text-align: center; font-size: 11px; color: #9ca3af; border-top: 1px solid #e5e7eb; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <span class="badge">EXPIRATION NOTICE (TEST)</span>
          <h1>Document Approaching End Date</h1>
          <p>Document Compliance System</p>
        </div>
        <div class="content">
          <p class="intro">
            Hello Administrator,<br><br>
            This is a <strong>test verification notification</strong> confirming that your automated document expiration mail alert system is active and sending correctly to <strong>${recipients.join(', ')}</strong>.
          </p>

          <table class="details-table">
            <tr>
              <td class="label">Document Name</td>
              <td class="value">${sampleItem.name}</td>
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
              <td class="value" style="font-weight: 400; color: #374151;">${sampleItem.description}</td>
            </tr>
            <tr>
              <td class="label">Attached Files</td>
              <td class="value" style="font-weight: 400; color: #374151;">${sampleItem.documentNames.join(', ')}</td>
            </tr>
          </table>

          <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; padding: 12px 14px; border-radius: 6px; font-size: 12px; color: #6b7280; line-height: 1.5;">
            <strong>Status:</strong> Mail delivery configuration is working correctly.
          </div>
        </div>
        <div class="footer">
          Recruitment &amp; Hiring Portal • Document Compliance Notification<br>
          &copy; ${new Date().getFullYear()} All rights reserved.
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
