const express = require('express');
const router = express.Router();
const getDriver = require('../lib/neo4j');
const { sendSalaryAdvanceEmail, sendEmail } = require('../services/emailService');

// ==================== HELPER FUNCTIONS ====================

// Get amount limit based on nationality
function getAmountLimit(nationality) {
  const upper = (nationality || '').toUpperCase();
  switch (upper) {
    case 'INDIA': return { max: 100000, min: 1000, currency: 'INR', symbol: '₹', employeeType: 'Indian' };
    case 'USA': return { max: 1000, min: 100, currency: 'USD', symbol: '$', employeeType: 'US' };
    case 'CHINA': return { max: 7000, min: 500, currency: 'CNY', symbol: '¥', employeeType: 'Chinese' };
    default: return { max: 100000, min: 1000, currency: 'INR', symbol: '₹', employeeType: 'Indian' };
  }
}

// Get employee details directly from PersonalDetails
async function getEmployeeDetailsFromPersonalDetails(session, employeeId) {
  const result = await session.run(
    `MATCH (p:PersonalDetails {userId: $employeeId})
     RETURN p.employeeNumber as employeeNumber, p.fullName as employeeName, p.nationality as nationality, p.emailId as email`,
    { employeeId }
  );
  if (result.records.length === 0) {
    return null;
  }
  const record = result.records[0];
  const employeeNumber = record.get('employeeNumber');
  if (!employeeNumber) return null; // employeeNumber is mandatory

  return {
    employeeNumber,
    employeeName: record.get('employeeName') || employeeId,
    nationality: record.get('nationality') || 'INDIA',
    email: record.get('email')
  };
}

// Ensure SalaryAdvanceAccount exists and get it
async function getOrCreateSalaryAdvanceAccount(session, employee) {
  const limit = getAmountLimit(employee.nationality);

  const result = await session.run(
    `MATCH (a:SalaryAdvanceAccount {employeeNumber: $employeeNumber})
     RETURN a`,
    { employeeNumber: employee.employeeNumber }
  );

  if (result.records.length > 0) {
    const node = result.records[0].get('a');
    return {
      salaryAdvanceUsed: node.properties.salaryAdvanceUsed !== undefined ? Number(node.properties.salaryAdvanceUsed) : 0,
      salaryAdvanceRemaining: node.properties.salaryAdvanceRemaining !== undefined ? Number(node.properties.salaryAdvanceRemaining) : limit.max,
      salaryAdvanceEligible: node.properties.salaryAdvanceEligible !== undefined ? node.properties.salaryAdvanceEligible : true,
      isRepaid: node.properties.isRepaid || false,
      repaidDate: node.properties.repaidDate || null,
      repaidBy: node.properties.repaidBy || null,
      repaymentRemarks: node.properties.repaymentRemarks || null
    };
  } else {
    // Create new account
    await session.run(
      `CREATE (a:SalaryAdvanceAccount {
         employeeNumber: $employeeNumber,
         employeeName: $employeeName,
         salaryAdvanceUsed: 0,
         salaryAdvanceRemaining: $salaryAdvanceRemaining,
         salaryAdvanceEligible: true,
         isRepaid: false,
         createdAt: datetime(),
         updatedAt: datetime()
       })`,
      {
        employeeNumber: employee.employeeNumber,
        employeeName: employee.employeeName,
        salaryAdvanceRemaining: limit.max
      }
    );
    return { salaryAdvanceUsed: 0, salaryAdvanceRemaining: limit.max, salaryAdvanceEligible: true, isRepaid: false };
  }
}

// ==================== API ENDPOINTS ====================

// POST - Submit salary advance request
router.post('/request', async (req, res) => {

  const { employeeId, amount, reason } = req.body;

  if (!employeeId || !amount) {
    return res.status(400).json({ success: false, message: 'Employee ID and amount are required' });
  }

  const trimmedReason = (reason || '').trim();
  if (!trimmedReason) {
    return res.status(400).json({ success: false, message: 'Reason is required for salary advance request.' });
  }
  if (trimmedReason.length > 500) {
    return res.status(400).json({ success: false, message: 'Reason must be 500 characters or less' });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    const employee = await getEmployeeDetailsFromPersonalDetails(session, employeeId);
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee Personal Details not found or missing employeeNumber.' });
    }

    const account = await getOrCreateSalaryAdvanceAccount(session, employee);

    if (!account.salaryAdvanceEligible) {
      return res.status(400).json({ success: false, message: 'You are currently not eligible to submit a salary advance request. Please contact HR/Admin for further assistance.' });
    }

    if (parseFloat(amount) > account.salaryAdvanceRemaining) {
      return res.status(400).json({ success: false, message: 'Requested amount exceeds your available salary advance balance.' });
    }

    const limit = getAmountLimit(employee.nationality);

    // Check if pending exists
    const pendingCheck = await session.run(
      `MATCH (r:SalaryAdvanceRequest {employeeNumber: $employeeNumber, status: 'PENDING'})
       RETURN r.requestId AS requestId`,
      { employeeNumber: employee.employeeNumber }
    );
    if (pendingCheck.records.length > 0) {
      return res.status(400).json({ success: false, message: 'You already have a pending request. Please wait for admin approval.' });
    }

    // Generate sequential request ID
    let requestId;
    let isUnique = false;
    let counter = 1;

    while (!isUnique) {
      const maxSeqResult = await session.run(
        `MATCH (r:SalaryAdvanceRequest)
         WHERE r.requestId =~ 'SAL_.*'
         RETURN max(toInteger(split(r.requestId, '_')[1])) AS maxSeq`
      );

      let maxSeq = 0;
      if (maxSeqResult.records.length > 0) {
        const maxSeqValue = maxSeqResult.records[0].get('maxSeq');
        if (maxSeqValue !== null) {
          maxSeq = Number(maxSeqValue) || 0;
        }
      }
      counter = maxSeq + 1;
      requestId = `SAL_${counter}`;

      const existingCheck = await session.run(
        `MATCH (r:SalaryAdvanceRequest {requestId: $requestId}) RETURN r.requestId AS requestId`,
        { requestId }
      );
      if (existingCheck.records.length === 0) isUnique = true;
      else counter++;
    }

    const appliedAt = new Date().toISOString();

    // Create Request (NO employeeId)
    await session.run(
      `CREATE (r:SalaryAdvanceRequest {
        requestId: $requestId,
        employeeNumber: $employeeNumber,
        employeeName: $employeeName,
        amount: $amount,
        currency: $currency,
        reason: $reason,
        status: 'PENDING',
        appliedAt: $appliedAt
      })`,
      {
        requestId,
        employeeNumber: employee.employeeNumber,
        employeeName: employee.employeeName,
        amount: parseFloat(amount),
        currency: limit.currency,
        reason: trimmedReason,
        appliedAt
      }
    );


    try {
      await sendSalaryAdvanceEmail({
        employeeName: employee.employeeName,
        employeeNumber: employee.employeeNumber,
        requestedAmount: amount,
        reason: trimmedReason,
        submissionDate: new Date().toLocaleString()
      });
    } catch (emailErr) {
      console.log('⚠️ Email not sent:', emailErr.message);
    }

    res.json({ success: true, message: 'Request submitted successfully! Admin will review it.', requestId });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// GET - Employee analytics (Uses SalaryAdvanceAccount)
router.get('/employee-analytics/:employeeId', async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const { employeeId } = req.params;
    const employee = await getEmployeeDetailsFromPersonalDetails(session, employeeId);

    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    const account = await getOrCreateSalaryAdvanceAccount(session, employee);

    res.json({
      success: true,
      data: {
        employeeNumber: employee.employeeNumber,
        employeeName: employee.employeeName,
        nationality: employee.nationality,
        email: employee.email,
        salaryAdvanceUsed: account.salaryAdvanceUsed,
        salaryAdvanceRemaining: account.salaryAdvanceRemaining,
        salaryAdvanceEligible: account.salaryAdvanceEligible,
        isRepaid: account.isRepaid,
        repaidDate: account.repaidDate || null,
        repaidBy: account.repaidBy || null,
        repaymentRemarks: account.repaymentRemarks || null
      }
    });
  } catch (error) {
    console.error('Error fetching employee analytics:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    await session.close();
  }
});

// GET - Fetch all requests with filters (for Admin)
router.get('/requests', async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const { search, status, dateFrom, dateTo } = req.query;

    let cypherQuery = `MATCH (r:SalaryAdvanceRequest) WITH r`;
    const params = {};
    const whereClauses = [];

    if (search && search.trim()) {
      const searchTerm = search.trim();
      const amountValue = parseFloat(searchTerm);
      if (!isNaN(amountValue) && isFinite(amountValue) && /^\\d+(\\.\\d+)?$/.test(searchTerm)) {
        whereClauses.push(`(toLower(r.employeeName) CONTAINS toLower($searchTerm) OR toLower(r.employeeNumber) CONTAINS toLower($searchTerm) OR abs(r.amount - $amountValue) < 0.01)`);
        params.amountValue = amountValue;
        params.searchTerm = searchTerm;
      } else {
        whereClauses.push(`(toLower(r.employeeName) CONTAINS toLower($searchTerm) OR toLower(r.employeeNumber) CONTAINS toLower($searchTerm))`);
        params.searchTerm = searchTerm;
      }
    }

    if (status && status !== 'ALL') {
      whereClauses.push(`r.status = $status`);
      params.status = status;
    }
    if (dateFrom) {
      whereClauses.push(`r.appliedAt >= $dateFrom`);
      params.dateFrom = dateFrom;
    }
    if (dateTo) {
      whereClauses.push(`r.appliedAt <= $dateTo`);
      params.dateTo = dateTo;
    }

    if (whereClauses.length > 0) cypherQuery += ` WHERE ` + whereClauses.join(' AND ');

    cypherQuery += `
      RETURN 
        r.requestId AS requestId,
        r.employeeNumber AS employeeNumber,
        r.employeeName AS employeeName,
        r.amount AS amount,
        r.currency AS currency,
        r.reason AS reason,
        r.status AS status,
        r.appliedAt AS appliedAt,
        r.adminRemarks AS adminRemarks,
        r.reviewedBy AS reviewedBy,
        r.reviewedAt AS reviewedAt
      ORDER BY r.appliedAt DESC
    `;

    const result = await session.run(cypherQuery, params);

    const requests = result.records.map(record => {
      let amount = record.get('amount');
      if (amount && typeof amount.toNumber === 'function') amount = amount.toNumber();
      else if (amount && typeof amount === 'object') amount = Number(amount);

      return {
        requestId: record.get('requestId'),
        employeeNumber: record.get('employeeNumber'),
        employeeName: record.get('employeeName'),
        amount: amount || 0,
        currency: record.get('currency'),
        reason: record.get('reason') || 'Not provided',
        status: record.get('status'),
        appliedAt: record.get('appliedAt'),
        adminRemarks: record.get('adminRemarks') || null,
        reviewedBy: record.get('reviewedBy') || null,
        reviewedAt: record.get('reviewedAt') || null
      };
    });

    res.json({ success: true, data: requests });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// GET - Check if employee has pending request
router.get('/pending/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  const driver = getDriver();
  const session = driver.session();

  try {
    const employee = await getEmployeeDetailsFromPersonalDetails(session, employeeId);
    if (!employee) return res.json({ success: true, hasPending: false });

    const result = await session.run(
      `MATCH (r:SalaryAdvanceRequest {employeeNumber: $employeeNumber, status: 'PENDING'})
       RETURN r.requestId AS requestId`,
      { employeeNumber: employee.employeeNumber }
    );

    res.json({ success: true, hasPending: result.records.length > 0 });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// GET - Fetch all requests for specific employee
router.get('/employee-requests/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  const driver = getDriver();
  const session = driver.session();

  try {
    const employee = await getEmployeeDetailsFromPersonalDetails(session, employeeId);
    if (!employee) return res.json({ success: true, data: [] });

    const result = await session.run(
      `MATCH (r:SalaryAdvanceRequest {employeeNumber: $employeeNumber})
       RETURN 
         r.requestId AS requestId,
         r.amount AS amount,
         r.currency AS currency,
         r.reason AS reason,
         r.status AS status,
         r.appliedAt AS appliedAt,
         r.adminRemarks AS adminRemarks,
         r.reviewedBy AS reviewedBy
       ORDER BY r.appliedAt DESC`,
      { employeeNumber: employee.employeeNumber }
    );

    const requests = result.records.map(record => ({
      requestId: record.get('requestId'),
      amount: record.get('amount'),
      currency: record.get('currency'),
      reason: record.get('reason') || 'Not provided',
      status: record.get('status'),
      appliedAt: record.get('appliedAt'),
      adminRemarks: record.get('adminRemarks') || null,
      reviewedBy: record.get('reviewedBy') || null
    }));

    res.json({ success: true, data: requests });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// PUT - Approve request
router.put('/request/:requestId/approve', async (req, res) => {
  const { requestId } = req.params;
  const { adminRemarks, reviewedBy } = req.body;
  const driver = getDriver();
  const session = driver.session();

  try {
    // Get request details
    const getResult = await session.run(
      `MATCH (r:SalaryAdvanceRequest {requestId: $requestId})
       RETURN r.employeeNumber AS employeeNumber, 
              r.employeeName AS employeeName,
              r.amount AS amount,
              r.currency AS currency`,
      { requestId }
    );

    if (getResult.records.length === 0) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    const record = getResult.records[0];
    const employeeNumber = record.get('employeeNumber');
    const employeeName = record.get('employeeName');
    const currency = record.get('currency');
    let amount = record.get('amount');
    if (typeof amount.toNumber === 'function') amount = amount.toNumber();
    else amount = Number(amount);

    // Get employee nationality to check limit
    const pResult = await session.run(
      `MATCH (p:PersonalDetails {employeeNumber: $employeeNumber}) RETURN p.nationality as nationality, p.emailId as emailId`,
      { employeeNumber }
    );
    const nationality = pResult.records.length > 0 ? pResult.records[0].get('nationality') : 'INDIA';
    const employeeEmail = pResult.records.length > 0 ? pResult.records[0].get('emailId') : null;
    const limit = getAmountLimit(nationality);

    // Update SalaryAdvanceAccount
    const accountResult = await session.run(
      `MATCH (a:SalaryAdvanceAccount {employeeNumber: $employeeNumber})
       RETURN a.salaryAdvanceUsed as used, a.salaryAdvanceRemaining as remaining`,
      { employeeNumber }
    );

    let currentUsed = 0;
    if (accountResult.records.length > 0) {
      currentUsed = Number(accountResult.records[0].get('used')) || 0;
    } else {
      await session.run(
        `CREATE (a:SalaryAdvanceAccount {
           employeeNumber: $employeeNumber,
           employeeName: $employeeName,
           salaryAdvanceUsed: 0,
           salaryAdvanceRemaining: $remaining,
           salaryAdvanceEligible: true,
           isRepaid: false,
           createdAt: datetime(),
           updatedAt: datetime()
         })`,
        { employeeNumber, employeeName, remaining: limit.max }
      );
    }

    const newUsed = currentUsed + amount;
    const newRemaining = limit.max - newUsed;
    const isEligible = newRemaining > 0;

    await session.run(
      `MATCH (a:SalaryAdvanceAccount {employeeNumber: $employeeNumber})
       SET a.salaryAdvanceUsed = $newUsed,
           a.salaryAdvanceRemaining = $newRemaining,
           a.salaryAdvanceEligible = $isEligible,
           a.updatedAt = datetime()`,
      { employeeNumber, newUsed, newRemaining, isEligible }
    );

    // Update request status
    await session.run(
      `MATCH (r:SalaryAdvanceRequest {requestId: $requestId})
       SET r.status = 'APPROVED', 
           r.approvedAt = datetime(),
           r.adminRemarks = $adminRemarks,
           r.reviewedBy = $reviewedBy`,
      { requestId, adminRemarks: adminRemarks || 'No remarks', reviewedBy: reviewedBy || 'Admin' }
    );


    try {
      if (employeeEmail) {
        await sendEmail({
          to: employeeEmail,
          subject: '✅ Salary Advance Request Approved',
          html: `<h2>Request Approved</h2><p>Dear ${employeeName}, your salary advance request of ${currency} ${amount.toLocaleString()} has been APPROVED.</p><p>The amount will be credited within 5-7 business days.</p>`
        });
      }

      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        await sendEmail({
          to: adminEmail,
          subject: `✅ Salary Advance Approved - ${employeeName}`,
          html: `<h2>Salary Advance Approved</h2><p>${employeeName}'s request of ${currency} ${amount.toLocaleString()} has been approved.</p>`
        });
      }
    } catch (emailErr) {
      console.log('⚠️ Email not sent:', emailErr.message);
    }

    res.json({ success: true, message: 'Request approved successfully' });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// PUT - Reject request
router.put('/request/:requestId/reject', async (req, res) => {
  const { requestId } = req.params;
  const { adminRemarks, reviewedBy } = req.body;
  const driver = getDriver();
  const session = driver.session();

  try {
    const getResult = await session.run(
      `MATCH (r:SalaryAdvanceRequest {requestId: $requestId}) 
       RETURN r.employeeName AS employeeName, r.currency AS currency, r.amount AS amount, r.employeeNumber AS employeeNumber`,
      { requestId }
    );

    if (getResult.records.length === 0) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    const record = getResult.records[0];
    const employeeName = record.get('employeeName');
    const currency = record.get('currency');
    const employeeNumber = record.get('employeeNumber');
    let amount = record.get('amount');
    if (typeof amount.toNumber === 'function') amount = amount.toNumber();
    else amount = Number(amount);

    await session.run(
      `MATCH (r:SalaryAdvanceRequest {requestId: $requestId})
       SET r.status = 'REJECTED', 
           r.updatedAt = datetime(),
           r.adminRemarks = $adminRemarks,
           r.reviewedBy = $reviewedBy`,
      { requestId, adminRemarks: adminRemarks || 'No remarks', reviewedBy: reviewedBy || 'Admin' }
    );

    try {
      const pResult = await session.run(`MATCH (p:PersonalDetails {employeeNumber: $employeeNumber}) RETURN p.emailId as emailId`, { employeeNumber });
      const employeeEmail = pResult.records.length > 0 ? pResult.records[0].get('emailId') : null;
      if (employeeEmail) {
        await sendEmail({
          to: employeeEmail,
          subject: '❌ Salary Advance Request Rejected',
          html: `<h2>Request Rejected</h2><p>Dear ${employeeName}, your salary advance request of ${currency} ${amount.toLocaleString()} has been REJECTED.</p><p>Please contact HR for more information.</p>`
        });
      }
    } catch (emailErr) {
      console.log('⚠️ Email not sent:', emailErr.message);
    }

    res.json({ success: true, message: 'Request rejected' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// POST - Mark as Repaid
router.post('/admin/repay/:employeeNumber', async (req, res) => {
  const { employeeNumber } = req.params;
  const { remarks, adminName } = req.body;
  const driver = getDriver();
  const session = driver.session();

  try {
    const pResult = await session.run(
      `MATCH (p:PersonalDetails {employeeNumber: $employeeNumber}) RETURN p.nationality as nationality`, { employeeNumber }
    );
    const nationality = pResult.records.length > 0 ? pResult.records[0].get('nationality') : 'INDIA';
    const limit = getAmountLimit(nationality);

    const result = await session.run(
      `MATCH (a:SalaryAdvanceAccount {employeeNumber: $employeeNumber})
       SET a.salaryAdvanceUsed = 0,
           a.salaryAdvanceRemaining = $limitMax,
           a.salaryAdvanceEligible = true,
           a.isRepaid = true,
           a.repaidDate = datetime(),
           a.repaidBy = $adminName,
           a.repaymentRemarks = $remarks,
           a.updatedAt = datetime()
       RETURN a`,
      { employeeNumber, adminName: adminName || 'Admin', remarks: remarks || 'Repayment completed', limitMax: limit.max }
    );

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: 'SalaryAdvanceAccount not found for this employee.' });
    }

    res.json({ success: true, message: 'Salary advance repayment recorded successfully.' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

module.exports = router;