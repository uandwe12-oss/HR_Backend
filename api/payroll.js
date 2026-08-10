const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");
const crypto = require("crypto");
const multer = require("multer");
const { uploadPayslip } = require("../services/googleDrive");

const upload = multer({ storage: multer.memoryStorage() });

// 1. Admin: Create or Update a Payroll Record for a specific month and year
router.post("/admin/upload", upload.single('payslip'), async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const { 
      employeeNumber, employeeName, month, year, baseSalary, 
      houseRentAllowance = 0,
      leaveTravelAllowance = 0,
      fourWheelerMaintenance = 0,
      employerPf = 0,
      professionalTax = 0,
      insurance = 0,
      gratuity = 0,
      telephoneAndInternet = 0,
      professionalDevelopment = 0,
      specialAllowance = 0,
      stipend = 0,
      otherDeductionsList = '[]',
      variablePayQuarterlyAnnual = 0,
      variablePayQuarterlyMonthly = 0,
      variablePayYearlyAnnual = 0,
      variablePayYearlyMonthly = 0,
      joiningBonusAnnual = 0,
      joiningBonusMonthly = 0,
      totalCtcAnnual = 0,
      totalCtcMonthly = 0
    } = req.body;

    if (!employeeNumber || !month || !year || baseSalary === undefined) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    // Upload payslip to Google Drive if provided
    let payslipUrl = null;
    if (req.file) {
      const uploadResult = await uploadPayslip(
        req.file.buffer, 
        req.file.originalname, 
        req.file.mimetype, 
        `${employeeNumber}_${month}_${year}`
      );
      if (uploadResult.success) {
        payslipUrl = uploadResult.viewLink;
      }
    }

    // Aggregate Approved Reimbursements for this user
    const reimbursementsResult = await session.run(`
      MATCH (p:PersonalDetails {employeeNumber: $employeeNumber})-[:HAS_REIMBURSEMENT]->(r:Reimbursement {status: 'APPROVED'})
      RETURN r
    `, { employeeNumber });

    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const monthIndex = monthNames.indexOf(month) + 1;
    const monthStr = `${year}-${String(monthIndex).padStart(2, '0')}`;

    let totalAnnualLeave = 0;
    let totalLopDays = 0;
    let totalLopPercentage = 0;
    let deductionReasons = [];

    // Calculate LOP and Leave based on LeaveRequests
    const leavesResult = await session.run(`
      MATCH (l:LeaveRequest {employeeNumber: $employeeNumber, status: 'Approved'})
      RETURN l
    `, { employeeNumber });

    leavesResult.records.forEach(record => {
      const leave = record.get('l').properties;
      if (!leave.startDate) return;
      const leaveDate = new Date(leave.startDate);
      const leaveMonth = monthNames[leaveDate.getMonth()];
      const leaveYear = leaveDate.getFullYear().toString();

      if (leaveMonth === month && leaveYear === year.toString()) {
        const actualDays = leave.actualUsedDays !== undefined && leave.actualUsedDays !== null ? leave.actualUsedDays : (leave.totalDays || leave.numberOfDays || 0);
        if (leave.isLOP) {
          totalLopDays += (leave.lopDays || actualDays || 0);
          totalLopPercentage += (leave.salaryDeductionPercentage || 0);
          deductionReasons.push(`${leave.lopDays || actualDays || 0} days LOP (${leave.reason || 'Leave'})`);
        } else {
          totalAnnualLeave += (leave.annualLeaveDays || actualDays || 0);
        }
      }
    });

    const parsedBaseSalary = parseFloat(baseSalary);
    const pHouseRentAllowance = parseFloat(houseRentAllowance) || 0;
    const pLeaveTravelAllowance = parseFloat(leaveTravelAllowance) || 0;
    const pFourWheelerMaintenance = parseFloat(fourWheelerMaintenance) || 0;
    const pTelephoneAndInternet = parseFloat(telephoneAndInternet) || 0;
    const pProfessionalDevelopment = parseFloat(professionalDevelopment) || 0;
    const pSpecialAllowance = parseFloat(specialAllowance) || 0;
    const pStipend = parseFloat(stipend) || 0;

    const parsedAllowances = pHouseRentAllowance + pLeaveTravelAllowance + pFourWheelerMaintenance + pTelephoneAndInternet + pProfessionalDevelopment + pSpecialAllowance + pStipend;

    const pEmployerPf = parseFloat(employerPf) || 0;
    const pProfessionalTax = parseFloat(professionalTax) || 0;
    const pInsurance = parseFloat(insurance) || 0;
    const pGratuity = parseFloat(gratuity) || 0;

    let parsedOtherDeductionsList = [];
    try {
      parsedOtherDeductionsList = JSON.parse(otherDeductionsList);
    } catch (e) {
      console.error("Error parsing otherDeductionsList", e);
    }

    const dynamicOtherDeductionsAmount = parsedOtherDeductionsList.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
    const parsedOtherDeductions = pEmployerPf + pProfessionalTax + pInsurance + pGratuity + dynamicOtherDeductionsAmount;

    let totalReimbursements = 0;
    reimbursementsResult.records.forEach(record => {
      const reimbursement = record.get('r').properties;
      if (!reimbursement.actionDate) return;
      const actionDate = new Date(reimbursement.actionDate);
      const actionMonth = monthNames[actionDate.getMonth()];
      const actionYear = actionDate.getFullYear().toString();

      if (actionMonth === month && actionYear === year.toString()) {
        totalReimbursements += (reimbursement.amount || 0);
      }
    });

    const parsedYear = parseInt(year);
    const parsedMonthIndex = monthNames.indexOf(month) + 1; // 1-12
    const totalDaysInMonth = new Date(parsedYear, parsedMonthIndex, 0).getDate();
    
    // Calculate new Daily Salary based LOP
    const dailySalary = parsedBaseSalary / totalDaysInMonth;
    const workedDays = totalDaysInMonth - totalLopDays;
    const calculatedLopAmount = dailySalary * totalLopDays;
    
    const finalSalaryCalculated = parsedBaseSalary + parsedAllowances - parsedOtherDeductions - calculatedLopAmount + totalReimbursements;
    const finalReason = deductionReasons.join(', ');
    const now = new Date().toISOString();

    // Check if payroll record already exists for this month/year
    const checkResult = await session.run(`
      MATCH (p:PayrollRecord {employeeNumber: $employeeNumber, month: $month, year: $year})
      RETURN p
    `, { employeeNumber, month, year });

    let result;
    if (checkResult.records.length > 0) {
      // Update existing record, applying LOP calculations
      result = await session.run(`
        MATCH (p:PayrollRecord {employeeNumber: $employeeNumber, month: $month, year: $year})
        SET p.baseSalary = $baseSalary,
            p.houseRentAllowance = $houseRentAllowance,
            p.leaveTravelAllowance = $leaveTravelAllowance,
            p.fourWheelerMaintenance = $fourWheelerMaintenance,
            p.employerPf = $employerPf,
            p.professionalTax = $professionalTax,
            p.insurance = $insurance,
            p.gratuity = $gratuity,
            p.telephoneAndInternet = $telephoneAndInternet,
            p.professionalDevelopment = $professionalDevelopment,
            p.specialAllowance = $specialAllowance,
            p.stipend = $stipend,
            p.variablePayQuarterlyAnnual = $variablePayQuarterlyAnnual,
            p.variablePayQuarterlyMonthly = $variablePayQuarterlyMonthly,
            p.variablePayYearlyAnnual = $variablePayYearlyAnnual,
            p.variablePayYearlyMonthly = $variablePayYearlyMonthly,
            p.joiningBonusAnnual = $joiningBonusAnnual,
            p.joiningBonusMonthly = $joiningBonusMonthly,
            p.totalCtcAnnual = $totalCtcAnnual,
            p.totalCtcMonthly = $totalCtcMonthly,
            p.otherDeductionsList = $otherDeductionsList,
            p.totalDaysInMonth = $totalDaysInMonth,
            p.dailySalary = $dailySalary,
            p.workedDays = $workedDays,
            p.allowances = $allowances,
            p.reimbursementsAmount = $reimbursementsAmount,
            p.otherDeductions = $otherDeductions,
            p.annualLeaveUsed = $annualLeaveUsed,
            p.lopDays = $lopDays,
            p.lopDeductionPercentage = $lopDeductionPercentage,
            p.lopDeductionAmount = $lopDeductionAmount,
            p.deductionReason = $deductionReason,
            p.finalSalary = $finalSalary,
            p.employeeName = $employeeName,
            p.payslipUrl = coalesce($payslipUrl, p.payslipUrl),
            p.updatedAt = $updatedAt,
            p.needsRecalculation = false,
            p.recalculationReason = null
        RETURN p
      `, { 
        employeeNumber, month, year, employeeName: employeeName || '', 
        baseSalary: parsedBaseSalary, 
        houseRentAllowance: pHouseRentAllowance,
        leaveTravelAllowance: pLeaveTravelAllowance,
        fourWheelerMaintenance: pFourWheelerMaintenance,
        employerPf: pEmployerPf,
        professionalTax: pProfessionalTax,
        insurance: pInsurance,
        gratuity: pGratuity,
        telephoneAndInternet: pTelephoneAndInternet,
        professionalDevelopment: pProfessionalDevelopment,
        specialAllowance: pSpecialAllowance,
        stipend: pStipend,
        variablePayQuarterlyAnnual: parseFloat(variablePayQuarterlyAnnual) || 0,
        variablePayQuarterlyMonthly: parseFloat(variablePayQuarterlyMonthly) || 0,
        variablePayYearlyAnnual: parseFloat(variablePayYearlyAnnual) || 0,
        variablePayYearlyMonthly: parseFloat(variablePayYearlyMonthly) || 0,
        joiningBonusAnnual: parseFloat(joiningBonusAnnual) || 0,
        joiningBonusMonthly: parseFloat(joiningBonusMonthly) || 0,
        totalCtcAnnual: parseFloat(totalCtcAnnual) || 0,
        totalCtcMonthly: parseFloat(totalCtcMonthly) || 0,
        otherDeductionsList: JSON.stringify(parsedOtherDeductionsList),
        totalDaysInMonth,
        dailySalary,
        workedDays,
        allowances: parsedAllowances, 
        reimbursementsAmount: totalReimbursements,
        otherDeductions: parsedOtherDeductions,
        annualLeaveUsed: totalAnnualLeave,
        lopDays: totalLopDays,
        lopDeductionPercentage: 0, // Ignored logic
        lopDeductionAmount: calculatedLopAmount,
        deductionReason: finalReason,
        finalSalary: finalSalaryCalculated,
        payslipUrl: payslipUrl,
        updatedAt: now
      });
    } else {
      // Create new record
      const id = crypto.randomUUID();
      result = await session.run(`
        CREATE (p:PayrollRecord {
          id: $id,
          employeeNumber: $employeeNumber,
          employeeName: $employeeName,
          month: $month,
          year: $year,
          baseSalary: $baseSalary,
          houseRentAllowance: $houseRentAllowance,
          leaveTravelAllowance: $leaveTravelAllowance,
          fourWheelerMaintenance: $fourWheelerMaintenance,
          employerPf: $employerPf,
          professionalTax: $professionalTax,
          insurance: $insurance,
          gratuity: $gratuity,
          telephoneAndInternet: $telephoneAndInternet,
          professionalDevelopment: $professionalDevelopment,
          specialAllowance: $specialAllowance,
          stipend: $stipend,
          variablePayQuarterlyAnnual: $variablePayQuarterlyAnnual,
          variablePayQuarterlyMonthly: $variablePayQuarterlyMonthly,
          variablePayYearlyAnnual: $variablePayYearlyAnnual,
          variablePayYearlyMonthly: $variablePayYearlyMonthly,
          joiningBonusAnnual: $joiningBonusAnnual,
          joiningBonusMonthly: $joiningBonusMonthly,
          totalCtcAnnual: $totalCtcAnnual,
          totalCtcMonthly: $totalCtcMonthly,
          otherDeductionsList: $otherDeductionsList,
          totalDaysInMonth: $totalDaysInMonth,
          dailySalary: $dailySalary,
          workedDays: $workedDays,
          allowances: $allowances,
          reimbursementsAmount: $reimbursementsAmount,
          otherDeductions: $otherDeductions,
          annualLeaveUsed: $annualLeaveUsed,
          lopDays: $lopDays,
          lopDeductionPercentage: $lopDeductionPercentage,
          lopDeductionAmount: $lopDeductionAmount,
          finalSalary: $finalSalary,
          deductionReason: $deductionReason,
          payslipUrl: $payslipUrl,
          createdAt: $createdAt,
          updatedAt: $createdAt,
          needsRecalculation: false
        })
        RETURN p
      `, { 
        id, employeeNumber, employeeName: employeeName || '', month, year, 
        baseSalary: parsedBaseSalary, 
        houseRentAllowance: pHouseRentAllowance,
        leaveTravelAllowance: pLeaveTravelAllowance,
        fourWheelerMaintenance: pFourWheelerMaintenance,
        employerPf: pEmployerPf,
        professionalTax: pProfessionalTax,
        insurance: pInsurance,
        gratuity: pGratuity,
        telephoneAndInternet: pTelephoneAndInternet,
        professionalDevelopment: pProfessionalDevelopment,
        specialAllowance: pSpecialAllowance,
        stipend: pStipend,
        variablePayQuarterlyAnnual: parseFloat(variablePayQuarterlyAnnual) || 0,
        variablePayQuarterlyMonthly: parseFloat(variablePayQuarterlyMonthly) || 0,
        variablePayYearlyAnnual: parseFloat(variablePayYearlyAnnual) || 0,
        variablePayYearlyMonthly: parseFloat(variablePayYearlyMonthly) || 0,
        joiningBonusAnnual: parseFloat(joiningBonusAnnual) || 0,
        joiningBonusMonthly: parseFloat(joiningBonusMonthly) || 0,
        totalCtcAnnual: parseFloat(totalCtcAnnual) || 0,
        totalCtcMonthly: parseFloat(totalCtcMonthly) || 0,
        otherDeductionsList: JSON.stringify(parsedOtherDeductionsList),
        totalDaysInMonth,
        dailySalary,
        workedDays,
        allowances: parsedAllowances, 
        reimbursementsAmount: totalReimbursements,
        otherDeductions: parsedOtherDeductions,
        annualLeaveUsed: totalAnnualLeave,
        lopDays: totalLopDays,
        lopDeductionPercentage: 0, // Ignored logic
        lopDeductionAmount: calculatedLopAmount,
        deductionReason: finalReason,
        finalSalary: finalSalaryCalculated, 
        payslipUrl: payslipUrl || '', createdAt: now 
      });
    }
    res.json({
      success: true,
      message: "Payroll record saved successfully",
      data: result.records[0].get('p').properties
    });

  } catch (error) {
    console.error("Error saving payroll record:", error);
    res.status(500).json({ success: false, message: "Failed to save payroll record" });
  } finally {
    await session.close();
  }
});

// 2. Admin: Get all payroll records
router.get("/admin/all", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const { month, year } = req.query;
    let query = `MATCH (p:PayrollRecord) RETURN p ORDER BY p.createdAt DESC`;
    let params = {};

    if (month && year) {
      if (month === 'All') {
        query = `MATCH (p:PayrollRecord {year: $year}) RETURN p ORDER BY p.createdAt DESC`;
        params = { year };
      } else {
        query = `MATCH (p:PayrollRecord {month: $month, year: $year}) RETURN p ORDER BY p.createdAt DESC`;
        params = { month, year };
      }
    } else if (year) {
      query = `MATCH (p:PayrollRecord {year: $year}) RETURN p ORDER BY p.createdAt DESC`;
      params = { year };
    }

    const result = await session.run(query, params);
    const records = result.records.map(record => record.get('p').properties);
    
    res.json({ success: true, data: records });
  } catch (error) {
    console.error("Error fetching all payroll records:", error);
    res.status(500).json({ success: false, message: "Failed to fetch payroll records" });
  } finally {
    await session.close();
  }
});

// 3. Employee/User: Get user's payroll history
router.get("/user/:identifier", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { identifier } = req.params;

  try {
    const result = await session.run(`
      OPTIONAL MATCH (pd:PersonalDetails {userId: $identifier})
      WITH coalesce(pd.employeeNumber, $identifier) AS targetEmpNum
      MATCH (p:PayrollRecord {employeeNumber: targetEmpNum})
      RETURN p
      ORDER BY p.year DESC, p.month DESC
    `, { identifier });

    const records = result.records.map(record => record.get('p').properties);

    res.json({
      success: true,
      data: records
    });
  } catch (error) {
    console.error("Error fetching user payroll:", error);
    res.status(500).json({ success: false, message: "Failed to fetch user payroll" });
  } finally {
    await session.close();
  }
});

// Temporary Migration Endpoint
router.get("/admin/migrate", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const result = await session.run(`MATCH (p:PayrollRecord) RETURN p`);
    const records = result.records.map(record => record.get('p').properties);
    
    let updatedCount = 0;
    for (const record of records) {
      const year = parseInt(record.year);
      const monthIndex = monthNames.indexOf(record.month) + 1;
      const totalDaysInMonth = new Date(year, monthIndex, 0).getDate();
      
      const baseSalary = record.baseSalary || 0;
      const lopDays = record.lopDays || 0;
      const allowances = record.allowances || 0;
      const reimbursements = record.reimbursementsAmount || 0;
      const otherDeductions = record.otherDeductions || 0;
      
      const dailySalary = baseSalary / totalDaysInMonth;
      const workedDays = totalDaysInMonth - lopDays;
      const newLopDeduction = dailySalary * lopDays;
      const newFinalSalary = baseSalary + allowances + reimbursements - otherDeductions - newLopDeduction;
      
      await session.run(`
        MATCH (p:PayrollRecord {id: $id})
        SET p.totalDaysInMonth = $totalDaysInMonth,
            p.dailySalary = $dailySalary,
            p.workedDays = $workedDays,
            p.lopDeductionAmount = $newLopDeduction,
            p.finalSalary = $newFinalSalary
      `, {
        id: record.id, totalDaysInMonth, dailySalary, workedDays, newLopDeduction, newFinalSalary
      });
      updatedCount++;
    }
    res.json({ success: true, message: `Successfully migrated ${updatedCount} records.` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

module.exports = router;
