const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");


/* ================================
   TEST ROUTE
================================ */

router.get("/ping", (req, res) => {
  res.json({
    success: true,
    message: "Insurance Policy routes are working!"
  });
});

/* ================================
   GET ALL INSURANCE POLICIES
   - Now queries InsurancePolicy label, not Policy
================================ */

router.get("/", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (p:InsurancePolicy)
      RETURN p
      ORDER BY p.id
    `);

    const policies = result.records.map(record => {
      const p = record.get("p").properties;
      return p;
    });


    res.json({
      success: true,
      total: policies.length,
      data: policies
    });

  } catch (err) {
    console.error("❌ Error fetching insurance policies:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   GET INSURANCE POLICY BY ID
================================ */

router.get("/:policyId", async (req, res) => {
  const { policyId } = req.params;
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(
      `
      MATCH (p:InsurancePolicy {id: $policyId})
      RETURN p
      `,
      { policyId }
    );

    if (result.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Insurance policy not found"
      });
    }

    const policy = result.records[0].get("p").properties;

    res.json({
      success: true,
      data: policy
    });

  } catch (err) {
    console.error("❌ Error fetching insurance policy:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   GET INSURANCE POLICY BY POLICY NUMBER
================================ */

router.get("/number/:policyNumber", async (req, res) => {
  const { policyNumber } = req.params;
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(
      `
      MATCH (p:InsurancePolicy)
      WHERE p.policy_number = $policyNumber
      RETURN p
      `,
      { policyNumber }
    );

    if (result.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Insurance policy not found"
      });
    }

    const policy = result.records[0].get("p").properties;

    res.json({
      success: true,
      data: policy
    });

  } catch (err) {
    console.error("❌ Error fetching insurance policy by number:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   POST - ADD NEW INSURANCE POLICY
   - Now creates InsurancePolicy node, not Policy
================================ */

router.post("/", async (req, res) => {
  const policyData = req.body;

  if (!policyData.policy_number || !policyData.product_name) {
    return res.status(400).json({
      success: false,
      message: "policy_number and product_name are required"
    });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    // Check if policy already exists by policy_number
    const existing = await session.run(
      `
      MATCH (p:InsurancePolicy {policy_number: $policyNumber})
      RETURN p
      `,
      { policyNumber: policyData.policy_number }
    );

    if (existing.records.length > 0) {
      return res.status(409).json({
        success: false,
        message: `Policy with number ${policyData.policy_number} already exists`
      });
    }

    // Generate ID if not provided
    const policyId = policyData.id || `INS_${Date.now()}`;
    const createdAt = policyData.created_at || new Date().toISOString();

    const properties = {
      id: policyId,
      created_at: createdAt,
      ...policyData
    };

    const propertyKeys = Object.keys(properties);
    const propertyPlaceholders = propertyKeys.map(key => `${key}: $${key}`).join(", ");
    
    const createQuery = `
      CREATE (p:InsurancePolicy {
        ${propertyPlaceholders}
      })
      RETURN p
    `;

    const result = await session.run(createQuery, properties);


    res.status(201).json({
      success: true,
      message: "Insurance policy added successfully",
      data: {
        id: policyId,
        policy_number: policyData.policy_number,
        product_name: policyData.product_name
      }
    });

  } catch (err) {
    console.error("❌ Error adding insurance policy:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   PUT - UPDATE INSURANCE POLICY
================================ */

router.put("/:policyId", async (req, res) => {
  const { policyId } = req.params;
  const updateData = req.body;

  const driver = getDriver();
  const session = driver.session();

  try {
    const checkResult = await session.run(
      `
      MATCH (p:InsurancePolicy {id: $policyId})
      RETURN p.id AS id
      `,
      { policyId }
    );

    if (checkResult.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Insurance policy not found"
      });
    }

    delete updateData.id;
    updateData.updated_at = new Date().toISOString();

    let setQuery = "";
    const params = { policyId };

    for (const [key, value] of Object.entries(updateData)) {
      if (value !== undefined) {
        setQuery += `p.${key} = $${key}, `;
        params[key] = value;
      }
    }

    setQuery = setQuery.slice(0, -2);

    if (setQuery.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields to update"
      });
    }

    await session.run(
      `
      MATCH (p:InsurancePolicy {id: $policyId})
      SET ${setQuery}
      `,
      params
    );


    res.json({
      success: true,
      message: "Insurance policy updated successfully"
    });

  } catch (err) {
    console.error("❌ Error updating insurance policy:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   PATCH - PARTIAL UPDATE INSURANCE POLICY
================================ */

router.patch("/:policyId", async (req, res) => {
  const { policyId } = req.params;
  const updateData = req.body;

  const driver = getDriver();
  const session = driver.session();

  try {
    const checkResult = await session.run(
      `
      MATCH (p:InsurancePolicy {id: $policyId})
      RETURN p.id AS id
      `,
      { policyId }
    );

    if (checkResult.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Insurance policy not found"
      });
    }

    delete updateData.id;
    updateData.updated_at = new Date().toISOString();

    let setQuery = "";
    const params = { policyId };

    for (const [key, value] of Object.entries(updateData)) {
      if (value !== undefined) {
        setQuery += `p.${key} = $${key}, `;
        params[key] = value;
      }
    }

    setQuery = setQuery.slice(0, -2);

    if (setQuery.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields to update"
      });
    }

    await session.run(
      `
      MATCH (p:InsurancePolicy {id: $policyId})
      SET ${setQuery}
      `,
      params
    );


    res.json({
      success: true,
      message: "Insurance policy updated successfully"
    });

  } catch (err) {
    console.error("❌ Error updating insurance policy:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   DELETE INSURANCE POLICY
================================ */

router.delete("/:policyId", async (req, res) => {
  const { policyId } = req.params;

  const driver = getDriver();
  const session = driver.session();

  try {
    const checkResult = await session.run(
      `
      MATCH (p:InsurancePolicy {id: $policyId})
      RETURN p.policy_number AS policy_number, p.product_name AS product_name
      `,
      { policyId }
    );

    if (checkResult.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Insurance policy not found"
      });
    }

    const policyNumber = checkResult.records[0].get("policy_number");
    const productName = checkResult.records[0].get("product_name");

    await session.run(
      `
      MATCH (p:InsurancePolicy {id: $policyId})
      DETACH DELETE p
      `,
      { policyId }
    );


    res.json({
      success: true,
      message: `Insurance policy "${policyNumber}" deleted successfully`
    });

  } catch (err) {
    console.error("❌ Error deleting insurance policy:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   GET ACTIVE POLICIES (Not Expired)
================================ */

router.get("/status/active", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (p:InsurancePolicy)
      WHERE p.expiry_date IS NOT NULL AND date(p.expiry_date) >= date()
      RETURN p
      ORDER BY p.expiry_date ASC
    `);

    const policies = result.records.map(record => {
      const p = record.get("p").properties;
      return p;
    });

    res.json({
      success: true,
      total: policies.length,
      data: policies
    });

  } catch (err) {
    console.error("❌ Error fetching active policies:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   SEARCH INSURANCE POLICIES
================================ */

router.get("/search/:keyword", async (req, res) => {
  const { keyword } = req.params;
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(
      `
      MATCH (p:InsurancePolicy)
      WHERE p.policy_number CONTAINS $keyword 
         OR p.product_name CONTAINS $keyword 
         OR p.policyholder_name CONTAINS $keyword
         OR p.insurer_name CONTAINS $keyword
      RETURN p
      ORDER BY p.product_name
      `,
      { keyword }
    );

    const policies = result.records.map(record => {
      const p = record.get("p").properties;
      return p;
    });

    res.json({
      success: true,
      total: policies.length,
      keyword: keyword,
      data: policies
    });

  } catch (err) {
    console.error("❌ Error searching policies:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   GET STATISTICS / DASHBOARD DATA
================================ */

router.get("/stats/dashboard", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (p:InsurancePolicy)
      RETURN 
        count(p) AS totalPolicies,
        sum(CASE WHEN p.expiry_date IS NOT NULL AND date(p.expiry_date) >= date() THEN 1 ELSE 0 END) AS activePolicies,
        sum(CASE WHEN p.expiry_date IS NOT NULL AND date(p.expiry_date) < date() THEN 1 ELSE 0 END) AS expiredPolicies,
        sum(toInteger(p.capital_sum_insured)) AS totalSumInsured,
        avg(toInteger(p.capital_sum_insured)) AS avgSumInsured,
        sum(toInteger(p.insured_self_count)) AS totalSelfLives,
        sum(toInteger(p.insured_dependent_count)) AS totalDependentLives,
        count(DISTINCT p.insurer_name) AS uniqueInsurers,
        count(DISTINCT p.policyholder_gstin) AS uniquePolicyholders
    `);

    const stats = result.records[0];

    res.json({
      success: true,
      data: {
        totalPolicies: stats.get("totalPolicies").toNumber() || 0,
        activePolicies: stats.get("activePolicies").toNumber() || 0,
        expiredPolicies: stats.get("expiredPolicies").toNumber() || 0,
        totalSumInsured: stats.get("totalSumInsured") || 0,
        avgSumInsured: Math.round(stats.get("avgSumInsured") || 0),
        totalSelfLives: stats.get("totalSelfLives").toNumber() || 0,
        totalDependentLives: stats.get("totalDependentLives").toNumber() || 0,
        uniqueInsurers: stats.get("uniqueInsurers").toNumber() || 0,
        uniquePolicyholders: stats.get("uniquePolicyholders").toNumber() || 0
      }
    });

  } catch (err) {
    console.error("❌ Error fetching dashboard stats:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

module.exports = router;
