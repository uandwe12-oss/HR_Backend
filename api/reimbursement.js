const express = require('express');
const router = express.Router();
const multer = require('multer');
const getDriver = require('../lib/neo4j');
const googleDrive = require('../services/googleDrive');
const { sendEmail } = require('../services/emailService');

const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPG, PNG, and PDF are allowed.'));
    }
  },
});

// CREATE Reimbursement Request (Employee)
router.post('/', upload.single('document'), async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const { employeeNumber, employeeName, reimbursementType, amount, description, notes } = req.body;
    const file = req.file;

    if (!employeeNumber || !employeeName || !reimbursementType || !amount || !file) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (isNaN(amount)) {
      return res.status(400).json({ success: false, message: 'Amount must be a numeric value' });
    }

    // Verify employee exists in PersonalDetails
    const employeeCheck = await session.run(
      `MATCH (p:PersonalDetails {employeeNumber: $employeeNumber}) RETURN p`,
      { employeeNumber }
    );

    if (employeeCheck.records.length === 0) {
      return res.status(404).json({ success: false, message: 'Employee not found in Personal Details' });
    }

    // Upload to Google Drive
    const uploadResult = await googleDrive.uploadReimbursementDocument(
      file.buffer,
      file.originalname,
      file.mimetype,
      employeeNumber
    );

    if (!uploadResult.success) {
      return res.status(500).json({ success: false, message: 'Document upload failed', error: uploadResult.error });
    }

    const documentUrl = uploadResult.viewLink;
    const currentTime = new Date().toISOString();

    // Create Neo4j Node and Relationship
    const result = await session.run(
      `MATCH (p:PersonalDetails {employeeNumber: $employeeNumber})
       CREATE (r:Reimbursement {
         id: randomUUID(),
         employeeNumber: $employeeNumber,
         employeeName: $employeeName,
         reimbursementType: $reimbursementType,
         amount: toFloat($amount),
         description: $description,
         notes: $notes,
         documentUrl: $documentUrl,
         status: 'PENDING',
         createdAt: $currentTime,
         updatedAt: $currentTime,
         actionDate: null,
         approvedBy: null
       })
       CREATE (p)-[:HAS_REIMBURSEMENT]->(r)
       WITH r
       MATCH (admin:User) WHERE admin.role = 'Admin'
       CREATE (n:Notification {
         id: randomUUID(),
         userId: admin.username,
         message: $employeeName + ' submitted a ' + $reimbursementType + ' reimbursement request.',
         type: 'REIMBURSEMENT_REQUEST',
         relatedId: r.id,
         isRead: false,
         createdAt: $currentTime
       })
       RETURN r, admin.username AS adminEmail`,
      {
        employeeNumber,
        employeeName,
        reimbursementType,
        amount,
        description: description || '',
        notes: notes || '',
        documentUrl,
        currentTime
      }
    );

    const createdRecord = result.records[0].get('r').properties;
    
    // Collect all admin emails and send email
    const adminEmails = result.records.map(record => record.get('adminEmail')).filter(email => email);
    if (adminEmails.length > 0) {
      const subject = `New Reimbursement Request: ${employeeName || employeeNumber}`;
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2b6cb0;">New Reimbursement Request</h2>
          <p>A new reimbursement request has been submitted and requires your attention.</p>
          <table border="1" cellpadding="10" style="border-collapse: collapse; width: 100%;">
            <tr><th style="text-align: left; background-color: #f7fafc; width: 40%;">Employee Name</th><td>${employeeName || employeeNumber}</td></tr>
            <tr><th style="text-align: left; background-color: #f7fafc;">Reimbursement Type</th><td>${reimbursementType}</td></tr>
            <tr><th style="text-align: left; background-color: #f7fafc;">Requested Amount</th><td>₹${amount}</td></tr>
            <tr><th style="text-align: left; background-color: #f7fafc;">Description</th><td>${description || 'N/A'}</td></tr>
          </table>
          <br>
          <p>Please log in to the HR Portal Admin Dashboard to review it.</p>
        </div>
      `;
      adminEmails.forEach(email => {
        sendEmail({ to: email, subject, html }).catch(e => console.error("Email send failed:", e));
      });
    }

    res.status(201).json({ success: true, message: 'Reimbursement request submitted', data: createdRecord });
  } catch (error) {
    console.error('Error creating reimbursement:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  } finally {
    await session.close();
  }
});

// GET Logged-in Employee Reimbursements
router.get('/my', async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { employeeNumber } = req.query; // Could also come from req.user/token in a real app

  try {
    if (!employeeNumber) {
      return res.status(400).json({ success: false, message: 'employeeNumber is required' });
    }

    const result = await session.run(
      `MATCH (p:PersonalDetails {employeeNumber: $employeeNumber})-[:HAS_REIMBURSEMENT]->(r:Reimbursement)
       RETURN r ORDER BY r.createdAt DESC`,
      { employeeNumber }
    );

    const reimbursements = result.records.map(record => record.get('r').properties);
    res.json({ success: true, data: reimbursements });
  } catch (error) {
    console.error('Error fetching employee reimbursements:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    await session.close();
  }
});

// GET All Reimbursements (Admin)
router.get('/admin', async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(
      `MATCH (r:Reimbursement) RETURN r ORDER BY r.createdAt DESC`
    );

    const reimbursements = result.records.map(record => record.get('r').properties);
    res.json({ success: true, data: reimbursements });
  } catch (error) {
    console.error('Error fetching all reimbursements:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    await session.close();
  }
});

// UPDATE Reimbursement Status (Admin Approve/Reject)
router.put('/admin/:id/status', async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const { id } = req.params;
    const { status, adminName, reason } = req.body;

    if (!['APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    if (!reason || reason.trim() === '') {
      return res.status(400).json({ success: false, message: 'Reason is required for approval/rejection' });
    }

    const currentTime = new Date().toISOString();

    const result = await session.run(
      `MATCH (r:Reimbursement {id: $id})
       SET r.status = $status,
           r.actionDate = $currentTime,
           r.updatedAt = $currentTime,
           r.approvedBy = $adminName,
           r.reason = $reason
       WITH r
       MATCH (p:PersonalDetails)-[:HAS_REIMBURSEMENT]->(r)
       CREATE (n:Notification {
         id: randomUUID(),
         userId: coalesce(p.userId, p.employeeNumber),
         message: 'Your ' + r.reimbursementType + ' reimbursement request has been ' + r.status + '.',
         type: 'REIMBURSEMENT_STATUS',
         relatedId: r.id,
         isRead: false,
         createdAt: $currentTime
       })
       RETURN r, coalesce(p.userId, p.employeeNumber) AS employeeEmail`,
      { id, status, currentTime, adminName: adminName || 'Admin', reason: reason.trim() }
    );

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: 'Reimbursement not found' });
    }

    const updatedRecord = result.records[0].get('r').properties;
    const employeeEmail = result.records[0].get('employeeEmail');

    if (employeeEmail) {
      const subject = `Reimbursement Request ${status}`;
      const color = status === 'APPROVED' ? '#48bb78' : '#f56565';
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: ${color};">Reimbursement Request ${status}</h2>
          <p>Your ${updatedRecord.reimbursementType} reimbursement request has been <strong>${status}</strong> by HR/Admin.</p>
          <table border="1" cellpadding="10" style="border-collapse: collapse; width: 100%;">
            <tr><th style="text-align: left; background-color: #f7fafc; width: 30%;">Status</th><td style="color: ${color}; font-weight: bold;">${status}</td></tr>
            <tr><th style="text-align: left; background-color: #f7fafc;">Amount</th><td>₹${updatedRecord.amount}</td></tr>
            <tr><th style="text-align: left; background-color: #f7fafc;">Reason/Notes</th><td>${reason}</td></tr>
          </table>
          <br>
          <p>Please log in to the HR Portal for more details.</p>
        </div>
      `;
      sendEmail({ to: employeeEmail, subject, html }).catch(e => console.error("Email send failed:", e));
    }

    res.json({ success: true, message: `Reimbursement ${status.toLowerCase()}`, data: updatedRecord });
  } catch (error) {
    console.error('Error updating reimbursement status:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    await session.close();
  }
});

module.exports = router;
