const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const getDriver = require("../lib/neo4j");
const { uploadDocumentToFolder, deleteFileFromDrive, DOCUMENT_FOLDER_ID } = require("../services/googleDrive");
const { checkAndSendDocumentExpiryNotifications } = require("../services/documentExpiryNotifier");

// Multer in-memory storage for handling multiple document uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB per file
});

// Format file size helper
function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Middleware: Document access is restricted to Admin only
router.use((req, res, next) => {
  const roles = Array.isArray(req.user?.role) ? req.user.role : [req.user?.role];
  if (!roles.includes("Admin")) {
    return res.status(403).json({
      success: false,
      message: "Access denied. Document management is restricted to Admin only."
    });
  }
  next();
});

/**
 * =========================================================================
 * GET /api/document - Fetch all document folders and their attached files
 * =========================================================================
 */
router.get("/", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(
      `MATCH (f:DocumentFolder)
       OPTIONAL MATCH (f)-[:CONTAINS_DOCUMENT]->(d:DocumentItem)
       OPTIONAL MATCH (f)-[:HAS_SUBFOLDER]->(sub:DocumentFolder)
       RETURN f, collect(DISTINCT d) as documents, collect(DISTINCT sub) as subfolders
       ORDER BY f.createdAt DESC`
    );

    const folders = result.records.map(record => {
      const f = record.get("f").properties;
      const rawDocs = record.get("documents");
      const documents = rawDocs
        ? rawDocs.map(d => d && d.properties).filter(d => d && d.id)
        : [];

      // Sort documents newest first
      documents.sort((a, b) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0));

      const rawSubs = record.get("subfolders");
      const subfolders = rawSubs
        ? rawSubs.map(s => s && s.properties).filter(s => s && s.id)
        : [];
      subfolders.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

      // Calculate dynamic active / expired / closed status based on f.status and endDate
      const today = new Date().toISOString().split("T")[0];
      let computedStatus = f.status || "Active";
      if (f.status === "Closed") {
        computedStatus = "Closed";
      } else if (f.endDate && f.endDate < today) {
        computedStatus = "Expired";
      } else if (f.startDate && f.startDate > today) {
        computedStatus = "Upcoming";
      } else {
        computedStatus = "Active";
      }

      return {
        ...f,
        parentFolderId: f.parentFolderId || null,
        status: computedStatus,
        documentsCount: documents.length,
        documents: documents,
        subfoldersCount: subfolders.length,
        subfolders: subfolders
      };
    });

    res.json({
      success: true,
      data: folders
    });
  } catch (error) {
    console.error("❌ Error fetching document folders:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch document folders",
      error: error.message
    });
  } finally {
    await session.close();
  }
});

/**
 * Robust date parser supporting DD-MM-YYYY, YYYY-MM-DD, ISO, etc.
 */
function parseDateRobust(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const trimmed = dateStr.trim();
  const dmyMatch = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10) - 1;
    const year = parseInt(dmyMatch[3], 10);
    const d = new Date(year, month, day);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(trimmed);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * =========================================================================
 * GET /api/document/expiring-count
 * Ultra-lightweight endpoint returning only the count of documents expiring in <= 60 days.
 * Specifically designed for dashboard badges (Home.jsx) to avoid loading heavy document trees.
 * =========================================================================
 */
router.get("/expiring-count", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const maxDays = parseInt(req.query.days, 10) || 60;

  try {
    const result = await session.run(
      `MATCH (f:DocumentFolder)
       WHERE f.endDate IS NOT NULL 
         AND trim(f.endDate) <> ""
         AND (f.status IS NULL OR NOT f.status IN ['Closed', 'Archived'])
       RETURN f.id as id, f.endDate as endDate, f.status as status`
    );

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let count = 0;
    for (const record of result.records) {
      const endDateStr = record.get("endDate");
      const status = record.get("status");
      if (status === 'Closed' || status === 'Archived') continue;

      const endDate = parseDateRobust(endDateStr);
      if (!endDate) continue;
      endDate.setHours(0, 0, 0, 0);

      const diffDays = Math.ceil((endDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays >= 0 && diffDays <= maxDays) {
        count++;
      }
    }

    res.json({
      success: true,
      count
    });
  } catch (error) {
    console.error("❌ Error fetching expiring document count:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch expiring document count",
      error: error.message
    });
  } finally {
    await session.close();
  }
});

/**
 * =========================================================================
 * GET /api/document/expiring
 * Server-side filtered & sorted endpoint for documents expiring within <= 60 days.
 * Supports query params:
 *   - days: number (default 60)
 *   - urgency: 'all' | 'critical' (<=15d) | 'medium' (16-30d) | 'approaching' (31-60d)
 *   - category: category name or 'All'
 *   - search: string search term
 * =========================================================================
 */
router.get("/expiring", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  const maxDays = parseInt(req.query.days, 10) || 60;
  const urgencyFilter = req.query.urgency || "all";
  const categoryFilter = req.query.category || "All";
  const searchFilter = (req.query.search || "").trim().toLowerCase();

  try {
    const result = await session.run(
      `MATCH (f:DocumentFolder)
       WHERE f.endDate IS NOT NULL 
         AND trim(f.endDate) <> ""
         AND (f.status IS NULL OR NOT f.status IN ['Closed', 'Archived'])
       OPTIONAL MATCH (parent:DocumentFolder)-[:HAS_SUBFOLDER]->(f)
       OPTIONAL MATCH (f)-[:CONTAINS_DOCUMENT]->(d:DocumentItem)
       RETURN f, parent.id as parentId, parent.name as parentName, collect(DISTINCT d) as documents
       ORDER BY f.endDate ASC`
    );

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const counts = {
      all: 0,
      critical: 0,    // 0 - 15 days
      medium: 0,      // 16 - 30 days
      approaching: 0  // 31 - 60 days
    };

    const expiringItems = [];

    for (const record of result.records) {
      const f = record.get("f").properties;
      const parentId = record.get("parentId") || f.parentFolderId || null;
      const parentName = record.get("parentName") || null;
      const rawDocs = record.get("documents");
      const documents = rawDocs
        ? rawDocs.map(d => d && d.properties).filter(d => d && d.id)
        : [];
      documents.sort((a, b) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0));

      if (f.status === 'Closed' || f.status === 'Archived') continue;

      const endDate = parseDateRobust(f.endDate);
      if (!endDate) continue;
      endDate.setHours(0, 0, 0, 0);

      const diffDays = Math.ceil((endDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays < 0 || diffDays > maxDays) continue;

      // Classify urgency
      let urgencyTier = 'approaching';
      if (diffDays <= 15) {
        urgencyTier = 'critical';
        counts.critical++;
      } else if (diffDays <= 30) {
        urgencyTier = 'medium';
        counts.medium++;
      } else {
        urgencyTier = 'approaching';
        counts.approaching++;
      }
      counts.all++;

      // Filter by urgency tier if requested
      if (urgencyFilter !== 'all' && urgencyTier !== urgencyFilter) {
        continue;
      }

      // Filter by category if requested
      if (categoryFilter !== 'All' && f.category !== categoryFilter) {
        continue;
      }

      // Filter by search query if requested
      if (searchFilter) {
        const nameMatch = (f.name || '').toLowerCase().includes(searchFilter);
        const descMatch = (f.description || '').toLowerCase().includes(searchFilter);
        const catMatch = (f.category || '').toLowerCase().includes(searchFilter);
        const parentMatch = parentName ? parentName.toLowerCase().includes(searchFilter) : false;
        const docMatch = documents.some(d => (d.name || '').toLowerCase().includes(searchFilter));

        if (!nameMatch && !descMatch && !catMatch && !parentMatch && !docMatch) {
          continue;
        }
      }

      expiringItems.push({
        ...f,
        parentFolderId: parentId,
        parentFolderName: parentName,
        daysRemaining: diffDays,
        urgency: urgencyTier,
        documentsCount: documents.length,
        documents: documents
      });
    }

    // Sort ascending by daysRemaining (most urgent first)
    expiringItems.sort((a, b) => a.daysRemaining - b.daysRemaining);

    res.json({
      success: true,
      totalCount: counts.all,
      counts,
      data: expiringItems
    });
  } catch (error) {
    console.error("❌ Error fetching expiring documents:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch expiring documents",
      error: error.message
    });
  } finally {
    await session.close();
  }
});

/**
 * =========================================================================
 * POST /api/document/folder - Create a new document folder / file container
 * =========================================================================
 */
router.post("/folder", upload.array("files", 10), async (req, res) => {
  const {
    name,
    description,
    startDate,
    endDate,
    category,
    visibilityRoles,
    parentFolderId,
    subFolderName,
    selectedExistingFolderId,
    itemType
  } = req.body;

  const cleanExistingId = (selectedExistingFolderId && selectedExistingFolderId.trim() && selectedExistingFolderId !== 'null' && selectedExistingFolderId !== 'undefined') ? selectedExistingFolderId.trim() : null;

  if (!cleanExistingId && (!name || !name.trim())) {
    return res.status(400).json({
      success: false,
      message: "File / Folder name is required"
    });
  }

  const today = new Date().toISOString().split("T")[0];
  const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const safeStartDate = (startDate && startDate.trim()) ? startDate.trim() : today;
  const safeEndDate = (endDate && endDate.trim()) ? endDate.trim() : nextYear;

  const driver = getDriver();
  const session = driver.session();

  try {
    const createdBy = req.user?.username || req.body.createdBy || "Admin";
    const nowISO = new Date().toISOString();

    let parsedRoles = ["All"];
    try {
      if (visibilityRoles) {
        parsedRoles = typeof visibilityRoles === "string" ? JSON.parse(visibilityRoles) : visibilityRoles;
      }
    } catch (e) {
      parsedRoles = ["All"];
    }

    let mainFolderId = cleanExistingId;
    let mainFolderName = name ? name.trim() : "";

    // 1. If not an existing folder, create the main DocumentFolder node
    if (!mainFolderId) {
      mainFolderId = crypto.randomUUID();
      const cleanParentId = (parentFolderId && parentFolderId.trim() && parentFolderId !== 'null' && parentFolderId !== 'undefined') ? parentFolderId.trim() : null;

      const folderData = {
        id: mainFolderId,
        name: mainFolderName,
        description: (description || "").trim(),
        startDate: safeStartDate,
        endDate: safeEndDate,
        category: (category || "PPO").trim(),
        parentFolderId: cleanParentId,
        itemType: (itemType || (req.files && req.files.length > 0 ? "file" : "folder")).trim(),
        visibilityRoles: Array.isArray(parsedRoles) ? parsedRoles : [parsedRoles],
        status: "Active",
        createdBy: createdBy,
        createdAt: nowISO,
        updatedAt: nowISO
      };

      await session.run(
        `CREATE (f:DocumentFolder $data) RETURN f`,
        { data: folderData }
      );

      // Link parent folder if this main folder itself is a sub-folder
      if (cleanParentId) {
        await session.run(
          `MATCH (parent:DocumentFolder { id: $parentId })
           MATCH (sub:DocumentFolder { id: $subId })
           MERGE (parent)-[:HAS_SUBFOLDER]->(sub)`,
          { parentId: cleanParentId, subId: mainFolderId }
        );
      }
    }

    // 2. Determine target folder for document uploads:
    // If subFolderName is provided, create the sub-folder inside mainFolderId and store docs there!
    // If no sub-folder is created, store docs directly in mainFolderId!
    let targetUploadFolderId = mainFolderId;
    let createdSubFolderData = null;

    if (subFolderName && subFolderName.trim()) {
      const subFolderId = crypto.randomUUID();
      createdSubFolderData = {
        id: subFolderId,
        name: subFolderName.trim(),
        description: `Sub-folder inside ${mainFolderName || 'parent file'}`,
        startDate: (startDate || "").trim(),
        endDate: (endDate || "").trim(),
        category: (category || "SPO").trim(),
        parentFolderId: mainFolderId,
        visibilityRoles: Array.isArray(parsedRoles) ? parsedRoles : [parsedRoles],
        status: "Active",
        createdBy: createdBy,
        createdAt: nowISO,
        updatedAt: nowISO
      };

      await session.run(
        `CREATE (sub:DocumentFolder $subData) RETURN sub`,
        { subData: createdSubFolderData }
      );

      await session.run(
        `MATCH (parent:DocumentFolder { id: $parentId })
         MATCH (sub:DocumentFolder { id: $subId })
         MERGE (parent)-[:HAS_SUBFOLDER]->(sub)`,
        { parentId: mainFolderId, subId: subFolderId }
      );

      // Documents must be stored in the sub-folder
      targetUploadFolderId = subFolderId;
    }

    // 3. If files were attached, upload and link them to targetUploadFolderId
    const uploadedDocs = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        let driveResult = null;
        try {
          driveResult = await uploadDocumentToFolder(
            file.buffer,
            file.originalname,
            file.mimetype,
            createdBy,
            "document_file",
            DOCUMENT_FOLDER_ID
          );
        } catch (uploadErr) {
          console.warn("⚠️ Google Drive upload warning:", uploadErr.message);
        }

        const docId = crypto.randomUUID();
        const driveLink = driveResult?.viewLink || (driveResult?.fileId ? `https://drive.google.com/file/d/${driveResult.fileId}/view` : null);
        const downloadLink = driveResult?.downloadLink || driveResult?.directLink || (driveResult?.fileId ? `https://drive.google.com/uc?export=download&id=${driveResult.fileId}` : null);
        const webViewLink = driveResult?.viewLink || driveLink;

        const docData = {
          id: docId,
          name: file.originalname,
          fileSize: formatBytes(file.size),
          sizeBytes: file.size,
          mimeType: file.mimetype,
          fileId: driveResult?.fileId || null,
          driveLink: driveLink,
          webViewLink: webViewLink,
          downloadLink: downloadLink,
          driveFolderId: DOCUMENT_FOLDER_ID,
          driveFolderLink: `https://drive.google.com/drive/folders/${DOCUMENT_FOLDER_ID}?usp=drive_link`,
          uploadedBy: createdBy,
          uploadedAt: new Date().toISOString()
        };

        await session.run(
          `MATCH (f:DocumentFolder { id: $folderId })
           CREATE (d:DocumentItem $docData)
           CREATE (f)-[:CONTAINS_DOCUMENT]->(d)`,
          { folderId: targetUploadFolderId, docData }
        );

        uploadedDocs.push(docData);
      }
    }

    res.status(201).json({
      success: true,
      message: createdSubFolderData
        ? `Sub-folder "${createdSubFolderData.name}" created and documents stored inside it!`
        : `Document file created successfully!`,
      data: {
        id: targetUploadFolderId,
        mainFolderId: mainFolderId,
        subFolderId: createdSubFolderData ? createdSubFolderData.id : null,
        documentsCount: uploadedDocs.length,
        documents: uploadedDocs
      }
    });
  } catch (error) {
    console.error("❌ Error creating document folder:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create document folder",
      error: error.message
    });
  } finally {
    await session.close();
  }
});

/**
 * =========================================================================
 * PUT /api/document/folder/:id - Update folder metadata (name, dates, etc.)
 * =========================================================================
 */
router.put("/folder/:id", async (req, res) => {
  const { id } = req.params;
  const { name, description, startDate, endDate, category, visibilityRoles, status } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, message: "File name is required" });
  }

  const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const safeEndDate = (endDate && endDate.trim()) ? endDate.trim() : nextYear;

  const driver = getDriver();
  const session = driver.session();

  try {
    let parsedRoles = undefined;
    if (visibilityRoles) {
      try {
        parsedRoles = typeof visibilityRoles === "string" ? JSON.parse(visibilityRoles) : visibilityRoles;
      } catch (e) {
        parsedRoles = [visibilityRoles];
      }
    }

    const updateData = {
      name: name.trim(),
      description: description !== undefined ? description.trim() : "",
      startDate: startDate !== undefined ? startDate.trim() : "",
      endDate: endDate !== undefined ? safeEndDate : "",
      category: category !== undefined ? category.trim() : "SPO",
      status: status || "Active",
      updatedAt: new Date().toISOString()
    };

    // If endDate was modified, reset the notification flag so future 2-month alert will fire
    if (endDate !== undefined) {
      updateData.expiryNotificationSent = false;
      updateData.expiryNotificationSentAt = null;
    }

    if (parsedRoles) {
      updateData.visibilityRoles = parsedRoles;
    }

    const result = await session.run(
      `MATCH (f:DocumentFolder { id: $id })
       SET f += $updateData
       RETURN f`,
      { id, updateData }
    );

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "Document folder not found" });
    }

    res.json({
      success: true,
      message: "Document folder updated successfully",
      data: result.records[0].get("f").properties
    });
  } catch (error) {
    console.error(`❌ Error updating document folder ${id}:`, error);
    res.status(500).json({
      success: false,
      message: "Failed to update document folder",
      error: error.message
    });
  } finally {
    await session.close();
  }
});

/**
 * =========================================================================
 * PUT /api/document/folder/:id/close - Mark document folder as Closed
 * Stops all recurring weekly reminder emails for this document
 * =========================================================================
 */
router.put("/folder/:id/close", async (req, res) => {
  const { id } = req.params;
  const closedBy = req.user?.username || req.user?.email || "Admin";
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(
      `MATCH (f:DocumentFolder { id: $id })
       SET f.status = 'Closed',
           f.closedAt = datetime(),
           f.closedBy = $closedBy,
           f.updatedAt = datetime()
       RETURN f`,
      { id, closedBy }
    );

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "Document folder not found" });
    }

    res.json({
      success: true,
      message: "Document marked as Closed. Weekly reminder emails have been stopped.",
      data: result.records[0].get("f").properties
    });
  } catch (error) {
    console.error(`❌ Error closing document folder ${id}:`, error);
    res.status(500).json({
      success: false,
      message: "Failed to close document folder",
      error: error.message
    });
  } finally {
    await session.close();
  }
});

/**
 * =========================================================================
 * PUT /api/document/folder/:id/reopen - Reopen a Closed document folder
 * Restores status to Active
 * =========================================================================
 */
router.put("/folder/:id/reopen", async (req, res) => {
  const { id } = req.params;
  const reopenedBy = req.user?.username || req.user?.email || "Admin";
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(
      `MATCH (f:DocumentFolder { id: $id })
       SET f.status = 'Active',
           f.reopenedAt = datetime(),
           f.reopenedBy = $reopenedBy,
           f.updatedAt = datetime()
       REMOVE f.closedAt, f.closedBy
       RETURN f`,
      { id, reopenedBy }
    );

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "Document folder not found" });
    }

    res.json({
      success: true,
      message: "Document reopened as Active.",
      data: result.records[0].get("f").properties
    });
  } catch (error) {
    console.error(`❌ Error reopening document folder ${id}:`, error);
    res.status(500).json({
      success: false,
      message: "Failed to reopen document folder",
      error: error.message
    });
  } finally {
    await session.close();
  }
});

/**
 * =========================================================================
 * POST /api/document/check-expirations - Trigger 2-month document expiry check
 * =========================================================================
 */
router.post("/check-expirations", async (req, res) => {
  try {
    const report = await checkAndSendDocumentExpiryNotifications();
    res.json({
      success: true,
      message: `Checked ${report.checked} items. Sent ${report.emailsSent} notification email(s) for ${report.expiring} item(s) expiring within 2 months.`,
      data: report
    });
  } catch (error) {
    console.error("❌ Error checking document expirations:", error);
    res.status(500).json({
      success: false,
      message: "Failed to check document expirations",
      error: error.message
    });
  }
});

/**
 * =========================================================================
 * POST /api/document/folder/:id/upload - Upload additional documents into a folder
 * =========================================================================
 */
router.post("/folder/:id/upload", upload.array("files", 10), async (req, res) => {
  const { id } = req.params;

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ success: false, message: "No files provided for upload" });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    const checkFolder = await session.run(
      `MATCH (f:DocumentFolder { id: $id }) RETURN f`,
      { id }
    );

    if (checkFolder.records.length === 0) {
      return res.status(404).json({ success: false, message: "Document folder not found" });
    }

    const uploadedBy = req.user?.username || req.body.uploadedBy || "Admin";
    const uploadedDocs = [];

    for (const file of req.files) {
      let driveResult = null;
      try {
        driveResult = await uploadDocumentToFolder(
          file.buffer,
          file.originalname,
          file.mimetype,
          uploadedBy,
          "document_file",
          DOCUMENT_FOLDER_ID
        );
      } catch (uploadErr) {
        console.warn("⚠️ Google Drive upload error:", uploadErr.message);
      }

      const docId = crypto.randomUUID();
      const driveLink = driveResult?.viewLink || (driveResult?.fileId ? `https://drive.google.com/file/d/${driveResult.fileId}/view` : null);
      const downloadLink = driveResult?.downloadLink || driveResult?.directLink || (driveResult?.fileId ? `https://drive.google.com/uc?export=download&id=${driveResult.fileId}` : null);
      const webViewLink = driveResult?.viewLink || driveLink;

      const docData = {
        id: docId,
        name: file.originalname,
        fileSize: formatBytes(file.size),
        sizeBytes: file.size,
        mimeType: file.mimetype,
        fileId: driveResult?.fileId || null,
        driveLink: driveLink,
        webViewLink: webViewLink,
        downloadLink: downloadLink,
        driveFolderId: DOCUMENT_FOLDER_ID,
        driveFolderLink: `https://drive.google.com/drive/folders/${DOCUMENT_FOLDER_ID}?usp=drive_link`,
        uploadedBy: uploadedBy,
        uploadedAt: new Date().toISOString()
      };

      await session.run(
        `MATCH (f:DocumentFolder { id: $folderId })
         CREATE (d:DocumentItem $docData)
         CREATE (f)-[:CONTAINS_DOCUMENT]->(d)
         SET f.updatedAt = datetime()`,
        { folderId: id, docData }
      );

      uploadedDocs.push(docData);
    }

    res.json({
      success: true,
      message: `${uploadedDocs.length} document(s) uploaded successfully`,
      data: uploadedDocs
    });
  } catch (error) {
    console.error(`❌ Error uploading to folder ${id}:`, error);
    res.status(500).json({
      success: false,
      message: "Failed to upload documents",
      error: error.message
    });
  } finally {
    await session.close();
  }
});

/**
 * =========================================================================
 * DELETE /api/document/folder/:folderId/document/:docId - Delete single document
 * =========================================================================
 */
router.delete("/folder/:folderId/document/:docId", async (req, res) => {
  const { folderId, docId } = req.params;

  const driver = getDriver();
  const session = driver.session();

  try {
    const docResult = await session.run(
      `MATCH (f:DocumentFolder { id: $folderId })-[:CONTAINS_DOCUMENT]->(d:DocumentItem { id: $docId })
       RETURN d`,
      { folderId, docId }
    );

    if (docResult.records.length === 0) {
      return res.status(404).json({ success: false, message: "Document not found in this folder" });
    }

    const docProps = docResult.records[0].get("d").properties;

    // Delete from Google Drive if fileId exists
    if (docProps.fileId) {
      try {
        await deleteFileFromDrive(docProps.fileId);
      } catch (err) {
        console.warn(`Could not delete Drive file ${docProps.fileId}:`, err.message);
      }
    }

    // Delete from Neo4j
    await session.run(
      `MATCH (f:DocumentFolder { id: $folderId })-[r:CONTAINS_DOCUMENT]->(d:DocumentItem { id: $docId })
       DETACH DELETE d
       SET f.updatedAt = datetime()`,
      { folderId, docId }
    );

    res.json({
      success: true,
      message: "Document deleted successfully"
    });
  } catch (error) {
    console.error(`❌ Error deleting document ${docId}:`, error);
    res.status(500).json({
      success: false,
      message: "Failed to delete document",
      error: error.message
    });
  } finally {
    await session.close();
  }
});

/**
 * =========================================================================
 * DELETE /api/document/folder/:id - Delete an entire folder and all its documents
 * =========================================================================
 */
router.delete("/folder/:id", async (req, res) => {
  const { id } = req.params;

  const driver = getDriver();
  const session = driver.session();

  try {
    // Find folder, all nested subfolders, and all attached documents
    const result = await session.run(
      `MATCH (f:DocumentFolder { id: $id })
       OPTIONAL MATCH (f)-[:HAS_SUBFOLDER*0..]->(sub:DocumentFolder)
       OPTIONAL MATCH (sub)-[:CONTAINS_DOCUMENT]->(d:DocumentItem)
       RETURN f, collect(DISTINCT sub) as allFolders, [x IN collect(DISTINCT d) WHERE x IS NOT NULL] as allDocs`,
      { id }
    );
    

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "Document folder not found" });
    }

    const allDocs = result.records[0].get("allDocs");
    if (allDocs && allDocs.length > 0) {
      for (const d of allDocs) {
        const docProps = d.properties;
        if (docProps && docProps.fileId) {
          try {
            await deleteFileFromDrive(docProps.fileId);
          } catch (err) {
            console.warn(`Could not delete Drive file ${docProps.fileId}:`, err.message);
          }
        }
      }
    }

    // Delete folder, all descendant subfolders, and documents from Neo4j safely
    await session.run(
      `MATCH (f:DocumentFolder { id: $id })
       OPTIONAL MATCH (f)-[:HAS_SUBFOLDER*1..]->(sub:DocumentFolder)
       OPTIONAL MATCH (f)-[:HAS_SUBFOLDER*0..]->(anyF:DocumentFolder)-[:CONTAINS_DOCUMENT]->(d:DocumentItem)
       WITH f, collect(DISTINCT sub) AS subs, collect(DISTINCT d) AS docs
       FOREACH (doc IN [x IN docs WHERE x IS NOT NULL] | DETACH DELETE doc)
       FOREACH (s IN [x IN subs WHERE x IS NOT NULL] | DETACH DELETE s)
       DETACH DELETE f`,
      { id }
    );

    res.json({
      success: true,
      message: "Document folder and all its documents deleted successfully"
    });
  } catch (error) {
    console.error(`❌ Error deleting document folder ${id}:`, error);
    res.status(500).json({
      success: false,
      message: "Failed to delete document folder",
      error: error.message
    });
  } finally {
    await session.close();
  }
});


/**
 * =========================================================================
 * GET /api/document/notification-recipients
 * Fetch all configured notification email recipients
 * =========================================================================
 */
router.get('/notification-recipients', async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (n:NotificationConfig { type: 'documentExpiry' })
      RETURN n.emails AS emails, n.updatedAt AS updatedAt, n.updatedBy AS updatedBy
    `);
    if (result.records.length === 0) {
      // Return defaults if not yet configured
      return res.json({
        success: true,
        recipients: ['bharathibharathi06733@gmail.com', 'bharill@kyotralis.com'],
        updatedAt: null,
        updatedBy: null
      });
    }
    const rec = result.records[0];
    const emails = rec.get('emails') || [];
    return res.json({
      success: true,
      recipients: emails,
      updatedAt: rec.get('updatedAt'),
      updatedBy: rec.get('updatedBy')
    });
  } catch (error) {
    console.error('❌ Error fetching notification recipients:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch recipients', error: error.message });
  } finally {
    await session.close();
  }
});

/**
 * =========================================================================
 * POST /api/document/notification-recipients
 * Add a new email to the notification recipients list
 * =========================================================================
 */
router.post('/notification-recipients', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'A valid email address is required' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  const updatedBy = req.user?.email || req.user?.name || 'Admin';

  const driver = getDriver();
  const session = driver.session();
  try {
    // Merge config node, then add email to list if not already present
    const result = await session.run(`
      MERGE (n:NotificationConfig { type: 'documentExpiry' })
      ON CREATE SET n.emails = [$email], n.createdAt = datetime(), n.updatedAt = datetime(), n.updatedBy = $updatedBy
      WITH n
      WHERE NOT $email IN coalesce(n.emails, [])
      SET n.emails = coalesce(n.emails, []) + [$email],
          n.updatedAt = datetime(),
          n.updatedBy = $updatedBy
      RETURN n.emails AS emails
    `, { email: normalizedEmail, updatedBy });

    // If WHERE blocked it (email already existed), re-fetch
    let emails;
    if (result.records.length === 0) {
      const fetchResult = await session.run(`
        MATCH (n:NotificationConfig { type: 'documentExpiry' })
        RETURN n.emails AS emails
      `);
      emails = fetchResult.records[0]?.get('emails') || [normalizedEmail];
      return res.json({ success: false, message: 'Email already exists in the list', recipients: emails });
    }
    emails = result.records[0].get('emails');
    return res.json({ success: true, message: `${normalizedEmail} added to notification recipients`, recipients: emails });
  } catch (error) {
    console.error('❌ Error adding notification recipient:', error);
    res.status(500).json({ success: false, message: 'Failed to add recipient', error: error.message });
  } finally {
    await session.close();
  }
});

/**
 * =========================================================================
 * DELETE /api/document/notification-recipients/:email
 * Remove an email from the notification recipients list
 * =========================================================================
 */
router.delete('/notification-recipients/:email', async (req, res) => {
  const emailToRemove = decodeURIComponent(req.params.email).trim().toLowerCase();
  const updatedBy = req.user?.email || req.user?.name || 'Admin';

  // Build initial emails from env (used to seed the node if it doesn't exist yet)
  const envEmails = (process.env.DOCUMENT_EXPIRY_NOTIFICATION_EMAILS || process.env.ADMIN_EMAIL || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(e => e && e.includes('@'));

  const driver = getDriver();
  const session = driver.session();
  try {
    // MERGE: create node from env defaults if it doesn't exist, then remove the target email
    const result = await session.run(`
      MERGE (n:NotificationConfig { type: 'documentExpiry' })
      ON CREATE SET n.emails = $envEmails, n.createdAt = datetime()
      WITH n
      SET n.emails = [e IN coalesce(n.emails, $envEmails) WHERE e <> $email],
          n.updatedAt = datetime(),
          n.updatedBy = $updatedBy
      RETURN n.emails AS emails
    `, { email: emailToRemove, updatedBy, envEmails });

    const emails = result.records[0]?.get('emails') || [];
    return res.json({ success: true, message: `${emailToRemove} removed from notification recipients`, recipients: emails });
  } catch (error) {
    console.error('❌ Error removing notification recipient:', error);
    res.status(500).json({ success: false, message: 'Failed to remove recipient', error: error.message });
  } finally {
    await session.close();
  }
});

module.exports = router;

