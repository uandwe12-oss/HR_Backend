const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");
const { sendEmail } = require("../services/emailService");

// ─── Birthday Email Templates ───────────────────────────────────────────────
const TEMPLATES = {
  professional: {
    subject: "🎂 Happy Birthday!",
    message:
      "Dear {name},\n\nWishing you a wonderful birthday and continued success in the year ahead. Your dedication and contributions are truly valued.\n\nWarm regards,\nHR Team",
  },
  friendly: {
    subject: "🎉 Happy Birthday!",
    message:
      "Hey {name}! 🎉\n\nMay your special day be filled with happiness, laughter, and memorable moments. Enjoy your day to the fullest!\n\nCheers,\nHR Team",
  },
  team: {
    subject: "🎁 Happy Birthday from the Team!",
    message:
      "Dear {name},\n\nThe entire team wishes you a fantastic birthday and an amazing year ahead! We're grateful to have you as part of our team.\n\nBest wishes,\nThe Team",
  },
  custom: {
    subject: "",
    message: "",
  },
};

// ─── Build professional HTML email ──────────────────────────────────────────
function buildHtmlEmail(employeeName, messageText) {
  // Convert newlines to <br> for HTML rendering
  const htmlMessage = messageText.replace(/\n/g, "<br>");

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="margin:0; padding:0; background-color:#f4f6f9; font-family: 'Segoe UI', Arial, sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f9; padding:40px 20px;">
      <tr>
        <td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,0.08);">
            <!-- Header -->
            <tr>
              <td style="background: linear-gradient(135deg, #3b82f6, #6366f1); padding:32px 40px; text-align:center;">
                <div style="font-size:48px; margin-bottom:12px;">🎂</div>
                <h1 style="color:#ffffff; font-size:28px; margin:0; font-weight:700;">Happy Birthday!</h1>
                <p style="color:rgba(255,255,255,0.85); font-size:16px; margin:8px 0 0;">${employeeName}</p>
              </td>
            </tr>
            <!-- Body -->
            <tr>
              <td style="padding:32px 40px;">
                <p style="color:#334155; font-size:15px; line-height:1.7; margin:0;">
                  ${htmlMessage}
                </p>
              </td>
            </tr>
            <!-- Footer -->
            <tr>
              <td style="padding:20px 40px 28px; border-top:1px solid #e2e8f0;">
                <p style="color:#94a3b8; font-size:12px; margin:0; text-align:center;">
                  Sent via HR Portal &bull; Birthday Wishes System
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/birthday/send-wishes
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/send-wishes", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const {
      birthdayEmployeeId,
      template,
      subject,
      message,
      sendToEmployee = true,
      sendToAllEmployees = false,
      sendToManager = false,
      sendToHRTeam = false,
      cc = [],
      bcc = [],
      sentBy = "Admin",
    } = req.body;

    console.log(`\n📡 POST /api/birthday/send-wishes for employee: ${birthdayEmployeeId}`);

    // ── Validate required fields ──
    if (!birthdayEmployeeId || !subject || !message) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: birthdayEmployeeId, subject, message",
      });
    }

    // ── Fetch birthday employee details ──
    const empResult = await session.run(
      `MATCH (p:PersonalDetails {employeeNumber: $empId})
       RETURN p.fullName AS fullName, p.emailId AS emailId, p.supervisor AS supervisor, p.employeeNumber AS employeeNumber`,
      { empId: birthdayEmployeeId }
    );

    if (empResult.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Birthday employee not found",
      });
    }

    const empRecord = empResult.records[0];
    const employeeName = empRecord.get("fullName");
    const employeeEmail = empRecord.get("emailId");
    const supervisorName = empRecord.get("supervisor");

    // ── Build recipient lists ──
    const toList = [];
    const ccList = [...cc];
    const bccList = [...bcc];

    // 1. Send to birthday employee
    if (sendToEmployee && employeeEmail) {
      toList.push(employeeEmail);
    }

    // 2. Send to all employees via BCC
    if (sendToAllEmployees) {
      const allResult = await session.run(
        `MATCH (p:PersonalDetails)
         WHERE p.emailId IS NOT NULL AND p.emailId <> ''
         RETURN p.emailId AS emailId`
      );
      allResult.records.forEach((r) => {
        const email = r.get("emailId");
        if (email && email !== employeeEmail && !bccList.includes(email)) {
          bccList.push(email);
        }
      });
    }

    // 3. Send to reporting manager
    if (sendToManager && supervisorName) {
      // Look up supervisor's email by matching fullName or userId
      const mgrResult = await session.run(
        `MATCH (p:PersonalDetails)
         WHERE p.fullName = $supervisor OR p.userId = $supervisor
         RETURN p.emailId AS emailId
         LIMIT 1`,
        { supervisor: supervisorName }
      );
      if (mgrResult.records.length > 0) {
        const mgrEmail = mgrResult.records[0].get("emailId");
        if (mgrEmail && !ccList.includes(mgrEmail)) {
          ccList.push(mgrEmail);
        }
      }
    }

    // 4. Send to HR team
    if (sendToHRTeam) {
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail && !ccList.includes(adminEmail)) {
        ccList.push(adminEmail);
      }
    }

    // ── Validate we have at least one recipient ──
    if (toList.length === 0 && ccList.length === 0 && bccList.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid recipients found. Ensure the employee has an email address.",
      });
    }

    // If no To, use admin email as fallback To
    if (toList.length === 0) {
      const fallback = process.env.ADMIN_EMAIL || process.env.SMTP_EMAIL;
      if (fallback) toList.push(fallback);
    }

    // ── Build HTML email ──
    const htmlContent = buildHtmlEmail(employeeName, message);

    // ── Send email ──
    const emailResult = await sendEmail({
      to: toList.join(", "),
      cc: ccList.length > 0 ? ccList.join(", ") : undefined,
      bcc: bccList.length > 0 ? bccList.join(", ") : undefined,
      subject,
      text: message,
      html: htmlContent,
    });

    // ── Log the wish ──
    const status = emailResult.success ? "Sent" : "Failed";
    const now = new Date().toISOString();

    await session.run(
      `CREATE (log:BirthdayWishLog {
        sentBy: $sentBy,
        sentDate: $sentDate,
        birthdayEmployee: $birthdayEmployee,
        birthdayEmployeeId: $birthdayEmployeeId,
        subject: $subject,
        template: $template,
        recipientCount: $recipientCount,
        status: $status
      })`,
      {
        sentBy,
        sentDate: now,
        birthdayEmployee: employeeName,
        birthdayEmployeeId,
        subject,
        template: template || "custom",
        recipientCount: toList.length + ccList.length + bccList.length,
        status,
      }
    );

    if (emailResult.success) {
      console.log(`✅ Birthday wish sent for ${employeeName}`);
      return res.json({
        success: true,
        message: `Birthday wishes sent successfully to ${employeeName}`,
        recipientCount: toList.length + ccList.length + bccList.length,
      });
    } else {
      console.error(`❌ Failed to send birthday wish for ${employeeName}:`, emailResult.error);
      return res.status(500).json({
        success: false,
        message: "Failed to send email: " + emailResult.error,
      });
    }
  } catch (error) {
    console.error("❌ Error sending birthday wishes:", error.message);
    res.status(500).json({
      success: false,
      message: "Server error: " + error.message,
    });
  } finally {
    await session.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/birthday/wish-logs
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/wish-logs", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(
      `MATCH (log:BirthdayWishLog)
       RETURN log {
         .sentBy, .sentDate, .birthdayEmployee, .birthdayEmployeeId,
         .subject, .template, .recipientCount, .status
       } AS log
       ORDER BY log.sentDate DESC
       LIMIT 100`
    );

    const logs = result.records.map((r) => r.get("log"));

    res.json({ success: true, count: logs.length, data: logs });
  } catch (error) {
    console.error("❌ Error fetching wish logs:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch wish logs",
    });
  } finally {
    await session.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/birthday/templates
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/templates", (req, res) => {
  res.json({ success: true, data: TEMPLATES });
});

module.exports = router;
