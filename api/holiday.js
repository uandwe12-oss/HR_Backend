const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");

console.log("✅ HOLIDAY ROUTES FILE LOADED SUCCESSFULLY");

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
  const { groupName } = req.params;
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (g:Group {name: $groupName})-[:HAS_HOLIDAY]->(h:Holiday)
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

// Get upcoming holidays
router.get("/upcoming", async (req, res) => {
  const { groupName } = req.query;
  const driver = getDriver();
  const session = driver.session();
  const today = new Date().toISOString().split('T')[0];
  try {
    let result;
    if (groupName) {
      result = await session.run(
        `MATCH (g:Group {name: $groupName})-[:HAS_HOLIDAY]->(h:Holiday)
         WHERE h.date >= $today
         RETURN h.id AS id, h.name AS name, h.date AS date, h.day AS day, h.type AS type
         ORDER BY h.date LIMIT 10`,
        { groupName, today }
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
  const { name, date, day, type, notes, groupName } = req.body;
  const driver = getDriver();
  const session = driver.session();
  try {
    const holidayId = `hol_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await session.run(
      `MATCH (g:Group {name: $groupName})
       CREATE (h:Holiday { id: $id, name: $name, date: $date, day: $day, type: $type, notes: $notes })
       CREATE (g)-[:HAS_HOLIDAY]->(h)`,
      { groupName, id: holidayId, name, date, day, type, notes: notes || "" }
    );
    console.log(`✅ Holiday "${name}" added for ${groupName} with id ${holidayId}`);
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
  const { name, date, day, type, notes, groupName } = req.body;
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (g:Group {name: $groupName})-[:HAS_HOLIDAY]->(h:Holiday {id: $holidayId})
       SET h.name = $name, h.date = $date, h.day = $day, h.type = $type, h.notes = $notes
       RETURN h.id AS holidayId`,
      { holidayId, groupName, name, date, day, type, notes: notes || "" }
    );
    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "Holiday not found" });
    }
    console.log(`✅ Holiday "${name}" updated successfully`);
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

  console.log(`\n📡 DELETE /api/holiday/${holidayId} - Deleting holiday`);

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
    console.log(`✅ Deleted holiday: "${holidayName}" (${holidayId})`);
    res.json({ success: true, message: `Holiday "${holidayName}" deleted successfully` });
  } catch (err) {
    console.error("❌ Error deleting holiday:", err.message);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await deleteSession.close();
  }
});

module.exports = router;