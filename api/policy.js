const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");


/* ================================
   TEST ROUTE
================================ */

router.get("/ping", (req, res) => {
  res.json({
    success: true,
    message: "Policy routes are working!"
  });
});

/* ================================
   GET ALL POLICIES
================================ */

router.get("/", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (p:Policy)
      RETURN 
        p.id AS id,
        p.title AS title,
        p.description AS description,
        p.nationality AS nationality,
        p.createdAt AS createdAt
      ORDER BY p.title
    `);

    const policies = result.records.map(record => ({
      id: record.get("id"),
      title: record.get("title"),
      description: record.get("description"),
      nationality: record.get("nationality") || null,
      createdAt: record.get("createdAt")
    }));

    res.json({
      success: true,
      total: policies.length,
      data: policies
    });

  } catch (err) {
    console.error("❌ Error fetching policies:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   GET POLICY BY ID
================================ */

router.get("/:policyId", async (req, res) => {
  const { policyId } = req.params;
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(
      `
      MATCH (p:Policy {id: $policyId})
      RETURN 
        p.id AS id,
        p.title AS title,
        p.description AS description,
        p.nationality AS nationality,
        p.createdAt AS createdAt
      `,
      { policyId }
    );

    if (result.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Policy not found"
      });
    }

    const record = result.records[0];
    const policy = {
      id: record.get("id"),
      title: record.get("title"),
      description: record.get("description"),
      nationality: record.get("nationality") || null,
      createdAt: record.get("createdAt")
    };

    res.json({
      success: true,
      data: policy
    });

  } catch (err) {
    console.error("❌ Error fetching policy:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   POST - ADD NEW POLICY
================================ */

router.post("/", async (req, res) => {
  const { title, description, nationality } = req.body;

  if (!title || !description) {
    return res.status(400).json({
      success: false,
      message: "Title and description are required"
    });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    const policyId = `pol_${Date.now()}`;
    const createdAt = new Date().toISOString();

    await session.run(
      `
      CREATE (p:Policy {
        id: $id,
        title: $title,
        description: $description,
        nationality: $nationality,
        createdAt: $createdAt
      })
      `,
      {
        id: policyId,
        title: title,
        description: description,
        nationality: nationality || null,
        createdAt: createdAt
      }
    );


    res.json({
      success: true,
      message: "Policy added successfully",
      data: {
        id: policyId,
        title: title,
        description: description,
        nationality: nationality || null,
        createdAt: createdAt
      }
    });

  } catch (err) {
    console.error("❌ Error adding policy:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   PUT - UPDATE POLICY
================================ */

router.put("/:policyId", async (req, res) => {
  const { policyId } = req.params;
  const { title, description, nationality } = req.body;

  if (!title && !description && !nationality) {
    return res.status(400).json({
      success: false,
      message: "At least one field (title, description, or nationality) is required to update"
    });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    // Build dynamic SET query
    let setQuery = "";
    const params = { policyId };

    if (title) {
      setQuery += "p.title = $title, ";
      params.title = title;
    }
    if (description) {
      setQuery += "p.description = $description, ";
      params.description = description;
    }
    if (nationality !== undefined) {
      setQuery += "p.nationality = $nationality, ";
      params.nationality = nationality;
    }
    
    // Remove trailing comma and space
    setQuery = setQuery.slice(0, -2);

    const result = await session.run(
      `
      MATCH (p:Policy {id: $policyId})
      SET ${setQuery}
      RETURN p.id AS id, p.title AS title, p.description AS description, p.nationality AS nationality
      `,
      params
    );

    if (result.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Policy not found"
      });
    }

    const record = result.records[0];

    res.json({
      success: true,
      message: "Policy updated successfully",
      data: {
        id: record.get("id"),
        title: record.get("title"),
        description: record.get("description"),
        nationality: record.get("nationality") || null
      }
    });

  } catch (err) {
    console.error("❌ Error updating policy:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   DELETE POLICY
================================ */

router.delete("/:policyId", async (req, res) => {
  const { policyId } = req.params;

  const driver = getDriver();
  const session = driver.session();

  try {
    // First check if policy exists
    const checkResult = await session.run(
      `
      MATCH (p:Policy {id: $policyId})
      RETURN p.title AS title
      `,
      { policyId }
    );

    if (checkResult.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Policy not found"
      });
    }

    const policyTitle = checkResult.records[0].get("title");

    // Delete the policy
    await session.run(
      `
      MATCH (p:Policy {id: $policyId})
      DETACH DELETE p
      `,
      { policyId }
    );


    res.json({
      success: true,
      message: `Policy "${policyTitle}" deleted successfully`
    });

  } catch (err) {
    console.error("❌ Error deleting policy:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

module.exports = router;
