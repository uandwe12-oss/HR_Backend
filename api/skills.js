const express = require("express");
const router = express.Router();

// ✅ Import shared Neo4j driver
const getDriver = require("../lib/neo4j");

/**
 * =================================================
 * Test Endpoint
 * =================================================
 */
router.get("/test", async (req, res) => {
  console.log("\n📡 GET /api/skills/test - Called");

  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(
      "RETURN 'Skills API is working!' AS message, datetime() as timestamp"
    );

    res.json({
      success: true,
      message: result.records[0].get("message"),
      timestamp: result.records[0].get("timestamp").toString(),
      neo4jConnected: true
    });
  } catch (error) {
    console.error("❌ Skills Test Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Skills API test failed",
      error: error.message
    });
  } finally {
    await session.close();
  }
});

/**
 * =================================================
 * GET – Fetch All Skills
 * =================================================
 */
router.get("/", async (req, res) => {
  console.log("\n📡 GET /api/skills - Fetching all skills");

  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(
      "MATCH (s:Skill) RETURN s ORDER BY s.name ASC"
    );

    console.log(`📊 Found ${result.records.length} skills`);

    const skills = result.records.map(record => {
      const skill = record.get("s").properties;
      // Remove createdAt if it exists
      const { createdAt, ...skillWithoutCreatedAt } = skill;
      return skillWithoutCreatedAt;
    });

    res.json({
      success: true,
      count: skills.length,
      data: skills
    });

  } catch (err) {
    console.error("❌ Error fetching skills:", err.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch skills",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * =================================================
 * POST – Create New Skill
 * =================================================
 */
router.post("/", async (req, res) => {
  console.log("\n📡 POST /api/skills - Creating new skill");
  
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const { name } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Skill name is required"
      });
    }
    
    // Check if skill already exists
    const checkResult = await session.run(
      "MATCH (s:Skill {name: $name}) RETURN s",
      { name: name.trim() }
    );
    
    if (checkResult.records.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Skill already exists"
      });
    }
    
    // Create the skill WITHOUT createdAt
    const result = await session.run(
      "CREATE (s:Skill {name: $name}) RETURN s",
      { name: name.trim() }
    );
    
    const skill = result.records[0].get("s").properties;
    // Remove createdAt if it somehow exists
    const { createdAt, ...skillWithoutCreatedAt } = skill;
    
    console.log(`✅ Skill created: ${skillWithoutCreatedAt.name}`);
    
    res.status(201).json({
      success: true,
      message: "Skill created successfully",
      data: skillWithoutCreatedAt
    });
    
  } catch (error) {
    console.error('❌ Error creating skill:', error);
    res.status(500).json({
      success: false,
      message: "Failed to create skill",
      error: error.message
    });
  } finally {
    await session.close();
  }
});

/**
 * =================================================
 * DELETE – Delete Skill by Name
 * =================================================
 */
router.delete("/:name", async (req, res) => {
  console.log(`\n📡 DELETE /api/skills/${req.params.name}`);

  const driver = getDriver();
  const session = driver.session();
  const name = req.params.name;

  try {
    console.log(`🔍 Checking if skill exists: ${name}`);

    const check = await session.run(
      "MATCH (s:Skill {name:$name}) RETURN s",
      { name }
    );

    if (!check.records.length) {
      return res.status(404).json({
        success: false,
        message: "Skill not found"
      });
    }

    console.log(`🗑️ Deleting skill: ${name}`);

    await session.run(
      "MATCH (s:Skill {name:$name}) DETACH DELETE s",
      { name }
    );

    res.json({
      success: true,
      message: "Skill deleted successfully"
    });

  } catch (err) {
    console.error("❌ Error deleting skill:", err.message);
    res.status(500).json({
      success: false,
      message: "Failed to delete skill",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

module.exports = router;