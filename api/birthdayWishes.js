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

function formatName(name) {
  if (!name) return "";
  return name
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ─── Build professional HTML email with uandwe Logo directly in HTML ─────────
function buildHtmlEmail(employeeName, messageText, logoBase64 = "") {
  // Format employee name with Proper Capitalization (e.g. "illaya bharathi" -> "Illaya Bharathi")
  const formattedEmployeeName = formatName(employeeName);

  // Convert newlines to <br> for HTML rendering, ensuring name in message is also properly capitalized
  let formattedMessage = messageText;
  if (employeeName && formattedEmployeeName && employeeName !== formattedEmployeeName) {
    formattedMessage = formattedMessage.replace(new RegExp(employeeName, 'g'), formattedEmployeeName);
  }
  const htmlMessage = formattedMessage.replace(/\n/g, "<br>");

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
                        <img src="${logoBase64}" alt="UANDWE" width="68" height="68" style="display:block; width:68px; height:68px; border-radius:16px; border:0; outline:none; text-decoration:none;" />
                      ` : `
                        <span style="color:#ffffff; font-size:16px; font-weight:800; font-family:'Segoe UI', Arial, sans-serif; letter-spacing:0.5px;">UANDWE</span>
                      `}
                    </td>
                  </tr>
                </table>
                <!-- Cake Emoji -->
                <div style="font-size:46px; line-height:1; margin-bottom:12px;">🎂</div>
                <!-- Happy Birthday Title (Natural title case, not all-caps) -->
                <h1 style="color:#1e3a8a; font-size:28px; font-weight:800; margin:0 0 6px; letter-spacing:-0.5px; font-family:'Segoe UI', Arial, sans-serif;">
                  Happy Birthday
                </h1>
                ${formattedEmployeeName ? `
                <p style="color:#334155; font-size:17px; font-weight:600; margin:0 0 16px; font-family:'Segoe UI', Arial, sans-serif;">
                  ${formattedEmployeeName}
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
                <p style="color:#64748b; font-size:12px; margin:0 0 4px; font-weight:700; font-family:'Segoe UI', Arial, sans-serif; letter-spacing:0.3px;">
                  UANDWE &bull; HUMAN RESOURCES
                </p>
                <p style="color:#94a3b8; font-size:10.5px; margin:0; font-family:'Segoe UI', Arial, sans-serif;">
                  This is a system generated mail.
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

    // ── Fetch birthday employee details & supervisor (prioritize unique email, then employeeNumber, then fullName) ──
    let empRecord = null;
    let employeeName = (birthdayEmployeeName || "").trim();
    let employeeEmail = (birthdayEmployeeEmail || "").trim();
    let empUserId = null;
    let supervisorName = (req.body.supervisor || "").trim() || null;
    let supervisorEmail = (req.body.supervisorEmail || "").trim() || null;
    let teamSupervisorEmail = null;
    let teamSupervisorName = null;

    const findQuery = `
      MATCH (p:PersonalDetails)
      WHERE (
        ($email <> '' AND (
          toLower(trim(p.emailId)) = toLower(trim($email)) OR
          toLower(trim(p.workEmail)) = toLower(trim($email)) OR
          toLower(trim(p.professionalEmail)) = toLower(trim($email))
        )) OR
        ($empId <> '' AND (
          p.employeeNumber = $empId OR
          toLower(trim(p.userId)) = toLower(trim($empId))
        )) OR
        ($name <> '' AND toLower(trim(p.fullName)) = toLower(trim($name)))
      )
      OPTIONAL MATCH (u:User) WHERE (u.username = p.userId OR toLower(u.username) = toLower(p.userId) OR u.username = p.employeeNumber)
      OPTIONAL MATCH (u)-[:MEMBER_OF]->(t:Team)
      OPTIONAL MATCH (s:User)-[:SUPERVISES]->(t)
      OPTIONAL MATCH (sp:PersonalDetails) WHERE (sp.userId = s.username OR toLower(sp.userId) = toLower(s.username) OR sp.employeeNumber = s.username)
      RETURN p.fullName AS fullName,
             COALESCE(NULLIF(trim(p.emailId), ''), NULLIF(trim(p.workEmail), ''), NULLIF(trim(p.professionalEmail), '')) AS emailId,
             COALESCE(
               NULLIF(trim(p.supervisor), ''),
               NULLIF(trim(p.manager), ''),
               NULLIF(trim(p.reportingManager), ''),
               NULLIF(trim(sp.fullName), ''),
               NULLIF(trim(s.name), ''),
               NULLIF(trim(s.username), '')
             ) AS supervisor,
             COALESCE(
               NULLIF(trim(sp.emailId), ''),
               NULLIF(trim(sp.workEmail), ''),
               NULLIF(trim(sp.professionalEmail), ''),
               NULLIF(trim(s.email), '')
             ) AS teamSupervisorEmail,
             COALESCE(sp.fullName, s.name, s.username) AS teamSupervisorName,
             p.employeeNumber AS employeeNumber,
             p.userId AS userId
      LIMIT 1
    `;

    const empResult = await session.run(findQuery, {
      email: employeeEmail,
      empId: (birthdayEmployeeId || "").trim(),
      name: employeeName
    });

    if (empResult.records.length > 0) {
      empRecord = empResult.records[0];
      if (!employeeName) employeeName = empRecord.get("fullName") || "";
      if (!employeeEmail) employeeEmail = empRecord.get("emailId") || "";
      empUserId = empRecord.get("userId") || empRecord.get("employeeNumber") || null;
      if (!supervisorName) supervisorName = empRecord.get("supervisor");
      teamSupervisorEmail = empRecord.get("teamSupervisorEmail");
      teamSupervisorName = empRecord.get("teamSupervisorName");
      if (!supervisorEmail && teamSupervisorEmail) {
        supervisorEmail = teamSupervisorEmail;
      }
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

    // 2. Send to all employees via BCC (Only employees with submitted PersonalDetails, using their professional email)
    if (sendToAllEmployees) {
      const allResult = await session.run(
        `MATCH (p:PersonalDetails)
         WHERE (p.profileStatus IS NULL OR toUpper(p.profileStatus) <> 'DEACTIVATED')
           AND (
             (p.emailId IS NOT NULL AND trim(p.emailId) <> '') OR
             (p.workEmail IS NOT NULL AND trim(p.workEmail) <> '') OR
             (p.professionalEmail IS NOT NULL AND trim(p.professionalEmail) <> '')
           )
         RETURN DISTINCT COALESCE(
           NULLIF(trim(p.emailId), ''),
           NULLIF(trim(p.workEmail), ''),
           NULLIF(trim(p.professionalEmail), '')
         ) AS professionalEmail,
         p.fullName AS fullName,
         p.employeeNumber AS employeeNumber`
      );

      const existingEmails = new Set(
        [...toList, ...ccList, ...bccList].map((e) => e.trim().toLowerCase())
      );

      allResult.records.forEach((r) => {
        const rawEmail = r.get("professionalEmail");
        if (rawEmail && typeof rawEmail === "string") {
          const cleanEmail = rawEmail.trim();
          const lowerEmail = cleanEmail.toLowerCase();
          if (cleanEmail.includes("@") && !existingEmails.has(lowerEmail)) {
            bccList.push(cleanEmail);
            existingEmails.add(lowerEmail);
          }
        }
      });

      console.log(`📋 [Send to All Employees] Added ${bccList.length} professional employee email(s) from submitted PersonalDetails to BCC:`, bccList);
    }

    // 3. Send to reporting manager (ONLY if user checked sendToManager)
    const shouldSendToManager = sendToManager === true || sendToManager === 'true';
    if (shouldSendToManager) {
      let mgrEmail = (supervisorEmail || teamSupervisorEmail || "").trim();
      let rawSupervisor = (supervisorName || teamSupervisorName || "").trim();

      // If rawSupervisor is already an email address:
      if (!mgrEmail && rawSupervisor && rawSupervisor.includes("@")) {
        mgrEmail = rawSupervisor;
      }

      // If we don't have mgrEmail yet, look up in PersonalDetails / User:
      if (!mgrEmail && rawSupervisor) {
        const mgrResult = await session.run(
          `MATCH (p:PersonalDetails)
           WHERE (
             toLower(trim(p.fullName)) = toLower(trim($supervisor)) OR
             toLower(trim(p.userId)) = toLower(trim($supervisor)) OR
             toLower(trim(p.employeeNumber)) = toLower(trim($supervisor)) OR
             toLower(trim(p.fullName)) CONTAINS toLower(trim($supervisor))
           )
           AND (p.profileStatus IS NULL OR toUpper(p.profileStatus) <> 'DEACTIVATED')
           OPTIONAL MATCH (u:User) WHERE (u.username = p.userId OR toLower(u.username) = toLower(p.userId) OR u.username = p.employeeNumber)
           RETURN COALESCE(
             NULLIF(trim(p.emailId), ''),
             NULLIF(trim(p.workEmail), ''),
             NULLIF(trim(p.professionalEmail), ''),
             NULLIF(trim(u.email), '')
           ) AS professionalEmail,
           p.fullName AS fullName
           LIMIT 1`,
          { supervisor: rawSupervisor }
        );

        if (mgrResult.records.length > 0) {
          mgrEmail = (mgrResult.records[0].get("professionalEmail") || "").trim();
        } else {
          // Fallback to User node
          const userResult = await session.run(
            `MATCH (u:User)
             WHERE toLower(trim(u.username)) = toLower(trim($supervisor))
                OR toLower(trim(u.name)) = toLower(trim($supervisor))
             RETURN u.email AS professionalEmail, u.name AS fullName
             LIMIT 1`,
            { supervisor: rawSupervisor }
          );
          if (userResult.records.length > 0) {
            mgrEmail = (userResult.records[0].get("professionalEmail") || "").trim();
          }
        }
      }

      // If still not found, check team supervisor by employee's userId / employeeNumber
      if (!mgrEmail && (empUserId || birthdayEmployeeId)) {
        const teamMgrResult = await session.run(
          `MATCH (u:User)
           WHERE u.username = $uid OR toLower(u.username) = toLower($uid)
           MATCH (u)-[:MEMBER_OF]->(t:Team)<-[:SUPERVISES]-(s:User)
           OPTIONAL MATCH (sp:PersonalDetails) WHERE sp.userId = s.username OR toLower(sp.userId) = toLower(s.username) OR sp.employeeNumber = s.username
           RETURN COALESCE(
             NULLIF(trim(sp.emailId), ''),
             NULLIF(trim(sp.workEmail), ''),
             NULLIF(trim(sp.professionalEmail), ''),
             NULLIF(trim(s.email), '')
           ) AS professionalEmail,
           COALESCE(sp.fullName, s.name, s.username) AS fullName
           LIMIT 1`,
          { uid: empUserId || birthdayEmployeeId }
        );
        if (teamMgrResult.records.length > 0) {
          mgrEmail = (teamMgrResult.records[0].get("professionalEmail") || "").trim();
        }
      }

      if (mgrEmail && mgrEmail.includes("@")) {
        const cleanMgrEmail = mgrEmail.trim();
        const existingEmails = new Set([...toList, ...ccList].map((e) => e.trim().toLowerCase()));
        if (!existingEmails.has(cleanMgrEmail.toLowerCase())) {
          ccList.push(cleanMgrEmail);
          console.log(`👤 [Send to Manager] Added manager (${cleanMgrEmail}) to CC list.`);
        }
      } else {
        console.warn(`⚠️ [Send to Manager] Could not resolve email address for manager (supervisor: "${rawSupervisor}").`);
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
