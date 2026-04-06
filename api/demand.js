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
  console.log("\n📡 GET /api/demand/test - Called");
  
  // Get driver and create session
  const driver = getDriver();
  const session = driver.session();
  
  try {
    console.log("🔍 Testing Neo4j connection...");
    const result = await session.run("RETURN 'Backend is working!' as message, datetime() as timestamp");
    const message = result.records[0].get("message");
    const timestamp = result.records[0].get("timestamp");
    
    console.log("✅ Test successful:", message);
    
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
  console.log("\n📡 GET /api/demand/clients/list - Fetching unique client names");
 
  // Get driver and create session
  const driver = getDriver();
  const session = driver.session();
 
  try {
    console.log("🔍 Executing Neo4j query for unique client names...");
    const result = await session.run(
      `MATCH (d:Demand)
       WHERE d.clientName IS NOT NULL AND d.clientName <> ''
       RETURN DISTINCT d.clientName as clientName
       ORDER BY d.clientName`
    );
 
    console.log(`📊 Found ${result.records.length} unique client names`);
   
    const clients = result.records.map(record => ({
      name: record.get("clientName")
    }));
 
    console.log("✅ Successfully fetched client names");
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
  console.log("\n📡 GET /api/demand - Fetching all demands");
  
  // Get driver and create session
  const driver = getDriver();
  const session = driver.session();

  try {
    console.log("🔍 Executing Neo4j query...");
    const result = await session.run(
      "MATCH (d:Demand) RETURN d ORDER BY d.createdDate DESC"
    );

    console.log(`📊 Found ${result.records.length} demands`);
    
    const demands = result.records.map(r => {
      const d = r.get("d").properties;
      return d;
    });

    console.log("✅ Successfully fetched demands");
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
  console.log(`\n📡 GET /api/demand/${req.params.id}/client - Fetching client name for demand`);
  
  // Get driver and create session
  const driver = getDriver();
  const session = driver.session();
  const id = Number(req.params.id);

  try {
    console.log(`🔍 Looking for demand with ID: ${id}`);
    const result = await session.run(
      "MATCH (d:Demand {id:$id}) RETURN d.clientName as clientName",
      { id }
    );

    if (!result.records.length) {
      console.log(`❌ Demand with ID ${id} not found`);
      return res.status(404).json({ 
        success: false, 
        message: "Demand not found" 
      });
    }

    const clientName = result.records[0].get("clientName");
    
    console.log(`✅ Found client name: ${clientName} for demand ${id}`);
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
 * PUT – Update Demand
 * =================================================
 */
router.put("/:id", async (req, res) => {
  console.log(`\n📡 PUT /api/demand/${req.params.id} - Updating demand`);
  
  // Get driver and create session
  const driver = getDriver();
  const session = driver.session();
  const id = Number(req.params.id);

  try {
    console.log(`🔍 Updating demand ID: ${id}`);
    console.log("📝 Update data:", req.body);
    
    const result = await session.run(
      `MATCH (d:Demand {id:$id})
       SET d += $data
       RETURN d`,
      { id, data: req.body }
    );

    if (!result.records.length) {
      console.log(`❌ Demand with ID ${id} not found for update`);
      return res.status(404).json({ message: "Demand not found" });
    }

    console.log(`✅ Successfully updated demand ${id}`);
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
 * POST – Create Demand
 * =================================================
 */
router.post("/", async (req, res) => {
  console.log("\n📡 POST /api/demand - Creating new demand");
  
  // Get driver and create session
  const driver = getDriver();
  const session = driver.session();

  try {
    // Get next ID
    const idResult = await session.run(
      "MATCH (d:Demand) RETURN coalesce(MAX(d.id), 0) + 1 AS nextId"
    );
    
    // Handle Neo4j integer properly
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
      status: req.body.status || "Active"
    };

    const result = await session.run(
      `
      CREATE (d:Demand)
      SET d = $data
      RETURN d
      `,
      { data: demandData }
    );

    const created = result.records[0].get("d").properties;

    console.log(`✅ Demand created successfully with ID: ${id}`);

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

/**
 * =================================================
 * DELETE – Delete Demand by ID
 * =================================================
 */
router.delete("/:id", async (req, res) => {
  console.log(`\n📡 DELETE /api/demand/${req.params.id} - Deleting demand`);
  
  // Get driver and create session
  const driver = getDriver();
  const session = driver.session();
  const id = Number(req.params.id);

  try {
    console.log(`🔍 Checking if demand ID ${id} exists`);
    const checkResult = await session.run(
      "MATCH (d:Demand {id: $id}) RETURN d",
      { id }
    );

    if (!checkResult.records.length) {
      console.log(`❌ Demand with ID ${id} not found`);
      return res.status(404).json({ message: "Demand not found" });
    }

    console.log(`🗑️ Deleting demand ID ${id}`);
    await session.run(
      "MATCH (d:Demand {id: $id}) DELETE d",
      { id }
    );

    console.log(`✅ Successfully deleted demand ${id}`);
    res.json({
      success: true,
      message: "Demand deleted successfully"
    });

  } catch (err) {
    console.error(`❌ Error deleting demand ${id}:`, err.message);
    res.status(500).json({ 
      message: "Failed to delete demand",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});

module.exports = router;
