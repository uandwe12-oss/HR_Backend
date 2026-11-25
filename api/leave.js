const express = require("express");
const router = express.Router();
const multer = require('multer');
const getDriver = require("../lib/neo4j");
const crypto = require("crypto");
const { sendLeaveApplicationEmail, sendLeaveStatusEmail } = require("../services/emailService");

const isValidEmail = (email) => typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

const getDefaultLeaveNotificationEmails = () => {
  const raw = process.env.ADMIN_EMAIL || 'swathi@uandwe.com';
  const seen = new Set();
  const emails = [];
  raw.split(',').forEach((entry) => {
    const clean = entry.trim().toLowerCase();
    if (isValidEmail(clean) && !seen.has(clean)) {
      seen.add(clean);
      emails.push(clean);
    }
  });
  return emails;
};

const getAdminEmails = async (session) => {
  const seen = new Set();
  const emails = [];

  const addEmail = (raw) => {
    if (!raw || typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!isValidEmail(trimmed)) return;
    const lower = trimmed.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      emails.push(trimmed);
    }
  };

  // Prefer Admin-configured Leave Notification Recipients from Neo4j if set
  try {
    const configResult = await session.run(`
      MATCH (n:NotificationConfig { type: 'leaveRequest' })
      RETURN n.emails AS emails
    `);
    if (configResult.records.length > 0) {
      const dbEmails = configResult.records[0].get('emails') || [];
      dbEmails.forEach(addEmail);
      return emails;
    }
  } catch (cfgErr) {
    console.warn("Warning loading leaveRequest NotificationConfig:", cfgErr.message);
  }

  getDefaultLeaveNotificationEmails().forEach(addEmail);

  try {
    const adminResult = await session.run(`
      MATCH (a:User)
      WHERE a.role = 'Admin' OR 'Admin' IN a.role
      OPTIONAL MATCH (ap:PersonalDetails) WHERE toLower(ap.userId) = toLower(a.username)
      RETURN NULLIF(trim(coalesce(ap.emailId, ap.workEmail, ap.professionalEmail)), '') AS workEmail, a.username AS username
    `);
    for (const record of adminResult.records) {
      const workEmail = record.get("workEmail");
      const username = record.get("username");
      if (workEmail) {
        addEmail(workEmail);
      } else if (username && isValidEmail(username)) {
        addEmail(username);
      }
    }
  } catch (err) {
    console.error("Error fetching admin emails:", err.message);
  }

  return emails;
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// Default Entitlements
const DEFAULT_ANNUAL_LEAVE = 11;

// Helper to calculate leave balance stats
const calculateBalances = (leaves, nationality, priorLeaves = {}, targetYear = new Date().getFullYear(), targetMonth = new Date().getMonth()) => {
  let wfhUsed = priorLeaves.priorWfhUsed || 0;
  let rawAnnualUsed = priorLeaves.priorAnnualUsed || 0;
  let pendingAnnual = 0;
  let rawSickUsed = priorLeaves.priorSickUsed || 0;
  let pendingSick = 0;

  const currentMonth = targetMonth;
  const currentYear = targetYear;

  let monthlyRawAL = 0;
  let monthlyWFH = 0;

  leaves.forEach(leave => {
    const days = leave.actualUsedDays !== undefined && leave.actualUsedDays !== null 
      ? parseFloat(leave.actualUsedDays) 
      : (parseFloat(leave.totalDays) || 0);
      
    let isThisYear = false;
    let isThisMonth = false;
    if (leave.startDate) {
      const ld = new Date(leave.startDate);
      isThisYear = ld.getFullYear() === currentYear;
      isThisMonth = ld.getMonth() === currentMonth && isThisYear;
    }
      
    if (leave.status === 'Approved') {
      if (leave.leaveType === 'Work From Home' || leave.leaveType === 'WFH') {
        wfhUsed += days;
        if (isThisMonth) monthlyWFH += days;
      } else if (isThisYear) {
        if (leave.leaveType === 'Annual Leave' || leave.leaveType === 'Leave' || leave.leaveType === 'Half Day Leave') {
          rawAnnualUsed += days;
          if (isThisMonth) monthlyRawAL += days;
        } else if (leave.leaveType === 'Sick Leave') {
          rawSickUsed += days;
        }
      }
    } else if (leave.status === 'Pending' && isThisYear) {
      if (leave.leaveType === 'Annual Leave' || leave.leaveType === 'Leave' || leave.leaveType === 'Half Day Leave') {
        pendingAnnual += days;
      } else if (leave.leaveType === 'Sick Leave') {
        pendingSick += days;
      }
    }
  });

  let annualEntitlement = priorLeaves.allocatedAnnual !== undefined && priorLeaves.allocatedAnnual !== null && priorLeaves.allocatedAnnual !== '' ? parseFloat(priorLeaves.allocatedAnnual) : (nationality === 'INDIA' ? 8 : 11);
  let sickEntitlement = priorLeaves.allocatedSick !== undefined && priorLeaves.allocatedSick !== null && priorLeaves.allocatedSick !== '' ? parseFloat(priorLeaves.allocatedSick) : (nationality === 'INDIA' ? 3 : 0);
  let wfhMonthlyCap = priorLeaves.allocatedWfhMonthly !== undefined && priorLeaves.allocatedWfhMonthly !== null && priorLeaves.allocatedWfhMonthly !== '' ? parseFloat(priorLeaves.allocatedWfhMonthly) : Infinity;

  let totalSickUsed = rawSickUsed + pendingSick;
  let totalAnnualUsed = rawAnnualUsed + pendingAnnual;

  // Reciprocal Overflow Logic (Applies to all)
  
  // 1. Annual overflows into Sick
  if (totalAnnualUsed > annualEntitlement) {
    const annualOverflow = totalAnnualUsed - annualEntitlement;
    const sickAvailable = Math.max(0, sickEntitlement - totalSickUsed);
    if (sickAvailable > 0) {
      const absorbed = Math.min(annualOverflow, sickAvailable);
      totalSickUsed += absorbed;
      totalAnnualUsed -= absorbed;
      
      const rawAbsorbed = Math.min(Math.max(0, rawAnnualUsed - annualEntitlement), Math.max(0, sickEntitlement - rawSickUsed));
      if (rawAbsorbed > 0) {
        rawSickUsed += rawAbsorbed;
        rawAnnualUsed -= rawAbsorbed;
      }
    }
  }
  
  // 2. Sick overflows into Annual
  if (totalSickUsed > sickEntitlement) {
    const sickOverflow = totalSickUsed - sickEntitlement;
    const annualAvailable = Math.max(0, annualEntitlement - totalAnnualUsed);
    if (annualAvailable > 0) {
      const absorbed = Math.min(sickOverflow, annualAvailable);
      totalAnnualUsed += absorbed;
      totalSickUsed -= absorbed;

      const rawAbsorbed = Math.min(Math.max(0, rawSickUsed - sickEntitlement), Math.max(0, annualEntitlement - rawAnnualUsed));
      if (rawAbsorbed > 0) {
        rawAnnualUsed += rawAbsorbed;
        rawSickUsed -= rawAbsorbed;
      }
    }
  }

  const annualUsed = rawAnnualUsed;
  const lopUsed = Math.max(0, rawAnnualUsed - annualEntitlement) + Math.max(0, rawSickUsed - sickEntitlement);
  
  // WFH Monthly LOP
  let wfhLop = 0;
  if (wfhMonthlyCap !== Infinity && monthlyWFH > wfhMonthlyCap) {
    wfhLop = monthlyWFH - wfhMonthlyCap;
  }
  const totalLopUsed = lopUsed + wfhLop;
  
  const rawAnnualBeforeThisMonth = rawAnnualUsed - monthlyRawAL;
  const lopBeforeThisMonth = Math.max(0, rawAnnualBeforeThisMonth - annualEntitlement);
  const monthlyLOP = Math.max(0, lopUsed - lopBeforeThisMonth) + wfhLop;
  const monthlyAL = monthlyRawAL - Math.max(0, lopUsed - lopBeforeThisMonth);
  
  const annualBalance = annualEntitlement - totalAnnualUsed;
  const sickBalance = sickEntitlement - totalSickUsed;

  return {
    annualEntitlement,
    annualUsed,
    annualPending: pendingAnnual,
    annualBalance,
    sickEntitlement,
    sickUsed: rawSickUsed,
    sickBalance,
    
    wfhUsed,
    lopUsed: totalLopUsed,
    wfhMonthlyCap,
    monthlyAL,
    monthlyWFH,
    monthlyLOP,
    totalSubmitted: leaves.length,
    pendingRequests: leaves.filter(l => l.status === 'Pending').length,
    approvedRequests: leaves.filter(l => l.status === 'Approved').length,
    rejectedRequests: leaves.filter(l => l.status === 'Rejected').length
  };
};

// 1. Get user leave details and balances
router.get("/user/:userId", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { userId } = req.params;

  try {
    const result = await session.run(`
      MATCH (l:LeaveRequest {userId: $userId})
      OPTIONAL MATCH (u:User {username: $userId})-[:SUPERVISES]->(anyTeam:Team)
      RETURN l, COUNT(anyTeam) > 0 AS isRequesterSupervisor
      ORDER BY l.createdAt DESC
    `, { userId });

    const leaves = result.records.map(record => {
      const l = record.get('l').properties;
      const isRequesterSupervisor = record.get('isRequesterSupervisor');
      
      if (isRequesterSupervisor && l.supervisorStatus !== 'N/A') {
        l.supervisorStatus = 'N/A';
        if (l.hrStatus === 'Approved') l.status = 'Approved';
        if (l.hrStatus === 'Rejected') l.status = 'Rejected';
      }
      return l;
    });

    const targetYear = parseInt(req.query.year) || new Date().getFullYear();
    const targetMonth = parseInt(req.query.month) >= 0 && parseInt(req.query.month) <= 11 ? parseInt(req.query.month) : new Date().getMonth();
    const pdResult = await session.run(`
      MATCH (u:User {username: $userId})
      OPTIONAL MATCH (p:PersonalDetails {userId: $userId})
      OPTIONAL MATCH (u)-[:HAS_LEAVE_BALANCE]->(lb:LeaveBalance)
      RETURN p.nationality as nationality, 
             lb.priorAnnualUsed as priorAnnualUsed, 
             lb.priorSickUsed as priorSickUsed, 
             lb.priorWfhUsed as priorWfhUsed,
             lb[$allocatedAnnualKey] as allocatedAnnual,
             lb[$allocatedSickKey] as allocatedSick,
             lb.allocatedWfhMonthly as allocatedWfhMonthly
    `, { userId, allocatedAnnualKey: `allocatedAnnual_${targetYear}`, allocatedSickKey: `allocatedSick_${targetYear}` });
    
    let nationality = 'INDIA';
    let priorLeaves = { priorAnnualUsed: 0, priorSickUsed: 0, priorWfhUsed: 0 };
    if (pdResult.records.length > 0) {
      const record = pdResult.records[0];
      nationality = record.get('nationality') || 'INDIA';
      priorLeaves = {
        priorAnnualUsed: parseFloat(record.get('priorAnnualUsed')) || 0,
        priorSickUsed: parseFloat(record.get('priorSickUsed')) || 0,
        priorWfhUsed: parseFloat(record.get('priorWfhUsed')) || 0,
        allocatedAnnual: record.get('allocatedAnnual') !== null ? record.get('allocatedAnnual') : undefined,
        allocatedSick: record.get('allocatedSick') !== null ? record.get('allocatedSick') : undefined,
        allocatedWfhMonthly: record.get('allocatedWfhMonthly') !== null ? record.get('allocatedWfhMonthly') : undefined
      };
    }

    const balances = calculateBalances(leaves, nationality, priorLeaves, targetYear, targetMonth);

    res.json({
      success: true,
      balances,
      history: leaves
    });
  } catch (error) {
    console.error("Error fetching leave details:", error);
    res.status(500).json({ success: false, message: "Failed to fetch leave details" });
  } finally {
    await session.close();
  }
});

// 2. Apply for Leave
router.post("/apply", upload.single('attachment'), async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const { 
      userId, employeeName, employeeNumber, company, 
      leaveType, startDate, startTime, endDate, endTime, 
      totalDays, reason, customReason, role
    } = req.body;

    if (!userId || !startDate || !endDate || !reason || !leaveType) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    if (leaveType === 'Work From Home' || leaveType === 'WFH') {
      return res.status(400).json({ success: false, message: "Work From Home option is not available." });
    }

    if (!customReason || customReason.trim() === '') {
      return res.status(400).json({ success: false, message: "Additional Reason is mandatory." });
    }
    const wordCount = customReason.trim().split(/\\s+/).filter(Boolean).length;
    if (wordCount > 50) {
      return res.status(400).json({ success: false, message: "Additional Reason cannot exceed 50 words." });
    }

    // Holiday Check - Matches target company and linked holiday calendars
    const cleanCompany = (company || "").trim();
    const holidayResult = await session.run(`
      MATCH (target:Group)
      WHERE toLower(target.name) = toLower($company)
         OR replace(toLower(target.name), ' ', '') = replace(toLower($company), ' ', '')
         OR (target.client IS NOT NULL AND (toLower(target.client) = toLower($company) OR replace(toLower(target.client), ' ', '') = replace(toLower($company), ' ', '')))
      OPTIONAL MATCH (target)-[:SHARES_HOLIDAY_CALENDAR*1..5]-(linked:Group)
      WITH collect(DISTINCT target) + collect(DISTINCT linked) AS allMatched
      UNWIND allMatched AS item
      WITH DISTINCT item WHERE item IS NOT NULL
      OPTIONAL MATCH (variant:Group)
      WHERE toLower(variant.name) = toLower(item.name)
         OR replace(toLower(variant.name), ' ', '') = replace(toLower(item.name), ' ', '')
      WITH collect(DISTINCT item) + collect(DISTINCT variant) AS allGroups
      UNWIND allGroups AS finalGroup
      WITH DISTINCT finalGroup WHERE finalGroup IS NOT NULL
      MATCH (finalGroup)-[:HAS_HOLIDAY]->(h:Holiday)
      RETURN DISTINCT h.date as date
    `, { company: cleanCompany });
    
    const companyHolidays = holidayResult.records.map(r => r.get('date')).filter(Boolean);
    if (companyHolidays.includes(startDate) || companyHolidays.includes(endDate)) {
      return res.status(400).json({ success: false, message: "It is a holiday. Leave cannot start or end on a holiday." });
    }

    // Check existing leaves to ensure enough balance
    const existingResult = await session.run(`
      MATCH (l:LeaveRequest {userId: $userId})
      RETURN l
    `, { userId });
    
    const targetYear = new Date(startDate).getFullYear();
    const targetMonth = new Date(startDate).getMonth();

    const pdResult = await session.run(`
      MATCH (u:User {username: $userId})
      OPTIONAL MATCH (p:PersonalDetails {userId: $userId})
      OPTIONAL MATCH (u)-[:HAS_LEAVE_BALANCE]->(lb:LeaveBalance)
      RETURN p.nationality as nationality, lb.priorAnnualUsed as priorAnnualUsed, lb.priorSickUsed as priorSickUsed, lb.priorWfhUsed as priorWfhUsed, lb[$allocatedAnnualKey] as allocatedAnnual, lb[$allocatedSickKey] as allocatedSick, lb.allocatedWfhMonthly as allocatedWfhMonthly
    `, { userId, allocatedAnnualKey: `allocatedAnnual_${targetYear}`, allocatedSickKey: `allocatedSick_${targetYear}` });
    
    let nationality = '';
    let priorLeaves = { priorAnnualUsed: 0, priorSickUsed: 0, priorWfhUsed: 0 };
    if (pdResult.records.length > 0) {
      nationality = pdResult.records[0].get('nationality') || '';
      priorLeaves = {
        priorAnnualUsed: parseFloat(pdResult.records[0].get('priorAnnualUsed')) || 0,
        priorSickUsed: parseFloat(pdResult.records[0].get('priorSickUsed')) || 0,
        priorWfhUsed: parseFloat(pdResult.records[0].get('priorWfhUsed')) || 0,
        allocatedAnnual: pdResult.records[0].get('allocatedAnnual') !== null ? pdResult.records[0].get('allocatedAnnual') : undefined,
        allocatedSick: pdResult.records[0].get('allocatedSick') !== null ? pdResult.records[0].get('allocatedSick') : undefined,
        allocatedWfhMonthly: pdResult.records[0].get('allocatedWfhMonthly') !== null ? pdResult.records[0].get('allocatedWfhMonthly') : undefined
      };
    }

    const existingLeaves = existingResult.records.map(record => record.get('l').properties);
    const balances = calculateBalances(existingLeaves, nationality, priorLeaves, targetYear, targetMonth);

    const normalizedCompany = (company || '').toLowerCase().replace(/\s+/g, '');
    const wfhEligibleCompanies = ['bangaloreuandwe', 'bangaloreuandwelabs', 'gurugramuandwe'];
    const isWfhCompany = wfhEligibleCompanies.includes(normalizedCompany) || normalizedCompany.includes('uandwe');
    
    // WFH 1-per-week validation
    if ((leaveType === 'Work From Home' || leaveType === 'WFH') && isWfhCompany) {
      const isSameWeek = (d1, d2) => {
        const date1 = new Date(d1); const date2 = new Date(d2);
        const day1 = date1.getDay() === 0 ? 7 : date1.getDay();
        date1.setDate(date1.getDate() - day1 + 1); date1.setHours(0,0,0,0);
        const day2 = date2.getDay() === 0 ? 7 : date2.getDay();
        date2.setDate(date2.getDate() - day2 + 1); date2.setHours(0,0,0,0);
        return date1.getTime() === date2.getTime();
      };
      const wfhThisWeek = existingLeaves.find(l => 
        (l.leaveType === 'Work From Home' || l.leaveType === 'WFH') && 
        l.status !== 'Rejected' && 
        isSameWeek(startDate, l.startDate)
      );
      if (wfhThisWeek) {
        return res.status(400).json({ success: false, message: "You have already used your Work From Home request for this week." });
      }
    }

    // Calculate actual working days excluding weekends and company holidays
    let calculatedWorkingDays = 0;
    try {
      const [sY, sM, sD] = startDate.slice(0, 10).split('-').map(Number);
      const [eY, eM, eD] = endDate.slice(0, 10).split('-').map(Number);
      const d1 = new Date(sY, sM - 1, sD);
      const d2 = new Date(eY, eM - 1, eD);
      let cur = new Date(d1);
      while (cur <= d2) {
        const d = cur.getDay();
        if (d !== 0 && d !== 6) {
          const y = cur.getFullYear();
          const m = String(cur.getMonth() + 1).padStart(2, '0');
          const day = String(cur.getDate()).padStart(2, '0');
          const dateStr = `${y}-${m}-${day}`;
          if (!companyHolidays.includes(dateStr)) {
            calculatedWorkingDays++;
          }
        }
        cur.setDate(cur.getDate() + 1);
      }
    } catch (e) {
      console.error("Error calculating working days:", e);
      calculatedWorkingDays = parseFloat(totalDays) || 0;
    }

    const requestedTotal = parseFloat(totalDays);
    const isHalfDay = leaveType === 'Half Day Leave' || (startDate === endDate && requestedTotal === 0.5);
    const daysRequested = isHalfDay ? 0.5 : (calculatedWorkingDays > 0 ? calculatedWorkingDays : (requestedTotal || 0));
    
    let annualLeaveDays = daysRequested;
    let lopDays = 0;
    
    if (leaveType === 'Annual Leave' || leaveType === 'Leave' || leaveType === 'Half Day Leave') {
      const currentAnnualBalance = Math.max(0, balances.annualBalance);
      const currentSickBalance = Math.max(0, balances.sickBalance);
      
      if (daysRequested > currentAnnualBalance) {
        annualLeaveDays = currentAnnualBalance;
        const excessAnnual = daysRequested - currentAnnualBalance;
        if (excessAnnual > currentSickBalance) {
          lopDays = excessAnnual - currentSickBalance;
        } else {
          lopDays = 0;
        }
      } else {
        annualLeaveDays = daysRequested;
        lopDays = 0;
      }
    } else if (leaveType === 'Sick Leave') {
      const currentSickBalance = Math.max(0, balances.sickBalance);
      const currentAnnualBalance = Math.max(0, balances.annualBalance);
      
      if (daysRequested > currentSickBalance) {
        const excessSick = daysRequested - currentSickBalance;
        if (excessSick > currentAnnualBalance) {
          lopDays = excessSick - currentAnnualBalance;
          annualLeaveDays = currentAnnualBalance;
        } else {
          annualLeaveDays = excessSick;
          lopDays = 0;
        }
      } else {
        annualLeaveDays = 0;
        lopDays = 0;
      }
    }
    
    const isLOP = lopDays > 0;
    const salaryDeductionPercentage = lopDays * 2;

    const countResult = await session.run('MATCH (l:LeaveRequest) RETURN count(l) as c');
    const cVal = countResult.records[0].get('c');
    const currentCount = typeof cVal.toNumber === 'function' ? cVal.toNumber() : Number(cVal);
    const leaveId = `leave_${currentCount + 1}_${employeeNumber}`;
    const createdAt = new Date().toISOString();
    
    // Fetch user's team, supervisor, and HR
    const teamInfoResult = await session.run(`
      MATCH (u:User) WHERE toLower(u.username) = toLower($userId)
      OPTIONAL MATCH (u)-[:MEMBER_OF]->(t:Team)
      OPTIONAL MATCH (s:User)-[:SUPERVISES]->(t)
      OPTIONAL MATCH (sp:PersonalDetails)
      WHERE toLower(sp.userId) = toLower(s.username) OR toLower(sp.emailId) = toLower(s.username)
      OPTIONAL MATCH (hr:User)-[:HR_FOR]->(t)
      OPTIONAL MATCH (u)-[:SUPERVISES]->(anyTeam:Team)
      RETURN s.username AS supervisorId,
             COALESCE(
               NULLIF(trim(sp.emailId), ''),
               NULLIF(trim(sp.workEmail), ''),
               NULLIF(trim(sp.professionalEmail), '')
             ) AS supervisorEmail,
             t.name AS teamName,
             hr.username AS hrId,
             COUNT(anyTeam) > 0 AS supervisesAnyTeam
    `, { userId });
    
    let assignedSupervisorId = null;
    let supervisorEmail = null;
    let teamName = null;
    let assignedHrId = null;
    let supervisesAnyTeam = false;
    
    if (teamInfoResult.records.length > 0) {
      assignedSupervisorId = teamInfoResult.records[0].get('supervisorId');
      supervisorEmail = teamInfoResult.records[0].get('supervisorEmail');
      teamName = teamInfoResult.records[0].get('teamName');
      assignedHrId = teamInfoResult.records[0].get('hrId');
      supervisesAnyTeam = Boolean(teamInfoResult.records[0].get('supervisesAnyTeam'));
    }

    const isRequesterSupervisor = (assignedSupervisorId && userId && assignedSupervisorId.toLowerCase() === userId.toLowerCase()) || supervisesAnyTeam;

    let initialSupervisorStatus = 'N/A';
    if (assignedSupervisorId && !isRequesterSupervisor) {
      initialSupervisorStatus = 'Pending';
    }
    
    let initialHrStatus = 'N/A';
    if (assignedHrId) {
      initialHrStatus = 'Pending';
    }

    // Create Leave Request
    const result = await session.run(`
      CREATE (l:LeaveRequest {
        id: $id,
        userId: $userId,
        employeeName: $employeeName,
        employeeNumber: $employeeNumber,
        company: $company,
        leaveType: $leaveType,
        startDate: $startDate,
        startTime: $startTime,
        endDate: $endDate,
        endTime: $endTime,
        totalDays: $totalDays,
        annualLeaveDays: $annualLeaveDays,
        lopDays: $lopDays,
        isLOP: $isLOP,
        salaryImpact: $isLOP,
        salaryDeductionPercentage: $salaryDeductionPercentage,
        salaryDeductionAmount: 0,
        reason: $reason,
        customReason: $customReason,
        status: 'Pending',
        supervisorStatus: $initialSupervisorStatus,
        hrStatus: $initialHrStatus,
        createdAt: $createdAt
      })
      RETURN l
    `, {
      id: leaveId, userId, employeeName: employeeName || '', employeeNumber: employeeNumber || '',
      company: company || '', leaveType, startDate, startTime: startTime || '',
      endDate, endTime: endTime || '', totalDays: daysRequested, 
      annualLeaveDays, lopDays, isLOP, salaryDeductionPercentage, reason,
      customReason: customReason || '', createdAt,
      initialSupervisorStatus,
      initialHrStatus
    });

    // Target Notifications based on Team Allocation
    const notificationMsg = isLOP 
      ? `Loss Of Pay Leave Request - Employee Name: ${employeeName || userId}, Requested Days: ${daysRequested}, LOP Days: ${lopDays}`
      : `${employeeName || userId} submitted a ${leaveType} request.`;
      
    let notifiedSomeone = false;
    
    // Notify Supervisor
    if (assignedSupervisorId && !isRequesterSupervisor) {
      await session.run(`
        CREATE (n:Notification {
          id: randomUUID(),
          userId: $assignedSupervisorId,
          message: $message,
          type: 'LEAVE_REQUEST',
          relatedId: $leaveId,
          isRead: false,
          createdAt: $createdAt
        })
      `, { assignedSupervisorId, message: notificationMsg, leaveId, createdAt });
      notifiedSomeone = true;
    }
    
    // Notify HR (only if different from Supervisor to avoid duplicates)
    if (assignedHrId && assignedHrId !== assignedSupervisorId) {
      await session.run(`
        CREATE (n:Notification {
          id: randomUUID(),
          userId: $assignedHrId,
          message: $message,
          type: 'LEAVE_REQUEST',
          relatedId: $leaveId,
          isRead: false,
          createdAt: $createdAt
        })
      `, { assignedHrId, message: notificationMsg, leaveId, createdAt });
      notifiedSomeone = true;
    }
    
    // Admin Fallback (if no team/supervisor/hr)
    if (!notifiedSomeone) {
      await session.run(`
        MATCH (admin:User)
        WHERE admin.role = 'Admin'
        CREATE (n:Notification {
          id: randomUUID(),
          userId: admin.username,
          message: $message,
          type: 'LEAVE_REQUEST',
          relatedId: $leaveId,
          isRead: false,
          createdAt: $createdAt
        })
      `, { message: notificationMsg, leaveId, createdAt });
    }

    // Send Email Notifications (Admin always; Team Supervisor only if requester is not a Supervisor)
    try {
      const adminEmails = await getAdminEmails(session);
      const emailPayload = {
        employeeName: employeeName || userId,
        employeeNumber,
        company,
        leaveType,
        startDate,
        endDate,
        totalDays: daysRequested,
        isLOP,
        lopDays,
        reason,
        customReason,
        teamName
      };

      console.log(`📧 [Leave Apply Email] leaveId=${leaveId} | admins=${JSON.stringify(adminEmails)} | supervisor=${supervisorEmail || 'none'} | isRequesterSupervisor=${isRequesterSupervisor}`);

      const emailPromises = [];

      for (const adminEmail of adminEmails) {
        emailPromises.push(
          sendLeaveApplicationEmail({
            ...emailPayload,
            to: adminEmail,
            recipientRole: 'Admin'
          }).catch(err => console.error(`Failed to send leave application email to Admin (${adminEmail}):`, err.message))
        );
      }

      if (!isRequesterSupervisor && supervisorEmail && isValidEmail(supervisorEmail)) {
        const isDuplicateAdmin = adminEmails.some(a => a.toLowerCase() === supervisorEmail.toLowerCase());
        if (!isDuplicateAdmin) {
          emailPromises.push(
            sendLeaveApplicationEmail({
              ...emailPayload,
              to: supervisorEmail,
              recipientRole: 'Supervisor'
            }).catch(err => console.error(`Failed to send leave application email to Supervisor (${supervisorEmail}):`, err.message))
          );
        }
      }

      if (emailPromises.length > 0) {
        await Promise.allSettled(emailPromises);
      }
    } catch (emailErr) {
      console.error("Error dispatching leave application emails:", emailErr.message);
    }

    res.json({
      success: true,
      message: "Leave request submitted successfully",
      data: result.records[0].get('l').properties
    });

  } catch (error) {
    console.error("Error applying for leave:", error);
    res.status(500).json({ success: false, message: "Failed to apply for leave" });
  } finally {
    await session.close();
  }
});

// 3. Get all leaves for HR/Admin
router.get("/all", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const result = await session.run(`
      MATCH (l:LeaveRequest)
      OPTIONAL MATCH (u:User {username: l.userId})-[:SUPERVISES]->(anyTeam:Team)
      RETURN l, COUNT(anyTeam) > 0 AS isRequesterSupervisor
      ORDER BY l.createdAt DESC
    `);
    
    const leaves = result.records.map(record => {
      const l = record.get('l').properties;
      const isRequesterSupervisor = record.get('isRequesterSupervisor');
      
      if (isRequesterSupervisor && l.supervisorStatus !== 'N/A') {
        l.supervisorStatus = 'N/A';
        if (l.hrStatus === 'Approved') l.status = 'Approved';
        if (l.hrStatus === 'Rejected') l.status = 'Rejected';
      }
      return l;
    });
    res.json({ success: true, data: leaves });
  } catch (error) {
    console.error("Error fetching all leaves:", error);
    res.status(500).json({ success: false, message: "Failed to fetch leaves" });
  } finally {
    await session.close();
  }
});

// Admin Route to adjust prior leaves
router.put("/admin/user/:userId/prior-leaves", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { userId } = req.params;
  const { priorAnnualUsed, priorSickUsed, priorWfhUsed } = req.body;

  try {
    const result = await session.run(`
      MATCH (u:User {username: $userId})
      OPTIONAL MATCH (p:PersonalDetails {userId: $userId})
      MERGE (u)-[:HAS_LEAVE_BALANCE]->(lb:LeaveBalance)
      SET lb.priorAnnualUsed = $priorAnnualUsed,
          lb.priorSickUsed = $priorSickUsed,
          lb.priorWfhUsed = $priorWfhUsed,
          lb.userId = $userId,
          lb.employeeNumber = p.employeeNumber
      RETURN lb
    `, { 
      userId, 
      priorAnnualUsed: parseFloat(priorAnnualUsed) || 0,
      priorSickUsed: parseFloat(priorSickUsed) || 0,
      priorWfhUsed: parseFloat(priorWfhUsed) || 0
    });

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.json({ success: true, message: "Prior leaves updated successfully." });
  } catch (error) {
    console.error("Error updating prior leaves:", error);
    res.status(500).json({ success: false, message: "Failed to update prior leaves." });
  } finally {
    await session.close();
  }
});

// Admin Route to log a past leave directly as Approved
router.post("/admin/user/:userId/past-leave", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { userId } = req.params;
  const { 
    employeeName, employeeNumber, company, 
    leaveType, startDate, endDate, 
    totalDays, reason 
  } = req.body;

  try {
    if (!userId || !startDate || !endDate || !leaveType) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const countResult = await session.run('MATCH (l:LeaveRequest) RETURN count(l) as c');
    const cVal = countResult.records[0].get('c');
    const currentCount = typeof cVal === 'number' ? cVal : (cVal.toNumber ? cVal.toNumber() : Number(cVal));
    const leaveId = `leave_${currentCount + 1}_${employeeNumber}`;
    const createdAt = new Date().toISOString();

    const result = await session.run(`
      MATCH (u:User {username: $userId})
      CREATE (l:LeaveRequest {
        id: $id,
        userId: $userId,
        employeeName: $employeeName,
        employeeNumber: $employeeNumber,
        company: $company,
        leaveType: $leaveType,
        startDate: $startDate,
        startTime: '09:00',
        endDate: $endDate,
        endTime: '18:00',
        totalDays: $totalDays,
        actualUsedDays: $totalDays,
        annualLeaveDays: 0,
        lopDays: 0,
        reason: $reason,
        customReason: 'Logged by Admin',
        status: 'Approved',
        supervisorStatus: 'Approved',
        hrStatus: 'Approved',
        createdAt: $createdAt
      })
      CREATE (u)-[:APPLIED_FOR]->(l)
      RETURN l
    `, {
      id: leaveId,
      userId,
      employeeName: employeeName || '',
      employeeNumber: employeeNumber || '',
      company: company || '',
      leaveType,
      startDate,
      endDate,
      totalDays: parseFloat(totalDays) || 0,
      reason: reason || 'Past leave logged by admin',
      createdAt
    });

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.json({ success: true, message: "Past leave logged successfully.", data: result.records[0].get('l').properties });
  } catch (error) {
    console.error("Error logging past leave:", error);
    res.status(500).json({ success: false, message: "Failed to log past leave." });
  } finally {
    await session.close();
  }
});

// Admin Route to update a past leave record
router.put("/admin/leave/:id", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { id } = req.params;
  const { leaveType, startDate, endDate, totalDays, reason } = req.body;

  if (!id || !startDate || !endDate || !leaveType) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  try {
    const result = await session.run(`
      MATCH (l:LeaveRequest {id: $id})
      SET l.leaveType = $leaveType,
          l.startDate = $startDate,
          l.endDate = $endDate,
          l.totalDays = $totalDays,
          l.actualUsedDays = $totalDays,
          l.reason = $reason
      RETURN l
    `, { id, leaveType, startDate, endDate, totalDays: parseFloat(totalDays), reason });

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "Leave request not found" });
    }

    res.json({ success: true, message: "Leave record updated successfully." });
  } catch (error) {
    console.error("Error updating leave record:", error);
    res.status(500).json({ success: false, message: "Failed to update leave record." });
  } finally {
    await session.close();
  }
});

// Admin Route to allocate leave balances for an employee (year-specific)
router.post("/admin/user/:userId/allocate-balance", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { userId } = req.params;
  const { allocatedAnnual, allocatedSick, allocatedWfhMonthly, year } = req.body;

  // Use provided year or current year
  const targetYear = parseInt(year) || new Date().getFullYear();

  try {
    const result = await session.run(`
      MATCH (u:User {username: $userId})
      OPTIONAL MATCH (p:PersonalDetails {userId: $userId})
      MERGE (u)-[:HAS_LEAVE_BALANCE]->(lb:LeaveBalance)
      SET 
        lb[$allocatedAnnualKey] = $allocatedAnnual,
        lb[$allocatedSickKey] = $allocatedSick,
        lb.allocatedWfhMonthly = $allocatedWfhMonthly,
        lb.userId = $userId,
        lb.employeeNumber = p.employeeNumber,
        lb.updatedAt = datetime()
      RETURN lb
    `, {
      userId,
      allocatedAnnualKey: `allocatedAnnual_${targetYear}`,
      allocatedSickKey: `allocatedSick_${targetYear}`,
      allocatedAnnual: allocatedAnnual !== '' && allocatedAnnual !== null && allocatedAnnual !== undefined ? parseFloat(allocatedAnnual) : null,
      allocatedSick: allocatedSick !== '' && allocatedSick !== null && allocatedSick !== undefined ? parseFloat(allocatedSick) : null,
      allocatedWfhMonthly: allocatedWfhMonthly !== '' && allocatedWfhMonthly !== null && allocatedWfhMonthly !== undefined ? parseFloat(allocatedWfhMonthly) : null
    });

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.json({ success: true, message: `Leave balances allocated for ${targetYear} successfully.` });
  } catch (error) {
    console.error("Error allocating leave balances:", error);
    res.status(500).json({ success: false, message: "Failed to allocate leave balances." });
  } finally {
    await session.close();
  }
});

// Admin Route to fetch all leave balances
router.get("/balances", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const leavesResult = await session.run(`MATCH (l:LeaveRequest) RETURN l`);
    const allLeaves = leavesResult.records.map(r => r.get('l').properties);

    const usersResult = await session.run(`
      MATCH (u:User)
      OPTIONAL MATCH (u)-[:HAS_LEAVE_BALANCE]->(lb:LeaveBalance)
      OPTIONAL MATCH (p:PersonalDetails {userId: u.username})
      RETURN u.username as userId, p.nationality as nationality, lb.priorAnnualUsed as priorAnnualUsed, lb.priorSickUsed as priorSickUsed, lb.priorWfhUsed as priorWfhUsed, lb[$allocatedAnnualKey] as allocatedAnnual, lb[$allocatedSickKey] as allocatedSick, lb.allocatedWfhMonthly as allocatedWfhMonthly
    `, { allocatedAnnualKey: `allocatedAnnual_${new Date().getFullYear()}`, allocatedSickKey: `allocatedSick_${new Date().getFullYear()}` });

    const userLeavesMap = {};
    allLeaves.forEach(l => {
      if (!userLeavesMap[l.userId]) userLeavesMap[l.userId] = [];
      userLeavesMap[l.userId].push(l);
    });

    const balances = usersResult.records.map(record => {
      const userId = record.get('userId');
      const nationality = record.get('nationality') || '';
      const priorLeaves = {
        priorAnnualUsed: parseFloat(record.get('priorAnnualUsed')) || 0,
        priorSickUsed: parseFloat(record.get('priorSickUsed')) || 0,
        priorWfhUsed: parseFloat(record.get('priorWfhUsed')) || 0,
        allocatedAnnual: record.get('allocatedAnnual') !== null ? record.get('allocatedAnnual') : undefined,
        allocatedSick: record.get('allocatedSick') !== null ? record.get('allocatedSick') : undefined,
        allocatedWfhMonthly: record.get('allocatedWfhMonthly') !== null ? record.get('allocatedWfhMonthly') : undefined
      };
      const userLeaves = userLeavesMap[userId] || [];
      const calc = calculateBalances(userLeaves, nationality, priorLeaves);
      return {
        userId,
        priorAnnualUsed: priorLeaves.priorAnnualUsed,
        priorSickUsed: priorLeaves.priorSickUsed,
        priorWfhUsed: priorLeaves.priorWfhUsed,
        ...calc
      };
    });

    res.json({ success: true, data: balances });
  } catch (error) {
    console.error("Error fetching leave balances:", error);
    res.status(500).json({ success: false, message: "Failed to fetch balances" });
  } finally {
    await session.close();
  }
});

// 4. Update Leave Status (Approve/Reject)
router.put("/status/:id", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { id } = req.params;
  const { status, remarks, approverRole, approverId } = req.body;
  
  try {
    if (!['Approved', 'Rejected', 'Pending'].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    // Get current leave request, team, supervisor Work Email, and employee Work Email
    const getResult = await session.run(`
      MATCH (l:LeaveRequest {id: $id})
      OPTIONAL MATCH (u:User) WHERE toLower(u.username) = toLower(l.userId)
      OPTIONAL MATCH (u)-[:MEMBER_OF]->(t:Team)
      OPTIONAL MATCH (s:User)-[:SUPERVISES]->(t)
      OPTIONAL MATCH (sp:PersonalDetails)
      WHERE toLower(sp.userId) = toLower(s.username) OR toLower(sp.emailId) = toLower(s.username)
      OPTIONAL MATCH (hr:User)-[:HR_FOR]->(t)
      OPTIONAL MATCH (u)-[:SUPERVISES]->(anyTeam:Team)
      OPTIONAL MATCH (ep:PersonalDetails)
      WHERE toLower(ep.userId) = toLower(l.userId)
         OR toLower(ep.emailId) = toLower(l.userId)
         OR (l.employeeNumber IS NOT NULL AND trim(l.employeeNumber) <> '' AND ep.employeeNumber = l.employeeNumber)
      RETURN l,
             s.username AS teamSupervisorId,
             COALESCE(
               NULLIF(trim(sp.emailId), ''),
               NULLIF(trim(sp.workEmail), ''),
               NULLIF(trim(sp.professionalEmail), '')
             ) AS supervisorWorkEmail,
             hr.username AS teamHrId,
             l.userId AS requesterId,
             COALESCE(
               NULLIF(trim(ep.emailId), ''),
               NULLIF(trim(ep.workEmail), ''),
               NULLIF(trim(ep.professionalEmail), '')
             ) AS employeeWorkEmail,
             COUNT(anyTeam) > 0 AS supervisesAnyTeam
    `, { id });
    
    if (getResult.records.length === 0) {
      return res.status(404).json({ success: false, message: "Leave request not found" });
    }
    const currentLeave = getResult.records[0].get('l').properties;
    const teamSupervisorId = getResult.records[0].get('teamSupervisorId');
    const supervisorWorkEmail = getResult.records[0].get('supervisorWorkEmail');
    const teamHrId = getResult.records[0].get('teamHrId');
    const requesterId = getResult.records[0].get('requesterId');
    const employeeWorkEmail = getResult.records[0].get('employeeWorkEmail');
    const supervisesAnyTeam = Boolean(getResult.records[0].get('supervisesAnyTeam'));
    
    const isRequesterSupervisor = (teamSupervisorId && requesterId && teamSupervisorId.toLowerCase() === requesterId.toLowerCase()) || supervisesAnyTeam;

    let newSupervisorStatus = currentLeave.supervisorStatus || 'Pending';
    let newHrStatus = currentLeave.hrStatus || 'Pending';
    
    if (isRequesterSupervisor && newSupervisorStatus !== 'N/A') {
      newSupervisorStatus = 'N/A'; // Patch old data dynamically
    }

    // Check if approver is BOTH HR and Supervisor for this team
    const isApproverBoth = approverId && (approverId === teamSupervisorId) && (approverId === teamHrId);

    if (isApproverBoth) {
      newSupervisorStatus = status;
      newHrStatus = status;
    } else if (approverRole === 'Supervisor') {
      newSupervisorStatus = status;
    } else if (approverRole === 'HR') {
      newHrStatus = status;
    } else {
      // Fallback for admin or old logic
      newSupervisorStatus = status;
      newHrStatus = status;
    }

    let newOverallStatus = 'Pending';
    if (newSupervisorStatus === 'Rejected' || newHrStatus === 'Rejected') {
      newOverallStatus = 'Rejected';
    } else if ((newSupervisorStatus === 'Approved' || newSupervisorStatus === 'N/A') && newHrStatus === 'Approved') {
      newOverallStatus = 'Approved';
    } else {
      newOverallStatus = 'Pending'; // e.g. Waiting for HR or Waiting for Supervisor
    }

    const result = await session.run(`
      MATCH (l:LeaveRequest {id: $id})
      SET l.status = $newOverallStatus, 
          l.supervisorStatus = $newSupervisorStatus,
          l.hrStatus = $newHrStatus,
          l.adminRemarks = coalesce(l.adminRemarks, '') + '\n' + coalesce($remarks, ''), 
          l.updatedAt = $updatedAt
      RETURN l
    `, { id, newOverallStatus, newSupervisorStatus, newHrStatus, remarks: remarks || '', updatedAt: new Date().toISOString() });
    
    const leave = result.records[0].get('l').properties;

    // Update payroll only if LOP and overall status is newly Approved
    if (newOverallStatus === 'Approved' && currentLeave.status !== 'Approved' && leave.isLOP) {
      const leaveStartDate = new Date(leave.startDate);
      const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const leaveMonth = monthNames[leaveStartDate.getMonth()];
      const leaveYear = leaveStartDate.getFullYear().toString();
      
      const payrollResult = await session.run(`
        MATCH (p:PayrollRecord {userId: $userId, month: $month, year: $year})
        RETURN p
      `, { userId: leave.userId, month: leaveMonth, year: leaveYear });
      
      if (payrollResult.records.length > 0) {
        const payroll = payrollResult.records[0].get('p').properties;
        
        const parsedYear = parseInt(leaveYear);
        const parsedMonthIndex = monthNames.indexOf(leaveMonth) + 1;
        const totalDaysInMonth = new Date(parsedYear, parsedMonthIndex, 0).getDate();
        
        const dailySalary = payroll.baseSalary / totalDaysInMonth;
        const lopDeductionAmount = dailySalary * leave.lopDays;
        
        await session.run(`
          MATCH (p:PayrollRecord {userId: $userId, month: $month, year: $year})
          SET p.annualLeaveUsed = p.annualLeaveUsed + $annualLeaveDays,
              p.lopDays = p.lopDays + $lopDays,
              p.workedDays = coalesce(p.workedDays, $totalDaysInMonth) - $lopDays,
              p.lopDeductionAmount = coalesce(p.lopDeductionAmount, 0) + $deductionAmount,
              p.finalSalary = p.baseSalary + p.allowances - p.otherDeductions - (coalesce(p.lopDeductionAmount, 0) + $deductionAmount),
              p.deductionReason = 'Annual Leave balance exhausted. Additional leave days were treated as Loss Of Pay (LOP).',
              p.updatedAt = $updatedAt
        `, {
          userId: leave.userId, month: leaveMonth, year: leaveYear,
          annualLeaveDays: leave.annualLeaveDays, lopDays: leave.lopDays,
          totalDaysInMonth, deductionAmount: lopDeductionAmount,
          updatedAt: new Date().toISOString()
        });
        
        await session.run(`
          MATCH (l:LeaveRequest {id: $id})
          SET l.salaryDeductionAmount = $deductionAmount
        `, { id, deductionAmount: lopDeductionAmount });
      }
    }

    // Mark the specific approver's notification as read
    if (approverId) {
      await session.run(`
        MATCH (n:Notification {relatedId: $leaveId, type: 'LEAVE_REQUEST', userId: $approverId})
        SET n.isRead = true
      `, { leaveId: id, approverId });
    } else {
      await session.run(`
        MATCH (n:Notification {relatedId: $leaveId, type: 'LEAVE_REQUEST'})
        SET n.isRead = true
      `, { leaveId: id });
    }

    // Send notification & Work Email to employee only when overall status is resolved
    if (newOverallStatus === 'Approved' || newOverallStatus === 'Rejected') {
      let employeeMessage = `Your ${leave.leaveType} request has been ${newOverallStatus}.`;
      if (status === 'Approved' && leave.isLOP) {
        employeeMessage += ` Note: ${leave.lopDays} days were treated as Loss Of Pay (LOP).`;
      }
      
      await session.run(`
        CREATE (n:Notification {
          id: randomUUID(),
          userId: $userId,
          message: $message,
          type: 'LEAVE_STATUS',
          relatedId: $leaveId,
          isRead: false,
          createdAt: $createdAt
        })
      `, { 
        userId: leave.userId, 
        message: employeeMessage,
        leaveId: leave.id,
        createdAt: new Date().toISOString()
      });

      console.log(`📧 [Leave Status Email] leaveId=${leave.id} | prev=${currentLeave.status} -> next=${newOverallStatus} | employeeWorkEmail=${employeeWorkEmail || 'none'} | supervisorWorkEmail=${supervisorWorkEmail || 'none'} | isRequesterSupervisor=${isRequesterSupervisor}`);

      if (String(currentLeave.status || '').trim().toLowerCase() !== newOverallStatus.toLowerCase()) {
        const statusEmailBase = {
          employeeName: leave.employeeName || leave.userId,
          leaveType: leave.leaveType,
          startDate: leave.startDate,
          endDate: leave.endDate,
          totalDays: leave.totalDays,
          status: newOverallStatus,
          isLOP: leave.isLOP,
          lopDays: leave.lopDays,
          remarks: remarks || ''
        };

        const statusEmailPromises = [];

        if (employeeWorkEmail && isValidEmail(employeeWorkEmail)) {
          statusEmailPromises.push(
            sendLeaveStatusEmail({
              ...statusEmailBase,
              to: employeeWorkEmail,
              recipientRole: 'Employee'
            }).catch(err => console.error(`Failed to send leave status email to Employee (${employeeWorkEmail}):`, err.message))
          );
        } else {
          console.warn(`⚠️ [Leave Status Email] Missing/invalid employeeWorkEmail for userId=${leave.userId}, empNo=${leave.employeeNumber}`);
        }

        if (!isRequesterSupervisor && supervisorWorkEmail && isValidEmail(supervisorWorkEmail)) {
          const isSameAsEmployee = employeeWorkEmail && employeeWorkEmail.toLowerCase() === supervisorWorkEmail.toLowerCase();
          if (!isSameAsEmployee) {
            statusEmailPromises.push(
              sendLeaveStatusEmail({
                ...statusEmailBase,
                to: supervisorWorkEmail,
                recipientRole: 'Supervisor'
              }).catch(err => console.error(`Failed to send leave status email to Supervisor (${supervisorWorkEmail}):`, err.message))
            );
          }
        }

        if (statusEmailPromises.length > 0) {
          await Promise.allSettled(statusEmailPromises);
        }
      }
    }

    res.json({
      success: true,
      message: `Leave request updated successfully. Overall status: ${newOverallStatus}`,
      data: leave
    });
  } catch (error) {
    console.error("Error updating leave status:", error);
    res.status(500).json({ success: false, message: "Failed to update leave status" });
  } finally {
    await session.close();
  }
});

// 5. Get all leaves for a supervisor's team
router.get("/team/:supervisorId", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { supervisorId } = req.params;

  try {
    const result = await session.run(`
      MATCH (s:User {username: $supervisorId})-[:SUPERVISES]->(t:Team)<-[:MEMBER_OF]-(m:User)
      MATCH (l:LeaveRequest {userId: m.username})
      OPTIONAL MATCH (m)-[:SUPERVISES]->(anyTeam:Team)
      RETURN l, COUNT(anyTeam) > 0 AS isRequesterSupervisor
      ORDER BY l.createdAt DESC
    `, { supervisorId });

    const leaves = result.records.map(record => {
      const l = record.get('l').properties;
      const isRequesterSupervisor = record.get('isRequesterSupervisor');
      
      if (isRequesterSupervisor && l.supervisorStatus !== 'N/A') {
        l.supervisorStatus = 'N/A';
        if (l.hrStatus === 'Approved') l.status = 'Approved';
        if (l.hrStatus === 'Rejected') l.status = 'Rejected';
      }
      return l;
    });
    res.json({ success: true, data: leaves });
  } catch (error) {
    console.error("Error fetching team leaves:", error);
    res.status(500).json({ success: false, message: "Failed to fetch team leaves" });
  } finally {
    await session.close();
  }
});

// 5b. Get all leaves for an HR's team
router.get("/hr/:hrId", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { hrId } = req.params;

  try {
    const result = await session.run(`
      MATCH (h:User {username: $hrId})-[:HR_FOR]->(t:Team)
      MATCH (t)<-[:MEMBER_OF|SUPERVISES]-(m:User)
      MATCH (l:LeaveRequest {userId: m.username})
      WITH DISTINCT l, m
      OPTIONAL MATCH (m)-[:SUPERVISES]->(anyTeam:Team)
      RETURN l, COUNT(anyTeam) > 0 AS isSupervisor
      ORDER BY l.createdAt DESC
    `, { hrId });

    const leaves = result.records.map(record => {
      const l = record.get('l').properties;
      const isSupervisor = record.get('isSupervisor');
      
      // Patch old data on the fly for Supervisors
      if (isSupervisor && l.supervisorStatus !== 'N/A') {
        l.supervisorStatus = 'N/A';
        if (l.hrStatus === 'Approved') l.status = 'Approved';
        if (l.hrStatus === 'Rejected') l.status = 'Rejected';
      }
      return l;
    });
    
    res.json({ success: true, data: leaves });
  } catch (error) {
    console.error("Error fetching hr team leaves:", error);
    res.status(500).json({ success: false, message: "Failed to fetch hr team leaves" });
  } finally {
    await session.close();
  }
});

// 6. Adjust Leave (Early Return)
router.put("/adjust/:id", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { id } = req.params;
  const { actualUsedDays, adjustmentReason, adjustedBy, adjustedEndDate } = req.body;

  try {
    const parsedActualDays = parseFloat(actualUsedDays);
    if (isNaN(parsedActualDays) || parsedActualDays < 0) {
      return res.status(400).json({ success: false, message: "Invalid actual used days" });
    }

    if (!adjustmentReason) {
      return res.status(400).json({ success: false, message: "Adjustment reason is required" });
    }

    // Get the leave request
    const getResult = await session.run(`
      MATCH (l:LeaveRequest {id: $id})
      RETURN l
    `, { id });

    if (getResult.records.length === 0) {
      return res.status(404).json({ success: false, message: "Leave request not found" });
    }

    const leave = getResult.records[0].get('l').properties;

    if (leave.status !== 'Approved') {
      return res.status(400).json({ success: false, message: "Can only adjust approved leave requests" });
    }

    const updateTotalDays = req.body.updateTotalDays === true || req.body.updateTotalDays === 'true';
    const totalDays = parseFloat(leave.totalDays);
    if (!updateTotalDays && parsedActualDays > totalDays) {
      return res.status(400).json({ success: false, message: "Actual used days cannot exceed originally approved days" });
    }

    const restoredDays = Math.max(0, totalDays - parsedActualDays);
    
    // Recalculate LOP vs Annual Leave
    let newLopDays = leave.lopDays || 0;
    let newAnnualLeaveDays = leave.annualLeaveDays || 0;
    let remainingToRestore = restoredDays;

    if (remainingToRestore > 0 && newLopDays > 0) {
      if (remainingToRestore >= newLopDays) {
        remainingToRestore -= newLopDays;
        newLopDays = 0;
      } else {
        newLopDays -= remainingToRestore;
        remainingToRestore = 0;
      }
    }

    if (remainingToRestore > 0 && newAnnualLeaveDays > 0) {
      if (remainingToRestore >= newAnnualLeaveDays) {
        remainingToRestore -= newAnnualLeaveDays;
        newAnnualLeaveDays = 0;
      } else {
        newAnnualLeaveDays -= remainingToRestore;
        remainingToRestore = 0;
      }
    }

    const newSalaryDeductionPercentage = newLopDays * 2;
    const isLOP = newLopDays > 0;

    // Update the leave request
    const updateResult = await session.run(`
      MATCH (l:LeaveRequest {id: $id})
      SET l.actualUsedDays = $actualUsedDays,
          l.totalDays = CASE WHEN $updateTotalDays THEN $actualUsedDays ELSE l.totalDays END,
          l.restoredDays = $restoredDays,
          l.adjustedBy = $adjustedBy,
          l.adjustedAt = $adjustedAt,
          l.adjustmentReason = $adjustmentReason,
          l.adjustedEndDate = $adjustedEndDate,
          l.lopDays = $newLopDays,
          l.annualLeaveDays = $newAnnualLeaveDays,
          l.salaryDeductionPercentage = $newSalaryDeductionPercentage,
          l.isLOP = $isLOP,
          l.salaryImpact = $isLOP
      RETURN l
    `, {
      id,
      actualUsedDays: parsedActualDays,
      updateTotalDays,
      restoredDays,
      adjustedBy: adjustedBy || 'Admin',
      adjustedAt: new Date().toISOString(),
      adjustmentReason,
      adjustedEndDate: adjustedEndDate || null,
      newLopDays,
      newAnnualLeaveDays,
      newSalaryDeductionPercentage,
      isLOP
    });

    const updatedLeave = updateResult.records[0].get('l').properties;

    // Check if a payroll record exists for this month and flag it for recalculation
    if (leave.startDate) {
      const leaveStartDate = new Date(leave.startDate);
      const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const leaveMonth = monthNames[leaveStartDate.getMonth()];
      const leaveYear = leaveStartDate.getFullYear().toString();

      await session.run(`
        MATCH (p:PayrollRecord {employeeNumber: $employeeNumber, month: $month, year: $year})
        SET p.needsRecalculation = true,
            p.recalculationReason = 'Leave adjustment occurred after payroll generation. LOP days were updated.'
      `, { employeeNumber: leave.employeeNumber, month: leaveMonth, year: leaveYear });
    }

    res.json({
      success: true,
      message: "Leave adjusted successfully",
      data: updatedLeave
    });

  } catch (error) {
    console.error("Error adjusting leave:", error);
    res.status(500).json({ success: false, message: "Failed to adjust leave" });
  } finally {
    await session.close();
  }
});

// 7. Cancel Leave Request (Employee Self-Service for Pending leaves)
router.delete("/cancel/:id", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { id } = req.params;
  const { userId } = req.body;

  try {
    // Verify leave belongs to user and is still Pending
    const getResult = await session.run(`
      MATCH (l:LeaveRequest {id: $id})
      RETURN l
    `, { id });

    if (getResult.records.length === 0) {
      return res.status(404).json({ success: false, message: "Leave request not found" });
    }

    const leave = getResult.records[0].get('l').properties;

    if (userId && leave.userId !== userId) {
      return res.status(403).json({ success: false, message: "Not authorized to cancel this leave" });
    }

    if (leave.status !== 'Pending') {
      return res.status(400).json({ success: false, message: "Only Pending leave requests can be cancelled" });
    }

    await session.run(`
      MATCH (l:LeaveRequest {id: $id})
      DETACH DELETE l
    `, { id });

    res.json({ success: true, message: "Leave request cancelled successfully" });
  } catch (error) {
    console.error("Error cancelling leave:", error);
    res.status(500).json({ success: false, message: "Failed to cancel leave request" });
  } finally {
    await session.close();
  }
});

// 8. Admin Cancel Leave (works on any status including Approved)
router.delete("/admin/cancel/:id", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { id } = req.params;
  const { cancelReason, cancelledBy } = req.body;

  try {
    if (!cancelReason || !cancelReason.trim()) {
      return res.status(400).json({ success: false, message: "Cancellation reason is required" });
    }

    // Get the leave request
    const getResult = await session.run(`
      MATCH (l:LeaveRequest {id: $id})
      RETURN l
    `, { id });

    if (getResult.records.length === 0) {
      return res.status(404).json({ success: false, message: "Leave request not found" });
    }

    const leave = getResult.records[0].get('l').properties;

    const cancelledAt = new Date().toISOString();

    // Update leave status to Cancelled (keep the record for history)
    await session.run(`
      MATCH (l:LeaveRequest {id: $id})
      SET l.status = 'Cancelled',
          l.supervisorStatus = 'Cancelled',
          l.hrStatus = 'Cancelled',
          l.cancelReason = $cancelReason,
          l.cancelledBy = $cancelledBy,
          l.cancelledAt = $cancelledAt,
          l.actualUsedDays = 0,
          l.annualLeaveDays = 0,
          l.lopDays = 0,
          l.isLOP = false,
          l.salaryImpact = false
      RETURN l
    `, { id, cancelReason, cancelledBy: cancelledBy || 'Admin', cancelledAt });

    // Notify the employee about the cancellation
    const notificationMsg = `Your ${leave.leaveType} from ${leave.startDate} to ${leave.endDate} has been cancelled by admin. Reason: ${cancelReason}`;

    await session.run(`
      CREATE (n:Notification {
        id: randomUUID(),
        userId: $userId,
        message: $message,
        type: 'LEAVE_CANCELLED',
        relatedId: $leaveId,
        isRead: false,
        createdAt: $cancelledAt
      })
    `, { userId: leave.userId, message: notificationMsg, leaveId: id, cancelledAt });

    // If there's a payroll record for this month, flag it for recalculation
    if (leave.startDate) {
      const leaveStartDate = new Date(leave.startDate);
      const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
      const leaveMonth = monthNames[leaveStartDate.getMonth()];
      const leaveYear = leaveStartDate.getFullYear().toString();
      await session.run(`
        MATCH (p:PayrollRecord {employeeNumber: $employeeNumber, month: $month, year: $year})
        SET p.needsRecalculation = true,
            p.recalculationReason = 'Leave cancelled by admin. Balance restored.'
      `, { employeeNumber: leave.employeeNumber, month: leaveMonth, year: leaveYear });
    }

    res.json({ success: true, message: "Leave cancelled successfully. Employee has been notified." });
  } catch (error) {
    console.error("Error cancelling leave (admin):", error);
    res.status(500).json({ success: false, message: "Failed to cancel leave" });
  } finally {
    await session.close();
  }
});

// 9. Get Leave Request Notification Recipients
router.get('/notification-recipients', async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (n:NotificationConfig { type: 'leaveRequest' })
      RETURN n.emails AS emails, n.updatedAt AS updatedAt, n.updatedBy AS updatedBy
    `);
    if (result.records.length === 0) {
      return res.json({
        success: true,
        recipients: getDefaultLeaveNotificationEmails(),
        updatedAt: null,
        updatedBy: null
      });
    }
    const rec = result.records[0];
    return res.json({
      success: true,
      recipients: rec.get('emails') || [],
      updatedAt: rec.get('updatedAt'),
      updatedBy: rec.get('updatedBy')
    });
  } catch (error) {
    console.error('❌ Error fetching leave notification recipients:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch recipients', error: error.message });
  } finally {
    await session.close();
  }
});

// 10. Add a Leave Request Notification Recipient
router.post('/notification-recipients', async (req, res) => {
  const { email } = req.body;
  if (!isValidEmail(email)) {
    return res.status(400).json({ success: false, message: 'A valid email address is required' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  const updatedBy = req.user?.email || req.user?.name || 'Admin';
  const defaultEmails = getDefaultLeaveNotificationEmails();

  const driver = getDriver();
  const session = driver.session();
  try {
    const existingResult = await session.run(`
      MATCH (n:NotificationConfig { type: 'leaveRequest' })
      RETURN n.emails AS emails
    `);

    if (existingResult.records.length === 0) {
      if (defaultEmails.includes(normalizedEmail)) {
        await session.run(`
          MERGE (n:NotificationConfig { type: 'leaveRequest' })
          ON CREATE SET n.emails = $defaultEmails, n.createdAt = datetime(), n.updatedAt = datetime(), n.updatedBy = $updatedBy
        `, { defaultEmails, updatedBy });
        return res.json({
          success: false,
          message: 'Email already exists in the list',
          recipients: defaultEmails
        });
      }
      const initialEmails = [...defaultEmails, normalizedEmail];
      await session.run(`
        MERGE (n:NotificationConfig { type: 'leaveRequest' })
        ON CREATE SET n.emails = $initialEmails, n.createdAt = datetime(), n.updatedAt = datetime(), n.updatedBy = $updatedBy
      `, { initialEmails, updatedBy });
      return res.json({
        success: true,
        message: `${normalizedEmail} added to notification recipients`,
        recipients: initialEmails
      });
    }

    const currentEmails = existingResult.records[0].get('emails') || [];
    if (currentEmails.some(e => e.toLowerCase() === normalizedEmail)) {
      return res.json({
        success: false,
        message: 'Email already exists in the list',
        recipients: currentEmails
      });
    }

    const updatedEmails = [...currentEmails, normalizedEmail];
    await session.run(`
      MATCH (n:NotificationConfig { type: 'leaveRequest' })
      SET n.emails = $updatedEmails,
          n.updatedAt = datetime(),
          n.updatedBy = $updatedBy
    `, { updatedEmails, updatedBy });

    return res.json({
      success: true,
      message: `${normalizedEmail} added to notification recipients`,
      recipients: updatedEmails
    });
  } catch (error) {
    console.error('❌ Error adding leave notification recipient:', error);
    res.status(500).json({ success: false, message: 'Failed to add recipient', error: error.message });
  } finally {
    await session.close();
  }
});

// 11. Remove a Leave Request Notification Recipient
router.delete('/notification-recipients/:email', async (req, res) => {
  const emailToRemove = decodeURIComponent(req.params.email).trim().toLowerCase();
  const updatedBy = req.user?.email || req.user?.name || 'Admin';
  const defaultEmails = getDefaultLeaveNotificationEmails();

  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(`
      MERGE (n:NotificationConfig { type: 'leaveRequest' })
      ON CREATE SET n.emails = $defaultEmails, n.createdAt = datetime()
      WITH n
      SET n.emails = [e IN coalesce(n.emails, $defaultEmails) WHERE toLower(trim(e)) <> $email],
          n.updatedAt = datetime(),
          n.updatedBy = $updatedBy
      RETURN n.emails AS emails
    `, { email: emailToRemove, updatedBy, defaultEmails });

    const emails = result.records[0]?.get('emails') || [];
    return res.json({
      success: true,
      message: `${emailToRemove} removed from notification recipients`,
      recipients: emails
    });
  } catch (error) {
    console.error('❌ Error removing leave notification recipient:', error);
    res.status(500).json({ success: false, message: 'Failed to remove recipient', error: error.message });
  } finally {
    await session.close();
  }
});

module.exports = router;
