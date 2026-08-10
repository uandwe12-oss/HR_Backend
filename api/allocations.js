const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const getDriver = require("../lib/neo4j");

// GET /api/allocations - Get all allocations or filter by employeeNumber
router.get("/", async (req, res) => {
  const driver = getDriver();
  if (!driver) return res.status(500).json({ success: false, message: "No DB connection" });
  
  const session = driver.session();
  const { employeeNumber, search } = req.query;
  
  try {
    let query = `
      MATCH (p:PersonalDetails)-[:HAS_ALLOCATION]->(a:Allocation)
      RETURN p.employeeNumber as employeeNumber, p.fullName as employeeName, a {.*} as allocation
      ORDER BY a.startDate ASC
    `;
    let params = {};
    
    if (employeeNumber) {
      query = `
        MATCH (p:PersonalDetails {employeeNumber: $employeeNumber})-[:HAS_ALLOCATION]->(a:Allocation)
        RETURN p.employeeNumber as employeeNumber, p.fullName as employeeName, a {.*} as allocation
        ORDER BY a.startDate ASC
      `;
      params = { employeeNumber };
    } else if (search) {
      query = `
        MATCH (p:PersonalDetails)-[:HAS_ALLOCATION]->(a:Allocation)
        WHERE toLower(p.fullName) CONTAINS toLower($search) OR toLower(p.employeeNumber) CONTAINS toLower($search)
        RETURN p.employeeNumber as employeeNumber, p.fullName as employeeName, a {.*} as allocation
        ORDER BY a.startDate ASC
      `;
      params = { search };
    }
    
    const result = await session.run(query, params);
    
    const allocations = result.records.map(record => ({
      ...record.get("allocation"),
      employeeNumber: record.get("employeeNumber"),
      employeeName: record.get("employeeName")
    }));
    
    res.json({ success: true, data: allocations });
  } catch (error) {
    console.error("Error fetching allocations:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// GET /api/allocations/metrics - Get metrics for dashboard
router.get("/metrics", async (req, res) => {
  const driver = getDriver();
  if (!driver) return res.status(500).json({ success: false, message: "No DB connection" });
  
  const session = driver.session();
  
  try {
    // Total employees
    const empResult = await session.run(`MATCH (p:PersonalDetails) RETURN count(p) as total`);
    const totalValue = empResult.records[0].get("total");
    const totalEmployees = totalValue && typeof totalValue.toNumber === 'function' ? totalValue.toNumber() : Number(totalValue);
    
    const allocResult = await session.run(`
      MATCH (p:PersonalDetails)-[:HAS_ALLOCATION]->(a:Allocation)
      WITH p, a ORDER BY a.startDate DESC
      WITH p, collect(a)[0] as latestAlloc
      RETURN latestAlloc.type as type, count(latestAlloc) as count
    `);
    
    let billable = 0;
    let support = 0;
    let bench = 0;
    
    allocResult.records.forEach(record => {
      const type = record.get("type");
      const countValue = record.get("count");
      const count = countValue && typeof countValue.toNumber === 'function' ? countValue.toNumber() : Number(countValue);
      if (type === "Billable") billable += count;
      else if (type === "Support") support += count;
      else if (type === "On Bench") bench += count;
    });
    
    // Utilization Percentage = ((Billable + Support) / Total Employees) * 100
    // Sometimes Bench is also considered in total, but usually utilization is (Billable+Support)/Total.
    // If an employee doesn't have an active allocation, they are theoretically "Unassigned", but we can just use total.
    let utilization = 0;
    if (totalEmployees > 0) {
      utilization = Math.round(((billable + support) / totalEmployees) * 100);
    }
    
    res.json({
      success: true,
      data: {
        totalEmployees,
        billable,
        support,
        bench,
        utilization
      }
    });
  } catch (error) {
    console.error("Error fetching allocation metrics:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// POST /api/allocations - Create a new allocation
router.post("/", async (req, res) => {
  const driver = getDriver();
  if (!driver) return res.status(500).json({ success: false, message: "No DB connection" });
  
  const session = driver.session();
  const { employeeNumber, employeeName, projectName, type, startDate, endDate } = req.body;
  
  if (!employeeNumber || !type || !startDate || !endDate) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }
  
  try {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    
    // Create the Allocation node and link it to PersonalDetails
    // If the employee exists in PersonalDetails, we attach it.
    // If not, we could fail or create a dummy one, but they should exist.
    const result = await session.run(`
      MATCH (p:PersonalDetails {employeeNumber: $employeeNumber})
      CREATE (a:Allocation {
        id: $id,
        employeeNumber: $employeeNumber,
        employeeName: $employeeName,
        projectName: $projectName,
        type: $type,
        startDate: $startDate,
        endDate: $endDate,
        createdAt: $createdAt
      })
      MERGE (p)-[:HAS_ALLOCATION]->(a)
      RETURN a
    `, {
      employeeNumber,
      employeeName: employeeName || "Unknown",
      projectName: projectName || "",
      type,
      startDate,
      endDate,
      id,
      createdAt
    });
    
    if (result.records.length === 0) {
       return res.status(404).json({ success: false, message: "Employee not found in Personal Details" });
    }
    
    res.json({ success: true, message: "Allocation created successfully", data: result.records[0].get("a").properties });
  } catch (error) {
    console.error("Error creating allocation:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// PUT /api/allocations/:id - Update an allocation
router.put("/:id", async (req, res) => {
  const driver = getDriver();
  if (!driver) return res.status(500).json({ success: false, message: "No DB connection" });
  
  const session = driver.session();
  const { id } = req.params;
  const { projectName, type, startDate, endDate } = req.body;
  
  try {
    const updatedAt = new Date().toISOString();
    
    const result = await session.run(`
      MATCH (a:Allocation {id: $id})
      SET a.projectName = $projectName,
          a.type = $type,
          a.startDate = $startDate,
          a.endDate = $endDate,
          a.updatedAt = $updatedAt
      RETURN a
    `, { id, projectName: projectName || "", type, startDate, endDate, updatedAt });
    
    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "Allocation not found" });
    }
    
    res.json({ success: true, message: "Allocation updated successfully" });
  } catch (error) {
    console.error("Error updating allocation:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// DELETE /api/allocations/:id - Delete an allocation
router.delete("/:id", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { id } = req.params;
  
  try {
    await session.run(`
      MATCH (a:Allocation {id: $id})
      DETACH DELETE a
    `, { id });
    
    res.json({ success: true, message: "Allocation deleted successfully" });
  } catch (error) {
    console.error("Error deleting allocation:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

module.exports = router;
