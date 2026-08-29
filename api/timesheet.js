const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");
const crypto = require("crypto");

/** Helper to get days in a month */
const getDaysInMonth = (year, month) => {
  return new Date(year, month, 0).getDate();
};

/** Helper to format date YYYY-MM-DD */
const formatDate = (date) => {
  const d = new Date(date);
  const month = '' + (d.getMonth() + 1);
  const day = '' + d.getDate();
  const year = d.getFullYear();
  return [year, month.padStart(2, '0'), day.padStart(2, '0')].join('-');
};

/** 
 * 1. GET /api/timesheet/user/:userId?month=YYYY-MM
 * Dynamically generates the timesheet for an employee.
 */
router.get("/user/:userId", async (req, res) => {
  const { userId } = req.params;
  const monthParam = req.query.month; // e.g., "2026-06"
  
  if (!monthParam) {
    return res.status(400).json({ success: false, message: "month query param (YYYY-MM) is required" });
  }

  const [yearStr, monthStr] = monthParam.split('-');
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);

  const driver = getDriver();
  const session = driver.session();

  try {
    // A. Fetch User details to get the client (for holiday group)
    const pdResult = await session.run(`
      MATCH (pd:PersonalDetails {userId: $userId})
      RETURN pd.assignedCompany AS client, pd.employmentLocation AS location, pd.employeeName AS employeeName, pd.employeeNumber AS employeeNumber, pd.nationality AS nationality
    `, { userId });

    let client = null;
    let location = null;
    let employeeName = userId;
    let employeeNumber = "";
    let nationality = "";
    if (pdResult.records.length > 0) {
      client = pdResult.records[0].get("client");
      location = pdResult.records[0].get("location");
      employeeName = pdResult.records[0].get("employeeName") || userId;
      employeeNumber = pdResult.records[0].get("employeeNumber") || "";
      nationality = pdResult.records[0].get("nationality") || "";
    }

    // B. Fetch Holidays for this client
    let holidays = [];
    let queryClient = client || "UANDWE"; // Default to company if no client assigned
    let exactGroupName = location && client ? `${location.replace(/\s+/g, '')}${client.replace(/\s+/g, '')}` : queryClient;
    // console.log("DEBUG: location =", location, "client =", client, "exactGroupName =", exactGroupName);

    let holidayResult = await session.run(`
      MATCH (g:Group {name: $exactGroupName})
      OPTIONAL MATCH (g)-[:SHARES_HOLIDAY_CALENDAR*0..]-(linkedGroup:Group)
      WITH DISTINCT coalesce(linkedGroup, g) AS validGroup
      MATCH (validGroup)-[:HAS_HOLIDAY]->(h:Holiday)
      WHERE h.date STARTS WITH $monthPrefix
      RETURN DISTINCT h.date AS date, h.name AS name
    `, { exactGroupName, monthPrefix: monthParam });
    
    if (holidayResult.records.length === 0) {
      holidayResult = await session.run(`
        MATCH (g:Group)
        WHERE g.name = $client OR g.client = $client
        OPTIONAL MATCH (g)-[:SHARES_HOLIDAY_CALENDAR*0..]-(linkedGroup:Group)
        WITH DISTINCT coalesce(linkedGroup, g) AS validGroup
        MATCH (validGroup)-[:HAS_HOLIDAY]->(h:Holiday)
        WHERE h.date STARTS WITH $monthPrefix
        RETURN DISTINCT h.date AS date, h.name AS name
      `, { client: queryClient, monthPrefix: monthParam });
    }
    
    holidays = holidayResult.records.map(r => ({
      date: r.get("date"),
      name: r.get("name")
    }));

    // C. Fetch Approved Leaves for this user in this month
    const leaveResult = await session.run(`
      MATCH (l:LeaveRequest {userId: $userId, status: 'Approved'})
      WHERE l.startDate STARTS WITH $monthPrefix OR l.endDate STARTS WITH $monthPrefix
      RETURN l.startDate AS startDate, l.endDate AS endDate, l.leaveType AS leaveType, l.isLOP AS isLOP
    `, { userId, monthPrefix: monthParam });
    
    const leaves = leaveResult.records.map(r => ({
      startDate: r.get("startDate"),
      endDate: r.get("endDate"),
      leaveType: r.get("leaveType"),
      isLOP: r.get("isLOP")
    }));

    // Generate flat list of leave dates
    const leaveDates = {};
    leaves.forEach(l => {
      let curr = new Date(l.startDate);
      const end = new Date(l.endDate);
      while (curr <= end) {
        const dStr = formatDate(curr);
        if (dStr.startsWith(monthParam)) {
          leaveDates[dStr] = { type: l.leaveType, isLOP: l.isLOP };
        }
        curr.setDate(curr.getDate() + 1);
      }
    });

    // D. Fetch Manual Exceptions (e.g. Overtime, Short Hours)
    const exceptionResult = await session.run(`
      MATCH (tr:TimesheetRecord {userId: $userId, monthStr: $monthPrefix})
      RETURN tr.exceptionsData AS exceptionsData
    `, { userId, monthPrefix: monthParam });
    
    let exceptions = {};
    if (exceptionResult.records.length > 0) {
      const dataStr = exceptionResult.records[0].get("exceptionsData");
      if (dataStr) {
        try {
          exceptions = JSON.parse(dataStr);
        } catch(e) {
          console.error("Error parsing exceptionsData JSON:", e);
        }
      }
    }

    // E. Fetch Month Record Status
    const recordResult = await session.run(`
      MATCH (tr:TimesheetRecord {userId: $userId, monthStr: $monthPrefix})
      RETURN tr.status AS status, tr.updatedAt AS updatedAt, tr.approvedBy AS approvedBy
    `, { userId, monthPrefix: monthParam });

    let recordStatus = "Generated";
    let recordUpdatedAt = null;
    let approvedBy = null;
    if (recordResult.records.length > 0) {
      recordStatus = recordResult.records[0].get("status");
      recordUpdatedAt = recordResult.records[0].get("updatedAt");
      approvedBy = recordResult.records[0].get("approvedBy");
    }

    // F. Construct the Timesheet Array
    const numDays = getDaysInMonth(year, month);
    const timesheetDays = [];
    
    let totalWorkingHours = 0;
    let totalOvertimeHours = 0; // Existing calculated OT
    let totalExplicitOvertime = 0; // New explicit OT for USA
    let totalMileage = 0; // New mileage for USA
    let totalLopDays = 0;
    let totalLeaveDays = 0;
    let totalHolidays = 0;
    const weeklyHoursMap = {};
    const weeklyExplicitOvertimeMap = {};

    for (let i = 1; i <= numDays; i++) {
      const d = new Date(year, month - 1, i);
      const dStr = formatDate(d);
      const dayOfWeek = d.getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

      const holiday = holidays.find(h => h.date === dStr);
      const leave = leaveDates[dStr];
      const exception = exceptions[dStr];

      let status = "";
      let hours = 0;
      let notes = "";

      let hasException = false;

      // Determine priority: Holiday -> Weekend -> Leave -> Normal Day
      if (holiday) {
        status = "Holiday";
        notes = holiday.name;
        totalHolidays++;
      } else if (isWeekend) {
        status = "Weekend";
      } else if (leave) {
        if (leave.type === "Work From Home" || leave.type === "WFH") {
          status = "WFH";
          notes = leave.type;
          hours = 0; // Default 0
        } else {
          status = leave.isLOP ? "LOP" : "Leave";
          notes = leave.type;
          if (leave.isLOP) totalLopDays++;
          else totalLeaveDays++;
        }
      } else {
        status = "Working Day";
        hours = 0; // Default 0, not 8
      }

      // Apply Exception overrides
      if (exception) {
        hasException = true;
        if (exception.hours !== null && exception.hours !== undefined) {
          if (status !== "Working Day" && status !== "WFH") {
             if (exception.hours > 0) {
               status = "Exception";
             }
          }
          hours = exception.hours;
        }
        notes = exception.reason || notes;
        
        // Sum explicit OT and Mileage
        totalExplicitOvertime += parseFloat(exception.overtimeHours) || 0;
        totalMileage += parseFloat(exception.mileage) || 0;
      }

      totalWorkingHours += hours;

      // Calculate week of the month (Week 1, Week 2, etc.) using Monday as start of week
      const firstDayOfMonth = (new Date(year, month - 1, 1).getDay() + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
      const weekOfMonth = Math.ceil((i + firstDayOfMonth) / 7);
      weeklyHoursMap[weekOfMonth] = (weeklyHoursMap[weekOfMonth] || 0) + hours;
      
      if (exception && exception.type === 'Overtime' && exception.hours > 0) {
         weeklyExplicitOvertimeMap[weekOfMonth] = (weeklyExplicitOvertimeMap[weekOfMonth] || 0) + exception.hours;
      }

      timesheetDays.push({
        date: dStr,
        dayOfWeek,
        status,
        hours,
        notes,
        hasException
      });
    }

    // Calculate totalOvertimeHours based on weekly logic
    Object.keys(weeklyHoursMap).forEach(week => {
      const weekHours = weeklyHoursMap[week];
      const explicitOT = weeklyExplicitOvertimeMap[week] || 0;
      const calculatedOT = Math.max(0, weekHours - 40);
      totalOvertimeHours += Math.max(calculatedOT, explicitOT);
    });

    res.json({
      success: true,
      data: {
        userId,
        employeeName,
        employeeNumber,
        client,
        nationality,
        monthStr: monthParam,
        status: recordStatus,
        updatedAt: recordUpdatedAt,
        approvedBy: approvedBy,
        days: timesheetDays,
        totalWorkingHours,
        totalOvertimeHours,
        totalExplicitOvertime,
        totalMileage,
        totalLopDays,
        totalLeaveDays,
        totalHolidays,
        summary: {
          weeklyHours: Object.keys(weeklyHoursMap).map(week => {
            const weekHours = weeklyHoursMap[week];
            const explicitOT = weeklyExplicitOvertimeMap[week] || 0;
            const calculatedOT = Math.max(0, weekHours - 40);
            return {
              week: parseInt(week),
              hours: weekHours,
              overtime: Math.max(calculatedOT, explicitOT)
            };
          })
        }
      }
    });

  } catch (error) {
    console.error("Error generating timesheet:", error);
    res.status(500).json({ success: false, message: "Failed to generate timesheet" });
  } finally {
    await session.close();
  }
});

/** 
 * 2. POST /api/timesheet/exception
 * Add/Edit an exception for a specific day.
 */
router.post("/exception", async (req, res) => {
  const { userId, date, hours, reason, type, overtimeHours, mileage } = req.body;

  if (!userId || !date) {
    return res.status(400).json({ success: false, message: "Missing userId or date" });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    const empRes = await session.run(`MATCH (pd:PersonalDetails {userId: $userId}) RETURN pd.employeeNumber AS empNum`, { userId });
    let employeeNumber = userId;
    if (empRes.records.length > 0) {
       employeeNumber = empRes.records[0].get("empNum") || userId;
    }
    
    const monthStr = date.substring(0, 7);
    const id = `timeexc_${employeeNumber}_${date}`;
    const updatedAt = new Date().toISOString();
    
    // Ensure TimesheetRecord exists for the month
    await session.run(`
      MERGE (tr:TimesheetRecord {userId: $userId, monthStr: $monthStr})
    `, { userId, monthStr });

    // Fetch existing exceptions data
    const trRes = await session.run(`
      MATCH (tr:TimesheetRecord {userId: $userId, monthStr: $monthStr})
      RETURN tr.exceptionsData AS exceptionsData
    `, { userId, monthStr });

    let exceptionsObj = {};
    if (trRes.records.length > 0) {
      const dataStr = trRes.records[0].get('exceptionsData');
      if (dataStr) {
        try {
          exceptionsObj = JSON.parse(dataStr);
        } catch (e) {}
      }
    }

    // Add or update exception for this date
    exceptionsObj[date] = {
      hours: parseFloat(hours) || 0,
      reason: reason || '',
      type: type || '',
      overtimeHours: parseFloat(overtimeHours) || 0,
      mileage: parseFloat(mileage) || 0,
      id,
      updatedAt
    };

    const newExceptionsData = JSON.stringify(exceptionsObj);

    // Save updated exceptions back to TimesheetRecord
    await session.run(`
      MATCH (tr:TimesheetRecord {userId: $userId, monthStr: $monthStr})
      SET tr.exceptionsData = $newExceptionsData
    `, { userId, monthStr, newExceptionsData });

    res.json({ success: true, message: "Exception saved successfully" });
  } catch (error) {
    console.error("Error saving exception:", error);
    res.status(500).json({ success: false, message: "Failed to save exception" });
  } finally {
    await session.close();
  }
});

/** 
 * 2.1 DELETE /api/timesheet/exception
 * Delete an exception for a specific day.
 */
router.delete("/exception", async (req, res) => {
  const { userId, date } = req.body;

  if (!userId || !date) {
    return res.status(400).json({ success: false, message: "Missing userId or date" });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    const monthStr = date.substring(0, 7);
    
    const trRes = await session.run(`
      MATCH (tr:TimesheetRecord {userId: $userId, monthStr: $monthStr})
      RETURN tr.exceptionsData AS exceptionsData
    `, { userId, monthStr });

    let exceptionsObj = {};
    if (trRes.records.length > 0) {
      const dataStr = trRes.records[0].get('exceptionsData');
      if (dataStr) {
        try {
          exceptionsObj = JSON.parse(dataStr);
        } catch (e) {}
      }
    }

    if (exceptionsObj[date]) {
      delete exceptionsObj[date];
      const newExceptionsData = JSON.stringify(exceptionsObj);

      await session.run(`
        MATCH (tr:TimesheetRecord {userId: $userId, monthStr: $monthStr})
        SET tr.exceptionsData = $newExceptionsData
      `, { userId, monthStr, newExceptionsData });
    }

    res.json({ success: true, message: "Exception deleted successfully" });
  } catch (error) {
    console.error("Error deleting exception:", error);
    res.status(500).json({ success: false, message: "Failed to delete exception" });
  } finally {
    await session.close();
  }
});

/** 
 * 3. POST /api/timesheet/status
 * Approve or Lock the entire month's timesheet. Also saves the snapshot of totals.
 */
router.post("/status", async (req, res) => {
  const { userId, monthStr, status, approvedBy, totals } = req.body;
  if (!userId || !monthStr || !status) {
    return res.status(400).json({ success: false, message: "Missing fields" });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    const empRes = await session.run(`MATCH (pd:PersonalDetails {userId: $userId}) RETURN pd.employeeNumber AS empNum`, { userId });
    let employeeNumber = userId;
    if (empRes.records.length > 0) {
       employeeNumber = empRes.records[0].get("empNum") || userId;
    }

    // Using monthStr ensures unique ID per month
    const id = `timesherec_${employeeNumber}_${monthStr}`;
    const updatedAt = new Date().toISOString();
    await session.run(`
      MERGE (tr:TimesheetRecord {userId: $userId, monthStr: $monthStr})
      SET tr.id = coalesce(tr.id, $id),
          tr.status = $status,
          tr.approvedBy = $approvedBy,
          tr.totalWorkingHours = $totalWorkingHours,
          tr.totalOvertimeHours = $totalOvertimeHours,
          tr.totalLopDays = $totalLopDays,
          tr.updatedAt = $updatedAt
    `, {
      userId, monthStr, status, approvedBy: approvedBy || "System", id,
      totalWorkingHours: totals?.totalWorkingHours || 0,
      totalOvertimeHours: totals?.totalOvertimeHours || 0,
      totalLopDays: totals?.totalLopDays || 0,
      updatedAt
    });

    res.json({ success: true, message: `Timesheet ${status} successfully` });
  } catch (error) {
    console.error("Error updating timesheet status:", error);
    res.status(500).json({ success: false, message: "Failed to update timesheet status" });
  } finally {
    await session.close();
  }
});

/** 
 * 4. GET /api/timesheet/team/:supervisorId?month=YYYY-MM
 * Supervisor view of team members' timesheets summary
 */
router.get("/team/:supervisorId", async (req, res) => {
  const { supervisorId } = req.params;
  const monthParam = req.query.month;
  if (!monthParam) return res.status(400).json({ success: false, message: "month required" });

  const driver = getDriver();
  const session = driver.session();

  try {
    // Find all users the supervisor manages
    const result = await session.run(`
      MATCH (s:User {username: $supervisorId})-[:SUPERVISES]->(t:Team)<-[:MEMBER_OF]-(m:User)
      OPTIONAL MATCH (pd:PersonalDetails {userId: m.username})
      OPTIONAL MATCH (tr:TimesheetRecord {userId: m.username, monthStr: $monthStr})
      RETURN m.username AS userId, m.name AS name, pd.employeeNumber AS employeeNumber, tr.status AS status, 
             tr.totalWorkingHours AS hours, tr.totalLopDays AS lop
      ORDER BY m.name
    `, { supervisorId, monthStr: monthParam });

    const team = result.records.map(r => ({
      userId: r.get("userId"),
      name: r.get("name") || r.get("userId"),
      employeeNumber: r.get("employeeNumber") || "",
      status: r.get("status") || "Generated",
      hours: r.get("hours") || 0,
      lop: r.get("lop") || 0
    }));

    res.json({ success: true, data: team });
  } catch (error) {
    console.error("Error fetching team timesheets:", error);
    res.status(500).json({ success: false, message: "Failed to fetch team timesheets" });
  } finally {
    await session.close();
  }
});

/** 
 * 5. GET /api/timesheet/all?month=YYYY-MM
 * Admin view of all timesheets
 */
router.get("/all", async (req, res) => {
  const monthParam = req.query.month;
  if (!monthParam) return res.status(400).json({ success: false, message: "month required" });

  const driver = getDriver();
  const session = driver.session();

  try {
    // Find all employees (users with role 'Employee')
    const result = await session.run(`
      MATCH (u:User {role: 'Employee'})
      OPTIONAL MATCH (pd:PersonalDetails {userId: u.username})
      OPTIONAL MATCH (tr:TimesheetRecord {userId: u.username, monthStr: $monthStr})
      RETURN u.username AS userId, u.name AS name, pd.employeeNumber AS employeeNumber, tr.status AS status, 
             tr.totalWorkingHours AS hours, tr.totalLopDays AS lop
      ORDER BY u.name
    `, { monthStr: monthParam });

    const all = result.records.map(r => ({
      userId: r.get("userId"),
      name: r.get("name") || r.get("userId"),
      employeeNumber: r.get("employeeNumber") || "",
      status: r.get("status") || "Generated",
      hours: r.get("hours") || 0,
      lop: r.get("lop") || 0
    }));

    res.json({ success: true, data: all });
  } catch (error) {
    console.error("Error fetching all timesheets:", error);
    res.status(500).json({ success: false, message: "Failed to fetch timesheets" });
  } finally {
    await session.close();
  }
});

/** 
 * 6. GET /api/timesheet/export?month=YYYY-MM
 * Export Timesheet summary as CSV for admins
 */
router.get("/export", async (req, res) => {
  const monthParam = req.query.month;
  if (!monthParam) return res.status(400).send("month required");

  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (u:User {role: 'Employee'})
      OPTIONAL MATCH (pd:PersonalDetails {userId: u.username})
      OPTIONAL MATCH (tr:TimesheetRecord {userId: u.username, monthStr: $monthStr})
      RETURN u.username AS userId, u.name AS name, pd.employeeNumber AS employeeNumber, tr.status AS status, 
             tr.totalWorkingHours AS hours, tr.totalLopDays AS lop
      ORDER BY u.name
    `, { monthStr: monthParam });

    const all = result.records.map(r => ({
      userId: r.get("userId"),
      name: r.get("name") || r.get("userId"),
      employeeNumber: r.get("employeeNumber") || "",
      status: r.get("status") || "Generated",
      hours: r.get("hours") || 0,
      lop: r.get("lop") || 0
    }));

    let csv = 'Employee ID,Employee Name,Status,Total Working Hours,LOP/Leaves\\n';
    all.forEach(emp => {
      csv += `"${emp.employeeNumber}","${emp.name}","${emp.status}","${emp.hours}","${emp.lop}"\\n`;
    });

    res.header('Content-Type', 'text/csv');
    res.attachment(`Timesheet_Report_${monthParam}.csv`);
    return res.send(csv);
  } catch (error) {
    console.error("Error exporting timesheets:", error);
    res.status(500).send("Failed to export timesheets");
  } finally {
    await session.close();
  }
});

module.exports = router;
