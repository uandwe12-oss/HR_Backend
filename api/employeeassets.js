// employeeassets.js
const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");
const multer = require("multer");
const { 
  uploadAssetReleaseImage, 
  uploadAssetWarrantyDocument, 
  deleteFileFromDrive 
} = require("../services/googleDrive");

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
      WHERE (a.is_admin_asset IS NULL OR a.is_admin_asset = false)
        AND (a.employee_name CONTAINS $search
         OR a.employee_number CONTAINS $search
         OR a.assets CONTAINS $search)
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
   POST - SUBMIT NEW ASSETS (Employee)
================================ */

router.post("/", async (req, res) => {
  const { employee_number, employee_name, assets } = req.body;

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

/* ===================================================
   ADMIN / COMPANY ASSETS INVENTORY (Neo4j EmployeeAsset)
   Stores company-owned assets directly under (:EmployeeAsset)
   with is_admin_asset: true & employee_number: 'COMPANY_ASSET'
=================================================== */

// GET ALL COMPANY ASSETS
router.get("/company/all", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (a:EmployeeAsset)
      WHERE a.is_admin_asset = true OR a.employee_number = 'COMPANY_ASSET'
      RETURN a
      ORDER BY a.created_at DESC
    `);

    const assets = result.records.map(record => {
      const a = { ...record.get("a").properties };
      if (typeof a.assets === 'string') {
        try {
          a.assets = JSON.parse(a.assets);
        } catch(e) {
          a.assets = [];
        }
      }
      if (typeof a.warranty_files === 'string') {
        try {
          a.warranty_files = JSON.parse(a.warranty_files);
        } catch(e) {
          a.warranty_files = [];
        }
      } else if (!a.warranty_files) {
        a.warranty_files = [];
      }
      return a;
    });

    res.json({
      success: true,
      total: assets.length,
      data: assets
    });
  } catch (err) {
    console.error("❌ Error fetching company assets:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

// POST - ADD SINGLE COMPANY ASSET
router.post("/company", upload.array('warranty_files', 10), async (req, res) => {
  const {
    asset_name,
    category,
    model_name,
    make,
    serial_number,
    quantity
  } = req.body;

  if (!asset_name || !asset_name.trim()) {
    return res.status(400).json({
      success: false,
      message: "Asset name is required"
    });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    const timestamp = Date.now();
    const id = `ADMIN_ASSET_${timestamp}_${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();
    const submitted_date = now.split('T')[0];

    // Upload warranty files to Google Drive (folder 1BIYjxM9sTlAYMY0doQEsOzJbDB6arr46)
    let warranty_files = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        try {
          const uploadRes = await uploadAssetWarrantyDocument(
            file.buffer,
            file.originalname,
            file.mimetype,
            id
          );
          if (uploadRes.success) {
            warranty_files.push({
              fileId: uploadRes.fileId,
              fileName: file.originalname,
              viewLink: uploadRes.viewLink,
              directLink: uploadRes.directLink,
              downloadLink: uploadRes.downloadLink,
              uploadedAt: new Date().toISOString()
            });
          }
        } catch (uploadErr) {
          console.error("Error uploading warranty file to Google Drive:", uploadErr);
        }
      }
    }

    const assetItem = {
      asset_name: asset_name.trim(),
      category: category ? category.trim() : "General",
      model_name: model_name ? model_name.trim() : "",
      make: make ? make.trim() : "",
      serial_number: serial_number ? serial_number.trim() : "",
      quantity: Math.max(1, parseInt(quantity, 10) || 1),
      warranty_files: warranty_files
    };

    const assetsJson = JSON.stringify([assetItem]);
    const warrantyJson = JSON.stringify(warranty_files);

    const result = await session.run(`
      CREATE (a:EmployeeAsset {
        id: $id,
        is_admin_asset: true,
        employee_number: 'COMPANY_ASSET',
        employee_name: 'Company Asset Inventory',
        asset_name: $asset_name,
        category: $category,
        model_name: $model_name,
        make: $make,
        serial_number: $serial_number,
        quantity: $quantity,
        warranty_files: $warranty_files,
        assets: $assets,
        submitted_date: $submitted_date,
        created_at: $created_at,
        updated_at: $updated_at
      })
      RETURN a
    `, {
      id,
      asset_name: assetItem.asset_name,
      category: assetItem.category,
      model_name: assetItem.model_name,
      make: assetItem.make,
      serial_number: assetItem.serial_number,
      quantity: assetItem.quantity,
      warranty_files: warrantyJson,
      assets: assetsJson,
      submitted_date,
      created_at: now,
      updated_at: now
    });

    const createdNode = { ...result.records[0].get("a").properties };
    if (typeof createdNode.assets === 'string') {
      try { createdNode.assets = JSON.parse(createdNode.assets); } catch (e) {}
    }
    if (typeof createdNode.warranty_files === 'string') {
      try { createdNode.warranty_files = JSON.parse(createdNode.warranty_files); } catch (e) {}
    }

    res.status(201).json({
      success: true,
      message: "Company asset added successfully",
      data: createdNode
    });
  } catch (err) {
    console.error("❌ Error adding company asset:", err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

// POST - BULK UPLOAD COMPANY ASSETS
router.post("/company/bulk", async (req, res) => {
  const { assets } = req.body;

  if (!Array.isArray(assets) || assets.length === 0) {
    return res.status(400).json({
      success: false,
      message: "An array of assets is required"
    });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    const createdAssets = [];
    const now = new Date().toISOString();
    const submitted_date = now.split('T')[0];

    for (let i = 0; i < assets.length; i++) {
      const item = assets[i];
      if (!item.asset_name || !item.asset_name.trim()) continue;

      const timestamp = Date.now() + i;
      const id = `ADMIN_ASSET_${timestamp}_${Math.random().toString(36).substring(2, 7)}`;

      const assetItem = {
        asset_name: item.asset_name.trim(),
        category: item.category ? item.category.trim() : "General",
        model_name: item.model_name ? item.model_name.trim() : "",
        make: item.make ? item.make.trim() : "",
        serial_number: item.serial_number ? item.serial_number.trim() : "",
        quantity: Math.max(1, parseInt(item.quantity, 10) || 1),
        status: item.status || "Available",
        location: item.location ? item.location.trim() : "Main Office",
        purchase_date: item.purchase_date || submitted_date,
        remarks: item.remarks ? item.remarks.trim() : ""
      };

      const assetsJson = JSON.stringify([assetItem]);

      const result = await session.run(`
        CREATE (a:EmployeeAsset {
          id: $id,
          is_admin_asset: true,
          employee_number: 'COMPANY_ASSET',
          employee_name: 'Company Asset Inventory',
          asset_name: $asset_name,
          category: $category,
          model_name: $model_name,
          make: $make,
          serial_number: $serial_number,
          quantity: $quantity,
          status: $status,
          location: $location,
          purchase_date: $purchase_date,
          remarks: $remarks,
          assets: $assets,
          submitted_date: $submitted_date,
          created_at: $created_at,
          updated_at: $updated_at
        })
        RETURN a
      `, {
        id,
        asset_name: assetItem.asset_name,
        category: assetItem.category,
        model_name: assetItem.model_name,
        make: assetItem.make,
        serial_number: assetItem.serial_number,
        quantity: assetItem.quantity,
        status: assetItem.status,
        location: assetItem.location,
        purchase_date: assetItem.purchase_date,
        remarks: assetItem.remarks,
        assets: assetsJson,
        submitted_date,
        created_at: now,
        updated_at: now
      });

      if (result.records.length > 0) {
        createdAssets.push(result.records[0].get("a").properties);
      }
    }

    res.status(201).json({
      success: true,
      message: `${createdAssets.length} company assets imported successfully`,
      data: createdAssets
    });
  } catch (err) {
    console.error("❌ Error in bulk upload company assets:", err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

// PUT - UPDATE SINGLE COMPANY ASSET
router.put("/company/:id", upload.array('warranty_files', 10), async (req, res) => {
  const { id } = req.params;
  const {
    asset_name,
    category,
    model_name,
    make,
    serial_number,
    quantity,
    existing_warranty_files
  } = req.body;

  if (!asset_name || !asset_name.trim()) {
    return res.status(400).json({
      success: false,
      message: "Asset name is required"
    });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    const now = new Date().toISOString();

    // Parse existing warranty files
    let warranty_files = [];
    if (existing_warranty_files) {
      try {
        warranty_files = typeof existing_warranty_files === 'string'
          ? JSON.parse(existing_warranty_files)
          : (Array.isArray(existing_warranty_files) ? existing_warranty_files : []);
      } catch (e) {
        warranty_files = [];
      }
    }

    // Check for removed warranty files from Google Drive
    try {
      const prevResult = await session.run(`
        MATCH (a:EmployeeAsset {id: $id})
        RETURN a.warranty_files AS warranty_files
      `, { id });

      if (prevResult.records.length > 0) {
        const prevRaw = prevResult.records[0].get("warranty_files");
        let prevFiles = [];
        if (typeof prevRaw === 'string') {
          try { prevFiles = JSON.parse(prevRaw); } catch (e) {}
        } else if (Array.isArray(prevRaw)) {
          prevFiles = prevRaw;
        }

        const keptFileIds = new Set(
          warranty_files.map(f => (typeof f === 'object' ? f.fileId : f)).filter(Boolean)
        );

        for (const prevFile of prevFiles) {
          const prevId = typeof prevFile === 'object' ? prevFile.fileId : prevFile;
          if (prevId && !keptFileIds.has(prevId)) {
            console.log(`🗑️ Deleting removed warranty file from Google Drive: ${prevId}`);
            await deleteFileFromDrive(prevId);
          }
        }
      }
    } catch (cleanupErr) {
      console.error("Error cleaning up removed warranty files from Google Drive:", cleanupErr);
    }

    // Upload newly attached files to Google Drive (folder 1BIYjxM9sTlAYMY0doQEsOzJbDB6arr46)
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        try {
          const uploadRes = await uploadAssetWarrantyDocument(
            file.buffer,
            file.originalname,
            file.mimetype,
            id
          );
          if (uploadRes.success) {
            warranty_files.push({
              fileId: uploadRes.fileId,
              fileName: file.originalname,
              viewLink: uploadRes.viewLink,
              directLink: uploadRes.directLink,
              downloadLink: uploadRes.downloadLink,
              uploadedAt: new Date().toISOString()
            });
          }
        } catch (uploadErr) {
          console.error("Error uploading warranty file to Google Drive:", uploadErr);
        }
      }
    }

    const assetItem = {
      asset_name: asset_name.trim(),
      category: category ? category.trim() : "General",
      model_name: model_name ? model_name.trim() : "",
      make: make ? make.trim() : "",
      serial_number: serial_number ? serial_number.trim() : "",
      quantity: Math.max(1, parseInt(quantity, 10) || 1),
      warranty_files: warranty_files
    };

    const assetsJson = JSON.stringify([assetItem]);
    const warrantyJson = JSON.stringify(warranty_files);

    const result = await session.run(`
      MATCH (a:EmployeeAsset {id: $id})
      SET a.asset_name = $asset_name,
          a.category = $category,
          a.model_name = $model_name,
          a.make = $make,
          a.serial_number = $serial_number,
          a.quantity = $quantity,
          a.warranty_files = $warranty_files,
          a.assets = $assets,
          a.updated_at = $updated_at
      RETURN a
    `, {
      id,
      asset_name: assetItem.asset_name,
      category: assetItem.category,
      model_name: assetItem.model_name,
      make: assetItem.make,
      serial_number: assetItem.serial_number,
      quantity: assetItem.quantity,
      warranty_files: warrantyJson,
      assets: assetsJson,
      updated_at: now
    });

    if (result.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Company asset not found"
      });
    }

    const updatedNode = { ...result.records[0].get("a").properties };
    if (typeof updatedNode.assets === 'string') {
      try { updatedNode.assets = JSON.parse(updatedNode.assets); } catch (e) {}
    }
    if (typeof updatedNode.warranty_files === 'string') {
      try { updatedNode.warranty_files = JSON.parse(updatedNode.warranty_files); } catch (e) {}
    }

    res.json({
      success: true,
      message: "Company asset updated successfully",
      data: updatedNode
    });
  } catch (err) {
    console.error("❌ Error updating company asset:", err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

// DELETE - REMOVE SINGLE COMPANY ASSET (Deletes from Neo4j AND Google Drive)
router.delete("/company/:id", async (req, res) => {
  const { id } = req.params;
  const driver = getDriver();
  const session = driver.session();

  try {
    // 1. Fetch asset details to identify all attached warranty files in Google Drive
    const findResult = await session.run(`
      MATCH (a:EmployeeAsset {id: $id})
      WHERE a.is_admin_asset = true OR a.employee_number = 'COMPANY_ASSET'
      RETURN a.warranty_files AS warranty_files, a.assets AS assets
    `, { id });

    if (findResult.records.length > 0) {
      const record = findResult.records[0];
      const filesToDelete = [];

      const rawWarranty = record.get("warranty_files");
      if (typeof rawWarranty === 'string') {
        try {
          const parsed = JSON.parse(rawWarranty);
          if (Array.isArray(parsed)) filesToDelete.push(...parsed);
        } catch (e) {}
      } else if (Array.isArray(rawWarranty)) {
        filesToDelete.push(...rawWarranty);
      }

      const rawAssets = record.get("assets");
      if (typeof rawAssets === 'string') {
        try {
          const parsedAssets = JSON.parse(rawAssets);
          if (Array.isArray(parsedAssets)) {
            parsedAssets.forEach(item => {
              if (Array.isArray(item.warranty_files)) {
                filesToDelete.push(...item.warranty_files);
              }
            });
          }
        } catch (e) {}
      }

      // Delete each warranty file from Google Drive
      const seenIds = new Set();
      for (const item of filesToDelete) {
        const fileId = item?.fileId || (typeof item === 'string' ? item : null);
        if (fileId && !seenIds.has(fileId)) {
          seenIds.add(fileId);
          try {
            console.log(`🗑️ Deleting warranty file from Google Drive: ${fileId}`);
            await deleteFileFromDrive(fileId);
          } catch (driveErr) {
            console.error(`❌ Failed to delete warranty file ${fileId} from Drive:`, driveErr.message);
          }
        }
      }
    }

    // 2. Delete the node from Neo4j
    const result = await session.run(`
      MATCH (a:EmployeeAsset {id: $id})
      WHERE a.is_admin_asset = true OR a.employee_number = 'COMPANY_ASSET'
      DETACH DELETE a
      RETURN count(a) AS deletedCount
    `, { id });

    res.json({
      success: true,
      message: "Company asset and warranty file(s) deleted successfully from database and Google Drive"
    });
  } catch (err) {
    console.error("❌ Error deleting company asset:", err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

// DELETE - REMOVE SPECIFIC WARRANTY FILE FROM A COMPANY ASSET
router.delete("/company/:id/warranty/:fileId", async (req, res) => {
  const { id, fileId } = req.params;
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (a:EmployeeAsset {id: $id})
      WHERE a.is_admin_asset = true OR a.employee_number = 'COMPANY_ASSET'
      RETURN a
    `, { id });

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "Company asset not found" });
    }

    const node = result.records[0].get("a").properties;
    let warranty_files = [];
    if (typeof node.warranty_files === 'string') {
      try { warranty_files = JSON.parse(node.warranty_files); } catch (e) {}
    } else if (Array.isArray(node.warranty_files)) {
      warranty_files = node.warranty_files;
    }

    // Filter out target file
    const filteredFiles = warranty_files.filter(f => {
      const currentId = typeof f === 'object' ? f.fileId : f;
      return currentId !== fileId;
    });

    // Update node
    await session.run(`
      MATCH (a:EmployeeAsset {id: $id})
      SET a.warranty_files = $warranty_files,
          a.updated_at = $updated_at
    `, {
      id,
      warranty_files: JSON.stringify(filteredFiles),
      updated_at: new Date().toISOString()
    });

    // Delete from Google Drive
    await deleteFileFromDrive(fileId);

    res.json({
      success: true,
      message: "Warranty file deleted from Google Drive and asset record",
      warranty_files: filteredFiles
    });
  } catch (err) {
    console.error("❌ Error deleting warranty file:", err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

/* ================================
   PUT - UPDATE ASSETS SUBMISSION (Employee)
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
   DELETE ASSETS SUBMISSION (Employee)
================================ */

router.delete("/:assetId", async (req, res) => {
  const { assetId } = req.params;

  const driver = getDriver();
  const session = driver.session();

  try {
    const checkResult = await session.run(
      `
      MATCH (a:EmployeeAsset {id: $assetId})
      RETURN a.employee_name AS employee_name, a.submitted_date AS submitted_date, a.assets AS assets, a.warranty_files AS warranty_files
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

    // Clean up any files from Google Drive
    try {
      const rawAssets = checkResult.records[0].get("assets");
      const rawWarranty = checkResult.records[0].get("warranty_files");
      const driveFilesToDelete = [];

      if (typeof rawWarranty === 'string') {
        try {
          const parsedW = JSON.parse(rawWarranty);
          if (Array.isArray(parsedW)) driveFilesToDelete.push(...parsedW);
        } catch (e) {}
      } else if (Array.isArray(rawWarranty)) {
        driveFilesToDelete.push(...rawWarranty);
      }

      if (typeof rawAssets === 'string') {
        try {
          const parsedA = JSON.parse(rawAssets);
          if (Array.isArray(parsedA)) {
            parsedA.forEach(item => {
              if (item.release_image_url) driveFilesToDelete.push(item.release_image_url);
              if (Array.isArray(item.warranty_files)) driveFilesToDelete.push(...item.warranty_files);
            });
          }
        } catch (e) {}
      }

      for (const f of driveFilesToDelete) {
        const idToDelete = typeof f === 'object' ? f.fileId : f;
        if (idToDelete) {
          await deleteFileFromDrive(idToDelete);
        }
      }
    } catch (cleanupErr) {
      console.error("Error cleaning up Drive files on asset submission delete:", cleanupErr);
    }

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
   GET ALL ASSETS FOR ADMIN (Employee Submissions)
================================ */

router.get("/admin/all", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (a:EmployeeAsset)
      WHERE a.is_admin_asset IS NULL OR a.is_admin_asset = false
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

    // Query total employees who have submitted PersonalDetails
    let totalPersonalDetailsEmployees = 0;
    try {
      const pdCountResult = await session.run(`
        MATCH (p:PersonalDetails)
        RETURN count(p) AS totalCount
      `);
      if (pdCountResult.records.length > 0) {
        const c = pdCountResult.records[0].get("totalCount");
        totalPersonalDetailsEmployees = typeof c === 'number' ? c : (c.toNumber ? c.toNumber() : Number(c) || 0);
      }
    } catch (pdErr) {
      console.error("Error counting PersonalDetails nodes:", pdErr.message);
    }

    res.json({
      success: true,
      total: assets.length,
      totalPersonalDetailsEmployees,
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

/* ======================================================
   GET TOTAL EMPLOYEES WHO SUBMITTED PERSONAL DETAILS
====================================================== */
router.get("/personal-details-count", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (p:PersonalDetails)
      RETURN count(p) AS totalCount
    `);
    const c = result.records[0]?.get("totalCount");
    const count = typeof c === 'number' ? c : (c?.toNumber ? c.toNumber() : Number(c) || 0);
    res.json({ success: true, count });
  } catch (err) {
    console.error("Error fetching personal details count:", err);
    res.status(500).json({ success: false, message: err.message });
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
      
      if (adminUsers.length === 0) {
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
      assetsArray[index].release_requested = false;
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
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (a:EmployeeAsset {id: $id})
      SET a.status = 'Approved'
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
