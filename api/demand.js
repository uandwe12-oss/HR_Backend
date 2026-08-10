const express = require("express");
const router = express.Router();

// Import the shared driver helper
const getDriver = require("../lib/neo4j");

/**
 * =================================================
 * Test Endpoint
 * =================================================
 */
router.get("/test", async (req, res) => {
  
  // Get driver and create session
  const driver = getDriver();
  const session = driver.session();
  
  try {
    console.log("🔍 Testing Neo4j connection...");
    const result = await session.run("RETURN 'Backend is working!' as message, datetime() as timestamp");
    const message = result.records[0].get("message");
    const timestamp = result.records[0].get("timestamp");
    
    
    res.json({
      success: true,
      message: message,
      timestamp: timestamp.toString(),
      neo4jConnected: true
    });
  } catch (error) {
    console.error("❌ Test endpoint error:", error.message);
    res.status(500).json({
      success: false,
      message: "Backend test failed",
      error: error.message,
      neo4jConnected: false
    });
  } finally {
    await session.close();
  }
});
/**
 * =================================================
 * GET – Fetch all unique client names from demands
 * =================================================
 */
router.get("/clients/list", async (req, res) => {
 
  // Get driver and create session
  const driver = getDriver();
  const session = driver.session();
 
  try {
    // console.log("🔍 Executing Neo4j query for unique client names...");
    const result = await session.run(
      `MATCH (d:Demand)
       WHERE d.clientName IS NOT NULL AND d.clientName <> ''
       RETURN DISTINCT d.clientName as clientName
       ORDER BY d.clientName`
    );
 
   
    const clients = result.records.map(record => ({
      name: record.get("clientName")
    }));
 
  
    res.json({
      success: true,
      clients: clients
    });
 
  } catch (err) {
    console.error("❌ Error fetching client names:", err.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch client names",
      error: err.message
    });
  } finally {
    await session.close();
  }
});
/**
 * =================================================
 * GET – Fetch all Demands
 * =================================================
 */
router.get("/", async (req, res) => {
  
  // Get driver and create session
  const driver = getDriver();
  const session = driver.session();

  try {
    // console.log("🔍 Executing Neo4j query...");
    const result = await session.run(
      "MATCH (d:Demand) RETURN d ORDER BY d.createdDate DESC"
    );

    
    const demands = result.records.map(r => {
      const d = r.get("d").properties;
      return d;
    });

    res.json(demands);
  } catch (err) {
    console.error("❌ Error fetching demands:", err.message);
    res.status(500).json({ 
      message: "Failed to fetch demands",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});

/**
 * =================================================
 * GET – Get Client Name by Demand ID
 * =================================================
 */
router.get("/:id/client", async (req, res) => {
  
  // Get driver and create session
  const driver = getDriver();
  const session = driver.session();
  const id = Number(req.params.id);

  try {
    const result = await session.run(
      "MATCH (d:Demand {id:$id}) RETURN d.clientName as clientName",
      { id }
    );

    if (!result.records.length) {
      return res.status(404).json({ 
        success: false, 
        message: "Demand not found" 
      });
    }

    const clientName = result.records[0].get("clientName");
    
    res.json({
      success: true,
      demandId: id,
      clientName: clientName
    });
    
  } catch (err) {
    console.error(`❌ Error fetching client name for demand ${id}:`, err.message);
    res.status(500).json({ 
      success: false,
      message: "Error fetching client name",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});
/**
 * =================================================
 * PUT – Update Demand (with status change tracking)
 * =================================================
 */
router.put("/:id", async (req, res) => {
  
  const driver = getDriver();
  const session = driver.session();
  const id = Number(req.params.id);

  try {
    // console.log(`🔍 Updating demand ID: ${id}`);
    // console.log("📝 Update data:", req.body);
    
    // First, get the current demand to check if status is changing
    const currentDemandResult = await session.run(
      "MATCH (d:Demand {id:$id}) RETURN d",
      { id }
    );
    
    let updateData = { ...req.body };
    
    if (currentDemandResult.records.length > 0) {
      const currentDemand = currentDemandResult.records[0].get("d").properties;
      const currentStatus = currentDemand.status;
      const newStatus = req.body.status;
      
      // If status is changing to Fulfilled, Closed, or Cancelled, record the end date
      if (currentStatus !== newStatus && 
          (newStatus === "Fulfilled" || newStatus === "Closed" || newStatus === "Cancelled")) {
        updateData.statusChangedDate = new Date().toISOString().split('T')[0];
        // console.log(`📅 Status changed to ${newStatus} - setting end date: ${updateData.statusChangedDate}`);
      }
      
      // If status is changing back to Active, clear the end date
      if (currentStatus !== newStatus && newStatus === "Active") {
        updateData.statusChangedDate = "";
        // console.log(`📅 Status changed back to Active - clearing end date`);
      }
    }
    
    const result = await session.run(
      `MATCH (d:Demand {id:$id})
       SET d += $data
       RETURN d`,
      { id, data: updateData }
    );

    if (!result.records.length) {
      // console.log(`❌ Demand with ID ${id} not found for update`);
      return res.status(404).json({ message: "Demand not found" });
    }

    res.json({
      message: "Demand updated successfully",
      data: result.records[0].get("d").properties
    });
  } catch (err) {
    console.error(`❌ Error updating demand ${id}:`, err.message);
    res.status(500).json({ 
      message: "Failed to update demand",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});

/**
 * =================================================
 * POST – Create Demand (with creation date tracking)
 * =================================================
 */
router.post("/", async (req, res) => {
  
  const driver = getDriver();
  const session = driver.session();

  try {
    // Get next ID
    const idResult = await session.run(
      "MATCH (d:Demand) RETURN coalesce(MAX(d.id), 0) + 1 AS nextId"
    );
    
    const nextIdRecord = idResult.records[0].get("nextId");
    const id = nextIdRecord.low !== undefined ? nextIdRecord.toNumber() : Number(nextIdRecord);

    const demandData = {
      id,
      clientName: req.body.clientName || "",
      country: req.body.country || "",
      createdDate: req.body.createdDate || new Date().toISOString().split("T")[0],
      expFrom: Number(req.body.expFrom || 0),
      expTo: Number(req.body.expTo || 0),
      interviewer1: req.body.interviewer1 || "",
      interviewer2: req.body.interviewer2 || "",
      jobDescription: req.body.jobDescription || "",
      jobPriority: req.body.jobPriority || "Medium",
      location: req.body.location || "",
      primarySkill: req.body.primarySkill || [],
      secondarySkill: req.body.secondarySkill || [],
      recruiterPOC: req.body.recruiterPOC || "",
      status: req.body.status || "Active",
      statusChangedDate: "", // Initialize empty
      statusHistory: req.body.statusHistory || "" // Store reason
    };

    const result = await session.run(
      `CREATE (d:Demand)
       SET d = $data
       RETURN d`,
      { data: demandData }
    );

    const created = result.records[0].get("d").properties;


    res.status(201).json({
      success: true,
      message: "Demand created successfully",
      data: created
    });

  } catch (err) {
    console.error("❌ CREATE ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Failed to create demand",
      error: err.message
    });
  } finally {
    await session.close();
  }
});


// Add to demand.js
/**
 * POST /api/demand/export/trigger
 * Manually trigger demand export
 */
router.post("/export/trigger", async (req, res) => {
  
  try {
    const { manualDemandExport } = require('../services/autoExportDemand');
    const result = await manualDemandExport();
    res.json(result);
  } catch (err) {
    console.error("Manual demand export error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add this GET version for browser testing (temporary)
router.get("/export/trigger", async (req, res) => {
  
  try {
    const { manualDemandExport } = require('../services/autoExportDemand');
    const result = await manualDemandExport();
    res.json(result);
  } catch (err) {
    console.error("Manual demand export error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * =================================================
 * DELETE – Delete Demand by ID
 * =================================================
 */
/**
 * =================================================
 * DELETE – Delete Demand by ID (with relationships)
 * =================================================
 */
router.delete("/:id", async (req, res) => {
  
  const driver = getDriver();
  const session = driver.session();
  const id = Number(req.params.id);

  try {
    const checkResult = await session.run(
      "MATCH (d:Demand {id: $id}) RETURN d",
      { id }
    );

    if (!checkResult.records.length) {
      console.log(`❌ Demand with ID ${id} not found`);
      return res.status(404).json({ 
        success: false,
        message: "Demand not found" 
      });
    }

    
    // ✅ FIRST: Delete all relationships connected to this demand node
    // This includes any SELECTED_FOR relationships to candidates
    await session.run(
      "MATCH (d:Demand {id: $id})-[r]-() DELETE r",
      { id }
    );
    
    
    // ✅ SECOND: Delete the demand node itself
    await session.run(
      "MATCH (d:Demand {id: $id}) DELETE d",
      { id }
    );

    
    res.json({
      success: true,
      message: "Demand deleted successfully"
    });

  } catch (err) {
    console.error(`❌ Error deleting demand ${id}:`, err);
    res.status(500).json({ 
      success: false,
      message: "Failed to delete demand",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});

module.exports = router;
