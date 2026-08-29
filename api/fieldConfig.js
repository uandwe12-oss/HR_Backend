const express = require('express');
const router = express.Router();
const getDriver = require('../lib/neo4j');

// GET /api/field-config/:country
router.get('/:country', async (req, res) => {
  const driver = getDriver();
  if (!driver) {
    return res.status(500).json({ success: false, message: 'Database connection not available' });
  }
  const session = driver.session();
  const { country } = req.params;

  try {
    const result = await session.run(
      `MATCH (c:CountryFieldConfig {countryName: $country}) RETURN c.fields AS fields`,
      { country: country.toUpperCase() }
    );

    let fields = [];
    if (result.records.length > 0) {
      const fieldsStr = result.records[0].get('fields');
      try {
        fields = JSON.parse(fieldsStr);
      } catch (e) {
        fields = [];
      }
    }
    res.json({ success: true, fields });
  } catch (error) {
    console.error('Error fetching field config:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch field configuration' });
  } finally {
    await session.close();
  }
});

// PUT /api/field-config/:country
router.put('/:country', async (req, res) => {
  const driver = getDriver();
  if (!driver) {
    return res.status(500).json({ success: false, message: 'Database connection not available' });
  }
  const session = driver.session();
  const { country } = req.params;
  const { fields } = req.body;

  if (!Array.isArray(fields)) {
    return res.status(400).json({ success: false, message: 'Fields must be an array' });
  }

  try {
    const result = await session.run(
      `MERGE (c:CountryFieldConfig {countryName: $country})
       SET c.fields = $fields
       RETURN c.fields AS fields`,
      { country: country.toUpperCase(), fields: JSON.stringify(fields) }
    );
    
    res.json({ success: true, message: 'Configuration saved successfully' });
  } catch (error) {
    console.error('Error saving field config:', error);
    res.status(500).json({ success: false, message: 'Failed to save field configuration' });
  } finally {
    await session.close();
  }
});

module.exports = router;
