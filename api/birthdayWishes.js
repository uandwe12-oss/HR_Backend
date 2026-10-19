const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const getDriver = require("../lib/neo4j");
const { sendEmail } = require("../services/emailService");

// ─── Resolve and Base64-encode uandwe Logo (Pure inline, NO attachments) ─────
let cachedLogoBase64 = null;

async function getLogoBase64() {
  if (cachedLogoBase64) return cachedLogoBase64;

  const candidatePaths = [
    path.resolve(__dirname, "../../HR_Frontend/src/assets/Images/logo.webp"),
    path.resolve(__dirname, "../assets/logo.png"),
    path.resolve(__dirname, "../assets/logo.webp"),
    path.resolve(__dirname, "../../HR_Frontend/public/logo.webp"),
  ];

  let foundPath = null;
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      foundPath = p;
      break;
    }
  }

  if (!foundPath) return "";

  try {
    const sharp = require("sharp");
    const pngBuf = await sharp(foundPath)
      .resize(140, 140)
      .png({ quality: 90 })
      .toBuffer();
    cachedLogoBase64 = `data:image/png;base64,${pngBuf.toString("base64")}`;
    return cachedLogoBase64;
  } catch (err) {
    try {
      const buf = fs.readFileSync(foundPath);
      const mime = foundPath.endsWith(".png") ? "image/png" : "image/webp";
      cachedLogoBase64 = `data:${mime};base64,${buf.toString("base64")}`;
      return cachedLogoBase64;
    } catch (_) {
      return "";
    }
  }
}

// Pre-cache on startup
getLogoBase64().catch(() => {});

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

// ─── Build professional HTML email with uandwe Logo directly in HTML ─────────
function buildHtmlEmail(employeeName, messageText, logoBase64 = "") {
  // Convert newlines to <br> for HTML rendering
  const htmlMessage = messageText.replace(/\n/g, "<br>");

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="margin:0; padding:0; background-color:#f4f6f9; font-family:'Segoe UI', -apple-system, BlinkMacSystemFont, Arial, sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f6f9; padding:40px 20px;">
      <tr>
        <td align="center">
          <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 20px rgba(0,0,0,0.07); border:1px solid #e2e8f0;">
            <!-- Header Section with uandwe Logo, Cake Emoji, and Title -->
            <tr>
              <td align="center" style="background-color:#ffffff; padding:40px 40px 20px; text-align:center;">
                <!-- uandwe Brand Logo directly at the top -->
                <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 16px;">
                  <tr>
                    <td align="center" bgcolor="#f26522" style="background-color:#f26522; width:68px; height:68px; border-radius:16px; text-align:center; vertical-align:middle; padding:0; overflow:hidden;">
                      ${logoBase64 ? `
                        <img src="${logoBase64}" alt="uandwe" width="68" height="68" style="display:block; width:68px; height:68px; border-radius:16px; border:0; outline:none; text-decoration:none;" />
                      ` : `
                        <span style="color:#ffffff; font-size:16px; font-weight:800; font-family:'Segoe UI', Arial, sans-serif; letter-spacing:-0.5px;">uandwe</span>
                      `}
                    </td>
                  </tr>
                </table>
                <!-- Cake Emoji -->
                <div style="font-size:46px; line-height:1; margin-bottom:12px;">🎂</div>
                <!-- Happy Birthday Title (High contrast, Outlook compatible) -->
                <h1 style="color:#1e3a8a; font-size:28px; font-weight:800; margin:0 0 6px; letter-spacing:-0.5px; font-family:'Segoe UI', Arial, sans-serif;">
                  Happy Birthday
                </h1>
                ${employeeName ? `
                <p style="color:#334155; font-size:17px; font-weight:600; margin:0 0 16px; font-family:'Segoe UI', Arial, sans-serif;">
                  ${employeeName}
                </p>
                ` : ''}
                <!-- Accent Line -->
                <div style="width:48px; height:3px; background-color:#f26522; border-radius:2px; margin:8px auto 0;"></div>
              </td>
            </tr>
            <!-- Message Body -->
            <tr>
              <td style="padding:28px 44px 34px;">
                <div style="color:#334155; font-size:15px; line-height:1.75; font-family:'Segoe UI', Arial, sans-serif;">
                  ${htmlMessage}
                </div>
              </td>
            </tr>
            <!-- Footer -->
            <tr>
              <td style="padding:20px 40px 26px; border-top:1px solid #f1f5f9; background-color:#fafafa; text-align:center;">
                <p style="color:#64748b; font-size:12px; margin:0 0 4px; font-weight:600; font-family:'Segoe UI', Arial, sans-serif;">
                  uandwe • Human Resources
                </p>
                <p style="color:#94a3b8; font-size:11px; margin:0; font-family:'Segoe UI', Arial, sans-serif;">
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
      birthdayEmployeeEmail,
      birthdayEmployeeName,
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

    console.log(`\n📡 POST /api/birthday/send-wishes for employee: ${birthdayEmployeeName || birthdayEmployeeEmail || birthdayEmployeeId}`);

    // ── Validate required fields ──
    if ((!birthdayEmployeeId && !birthdayEmployeeEmail && !birthdayEmployeeName) || !subject || !message) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: employee identifier, subject, message",
      });
    }

    // ── Fetch birthday employee details (prioritize unique email, then employeeNumber, then fullName) ──
    let empRecord = null;
    let employeeName = (birthdayEmployeeName || "").trim();
    let employeeEmail = (birthdayEmployeeEmail || "").trim();
    let supervisorName = null;

    if (birthdayEmployeeEmail && String(birthdayEmployeeEmail).trim() !== '') {
      const emailResult = await session.run(
        `MATCH (p:PersonalDetails)
         WHERE toLower(p.emailId) = toLower($email)
         RETURN p.fullName AS fullName, p.emailId AS emailId, p.supervisor AS supervisor, p.employeeNumber AS employeeNumber
         LIMIT 1`,
        { email: String(birthdayEmployeeEmail).trim() }
      );
      if (emailResult.records.length > 0) {
        empRecord = emailResult.records[0];
      }
    }

    if (!empRecord && birthdayEmployeeId && String(birthdayEmployeeId).trim() !== '' && String(birthdayEmployeeId).trim() !== 'null' && String(birthdayEmployeeId).trim() !== 'undefined' && String(birthdayEmployeeId).trim() !== 'N/A') {
      const idResult = await session.run(
        `MATCH (p:PersonalDetails)
         WHERE (p.employeeNumber = $empId OR toLower(p.userId) = toLower($empId))
         RETURN p.fullName AS fullName, p.emailId AS emailId, p.supervisor AS supervisor, p.employeeNumber AS employeeNumber
         LIMIT 1`,
        { empId: String(birthdayEmployeeId).trim() }
      );
      if (idResult.records.length > 0) {
        empRecord = idResult.records[0];
      }
    }

    if (!empRecord && birthdayEmployeeName && String(birthdayEmployeeName).trim() !== '') {
      const nameResult = await session.run(
        `MATCH (p:PersonalDetails)
         WHERE toLower(p.fullName) = toLower($name)
         RETURN p.fullName AS fullName, p.emailId AS emailId, p.supervisor AS supervisor, p.employeeNumber AS employeeNumber
         LIMIT 1`,
        { name: String(birthdayEmployeeName).trim() }
      );
      if (nameResult.records.length > 0) {
        empRecord = nameResult.records[0];
      }
    }

    if (empRecord) {
      if (!employeeName) {
        employeeName = empRecord.get("fullName") || "";
      }
      if (!employeeEmail) {
        employeeEmail = empRecord.get("emailId") || "";
      }
      supervisorName = empRecord.get("supervisor");
    } else if (!employeeEmail && !employeeName) {
      return res.status(404).json({
        success: false,
        message: "Birthday employee not found",
      });
    }

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

    // ── Build HTML email with inline base64 logo (NO attachments array!) ──
    const logoDataUrl = await getLogoBase64();
    const htmlContent = buildHtmlEmail(employeeName, message, logoDataUrl);

    // ── Send email (Pure inline HTML - NO attachments to prevent Outlook download box) ──
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
