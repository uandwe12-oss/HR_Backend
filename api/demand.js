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
    const result = await session.run(
      `MATCH (d:Demand)
       WHERE d.clientName IS NOT NULL AND trim(d.clientName) <> ''
       RETURN DISTINCT d.clientName as clientName`
    );
 
    const clientMap = new Map();
    result.records.forEach(record => {
      const raw = record.get("clientName");
      if (!raw || typeof raw !== 'string') return;
      const trimmed = raw.trim();
      if (!trimmed) return;
      
      const key = trimmed.toLowerCase();
      if (!clientMap.has(key)) {
        clientMap.set(key, trimmed);
      } else {
        const existing = clientMap.get(key);
        // Prefer TitleCase/PascalCase over all-lowercase (e.g. "Broadcom" over "broadcom")
        if (existing === existing.toLowerCase() && trimmed !== trimmed.toLowerCase()) {
          clientMap.set(key, trimmed);
        }
      }
    });

    const clients = Array.from(clientMap.values())
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .map(name => ({ name }));
 
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
      const d = { ...r.get("d").properties };
      if (d.clientName && typeof d.clientName === 'string') {
        d.clientName = d.clientName.trim();
      }
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
 * GET – Fetch unique historical field values for demand form dropdowns
 * =================================================
 */
router.get("/field-options", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (d:Demand)
      RETURN 
        collect(DISTINCT trim(d.clientName)) as clients,
        collect(DISTINCT trim(d.country)) as countries,
        collect(DISTINCT trim(d.location)) as locations,
        collect(DISTINCT trim(d.interviewer1)) as uandweInterviewers,
        collect(DISTINCT trim(d.interviewer2)) as clientInterviewers,
        collect(DISTINCT trim(d.recruiterPOC)) as recruiters,
        collect(DISTINCT trim(d.sales)) as sales,
        collect(d.primarySkill) as primarySkillsRaw,
        collect(d.secondarySkill) as secondarySkillsRaw
    `);

    const clean = (arr) => {
      if (!Array.isArray(arr)) return [];
      const map = new Map();
      arr.forEach(item => {
        if (item && typeof item === 'string') {
          const t = item.trim();
          if (t) {
            const key = t.toLowerCase();
            if (!map.has(key)) {
              map.set(key, t);
            } else {
              const existing = map.get(key);
              if (existing === existing.toLowerCase() && t !== t.toLowerCase()) {
                map.set(key, t);
              }
            }
          }
        }
      });
      return Array.from(map.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    };

    const cleanSkillList = (nestedList) => {
      if (!Array.isArray(nestedList)) return [];
      const set = new Set();
      nestedList.forEach(item => {
        if (Array.isArray(item)) {
          item.forEach(sub => {
            if (sub && typeof sub === 'string') {
              const t = sub.trim();
              if (t) set.add(t);
            }
          });
        } else if (item && typeof item === 'string') {
          const t = item.trim();
          if (t) set.add(t);
        }
      });
      return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    };

    // Fetch hidden clients so admin-hidden client entries are excluded from dropdowns
    const hiddenResult = await session.run(`
      MATCH (h:HiddenDemandOption { field: 'clientName' })
      RETURN h.value AS value
    `);

    const hiddenClientsSet = new Set();
    const hiddenClientsList = [];
    hiddenResult.records.forEach(r => {
      const v = r.get("value");
      if (v) {
        hiddenClientsSet.add(v.trim().toLowerCase());
        if (!hiddenClientsList.includes(v.trim())) {
          hiddenClientsList.push(v.trim());
        }
      }
    });

    if (result.records.length > 0) {
      const rec = result.records[0];
      const pSkills = cleanSkillList(rec.get("primarySkillsRaw"));
      const sSkills = cleanSkillList(rec.get("secondarySkillsRaw"));
      const allSkills = Array.from(new Set([...pSkills, ...sSkills])).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      res.json({
        success: true,
        options: {
          clientName: clean(rec.get("clients")).filter(c => c && !hiddenClientsSet.has(c.trim().toLowerCase())),
          country: clean(rec.get("countries")),
          location: clean(rec.get("locations")),
          interviewer1: clean(rec.get("uandweInterviewers")),
          interviewer2: clean(rec.get("clientInterviewers")),
          recruiterPOC: clean(rec.get("recruiters")),
          sales: clean(rec.get("sales")),
          primarySkill: pSkills,
          secondarySkill: sSkills,
          allSkills: allSkills
        },
        hiddenClients: hiddenClientsList,
        hiddenOptions: { clientName: hiddenClientsList }
      });
    } else {
      res.json({
        success: true,
        options: {
          clientName: [],
          country: [],
          location: [],
          interviewer1: [],
          interviewer2: [],
          recruiterPOC: [],
          sales: [],
          primarySkill: [],
          secondarySkill: [],
          allSkills: []
        },
        hiddenClients: hiddenClientsList,
        hiddenOptions: { clientName: hiddenClientsList }
      });
    }
  } catch (err) {
    console.error("❌ Error fetching field options:", err.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch field options",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * =================================================
 * POST – Hide Field Option from Dropdowns (Admin)
 * =================================================
 */
router.post("/field-options/hide", async (req, res) => {
  const { field, value } = req.body;
  if (!field || !value) {
    return res.status(400).json({ success: false, message: "Field and value are required" });
  }

  const driver = getDriver();
  const session = driver.session();
  const trimmedVal = String(value).trim();

  try {
    await session.run(
      `MERGE (h:HiddenDemandOption { field: $field, valueLower: toLower($trimmedVal) })
       ON CREATE SET h.value = $trimmedVal, h.createdAt = datetime()
       ON MATCH SET h.value = $trimmedVal
       RETURN h`,
      { field, trimmedVal }
    );

    res.json({
      success: true,
      message: `"${trimmedVal}" hidden from ${field} dropdown`,
      field,
      value: trimmedVal
    });
  } catch (err) {
    console.error("❌ Error hiding field option:", err.message);
    res.status(500).json({ success: false, message: "Failed to hide option", error: err.message });
  } finally {
    await session.close();
  }
});

/**
 * =================================================
 * POST – Unhide / Restore Field Option to Dropdowns (Admin)
 * =================================================
 */
router.post("/field-options/unhide", async (req, res) => {
  const { field, value } = req.body;
  if (!field || !value) {
    return res.status(400).json({ success: false, message: "Field and value are required" });
  }

  const driver = getDriver();
  const session = driver.session();
  const trimmedVal = String(value).trim();

  try {
    await session.run(
      `MATCH (h:HiddenDemandOption { field: $field })
       WHERE toLower(h.value) = toLower($trimmedVal) OR h.valueLower = toLower($trimmedVal)
       DELETE h`,
      { field, trimmedVal }
    );

    res.json({
      success: true,
      message: `"${trimmedVal}" restored to ${field} dropdown`,
      field,
      value: trimmedVal
    });
  } catch (err) {
    console.error("❌ Error unhiding field option:", err.message);
    res.status(500).json({ success: false, message: "Failed to restore option", error: err.message });
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
      sales: req.body.sales || "",
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


// Removed obsolete manual export trigger routes

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
