const express = require("express");
const router = express.Router();
const multer = require("multer");
const getDriver = require("../lib/neo4j");
const { uploadTrainingMaterial, deleteFileFromDrive } = require("../services/googleDrive");
const crypto = require('crypto');

// Multer setup - memory storage since we upload directly to Google Drive
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit for training materials
});

// GET all training materials
router.get("/", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:Training_Material) 
       RETURN t ORDER BY t.createdAt DESC`
    );

    const materials = result.records.map(record => record.get('t').properties);
    
    res.json({
      success: true,
      data: materials
    });
  } catch (error) {
    console.error("Error fetching training materials:", error);
    res.status(500).json({ success: false, message: "Failed to fetch training materials" });
  } finally {
    await session.close();
  }
});

// POST upload new training material
router.post("/upload", upload.fields([{ name: 'file', maxCount: 1 }, { name: 'videoFile', maxCount: 1 }]), async (req, res) => {
// File is now optional

    const { title, description, category, visibilityRoles, uploadedBy, referenceLink, layoutOrder } = req.body;
  
    if (!title) {
      return res.status(400).json({ success: false, message: "Title is required" });
    }
  
    const driver = getDriver();
    const session = driver.session();
    
    try {
      let driveResult = null;
      let videoDriveResult = null;

      const docFile = req.files && req.files['file'] ? req.files['file'][0] : null;
      const vidFile = req.files && req.files['videoFile'] ? req.files['videoFile'][0] : null;

      // 1. Upload Document to Google Drive
      if (docFile) {
        driveResult = await uploadTrainingMaterial(
          docFile.buffer,
          docFile.originalname,
          docFile.mimetype,
          uploadedBy || 'admin'
        );
        if (!driveResult || !driveResult.success) throw new Error(driveResult?.error || "Failed to upload document to Google Drive");
      }

      // 2. Upload Video to Google Drive
      if (vidFile) {
        videoDriveResult = await uploadTrainingMaterial(
          vidFile.buffer,
          vidFile.originalname,
          vidFile.mimetype,
          uploadedBy || 'admin'
        );
        if (!videoDriveResult || !videoDriveResult.success) throw new Error(videoDriveResult?.error || "Failed to upload video to Google Drive");
      }
  
      // 3. Save metadata to Neo4j
      const id = crypto.randomUUID();
      let parsedRoles = [];
      try {
        parsedRoles = visibilityRoles ? JSON.parse(visibilityRoles) : ["All"];
      } catch (e) {
        parsedRoles = ["All"];
      }
  
      let parsedLayoutOrder = ['DOCUMENT', 'TEXT', 'LINK'];
      try {
        if (layoutOrder) parsedLayoutOrder = JSON.parse(layoutOrder);
      } catch (e) {
        parsedLayoutOrder = ['DOCUMENT', 'TEXT', 'LINK'];
      }
  
      const materialData = {
        id,
        title,
        description: description || "",
        category: category || "General",
        visibilityRoles: parsedRoles,
        fileName: docFile ? docFile.originalname : null,
        mimeType: docFile ? docFile.mimetype : null,
        googleDriveFileId: driveResult ? driveResult.fileId : null,
        googleDriveViewLink: driveResult ? driveResult.viewLink : null,
        googleDriveDownloadLink: driveResult ? driveResult.directLink : null,
        referenceLink: referenceLink || "",
        videoLink: videoDriveResult ? videoDriveResult.viewLink : "",
        videoDriveFileId: videoDriveResult ? videoDriveResult.fileId : null,
        layoutOrder: JSON.stringify(parsedLayoutOrder),
        uploadedBy: uploadedBy || "admin",
        createdAt: new Date().toISOString()
      };

    const result = await session.run(
      `CREATE (t:Training_Material) SET t = $data RETURN t`,
      { data: materialData }
    );

    const savedMaterial = result.records[0].get('t').properties;

    res.status(201).json({
      success: true,
      message: "Training material uploaded successfully",
      data: savedMaterial
    });

  } catch (error) {
    console.error("Error uploading training material:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to upload material" });
  } finally {
    await session.close();
  }
});

// DELETE a training material
router.delete("/:id", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { id } = req.params;

  try {
    // Get file ID first
    const findResult = await session.run(
      `MATCH (t:Training_Material {id: $id}) RETURN t.googleDriveFileId AS fileId`,
      { id }
    );

    if (findResult.records.length === 0) {
      return res.status(404).json({ success: false, message: "Material not found" });
    }

    const fileId = findResult.records[0].get('fileId');

    // Delete from Neo4j
    await session.run(
      `MATCH (t:Training_Material {id: $id}) DETACH DELETE t`,
      { id }
    );

    // Delete from Google Drive
    if (fileId) {
      try {
        await deleteFileFromDrive(fileId);
      } catch (driveErr) {
        console.warn("Failed to delete file from Google Drive, but database record was removed", driveErr);
      }
    }

    res.json({ success: true, message: "Training material deleted successfully" });
  } catch (error) {
    console.error("Error deleting training material:", error);
    res.status(500).json({ success: false, message: "Failed to delete training material" });
  } finally {
    await session.close();
  }
});

// PUT update a training material
router.put("/:id", upload.fields([{ name: 'file', maxCount: 1 }, { name: 'videoFile', maxCount: 1 }]), async (req, res) => {
  const { id } = req.params;
  const { title, description, category, visibilityRoles, referenceLink, layoutOrder } = req.body;

  if (!title) {
    return res.status(400).json({ success: false, message: "Title is required" });
  }

  const driver = getDriver();
  const session = driver.session();
  
  try {
    // 1. Check if material exists
    const findResult = await session.run(
      `MATCH (t:Training_Material {id: $id}) RETURN t`,
      { id }
    );

    if (findResult.records.length === 0) {
      return res.status(404).json({ success: false, message: "Material not found" });
    }

    const existingMaterial = findResult.records[0].get('t').properties;
    // 3. Prepare update data
    let parsedRoles = [];
    try {
      parsedRoles = visibilityRoles ? JSON.parse(visibilityRoles) : ["All"];
    } catch (e) {
      parsedRoles = ["All"];
    }

    let parsedLayoutOrder = ['DOCUMENT', 'TEXT', 'LINK'];
    try {
      if (layoutOrder) parsedLayoutOrder = JSON.parse(layoutOrder);
    } catch (e) {
      parsedLayoutOrder = ['DOCUMENT', 'TEXT', 'LINK'];
    }

    let driveResult = null;
    let videoDriveResult = null;
    
    const docFile = req.files && req.files['file'] ? req.files['file'][0] : null;
    const vidFile = req.files && req.files['videoFile'] ? req.files['videoFile'][0] : null;

    if (docFile) {
      driveResult = await uploadTrainingMaterial(
        docFile.buffer,
        docFile.originalname,
        docFile.mimetype,
        "admin" // Hardcoded for update as uploadedBy isn't sent
      );
      if (!driveResult || !driveResult.success) throw new Error(driveResult?.error || "Failed to upload new document");

      // Delete old file from Drive if it existed
      if (existingMaterial.googleDriveFileId) {
        try {
          await deleteFileFromDrive(existingMaterial.googleDriveFileId);
        } catch (e) {
          console.warn("Failed to delete old file from Drive", e);
        }
      }
    }

    if (vidFile) {
      videoDriveResult = await uploadTrainingMaterial(
        vidFile.buffer,
        vidFile.originalname,
        vidFile.mimetype,
        "admin"
      );
      if (!videoDriveResult || !videoDriveResult.success) throw new Error(videoDriveResult?.error || "Failed to upload new video");

      // Delete old video from Drive if it existed
      if (existingMaterial.videoDriveFileId) {
        try {
          await deleteFileFromDrive(existingMaterial.videoDriveFileId);
        } catch (e) {
          console.warn("Failed to delete old video from Drive", e);
        }
      }
    }

    const updateData = {
      title,
      description: description || "",
      category: category || "General",
      visibilityRoles: parsedRoles,
      referenceLink: referenceLink || "",
      layoutOrder: JSON.stringify(parsedLayoutOrder),
      // Update file info only if new file uploaded, else keep existing
      fileName: driveResult ? docFile.originalname : existingMaterial.fileName,
      mimeType: driveResult ? docFile.mimetype : existingMaterial.mimeType,
      googleDriveFileId: driveResult ? driveResult.fileId : existingMaterial.googleDriveFileId,
      googleDriveViewLink: driveResult ? driveResult.viewLink : existingMaterial.googleDriveViewLink,
      googleDriveDownloadLink: driveResult ? driveResult.directLink : existingMaterial.googleDriveDownloadLink,
      videoLink: videoDriveResult ? videoDriveResult.viewLink : existingMaterial.videoLink,
      videoDriveFileId: videoDriveResult ? videoDriveResult.fileId : existingMaterial.videoDriveFileId
    };

    // 4. Update Neo4j
    const updateResult = await session.run(
      `MATCH (t:Training_Material {id: $id})
       SET t += $updateData
       RETURN t`,
      { id, updateData }
    );

    res.json({
      success: true,
      message: "Training material updated successfully",
      data: updateResult.records[0].get('t').properties
    });

  } catch (error) {
    console.error("Error updating training material:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to update material" });
  } finally {
    await session.close();
  }
});

module.exports = router;
