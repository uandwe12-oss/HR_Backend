// backend/api/profileApproval.js
const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");

// Helper function to clean up profile data before saving
function cleanProfileData(profile) {
  const cleaned = { ...profile };

  // Parse skills if it's a string
  if (cleaned.skills && typeof cleaned.skills === 'string') {
    try {
      cleaned.skills = JSON.parse(cleaned.skills);
    } catch (e) {
      if (cleaned.skills.includes(',')) {
        cleaned.skills = cleaned.skills.split(',').map(s => s.trim());
      } else {
        cleaned.skills = [cleaned.skills];
      }
    }
  }

  // Ensure skills is always an array
  if (!Array.isArray(cleaned.skills)) {
    cleaned.skills = [];
  }

  return cleaned;
}

// Get all profiles with approval status (Admin only)
router.get("/admin/profiles", async (req, res) => {
  const driver = getDriver();
  if (!driver) {
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();

  try {
    const { status, department, search } = req.query;

    let query = `
      MATCH (p:PersonalDetails)
      OPTIONAL MATCH (u:User {username: p.userId})
      RETURN 
        p {.*} as personalDetails,
        u.role as role,
        u.department as department
      ORDER BY p.createdAt DESC
    `;

    let params = {};

    if (status && status !== 'ALL') {
      query = `
        MATCH (p:PersonalDetails)
        WHERE p.profileStatus = $status
        OPTIONAL MATCH (u:User {username: p.userId})
        RETURN 
          p {.*} as personalDetails,
          u.role as role,
          u.department as department
        ORDER BY p.createdAt DESC
      `;
      params.status = status;
    }

    const result = await session.run(query, params);

    const profiles = result.records.map(record => {
      const p = record.get("personalDetails") || {};
      return {
        ...p,
        userId: p.userId,
        fullName: `${p.firstName || ""} ${p.lastName || ""}`.trim(),
        firstName: p.firstName,
        lastName: p.lastName,
        email: p.emailId || p.email,
        mobileNumber: p.mobileNumber,
        pid: p.pid,
        submissionDate: p.createdAt,
        approvalStatus: p.profileStatus || "PENDING",
        rejectionReason: p.profileRejectionReason || "",
        submittedAt: p.profileSubmittedAt,
        approvedAt: p.profileApprovedAt,
        role: record.get("role"),
        department: record.get("department") || "Not Specified"
      };
    });

    res.json({ success: true, data: profiles });

  } catch (err) {
    console.error("Error fetching profiles:", err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// Get single profile details for admin view
router.get("/admin/profile/:userId", async (req, res) => {
  const driver = getDriver();
  if (!driver) {
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { userId } = req.params;

  try {
    const result = await session.run(
      `MATCH (p:PersonalDetails {userId: $userId})
       OPTIONAL MATCH (u:User {username: $userId})
       RETURN 
         p {.*} as personalDetails,
         p.profileStatus as approvalStatus,
         p.profileRejectionReason as rejectionReason,
         p.profileSubmittedAt as submittedAt,
         p.profileApprovedAt as approvedAt,
         u.role as role,
         u.department as department
      `,
      { userId }
    );

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "Profile not found" });
    }

    const record = result.records[0];
    const personalDetails = record.get("personalDetails");

    // Parse skills if it's a string
    if (personalDetails.skills && typeof personalDetails.skills === 'string') {
      try {
        personalDetails.skills = JSON.parse(personalDetails.skills);
      } catch (e) {
        personalDetails.skills = [];
      }
    }

    res.json({
      success: true,
      data: {
        ...personalDetails,
        approvalStatus: record.get("approvalStatus") || "PENDING",
        rejectionReason: record.get("rejectionReason") || "",
        submittedAt: record.get("submittedAt"),
        approvedAt: record.get("approvedAt"),
        role: record.get("role"),
        department: record.get("department")
      }
    });

  } catch (err) {
    console.error("Error fetching profile:", err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// Approve profile - CLEAN UP rejection fields
router.put("/admin/approve/:userId", async (req, res) => {
  const driver = getDriver();
  if (!driver) {
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { userId } = req.params;
  const { startDate } = req.body || {};

  if (!startDate) {
    return res.status(400).json({ success: false, message: "Start date is required to approve the profile" });
  }

  try {
    // First get the current profile to preserve all data
    const getResult = await session.run(
      `MATCH (p:PersonalDetails {userId: $userId}) RETURN p`,
      { userId }
    );

    if (getResult.records.length === 0) {
      return res.status(404).json({ success: false, message: "Profile not found" });
    }

    const currentProfile = getResult.records[0].get('p').properties;
    const now = new Date().toISOString();

    // Clean up the profile data
    const cleanedProfile = cleanProfileData(currentProfile);

    // Update profile: Set status to APPROVED, remove rejection fields
    cleanedProfile.profileStatus = 'APPROVED';
    cleanedProfile.profileApprovedAt = now;
    cleanedProfile.employmentStartDate = startDate;
    cleanedProfile.updatedAt = now;
    delete cleanedProfile.profileRejectionReason;
    delete cleanedProfile.profileRejectedAt;

    const result = await session.run(
      `MATCH (p:PersonalDetails {userId: $userId})
       SET p = $data
       RETURN p
      `,
      {
        userId,
        data: cleanedProfile
      }
    );

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "Profile not found" });
    }

    // Create notification for the user
    await session.run(`
      CREATE (n:Notification {
        id: randomUUID(),
        userId: $userId,
        type: 'PROFILE_STATUS',
        message: 'Congratulations! Your profile has been approved.',
        createdAt: $createdAt,
        isRead: false,
        relatedId: $userId
      })
    `, { userId, createdAt: now });


    res.json({
      success: true,
      message: "Profile approved successfully",
      data: {
        userId,
        status: 'APPROVED',
        approvedAt: now
      }
    });

  } catch (err) {
    console.error("Error approving profile:", err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// Reject profile - Add rejection fields
router.put("/admin/reject/:userId", async (req, res) => {
  const driver = getDriver();
  if (!driver) {
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { userId } = req.params;
  const { rejectionReason } = req.body;

  if (!rejectionReason) {
    return res.status(400).json({ success: false, message: "Rejection reason is required" });
  }

  try {
    // First get the current profile
    const getResult = await session.run(
      `MATCH (p:PersonalDetails {userId: $userId}) RETURN p`,
      { userId }
    );

    if (getResult.records.length === 0) {
      return res.status(404).json({ success: false, message: "Profile not found" });
    }

    const currentProfile = getResult.records[0].get('p').properties;
    const now = new Date().toISOString();

    // Clean up the profile data
    const cleanedProfile = cleanProfileData(currentProfile);

    // Update profile: Set status to REJECTED, add rejection fields, remove approval fields
    cleanedProfile.profileStatus = 'REJECTED';
    cleanedProfile.profileRejectionReason = rejectionReason;
    cleanedProfile.profileRejectedAt = now;
    cleanedProfile.updatedAt = now;
    delete cleanedProfile.profileApprovedAt;

    const result = await session.run(
      `MATCH (p:PersonalDetails {userId: $userId})
       SET p = $data
       RETURN p
      `,
      {
        userId,
        data: cleanedProfile
      }
    );

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "Profile not found" });
    }

    // Create notification for the user
    await session.run(`
      CREATE (n:Notification {
        id: randomUUID(),
        userId: $userId,
        type: 'PROFILE_STATUS',
        message: 'Your profile has been rejected. Please check the rejection reason and update your details.',
        createdAt: $createdAt,
        isRead: false,
        relatedId: $userId
      })
    `, { userId, createdAt: now });

    res.json({
      success: true,
      message: "Profile rejected successfully",
      data: {
        userId,
        status: 'REJECTED',
        rejectionReason,
        rejectedAt: now
      }
    });

  } catch (err) {
    console.error("Error rejecting profile:", err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// Get dashboard statistics
router.get("/admin/stats", async (req, res) => {
  const driver = getDriver();
  if (!driver) {
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();

  try {
    const result = await session.run(
      `MATCH (p:PersonalDetails)
       RETURN 
         COUNT(CASE WHEN p.profileStatus = 'PENDING' THEN 1 END) as pending,
         COUNT(CASE WHEN p.profileStatus = 'APPROVED' THEN 1 END) as approved,
         COUNT(CASE WHEN p.profileStatus = 'REJECTED' THEN 1 END) as rejected,
         COUNT(p) as total
      `
    );

    let stats = { total: 0, pending: 0, approved: 0, rejected: 0 };
    if (result.records.length > 0) {
      const toNum = (val) => {
        if (val === null || val === undefined) return 0;
        return typeof val.toNumber === 'function' ? val.toNumber() : Number(val);
      };
      stats = {
        total: toNum(result.records[0].get("total")),
        pending: toNum(result.records[0].get("pending")),
        approved: toNum(result.records[0].get("approved")),
        rejected: toNum(result.records[0].get("rejected"))
      };
    }

    res.json({ success: true, data: stats });

  } catch (err) {
    console.error("Error fetching stats:", err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// Check employee access (for frontend route protection)
router.get("/check-access", async (req, res) => {
  const driver = getDriver();
  if (!driver) {
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ success: false, message: "userId is required" });
  }

  try {
    const result = await session.run(
      `MATCH (u:User {username: $userId})
       OPTIONAL MATCH (p:PersonalDetails {userId: $userId})
       RETURN u.role as role, p.profileStatus as status
      `,
      { userId }
    );

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const role = result.records[0].get("role") || "";
    const status = result.records[0].get("status") || "PENDING";

    // Admins always have access, regardless of their own profile status
    const hasAccess = role === "Admin" || status === "APPROVED";

    res.json({
      success: true,
      hasAccess,
      status: role === "Admin" ? "APPROVED" : status,
      message: hasAccess ? "Access granted" : "Profile pending approval"
    });

  } catch (err) {
    console.error("Error checking access:", err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// Resubmit rejected profile (employee action)
router.put("/employee/resubmit/:userId", async (req, res) => {
  const driver = getDriver();
  if (!driver) {
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { userId } = req.params;
  const profileData = req.body;

  try {
    const now = new Date().toISOString();

    // Get existing profile
    const getResult = await session.run(
      `MATCH (p:PersonalDetails {userId: $userId}) RETURN p`,
      { userId }
    );

    if (getResult.records.length === 0) {
      return res.status(404).json({ success: false, message: "Profile not found" });
    }

    const existingProfile = getResult.records[0].get('p').properties;

    // Merge existing data with new data
    const updatedProfile = {
      ...existingProfile,
      ...profileData,
      userId: userId,
      profileStatus: 'PENDING',  // Reset to PENDING for re-review
      profileSubmittedAt: now,
      updatedAt: now
    };

    // Remove rejection and approval fields
    delete updatedProfile.profileRejectionReason;
    delete updatedProfile.profileRejectedAt;
    delete updatedProfile.profileApprovedAt;

    // Clean up skills
    const cleanedProfile = cleanProfileData(updatedProfile);

    // Update profile
    const result = await session.run(
      `MATCH (p:PersonalDetails {userId: $userId})
       SET p = $data
       RETURN p
      `,
      { userId, data: cleanedProfile }
    );

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "Profile not found" });
    }


    res.json({
      success: true,
      message: "Profile resubmitted successfully. Waiting for admin approval.",
      data: {
        userId,
        status: 'PENDING',
        submittedAt: now
      }
    });

  } catch (err) {
    console.error("Error resubmitting profile:", err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

module.exports = router;
