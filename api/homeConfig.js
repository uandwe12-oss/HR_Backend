const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");

// GET /api/home-config
router.get("/", async (req, res) => {
  const driver = getDriver();
  if (!driver) return res.status(500).json({ success: false, message: "No DB connection" });
  
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (c:HomeConfig)
      RETURN c
    `);
    
    const configs = [];
    result.records.forEach(record => {
      const node = record.get("c").properties;
      
      if (node.modules && typeof node.modules === 'string') {
        // Stringified JSON array format (matches CountryFieldConfig style)
        try {
          const parsedModules = JSON.parse(node.modules);
          parsedModules.forEach(mod => {
            configs.push({
              country: node.country,
              role: node.role,
              moduleName: mod.moduleName,
              status: mod.status
            });
          });
        } catch (e) {
          console.error("Error parsing HomeConfig JSON string:", e);
        }
      } else if (node.modules && Array.isArray(node.modules)) {
        // Fallback for native array format if any exist
        node.modules.forEach(modString => {
          const separatorIndex = modString.indexOf(":");
          if (separatorIndex > -1) {
            const moduleName = modString.substring(0, separatorIndex);
            const status = modString.substring(separatorIndex + 1);
            configs.push({
              country: node.country,
              role: node.role,
              moduleName,
              status
            });
          }
        });
      } else if (node.moduleName) {
        // Old individual node format
        configs.push({
          country: node.country,
          role: node.role,
          moduleName: node.moduleName,
          status: node.status
        });
      }
    });
    
    res.json({ success: true, data: configs });
  } catch (error) {
    console.error("Error fetching home config:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// POST /api/home-config
router.post("/", async (req, res) => {
  const driver = getDriver();
  if (!driver) return res.status(500).json({ success: false, message: "No DB connection" });
  
  const session = driver.session();
  const { configs } = req.body;
  
  if (!configs || !Array.isArray(configs) || configs.length === 0) {
    return res.status(400).json({ success: false, message: "Invalid payload or empty array" });
  }
  
  const country = configs[0].country;
  const role = configs[0].role;
  
  // Format as stringified JSON array to match CountryFieldConfig style
  const simplifiedConfigs = configs.map(c => ({ moduleName: c.moduleName, status: c.status }));
  const modulesString = JSON.stringify(simplifiedConfigs);
  
  try {
    // Clean up all old individual nodes and existing array nodes for this country/role
    await session.run(`
      MATCH (c:HomeConfig {country: $country, role: $role})
      DELETE c
    `, { country, role });
    
    // Create one single node for this country/role containing the stringified JSON array
    await session.run(`
      CREATE (c:HomeConfig {country: $country, role: $role, modules: $modulesString})
    `, { country, role, modulesString });
    
    res.json({ success: true, message: "Configurations saved successfully in JSON array format" });
  } catch (error) {
    console.error("Error saving home config:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

module.exports = router;
