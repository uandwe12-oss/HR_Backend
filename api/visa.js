const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");

router.get("/", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (c:Candidate_Profile)
      RETURN c.\`Visa type\` AS VisaType, COUNT(*) AS Total
      ORDER BY Total DESC
    `);

    const data = result.records.map(record => ({
      VisaType: record.get("VisaType"),
      Total: Number(record.get("Total"))
    }));

    res.json(data);

  } catch (error) {
    console.error("Visa API Error:", error);
    res.status(500).send("Error fetching visa data");
  } finally {
    await session.close();
  }
});

module.exports = router;