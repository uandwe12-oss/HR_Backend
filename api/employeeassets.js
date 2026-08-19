// employeeassets.js
const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");
const multer = require("multer");
const { uploadAssetReleaseImage } = require("../services/googleDrive");

const upload = multer({ storage: multer.memoryStorage() });

/* ================================
   TEST ROUTE
================================ */

router.get("/ping", (req, res) => {
  res.json({
    success: true,
    message: "Employee Assets routes are working!"
  });
});

/* ================================
   GET ASSETS BY EMPLOYEE (Employee view their own assets)
   Supports userId, username, or employeeNumber
================================ */


router.get("/employee/:identifier", async (req, res) => {
  const { identifier } = req.params;
  const driver = getDriver();
  const session = driver.session();

  try {
    // First, find the employee's userId from PersonalDetails
    const employeeResult = await session.run(
      `
      MATCH (p:PersonalDetails)
      WHERE p.userId = $identifier 
         OR p.employeeNumber = $identifier 
         OR p.fullName CONTAINS $identifier
      RETURN p.userId AS userId, p.employeeNumber AS employeeNumber, p.fullName AS fullName
      LIMIT 1
      `,
      { identifier }
    );

    let employeeUserId = identifier;
    let employeeFullName = "";
    let employeeNumber = "";

    if (employeeResult.records.length > 0) {
      employeeUserId = employeeResult.records[0].get("userId");
      employeeNumber = employeeResult.records[0].get("employeeNumber") || "";
      employeeFullName = employeeResult.records[0].get("fullName") || "";
    }

    // Check if employeeNumber exists
    if (!employeeNumber) {
      return res.json({
        success: true,
        total: 0,
        data: [],
        message: "No employee number found for this user"
      });
    }

    // Now fetch assets for this employee
    const result = await session.run(
      `
      MATCH (a:EmployeeAsset)
      WHERE a.employee_number = $employeeNumber
      RETURN a
      ORDER BY a.submitted_date DESC
      `,
      { employeeNumber: employeeNumber }
    );

    const assets = result.records.map(record => {
      const a = record.get("a").properties;
      // Parse assets if it's a string
      if (typeof a.assets === 'string') {
        try {
          a.assets = JSON.parse(a.assets);
        } catch(e) {
          console.error("Error parsing assets:", e);
          a.assets = [];
        }
      }
      return a;
    });

    res.json({
      success: true,
      total: assets.length,
      data: assets
    });

  } catch (err) {
    console.error("❌ Error fetching employee assets:", err.message);
    console.error("Error stack:", err.stack);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   SEARCH ASSETS (Admin)
================================ */

router.get("/search", async (req, res) => {
  const { q } = req.query;
  const driver = getDriver();
  const session = driver.session();

  if (!q || q.trim() === "") {
    return res.status(400).json({
      success: false,
      message: "Search query is required"
    });
  }

  try {
    const result = await session.run(
      `
      MATCH (a:EmployeeAsset)
      WHERE a.employee_name CONTAINS $search
         OR a.employee_number CONTAINS $search
         OR a.assets CONTAINS $search
      RETURN a
      ORDER BY a.submitted_date DESC
      `,
      { search: q }
    );

    const assets = result.records.map(record => {
      const a = record.get("a").properties;
      if (typeof a.assets === 'string') {
        try {
          a.assets = JSON.parse(a.assets);
        } catch(e) {
          a.assets = [];
        }
      }
      return a;
    });

    res.json({
      success: true,
      total: assets.length,
      data: assets
    });

  } catch (err) {
    console.error("❌ Error searching assets:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   POST - SUBMIT NEW ASSETS
================================ */

router.post("/", async (req, res) => {
  const { employee_number, employee_name, assets } = req.body;

  // console.log("Received payload:", { employee_number, employee_name, assets: assets?.length });

  if (!employee_number || !employee_name || !assets || assets.length === 0) {
    return res.status(400).json({
      success: false,
      message: "employee_number, employee_name, and assets are required"
    });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    const submitted_date = new Date().toISOString().split('T')[0];
    const updated_at = new Date().toISOString();
    const assetsJson = JSON.stringify(assets);

    // Check if employee already has assets
    const checkResult = await session.run(
      `MATCH (a:EmployeeAsset {employee_number: $employee_number}) RETURN a`,
      { employee_number }
    );

    let assetId;

    if (checkResult.records.length > 0) {
      // Update existing record
      const existingNode = checkResult.records[0].get('a');
      assetId = existingNode.properties.id;

      let currentAssets = [];
      if (typeof existingNode.properties.assets === 'string') {
        try { 
          currentAssets = JSON.parse(existingNode.properties.assets); 
        } catch (e) {
          console.error("Error parsing existing assets:", e);
        }
      } else if (Array.isArray(existingNode.properties.assets)) {
        currentAssets = existingNode.properties.assets;
      }
      
      const newAssetsList = [...currentAssets, ...assets];
      const newAssetsJson = JSON.stringify(newAssetsList);

      const updateResult = await session.run(
        `
        MATCH (a:EmployeeAsset {employee_number: $employee_number})
        SET a.assets = $assets,
            a.updated_at = $updated_at,
            a.submitted_date = $submitted_date,
            a.employee_name = $employee_name,
            a.status = 'Approved'
        RETURN a.id AS id
        `,
        {
          employee_number,
          employee_name,
          assets: newAssetsJson,
          updated_at,
          submitted_date
        }
      );
      
      if (updateResult.records.length > 0) {
        assetId = updateResult.records[0].get("id");
      }
      
    } else {
      // Create new record
      // Generate a proper ID
      const timestamp = Date.now();
      assetId = `ASSET_${employee_number}_${timestamp}`;
      
      await session.run(
        `
        CREATE (a:EmployeeAsset {
          id: $id,
          employee_number: $employee_number,
          employee_name: $employee_name,
          assets: $assets,
          submitted_date: $submitted_date,
          created_at: $created_at,
          updated_at: $updated_at,
          status: 'Approved'
        })
        RETURN a.id AS id
        `,
        {
          id: assetId,
          employee_number,
          employee_name,
          assets: assetsJson,
          submitted_date,
          created_at: updated_at,
          updated_at
        }
      );
    }

    res.status(201).json({
      success: true,
      message: "Assets saved successfully",
      data: {
        id: assetId,
        employee_name: employee_name,
        assets_count: assets.length,
        submitted_date: submitted_date
      }
    });

  } catch (err) {
    console.error("❌ Error saving assets:", err);
    console.error("Error details:", err.stack);
    res.status(500).json({
      success: false,
      message: err.message,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  } finally {
    await session.close();
  }
});

/* ================================
   PUT - UPDATE ASSETS SUBMISSION
================================ */

router.put("/:assetId", async (req, res) => {
  const { assetId } = req.params;
  const { assets } = req.body;

  if (!assets || assets.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Assets data is required for update"
    });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    const checkResult = await session.run(
      `
      MATCH (a:EmployeeAsset {id: $assetId})
      RETURN a.id AS id
      `,
      { assetId }
    );

    if (checkResult.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Asset record not found"
      });
    }

    const updated_at = new Date().toISOString();

    await session.run(
      `
      MATCH (a:EmployeeAsset {id: $assetId})
      SET a.assets = $assets,
          a.updated_at = $updated_at
      `,
      {
        assetId: assetId,
        assets: JSON.stringify(assets),
        updated_at: updated_at
      }
    );


    res.json({
      success: true,
      message: "Assets updated successfully"
    });

  } catch (err) {
    console.error("❌ Error updating assets:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   DELETE ASSETS SUBMISSION
================================ */

router.delete("/:assetId", async (req, res) => {
  const { assetId } = req.params;

  const driver = getDriver();
  const session = driver.session();

  try {
    const checkResult = await session.run(
      `
      MATCH (a:EmployeeAsset {id: $assetId})
      RETURN a.employee_name AS employee_name, a.submitted_date AS submitted_date
      `,
      { assetId }
    );

    if (checkResult.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Asset record not found"
      });
    }

    const employeeName = checkResult.records[0].get("employee_name");
    const submittedDate = checkResult.records[0].get("submitted_date");

    await session.run(
      `
      MATCH (a:EmployeeAsset {id: $assetId})
      DETACH DELETE a
      `,
      { assetId }
    );


    res.json({
      success: true,
      message: `Assets record for ${employeeName} deleted successfully`
    });

  } catch (err) {
    console.error("❌ Error deleting assets:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   GET ALL ASSETS FOR ADMIN
================================ */

router.get("/admin/all", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (a:EmployeeAsset)
      RETURN 
        a.id AS id,
        a.employee_name AS employee_name,
        a.employee_number AS employee_number,
        a.assets AS assets,
        a.submitted_date AS submitted_date,
        a.created_at AS created_at,
        a.updated_at AS updated_at
      ORDER BY a.submitted_date DESC
    `);

    const assets = result.records.map(record => {
      let assetsData = record.get("assets");
      if (typeof assetsData === 'string') {
        try {
          assetsData = JSON.parse(assetsData);
        } catch (e) {
          assetsData = [];
        }
      }
      return {
        id: record.get("id"),
        employee_name: record.get("employee_name"),
        employee_number: record.get("employee_number"),
        assets: assetsData,
        submitted_date: record.get("submitted_date"),
        created_at: record.get("created_at"),
        updated_at: record.get("updated_at")
      };
    });

    res.json({
      success: true,
      total: assets.length,
      data: assets
    });

  } catch (err) {
    console.error("❌ Error fetching all assets:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   POST - REQUEST ASSET RELEASE
================================ */

router.post("/release/:assetId", upload.single('image'), async (req, res) => {
  const { assetId } = req.params;
  const { assetIndex } = req.body;
  const index = parseInt(assetIndex, 10);

  if (isNaN(index)) {
    return res.status(400).json({ success: false, message: "Valid assetIndex is required" });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (a:EmployeeAsset {id: $assetId})
      RETURN a
    `, { assetId });

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "Asset record not found" });
    }

    const node = result.records[0].get("a").properties;
    let assetsArray = [];
    if (typeof node.assets === 'string') {
      try { assetsArray = JSON.parse(node.assets); } catch (e) { assetsArray = []; }
    } else {
      assetsArray = node.assets || [];
    }

    if (index < 0 || index >= assetsArray.length) {
      return res.status(400).json({ success: false, message: "Invalid asset index" });
    }

    let imageUrl = null;
    if (req.file) {
      const uploadResponse = await uploadAssetReleaseImage(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        node.employee_number || 'unknown'
      );
      if (uploadResponse.success) {
        imageUrl = uploadResponse.directLink || uploadResponse.viewLink;
      } else {
        console.warn("Failed to upload asset release image:", uploadResponse.error);
      }
    }

    assetsArray[index].release_requested = true;
    assetsArray[index].release_request_date = new Date().toISOString();
    assetsArray[index].release_image_url = imageUrl;

    await session.run(`
      MATCH (a:EmployeeAsset {id: $assetId})
      SET a.assets = $assetsStr
    `, { assetId, assetsStr: JSON.stringify(assetsArray) });

    // Send notification to Admin ONLY
    try {
      const usersResult = await session.run(`
        MATCH (u:User) WHERE toLower(u.role) = 'admin'
        RETURN u.username AS username, u.role AS role
      `);
      
      const adminUsers = usersResult.records.map(record => record.get("username")).filter(Boolean);
      // console.log("Found Admin/HR users to notify:", adminUsers);
      
      if (adminUsers.length === 0) {
        // Fallback
        adminUsers.push("Admin", "admin");
      }
      
      for (const adminUser of adminUsers) {
        await session.run(`
          CREATE (n:Notification {
            id: randomUUID(),
            userId: $userId,
            type: "AssetRelease",
            message: $message,
            isRead: false,
            createdAt: $createdAt
          })
        `, { 
          userId: adminUser,
          message: `Asset Release requested by ${node.employee_name} (${node.employee_number}) for ${assetsArray[index].asset_name}`,
          createdAt: new Date().toISOString()
        });
      }
    } catch (notifErr) {
      console.error("Failed to create notification:", notifErr);
    }

    res.json({ success: true, message: "Release requested successfully" });
  } catch (err) {
    console.error("Error requesting release:", err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

/* ================================
   PUT - APPROVE RELEASE
================================ */
router.put("/release/approve/:assetId", async (req, res) => {
  const { assetId } = req.params;
  const { assetIndex } = req.body;
  const index = parseInt(assetIndex, 10);

  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`MATCH (a:EmployeeAsset {id: $assetId}) RETURN a`, { assetId });
    if (result.records.length === 0) return res.status(404).json({ success: false, message: "Not found" });

    const node = result.records[0].get("a").properties;
    let assetsArray = typeof node.assets === 'string' ? JSON.parse(node.assets) : (node.assets || []);

    if (index >= 0 && index < assetsArray.length) {
      assetsArray[index].released = true;
      assetsArray[index].release_requested = false; // clear flag
    }

    await session.run(`
      MATCH (a:EmployeeAsset {id: $assetId})
      SET a.assets = $assetsStr
    `, { assetId, assetsStr: JSON.stringify(assetsArray) });

    // Send notification to Employee
    try {
      if (node.employee_number) {
        await session.run(`
          OPTIONAL MATCH (p:PersonalDetails {employeeNumber: $empNum})
          WITH coalesce(p.userId, $empNum) AS targetUserId
          CREATE (n:Notification {
            id: randomUUID(),
            userId: targetUserId,
            type: "AssetRelease",
            message: $message,
            isRead: false,
            createdAt: $createdAt
          })
        `, { 
          empNum: node.employee_number, 
          message: `Your release request for ${assetsArray[index].asset_name} has been approved.`,
          createdAt: new Date().toISOString()
        });
      }
    } catch (notifErr) {
      console.error("Failed to create employee notification:", notifErr);
    }

    res.json({ success: true, message: "Release approved successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

/* ================================
   PUT - REJECT RELEASE
================================ */
router.put("/release/reject/:assetId", async (req, res) => {
  const { assetId } = req.params;
  const { assetIndex } = req.body;
  const index = parseInt(assetIndex, 10);

  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`MATCH (a:EmployeeAsset {id: $assetId}) RETURN a`, { assetId });
    if (result.records.length === 0) return res.status(404).json({ success: false, message: "Not found" });

    const node = result.records[0].get("a").properties;
    let assetsArray = typeof node.assets === 'string' ? JSON.parse(node.assets) : (node.assets || []);

    if (index >= 0 && index < assetsArray.length) {
      assetsArray[index].release_requested = false;
      assetsArray[index].release_request_date = null;
      // keep image url or remove it
    }

    await session.run(`
      MATCH (a:EmployeeAsset {id: $assetId})
      SET a.assets = $assetsStr
    `, { assetId, assetsStr: JSON.stringify(assetsArray) });

    // Send notification to Employee
    try {
      if (node.employee_number) {
        await session.run(`
          OPTIONAL MATCH (p:PersonalDetails {employeeNumber: $empNum})
          WITH coalesce(p.userId, $empNum) AS targetUserId
          CREATE (n:Notification {
            id: randomUUID(),
            userId: targetUserId,
            type: "AssetRelease",
            message: $message,
            isRead: false,
            createdAt: $createdAt
          })
        `, { 
          empNum: node.employee_number, 
          message: `Your release request for ${assetsArray[index].asset_name} has been rejected.`,
          createdAt: new Date().toISOString()
        });
      }
    } catch (notifErr) {
      console.error("Failed to create employee notification:", notifErr);
    }

    res.json({ success: true, message: "Release rejected successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// Approve Asset Submission
router.put("/approve-submission/:id", async (req, res) => {
  const { id } = req.params;
  console.log(`Approving submission for ID: ${id}`);
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (a:EmployeeAsset {id: $id})
      SET a.status = 'Approved'
      RETURN a
    `, { id });
    if (result.records.length > 0) {
      console.log(`Successfully approved submission ${id}`);
      const node = result.records[0].get("a").properties;
      if (node.employee_number) {
        await session.run(`
          OPTIONAL MATCH (p:PersonalDetails {employeeNumber: $empNum})
          WITH coalesce(p.userId, $empNum) AS targetUserId
          CREATE (n:Notification {
            id: randomUUID(), userId: targetUserId, type: "AssetSubmission",
            message: "Your asset submission has been approved.", isRead: false, createdAt: $createdAt
          })
        `, { empNum: node.employee_number, createdAt: new Date().toISOString() });
      }
      res.json({ success: true, message: "Submission approved successfully" });
    } else {
      console.warn(`No record found for ID: ${id}`);
      res.status(404).json({ success: false, message: "Record not found" });
    }
  } catch (err) {
    console.error(`Error in /approve-submission/${id}:`, err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// Reject Asset Submission
router.put("/reject-submission/:id", async (req, res) => {
  const { id } = req.params;
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (a:EmployeeAsset {id: $id})
      SET a.status = 'Rejected'
      RETURN a
    `, { id });
    if (result.records.length > 0) {
      const node = result.records[0].get("a").properties;
      if (node.employee_number) {
        await session.run(`
          OPTIONAL MATCH (p:PersonalDetails {employeeNumber: $empNum})
          WITH coalesce(p.userId, $empNum) AS targetUserId
          CREATE (n:Notification {
            id: randomUUID(), userId: targetUserId, type: "AssetSubmission",
            message: "Your asset submission has been rejected.", isRead: false, createdAt: $createdAt
          })
        `, { empNum: node.employee_number, createdAt: new Date().toISOString() });
      }
    }
    res.json({ success: true, message: "Submission rejected successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

module.exports = router;
