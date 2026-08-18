const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");


// Test route
router.get("/ping", (req, res) => {
  res.json({ success: true, message: "Holiday routes are working!" });
});

// Get all groups
router.get("/groups", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (g:Group)
      RETURN g.name AS name, g.location AS location, g.client AS client, g.country AS country
      ORDER BY g.name
    `);
    const groups = result.records.map(record => ({
      name: record.get("name"),
      location: record.get("location"),
      client: record.get("client"),
      country: record.get("country")
    }));
    res.json({ success: true, data: groups });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// Get holidays by group name
router.get("/group/:groupName", async (req, res) => {
  let { groupName } = req.params;
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (g:Group {name: $groupName})
       OPTIONAL MATCH (g)-[:SHARES_HOLIDAY_CALENDAR*0..]-(linkedGroup:Group)
       WITH DISTINCT linkedGroup
       MATCH (linkedGroup)-[:HAS_HOLIDAY]->(h:Holiday)
       RETURN h.id AS id, h.name AS name, h.date AS date, h.day AS day, h.type AS type, h.notes AS notes
       ORDER BY h.date`,
      { groupName }
    );
    const holidays = result.records.map(record => ({
      id: record.get("id"),
      name: record.get("name"),
      date: record.get("date"),
      day: record.get("day"),
      type: record.get("type"),
      notes: record.get("notes") || ""
    }));
    res.json({ success: true, data: holidays });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// Add these to your holidayRoutes.js file

// GET /api/holiday/companies - Get all companies/groups for dropdown
// GET /api/holiday/companies - Get all companies/groups filtered by client
router.get("/companies", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { client } = req.query; // Get client from query parameter

  if (!driver) {
    console.error("❌ Neo4j driver not available");
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  try {

    let result;
    if (client) {
      // Filter by client
      result = await session.run(`
        MATCH (g:Group)
        WHERE g.client = $client
        OPTIONAL MATCH (g)-[:SHARES_HOLIDAY_CALENDAR*0..]-(linked:Group)
        WITH g, collect(DISTINCT linked.name) AS sharedWith
        RETURN DISTINCT 
          g.name AS name, 
          g.location AS location, 
          g.client AS client, 
          g.country AS country,
          g.id AS id,
          sharedWith
        ORDER BY g.name
      `, { client });
    } else {
      // Get all companies
      result = await session.run(`
        MATCH (g:Group)
        OPTIONAL MATCH (g)-[:SHARES_HOLIDAY_CALENDAR*0..]-(linked:Group)
        WITH g, collect(DISTINCT linked.name) AS sharedWith
        RETURN DISTINCT 
          g.name AS name, 
          g.location AS location, 
          g.client AS client, 
          g.country AS country,
          g.id AS id,
          sharedWith
        ORDER BY g.name
      `);
    }

    const companies = result.records.map(record => ({
      name: record.get("name"),
      location: record.get("location") || "",
      client: record.get("client") || "",
      country: record.get("country") || "",
      id: record.get("id") || record.get("name"),
      sharedWith: record.get("sharedWith") || []
    }));

    // Ensure required companies are present for dropdown
    const requiredCompanies = ["BangaloreUANDWE", "BangaloreUANDWELabs"];
    requiredCompanies.forEach(reqCompany => {
      if (!companies.some(c => c.name.toLowerCase() === reqCompany.toLowerCase())) {
        companies.push({
          name: reqCompany,
          location: "Bangalore",
          client: "UANDWE",
          country: "India",
          id: reqCompany,
          sharedWith: [reqCompany]
        });
      }
    });

    companies.sort((a, b) => a.name.localeCompare(b.name));

    res.json({ success: true, data: companies });

  } catch (err) {
    console.error("❌ Error fetching companies:", err.message);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// DELETE a company/group node
router.delete("/companies/:name", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const { name } = req.params;
    
    // First, delete any holidays that are ONLY associated with this group
    await session.run(`
      MATCH (g:Group {name: $name})-[:HAS_HOLIDAY]->(h:Holiday)
      DETACH DELETE h
    `, { name });

    // Then delete the group itself
    await session.run(`
      MATCH (g:Group {name: $name})
      DETACH DELETE g
    `, { name });

    res.json({ success: true, message: `Company ${name} deleted successfully` });
  } catch (err) {
    console.error("❌ Error deleting company:", err.message);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// Alternative endpoint for backward compatibility
router.get("/companies/list", async (req, res) => {
  // Redirect to the main endpoint or handle directly
  const driver = getDriver();
  const session = driver.session();

  if (!driver) {
    console.error("❌ Neo4j driver not available");
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  try {

    const result = await session.run(`
      MATCH (g:Group)
      RETURN DISTINCT 
        g.name AS name, 
        g.location AS location, 
        g.client AS client
      ORDER BY g.name
    `);

    const companies = result.records.map(record => ({
      name: record.get("name"),
      location: record.get("location") || "",
      client: record.get("client") || ""
    }));

    // Removed hardcoded required companies

    companies.sort((a, b) => a.name.localeCompare(b.name));

    res.json({ success: true, data: companies });

  } catch (err) {
    console.error("❌ Error fetching companies:", err.message);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// Get holiday groups (same as companies)
router.get("/groups/list", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  if (!driver) {
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  try {
    const result = await session.run(`
      MATCH (g:Group)
      RETURN g.name AS name, g.location AS location, g.client AS client, g.country AS country
      ORDER BY g.name
    `);

    const groups = result.records.map(record => ({
      name: record.get("name"),
      location: record.get("location"),
      client: record.get("client"),
      country: record.get("country")
    }));

    res.json({ success: true, data: groups });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// Get upcoming holidays
router.get("/upcoming", async (req, res) => {
  const { groupName } = req.query;
  const driver = getDriver();
  const session = driver.session();
  const today = new Date().toISOString().split('T')[0];
  try {
    let result;
    let searchGroup = groupName;
    if (searchGroup) {
      const normalized = searchGroup.toLowerCase().replace(/\s+/g, '');
      // Removed hardcoded logic
      result = await session.run(
        `MATCH (g:Group {name: $searchGroup})
         OPTIONAL MATCH (g)-[:SHARES_HOLIDAY_CALENDAR*0..]-(linkedGroup:Group)
         WITH DISTINCT linkedGroup
         MATCH (linkedGroup)-[:HAS_HOLIDAY]->(h:Holiday)
         WHERE h.date >= $today
         RETURN h.id AS id, h.name AS name, h.date AS date, h.day AS day, h.type AS type
         ORDER BY h.date LIMIT 10`,
        { searchGroup, today }
      );
    } else {
      result = await session.run(
        `MATCH (g:Group)-[:HAS_HOLIDAY]->(h:Holiday)
         WHERE h.date >= $today
         RETURN g.name AS groupName, g.location AS location,
                h.id AS id, h.name AS name, h.date AS date, h.day AS day, h.type AS type
         ORDER BY h.date LIMIT 20`,
        { today }
      );
    }
    const holidays = result.records.map(record => {
      const obj = {
        id: record.get("id"),
        name: record.get("name"),
        date: record.get("date"),
        day: record.get("day"),
        type: record.get("type")
      };
      if (!groupName) {
        obj.groupName = record.get("groupName");
        obj.location = record.get("location");
      }
      return obj;
    });
    res.json({ success: true, data: holidays });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// Get ALL holidays
router.get("/all", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (g:Group)-[:HAS_HOLIDAY]->(h:Holiday)
      RETURN g.name AS groupName, g.location AS location, g.client AS client, g.country AS country,
             h.id AS id, h.name AS name, h.date AS date, h.day AS day, h.type AS type, h.notes AS notes
      ORDER BY h.date, g.name
    `);
    const holidays = result.records.map(record => ({
      group: {
        name: record.get("groupName"),
        location: record.get("location"),
        client: record.get("client"),
        country: record.get("country")
      },
      holiday: {
        id: record.get("id"),
        name: record.get("name"),
        date: record.get("date"),
        day: record.get("day"),
        type: record.get("type"),
        notes: record.get("notes") || ""
      }
    }));
    res.json({ success: true, total: holidays.length, data: holidays });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// Add new holiday
router.post("/add", async (req, res) => {
  let { name, date, day, type, notes, groupName, groupWith } = req.body;
  if (groupName) {
    const normalized = groupName.toLowerCase().replace(/\s+/g, '');
    // Removed hardcoded logic
  }
  const driver = getDriver();
  const session = driver.session();
  try {
    const holidayId = `hol_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Base query to create holiday
    let query = `
      MERGE (g:Group {name: $groupName})
      CREATE (h:Holiday { id: $id, name: $name, date: $date, day: $day, type: $type, notes: $notes })
      CREATE (g)-[:HAS_HOLIDAY]->(h)
    `;
    
    // If groupWith is provided, link the companies
    if (groupWith && groupWith.trim() !== "") {
      query += `
        WITH g
        MERGE (g2:Group {name: $groupWith})
        MERGE (g)-[:SHARES_HOLIDAY_CALENDAR]->(g2)
      `;
    }
    
    await session.run(query, { 
      groupName, 
      groupWith: groupWith || "",
      id: holidayId, 
      name, 
      date, 
      day, 
      type, 
      notes: notes || "" 
    });
    res.json({ success: true, message: "Holiday added successfully", data: { id: holidayId, name } });
  } catch (err) {
    console.error("❌ Error adding holiday:", err.message);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// Update holiday
router.put("/:holidayId", async (req, res) => {
  const { holidayId } = req.params;
  let { name, date, day, type, notes, groupName } = req.body;
  if (groupName) {
    const normalized = groupName.toLowerCase().replace(/\s+/g, '');
    // Removed hardcoded logic
  }
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (h:Holiday {id: $holidayId})
       OPTIONAL MATCH (oldG:Group)-[r:HAS_HOLIDAY]->(h)
       DELETE r
       WITH h
       MERGE (newG:Group {name: $groupName})
       MERGE (newG)-[:HAS_HOLIDAY]->(h)
       SET h.name = $name, h.date = $date, h.day = $day, h.type = $type, h.notes = $notes
       RETURN h.id AS holidayId`,
      { holidayId, groupName, name, date, day, type, notes: notes || "" }
    );
    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "Holiday not found" });
    }
    res.json({ success: true, message: "Holiday updated successfully" });
  } catch (err) {
    console.error("❌ Error updating holiday:", err.message);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// ✅ DELETE holiday — single clean route, two isolated sessions
router.delete("/:holidayId", async (req, res) => {
  const { holidayId } = req.params;
  const driver = getDriver();


  // Session 1: find the node
  const findSession = driver.session();
  let holidayName;
  try {
    const findResult = await findSession.run(
      `MATCH (h:Holiday {id: $holidayId}) RETURN h.name AS name`,
      { holidayId }
    );
    if (findResult.records.length === 0) {
      return res.json({ success: true, message: "Holiday not found (may already be deleted)" });
    }
    holidayName = findResult.records[0].get("name");
  } catch (err) {
    console.error("❌ Error finding holiday:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    await findSession.close(); // ✅ fully closed before delete session opens
  }

  // Session 2: delete the node
  const deleteSession = driver.session();
  try {
    await deleteSession.run(
      `MATCH (h:Holiday {id: $holidayId}) DETACH DELETE h`,
      { holidayId }
    );
    res.json({ success: true, message: `Holiday "${holidayName}" deleted successfully` });
  } catch (err) {
    console.error("❌ Error deleting holiday:", err.message);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await deleteSession.close();
  }
});

// Create new company
router.post("/companies/add", async (req, res) => {
  const { name, location, client, country } = req.body;
  const driver = getDriver();
  const session = driver.session();
  try {
    await session.run(
      `MERGE (g:Group {name: $name})
       SET g.location = $location, g.client = $client, g.country = $country`,
      { name, location: location || "", client: client || "", country: country || "" }
    );
    res.json({ success: true, message: "Company added successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

// Update Shared Calendar Relationships
router.post("/companies/share-holiday-calendar", async (req, res) => {
  const { previousCompanies, newCompanies } = req.body;
  const driver = getDriver();
  const session = driver.session();
  try {
    const allToClear = [...new Set([...(previousCompanies || []), ...(newCompanies || [])])];
    
    // Clear relationships for all involved nodes
    if (allToClear.length > 0) {
      await session.run(`
        UNWIND $companies AS comp
        MATCH (g:Group {name: comp})-[r:SHARES_HOLIDAY_CALENDAR]-()
        DELETE r
      `, { companies: allToClear });
    }
    
    // Create chain relationships for newCompanies
    if (newCompanies && newCompanies.length > 1) {
      for (let i = 0; i < newCompanies.length - 1; i++) {
        await session.run(`
          MERGE (g1:Group {name: $c1})
          MERGE (g2:Group {name: $c2})
          MERGE (g1)-[:SHARES_HOLIDAY_CALENDAR]->(g2)
        `, { c1: newCompanies[i], c2: newCompanies[i+1] });
      }
    }
    
    res.json({ success: true, message: "Calendar sharing updated" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.close();
  }
});

module.exports = router;
