const express = require("express");
const router = express.Router();
const multer = require('multer');
const getDriver = require("../lib/neo4j");
const crypto = require("crypto");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// Default Entitlements
const DEFAULT_ANNUAL_LEAVE = 11;

// Helper to calculate leave balance stats
const calculateBalances = (leaves, nationality) => {
  let wfhUsed = 0;
  let rawAnnualUsed = 0;
  let pendingAnnual = 0;
  let rawSickUsed = 0;
  let pendingSick = 0;

  const currentMonth = new Date().getMonth();
  const currentYear = new Date().getFullYear();

  let monthlyRawAL = 0;
  let monthlyWFH = 0;

  leaves.forEach(leave => {
    const days = leave.actualUsedDays !== undefined && leave.actualUsedDays !== null 
      ? parseFloat(leave.actualUsedDays) 
      : (parseFloat(leave.totalDays) || 0);
      
    let isThisMonth = false;
    if (leave.startDate) {
      const ld = new Date(leave.startDate);
      isThisMonth = ld.getMonth() === currentMonth && ld.getFullYear() === currentYear;
    }
      
    if (leave.status === 'Approved') {
      if (leave.leaveType === 'Annual Leave' || leave.leaveType === 'Leave') {
        rawAnnualUsed += days;
        if (isThisMonth) monthlyRawAL += days;
      } else if (leave.leaveType === 'Sick Leave') {
        rawSickUsed += days;
      } else if (leave.leaveType === 'Work From Home') {
        wfhUsed += days;
        if (isThisMonth) monthlyWFH += days;
      }
    } else if (leave.status === 'Pending') {
      if (leave.leaveType === 'Annual Leave' || leave.leaveType === 'Leave') {
        pendingAnnual += days;
      } else if (leave.leaveType === 'Sick Leave') {
        pendingSick += days;
      }
    }
  });

  let annualEntitlement = DEFAULT_ANNUAL_LEAVE;
  let sickEntitlement = 0;

  if (nationality === 'INDIA') {
    annualEntitlement = 8;
    sickEntitlement = 3;
    
    // Migration: If rawAnnualUsed > 8, shift overflow to Sick if possible
    if (rawAnnualUsed > annualEntitlement) {
      const overflow = rawAnnualUsed - annualEntitlement;
      const sickAvailableForOverflow = sickEntitlement - rawSickUsed;
      if (overflow <= sickAvailableForOverflow && sickAvailableForOverflow > 0) {
        rawSickUsed += overflow;
        rawAnnualUsed = annualEntitlement;
      } else if (sickAvailableForOverflow > 0) {
        rawSickUsed += sickAvailableForOverflow;
        rawAnnualUsed = rawAnnualUsed - sickAvailableForOverflow;
      }
    }
  }

  const annualUsed = Math.min(rawAnnualUsed, annualEntitlement);
  const lopUsed = Math.max(0, rawAnnualUsed - annualEntitlement) + Math.max(0, rawSickUsed - sickEntitlement);
  
  const rawAnnualBeforeThisMonth = rawAnnualUsed - monthlyRawAL;
  const lopBeforeThisMonth = Math.max(0, rawAnnualBeforeThisMonth - annualEntitlement);
  const monthlyLOP = Math.max(0, lopUsed - lopBeforeThisMonth);
  const monthlyAL = monthlyRawAL - monthlyLOP;
  
  const annualBalance = Math.max(0, annualEntitlement - rawAnnualUsed) - pendingAnnual;
  const sickBalance = Math.max(0, sickEntitlement - rawSickUsed) - pendingSick;

  return {
    annualEntitlement,
    annualUsed,
    annualPending: pendingAnnual,
    annualBalance,
    sickEntitlement,
    sickUsed: rawSickUsed,
    sickBalance,
    
    wfhUsed,
    lopUsed,
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

    const pdResult = await session.run(`MATCH (p:PersonalDetails {userId: $userId}) RETURN p.nationality as nationality`, { userId });
    let nationality = '';
    if (pdResult.records.length > 0) nationality = pdResult.records[0].get('nationality');

    const balances = calculateBalances(leaves, nationality);

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

    if (!customReason || customReason.trim() === '') {
      return res.status(400).json({ success: false, message: "Additional Reason is mandatory." });
    }
    const wordCount = customReason.trim().split(/\\s+/).filter(Boolean).length;
    if (wordCount > 50) {
      return res.status(400).json({ success: false, message: "Additional Reason cannot exceed 50 words." });
    }

    // Holiday Check
    const holidayResult = await session.run(`
      MATCH (g:Group {name: $company})-[:HAS_HOLIDAY]->(h:Holiday)
      WHERE h.date = $startDate OR h.date = $endDate
      RETURN h.date as date
    `, { company, startDate, endDate });
    
    if (holidayResult.records.length > 0) {
      return res.status(400).json({ success: false, message: "It is a holiday. Leave cannot be applied on a holiday." });
    }

    // Check existing leaves to ensure enough balance
    const existingResult = await session.run(`
      MATCH (l:LeaveRequest {userId: $userId})
      RETURN l
    `, { userId });
    
    const pdResult = await session.run(`MATCH (p:PersonalDetails {userId: $userId}) RETURN p.nationality as nationality`, { userId });
    let nationality = '';
    if (pdResult.records.length > 0) nationality = pdResult.records[0].get('nationality');

    const existingLeaves = existingResult.records.map(record => record.get('l').properties);
    const balances = calculateBalances(existingLeaves, nationality);

    // WFH 1-per-week validation
    if (leaveType === 'Work From Home' && ['UANDWE Bangalore', 'BangaloreUANDWE', 'bangaloreuandwelabs', 'BangaloreUANDWELabs', 'bangaloreuandwe labs'].includes(company)) {
      const isSameWeek = (d1, d2) => {
        const date1 = new Date(d1); const date2 = new Date(d2);
        const day1 = date1.getDay() === 0 ? 7 : date1.getDay();
        date1.setDate(date1.getDate() - day1 + 1); date1.setHours(0,0,0,0);
        const day2 = date2.getDay() === 0 ? 7 : date2.getDay();
        date2.setDate(date2.getDate() - day2 + 1); date2.setHours(0,0,0,0);
        return date1.getTime() === date2.getTime();
      };
      const wfhThisWeek = existingLeaves.find(l => 
        l.leaveType === 'Work From Home' && 
        l.status !== 'Rejected' && 
        isSameWeek(startDate, l.startDate)
      );
      if (wfhThisWeek) {
        return res.status(400).json({ success: false, message: "You have already used your Work From Home request for this week." });
      }
    }

    const daysRequested = parseFloat(totalDays);
    
    let annualLeaveDays = daysRequested;
    let lopDays = 0;
    
    if (leaveType === 'Annual Leave' || leaveType === 'Leave') {
      const currentBalance = Math.max(0, balances.annualBalance);
      if (daysRequested > currentBalance) {
        annualLeaveDays = currentBalance;
        lopDays = daysRequested - currentBalance;
      }
    } else if (leaveType === 'Sick Leave') {
      const currentBalance = Math.max(0, balances.sickBalance);
      if (daysRequested > currentBalance) {
        // Technically sick leave doesn't have an "annualLeaveDays" field in the schema, 
        // we can store the consumed part in a new field if we want, or just treat excess as LOP.
        lopDays = daysRequested - currentBalance;
        annualLeaveDays = 0;
      } else {
        annualLeaveDays = 0;
      }
    }
    
    const isLOP = lopDays > 0;
    const salaryDeductionPercentage = lopDays * 2;

    const leaveId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    
    // Check if requester supervises any team
    const checkSupResult = await session.run(`
      MATCH (u:User {username: $userId})
      OPTIONAL MATCH (u)-[:SUPERVISES]->(anyTeam:Team)
      RETURN COUNT(anyTeam) > 0 AS isRequesterSupervisor
    `, { userId });
    const isRequesterSupervisor = checkSupResult.records.length > 0 ? checkSupResult.records[0].get('isRequesterSupervisor') : false;

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
        hrStatus: 'Pending',
        createdAt: $createdAt
      })
      RETURN l
    `, {
      id: leaveId, userId, employeeName: employeeName || '', employeeNumber: employeeNumber || '',
      company: company || '', leaveType, startDate, startTime: startTime || '',
      endDate, endTime: endTime || '', totalDays: daysRequested, 
      annualLeaveDays, lopDays, isLOP, salaryDeductionPercentage, reason,
      customReason: customReason || '', createdAt,
      initialSupervisorStatus: isRequesterSupervisor ? 'N/A' : 'Pending'
    });

    // Find supervisor and send notification (only if they are an employee)
    const notificationMsg = isLOP 
      ? `Loss Of Pay Leave Request - Employee Name: ${employeeName || userId}, Requested Days: ${daysRequested}, LOP Days: ${lopDays}`
      : `${employeeName || userId} submitted a ${leaveType} request.`;
      
    if (!isRequesterSupervisor) {
      await session.run(`
        MATCH (u:User {username: $userId})-[:MEMBER_OF]->(t:Team)<-[:SUPERVISES]-(s:User)
        CREATE (n:Notification {
          id: randomUUID(),
          userId: s.username,
          message: $message,
          type: 'LEAVE_REQUEST',
          relatedId: $leaveId,
          isRead: false,
          createdAt: $createdAt
        })
      `, { userId, message: notificationMsg, leaveId, createdAt });
    }

    // Find HR and send notification
    await session.run(`
      MATCH (hr:User)
      WHERE hr.role = 'HR'
      
      CREATE (n:Notification {
        id: randomUUID(),
        userId: hr.username,
        message: $message,
        type: 'LEAVE_REQUEST',
        relatedId: $leaveId,
        isRead: false,
        createdAt: $createdAt
      })
    `, { message: notificationMsg, leaveId, createdAt });

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

// 3. Get all leaves (Admin view)
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

    // Get current leave request and check if requester supervises any team
    const getResult = await session.run(`
      MATCH (l:LeaveRequest {id: $id})
      OPTIONAL MATCH (u:User {username: l.userId})-[:SUPERVISES]->(t:Team)
      RETURN l, COUNT(t) > 0 AS isRequesterSupervisor
    `, { id });
    
    if (getResult.records.length === 0) {
      return res.status(404).json({ success: false, message: "Leave request not found" });
    }
    const currentLeave = getResult.records[0].get('l').properties;
    const isRequesterSupervisor = getResult.records[0].get('isRequesterSupervisor');

    let newSupervisorStatus = currentLeave.supervisorStatus || 'Pending';
    let newHrStatus = currentLeave.hrStatus || 'Pending';
    
    if (isRequesterSupervisor && newSupervisorStatus !== 'N/A') {
      newSupervisorStatus = 'N/A'; // Patch old data dynamically
    }

    if (approverRole === 'Supervisor') {
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

    // Send notification to employee only when overall status is resolved
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
  const { actualUsedDays, adjustmentReason, adjustedBy } = req.body;

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

    const totalDays = parseFloat(leave.totalDays);
    if (parsedActualDays > totalDays) {
      return res.status(400).json({ success: false, message: "Actual used days cannot exceed originally approved days" });
    }

    const restoredDays = totalDays - parsedActualDays;
    
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
          l.restoredDays = $restoredDays,
          l.adjustedBy = $adjustedBy,
          l.adjustedAt = $adjustedAt,
          l.adjustmentReason = $adjustmentReason,
          l.lopDays = $newLopDays,
          l.annualLeaveDays = $newAnnualLeaveDays,
          l.salaryDeductionPercentage = $newSalaryDeductionPercentage,
          l.isLOP = $isLOP,
          l.salaryImpact = $isLOP
      RETURN l
    `, {
      id,
      actualUsedDays: parsedActualDays,
      restoredDays,
      adjustedBy: adjustedBy || 'Admin',
      adjustedAt: new Date().toISOString(),
      adjustmentReason,
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

module.exports = router;
