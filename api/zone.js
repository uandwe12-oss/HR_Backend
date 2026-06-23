const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");

/**
 * Helper function to convert Neo4j integer to number
 */
const toNumber = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && value.low !== undefined) {
    return value.toNumber ? value.toNumber() : value.low;
  }
  return value;
};


/**
 * =================================================
 * ZONE STATUS LIST - Only these 4 statuses create/update zone entries
 * =================================================
 */
const ZONE_STATUSES = [
  'offer decline',
  'client interview reject',
  'client screening reject',
  'screening reject',
  'interview reject'
];

const isZoneStatus = (status) => {
  if (!status) return false;

  const normalized = status.trim().toLowerCase();

  // Handle aliases
  const aliases = {
    'offer declined': 'offer decline',
    'offer reject': 'offer decline',
    'offer rejected': 'offer decline'
  };
  console.log("FINAL STATUS CHECK:", {
    original: status,
    normalized: status?.trim()?.toLowerCase()
  });
  const finalStatus = aliases[normalized] || normalized;

  return ZONE_STATUSES.includes(finalStatus);
};

/**
 * Helper function to delete zone entry
 */
const deleteZoneEntry = async (candidateId, clientName) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
MATCH (z:Zone)
WHERE toFloat(z.candidateId) = toFloat($candidateId)
AND toLower(trim(z.clientName)) = toLower(trim($clientName))

WITH collect(z) as zones, count(z) as deletedCount

FOREACH (zone IN zones | DELETE zone)

RETURN deletedCount
    `, {
      candidateId: parseInt(candidateId),
      clientName: clientName
    });

    const deletedCount = toNumber(result.records[0].get('deletedCount'));
    if (deletedCount > 0) {
    }
    return deletedCount;
  } catch (err) {
    console.error("❌ Error deleting zone entry:", err);
    throw err;
  } finally {
    await session.close();
  }
};


/**
 * =================================================
 * AUTO CLEANUP FUNCTION - Runs automatically
 * =================================================
 */
const autoCleanupExpiredZones = async () => {

  const driver = getDriver();
  const session = driver.session();

  try {
    // Find expired entries using datetime conversion
    const findResult = await session.run(`
      MATCH (z:Zone)
      WHERE datetime(z.expiryDate) <= datetime()
      RETURN z.candidateId as candidateId, z.clientName as clientName, z.expiryDate as expiryDate
    `);

    const expiredCount = findResult.records.length;

    if (expiredCount > 0) {

      // Log the expired entries
      findResult.records.forEach(record => {
      });

      // Delete expired entries
      const result = await session.run(`
        MATCH (z:Zone)
        WHERE datetime(z.expiryDate) <= datetime()
        DELETE z
        RETURN count(z) as deletedCount
      `);

      const deletedCount = toNumber(result.records[0].get('deletedCount'));
    } else {
      console.log(`✅ [AUTO CLEANUP] No expired zone entries found`);
    }

  } catch (err) {
    console.error("❌ [AUTO CLEANUP] Error:", err.message);
  } finally {
    await session.close();
  }
};

/**
 * =================================================
 * START AUTO CLEANUP SCHEDULER
 * =================================================
 */
let cleanupInterval = null;

const startAutoCleanup = () => {
  if (cleanupInterval) {
    return;
  }


  // Run cleanup immediately on startup
  setTimeout(() => {
    autoCleanupExpiredZones();
  }, 5000);

  // Run cleanup every hour (instead of 6 hours)
  cleanupInterval = setInterval(autoCleanupExpiredZones, 60 * 60 * 1000);

  
};

/**
 * Stop auto cleanup (useful for testing)
 */
const stopAutoCleanup = () => {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
};

// Export the cleanup functions for external use
module.exports.startAutoCleanup = startAutoCleanup;
module.exports.stopAutoCleanup = stopAutoCleanup;
module.exports.autoCleanupExpiredZones = autoCleanupExpiredZones;

/**
 * =================================================
 * GET /api/zone - Get ALL zone entries (both active and expired)
 * =================================================
 */
router.get("/", async (req, res) => {

  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (z:Zone)
      RETURN z
      ORDER BY z.createdAt DESC
    `);

    const now = new Date();
    const zoneEntries = result.records.map(record => {
      const z = record.get('z').properties;
      const expiryDate = new Date(z.expiryDate);
      const isExpired = expiryDate <= now;
      const daysRemaining = isExpired ? 0 : Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

      return {
        candidateId: toNumber(z.candidateId),
        demandId: toNumber(z.demandId),
        clientName: z.clientName,
        rejectedStatus: z.rejectedStatus,
        reason: z.reason,
        rejectedBy: z.rejectedBy,
        rejectedAt: z.rejectedAt,
        createdAt: z.createdAt,
        expiryDate: z.expiryDate,
        isExpired: isExpired,
        daysRemaining: daysRemaining,
        status: isExpired ? 'Expired' : 'Active'
      };
    });

    const activeCount = zoneEntries.filter(z => !z.isExpired).length;
    const expiredCount = zoneEntries.filter(z => z.isExpired).length;


    res.json({
      success: true,
      data: zoneEntries,
      count: zoneEntries.length,
      activeCount: activeCount,
      expiredCount: expiredCount,
      message: `Found ${zoneEntries.length} zone entries (${activeCount} active, ${expiredCount} expired)`
    });

  } catch (err) {
    console.error("❌ Error fetching zone entries:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch zone entries",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/zone/active - Get ONLY active (non-expired) zone entries
 */
router.get("/active", async (req, res) => {

  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (z:Zone)
      WHERE datetime(z.expiryDate) > datetime()
      RETURN z
      ORDER BY z.expiryDate ASC
    `);

    const zoneEntries = result.records.map(record => {
      const z = record.get('z').properties;
      const expiryDate = new Date(z.expiryDate);
      const now = new Date();
      const daysRemaining = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

      return {
        candidateId: toNumber(z.candidateId),
        demandId: toNumber(z.demandId),
        clientName: z.clientName,
        rejectedStatus: z.rejectedStatus,
        reason: z.reason,
        rejectedBy: z.rejectedBy,
        rejectedAt: z.rejectedAt,
        createdAt: z.createdAt,
        expiryDate: z.expiryDate,
        daysRemaining: daysRemaining
      };
    });


    res.json({
      success: true,
      data: zoneEntries,
      count: zoneEntries.length,
      message: `Found ${zoneEntries.length} active zone entries`
    });

  } catch (err) {
    console.error("❌ Error fetching active zone entries:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch active zone entries",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/zone/expired - Get ONLY expired zone entries
 */
router.get("/expired", async (req, res) => {

  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (z:Zone)
      WHERE z.expiryDate <= datetime()
      RETURN z
      ORDER BY z.expiryDate DESC
    `);

    const zoneEntries = result.records.map(record => {
      const z = record.get('z').properties;
      const expiryDate = new Date(z.expiryDate);
      const now = new Date();
      const daysOverdue = Math.ceil((now - expiryDate) / (1000 * 60 * 60 * 24));

      return {
        candidateId: toNumber(z.candidateId),
        demandId: toNumber(z.demandId),
        clientName: z.clientName,
        rejectedStatus: z.rejectedStatus,
        reason: z.reason,
        rejectedBy: z.rejectedBy,
        rejectedAt: z.rejectedAt,
        createdAt: z.createdAt,
        expiryDate: z.expiryDate,
        daysOverdue: daysOverdue
      };
    });


    res.json({
      success: true,
      data: zoneEntries,
      count: zoneEntries.length,
      message: `Found ${zoneEntries.length} expired zone entries`
    });

  } catch (err) {
    console.error("❌ Error fetching expired zone entries:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch expired zone entries",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * POST /api/zone/add
 * Add or UPDATE a candidate to the zone for a specific client (after rejection)
 * - If candidate exists for the same client (any demand), UPDATE the existing record
 * - If candidate doesn't exist for this client, CREATE a new record
 */
router.post("/add", async (req, res) => {
  const { candidateId, demandId, clientName, status, reason, rejectedBy } = req.body;


  if (!candidateId || !demandId || !clientName) {
    return res.status(400).json({
      success: false,
      message: "candidateId, demandId, and clientName are required"
    });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    const now = new Date();
    const expiryDate = new Date(now);
    expiryDate.setMonth(expiryDate.getMonth() + 6); // 6 months from now

    // Check if candidate already has ANY zone entry for this client (regardless of demand)
    const existingCheck = await session.run(`
     MATCH (z:Zone)
WHERE toFloat(z.candidateId) = toFloat($candidateId)
AND toLower(trim(z.clientName)) = toLower(trim($clientName))
      RETURN z
      ORDER BY z.createdAt DESC
      LIMIT 1
    `, {
      candidateId: parseInt(candidateId),
      clientName: clientName
    });

    let result;

    if (existingCheck.records.length > 0) {
      // Existing entry found - UPDATE it
      const existingZone = existingCheck.records[0].get('z').properties;
      const oldExpiryDate = existingZone.expiryDate;
      const oldDemandId = existingZone.demandId;
      const oldStatus = existingZone.rejectedStatus;

      // Create previous rejection as JSON string
      const previousRejection = JSON.stringify({
        demandId: toNumber(oldDemandId),
        status: oldStatus,
        rejectedAt: existingZone.rejectedAt,
        expiryDate: oldExpiryDate,
        reason: existingZone.reason
      });

    
      // Update the existing entry with new rejection details
      result = await session.run(`
    MATCH (z:Zone)
WHERE toFloat(z.candidateId) = toFloat($candidateId)
AND toLower(trim(z.clientName)) = toLower(trim($clientName))
    SET z.demandId = $demandId,
        z.rejectedStatus = $status,
        z.reason = $reason,
        z.rejectedBy = $rejectedBy,
        z.rejectedAt = $rejectedAt,
        z.expiryDate = $expiryDate,
        z.updatedAt = $updatedAt,
        z.previousRejection = $previousRejection
    RETURN z
  `, {
        candidateId: parseInt(candidateId),
        clientName: clientName,
        demandId: parseInt(demandId),
        status: status,
        reason: reason || `Rejected with status: ${status}`,
        rejectedBy: rejectedBy || 'Unknown',
        rejectedAt: now.toISOString(),
        expiryDate: expiryDate.toISOString(),
        updatedAt: now.toISOString(),
        previousRejection: previousRejection  // Store as JSON string
      });


      const updatedZone = result.records[0].get('z').properties;

      res.json({
        success: true,
        action: 'updated',
        message: `Candidate zone entry updated for client ${clientName}. New expiry: ${expiryDate.toISOString()}`,
        data: {
          candidateId: toNumber(updatedZone.candidateId),
          clientName: updatedZone.clientName,
          demandId: toNumber(updatedZone.demandId),
          oldDemandId: toNumber(oldDemandId),
          rejectedStatus: updatedZone.rejectedStatus,
          oldStatus: oldStatus,
          reason: updatedZone.reason,
          rejectedBy: updatedZone.rejectedBy,
          rejectedAt: updatedZone.rejectedAt,
          expiryDate: updatedZone.expiryDate,
          updatedAt: updatedZone.updatedAt,
          previousRejection: JSON.parse(updatedZone.previousRejection) // Parse for response
        }
      });
    } else {
      // No existing entry - CREATE new one

      result = await session.run(`
        CREATE (z:Zone {
          candidateId: $candidateId,
          demandId: $demandId,
          clientName: $clientName,
          rejectedStatus: $status,
          reason: $reason,
          rejectedBy: $rejectedBy,
          rejectedAt: $rejectedAt,
          expiryDate: $expiryDate,
          createdAt: $createdAt,
          updatedAt: $createdAt
        })
        RETURN z
      `, {
        candidateId: parseInt(candidateId),
        demandId: parseInt(demandId),
        clientName: clientName,
        status: status,
        reason: reason || `Rejected with status: ${status}`,
        rejectedBy: rejectedBy || 'Unknown',
        rejectedAt: now.toISOString(),
        expiryDate: expiryDate.toISOString(),
        createdAt: now.toISOString()
      });

      const zoneEntry = result.records[0].get('z').properties;


      res.json({
        success: true,
        action: 'created',
        message: `Candidate added to zone for client ${clientName} for 6 months`,
        data: {
          candidateId: toNumber(zoneEntry.candidateId),
          clientName: zoneEntry.clientName,
          demandId: toNumber(zoneEntry.demandId),
          rejectedStatus: zoneEntry.rejectedStatus,
          reason: zoneEntry.reason,
          rejectedBy: zoneEntry.rejectedBy,
          rejectedAt: zoneEntry.rejectedAt,
          expiryDate: zoneEntry.expiryDate,
          createdAt: zoneEntry.createdAt
        }
      });
    }

  } catch (err) {
    console.error("❌ Error adding/updating candidate to zone:", err);
    res.status(500).json({
      success: false,
      message: "Failed to add/update candidate to zone",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

router.post("/manage", async (req, res) => {
  let { candidateId, clientName, demandId, status, reason, rejectedBy } = req.body;

  // console.log("\n" + "=".repeat(60));
  // console.log("🚨 ZONE MANAGE ENDPOINT CALLED 🚨");
  // console.log("=".repeat(60));
  // console.log("Raw request body:", JSON.stringify(req.body, null, 2));
  // console.log("candidateId:", candidateId, "type:", typeof candidateId);
  // console.log("clientName:", clientName);
  // console.log("demandId:", demandId);
  // console.log("status:", status, "type:", typeof status);
  // console.log("status length:", status?.length);
  // console.log("status trimmed:", status?.trim());
  // console.log("status === 'Offer Decline':", status === 'Offer Decline');
  // console.log("status.trim() === 'Offer Decline':", status?.trim() === 'Offer Decline');
  // console.log("ZONE_STATUSES:", ZONE_STATUSES);
  // console.log("isZoneStatus() result:", isZoneStatus(status));

  if (!candidateId || !clientName) {
    // console.log("❌ Missing required fields");
    return res.status(400).json({
      success: false,
      message: "candidateId and clientName are required"
    });
  }

  const driver = getDriver();
  if (!driver) {
    console.error("❌ Database driver not initialized!");
    return res.status(500).json({
      success: false,
      message: "Database driver not initialized"
    });
  }

  const session = driver.session();

  try {
    if (isZoneStatus(status)) {
      // console.log("✅ Status is a zone status - Proceeding with zone creation");

      const now = new Date();
      const expiryDate = new Date(now);
      expiryDate.setMonth(expiryDate.getMonth() + 6);

      // console.log("Creating zone entry with:", {
      //   candidateId: parseInt(candidateId),
      //   clientName: clientName,
      //   demandId: demandId ? parseInt(demandId) : null,
      //   status: status,
      //   expiryDate: expiryDate.toISOString()
      // });

      // Create zone entry directly without checking for existing
      const createResult = await session.run(`
  OPTIONAL MATCH (existing:Zone)
WHERE toFloat(existing.candidateId) = toFloat($candidateId)  AND toLower(trim(existing.clientName)) = toLower(trim($clientName))

  WITH existing

  FOREACH (_ IN CASE WHEN existing IS NOT NULL THEN [1] ELSE [] END |
    SET existing.demandId = $demandId,
        existing.rejectedStatus = $status,
        existing.reason = $reason,
        existing.rejectedBy = $rejectedBy,
        existing.rejectedAt = $rejectedAt,
        existing.expiryDate = $expiryDate,
        existing.updatedAt = $createdAt
  )

  FOREACH (_ IN CASE WHEN existing IS NULL THEN [1] ELSE [] END |
    CREATE (newZone:Zone {
      candidateId: $candidateId,
      clientName: $clientName,
      demandId: $demandId,
      rejectedStatus: $status,
      reason: $reason,
      rejectedBy: $rejectedBy,
      rejectedAt: $rejectedAt,
      expiryDate: $expiryDate,
      createdAt: $createdAt,
      updatedAt: $createdAt
    })
  )

  RETURN true as success
`, {
  candidateId: Number(candidateId),
  demandId: demandId ? Number(demandId) : null,
  clientName: String(clientName).trim(),
  status: String(status).trim(),
  reason: reason || `Rejected with status: ${status}`,
rejectedBy: rejectedBy || 'Unknown',
  rejectedAt: now.toISOString(),
  expiryDate: expiryDate.toISOString(),
  createdAt: now.toISOString()
});

      if (createResult.records.length > 0) {
        // console.log("✅ Zone entry created/updated successfully!");
        // console.log("   Candidate ID:", candidateId);
        // console.log("   Status:", status);
        // console.log("   Expiry:", expiryDate.toISOString());

        res.json({
          success: true,
          action: 'upserted',
          message: `Zone entry created/updated for candidate ${candidateId}`,
          data: {
            candidateId: candidateId,
            clientName: clientName,
            rejectedStatus: status,
            expiryDate: expiryDate.toISOString()
          }
        });
      } else {
        console.error("❌ Failed to create zone entry - no records returned");
        throw new Error("Failed to create zone entry");
      }

    } else {
      console.log("❌ Status is NOT a zone status - Skipping");
      res.json({
        success: true,
        action: 'skipped',
        message: `Status "${status}" is not a zone status`
      });
    }

  } catch (err) {
    console.error("❌ Error in zone/manage:", err);
    console.error("Error stack:", err.stack);
    res.status(500).json({
      success: false,
      message: "Failed to manage zone entry",
      error: err.message,
      stack: err.stack
    });
  } finally {
    await session.close();
  }
});



/**
 * GET /api/zone/history/:candidateId/:clientName
 * Get all zone history for a candidate with a specific client
 */
router.get("/history/:candidateId/:clientName", async (req, res) => {
  const { candidateId, clientName } = req.params;

  // console.log(`\n📡 GET /api/zone/history/${candidateId}/${clientName} - Fetching zone history`);

  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (z:Zone)
WHERE toFloat(z.candidateId) = toFloat($candidateId)
AND toLower(trim(z.clientName)) = toLower(trim($clientName))
      RETURN z
      ORDER BY z.createdAt DESC
    `, {
      candidateId: parseInt(candidateId),
      clientName: clientName
    });

    if (result.records.length === 0) {
      return res.json({
        success: true,
        hasHistory: false,
        message: `No zone history found for candidate ${candidateId} with client ${clientName}`,
        history: []
      });
    }

    const history = result.records.map(record => {
      const z = record.get('z').properties;
      const expiryDate = new Date(z.expiryDate);
      const now = new Date();
      const isExpired = expiryDate <= now;

      return {
        candidateId: toNumber(z.candidateId),
        demandId: toNumber(z.demandId),
        clientName: z.clientName,
        rejectedStatus: z.rejectedStatus,
        reason: z.reason,
        rejectedBy: z.rejectedBy,
        rejectedAt: z.rejectedAt,
        createdAt: z.createdAt,
        expiryDate: z.expiryDate,
        updatedAt: z.updatedAt,
        isExpired: isExpired,
        previousRejection: z.previousRejection || null
      };
    });


    res.json({
      success: true,
      hasHistory: true,
      candidateId: parseInt(candidateId),
      clientName: clientName,
      history: history,
      count: history.length,
      currentActive: history.find(h => !h.isExpired) ? true : false
    });

  } catch (err) {
    console.error("❌ Error fetching zone history:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch zone history",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/zone/check/:candidateId/:clientName
 * Check if candidate is in zone for a specific client
 */
router.get("/check/:candidateId/:clientName", async (req, res) => {
  const { candidateId, clientName } = req.params;


  const driver = getDriver();
  const session = driver.session();

  try {
    // Convert expiryDate string to datetime for comparison
    const result = await session.run(`
      MATCH (z:Zone)
WHERE toFloat(z.candidateId) = toFloat($candidateId)
AND toLower(trim(z.clientName)) = toLower(trim($clientName))
      WHERE datetime(z.expiryDate) > datetime()
      RETURN z
      ORDER BY z.rejectedAt DESC
      LIMIT 1
    `, {
      candidateId: parseInt(candidateId),
      clientName: clientName
    });

    if (result.records.length === 0) {
      return res.json({
        success: true,
        inZone: false,
        message: "Candidate is eligible for this client"
      });
    }

    const zoneEntry = result.records[0].get('z').properties;
    const expiryDate = zoneEntry.expiryDate;
    const now = new Date();
    const expiry = new Date(expiryDate);

    const daysRemaining = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));


    res.json({
      success: true,
      inZone: true,
      data: {
        candidateId: toNumber(zoneEntry.candidateId),
        clientName: zoneEntry.clientName,
        rejectedStatus: zoneEntry.rejectedStatus,
        reason: zoneEntry.reason,
        rejectedAt: zoneEntry.rejectedAt,
        expiryDate: expiryDate,
        daysRemaining: daysRemaining
      },
      message: `Candidate is in zone for ${clientName} for ${daysRemaining} more days`
    });

  } catch (err) {
    console.error("❌ Error checking zone status:", err);
    res.status(500).json({
      success: false,
      message: "Failed to check zone status",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * POST /api/zone/check-multiple
 * Check multiple candidates for zone status against a client
 */
router.post("/check-multiple", async (req, res) => {
  const { candidateIds, clientName } = req.body;


  if (!candidateIds || !Array.isArray(candidateIds) || candidateIds.length === 0) {
    return res.status(400).json({
      success: false,
      message: "candidateIds array and clientName are required"
    });
  }

  if (!clientName) {
    return res.status(400).json({
      success: false,
      message: "clientName is required"
    });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    const results = [];

    for (const candidateId of candidateIds) {
      const checkResult = await session.run(`
        MATCH (z:Zone)
WHERE toFloat(z.candidateId) = toFloat($candidateId)
AND toLower(trim(z.clientName)) = toLower(trim($clientName))
        WHERE datetime(z.expiryDate) > datetime()
        RETURN z
        ORDER BY z.rejectedAt DESC
        LIMIT 1
      `, {
        candidateId: parseInt(candidateId),
        clientName: clientName
      });

      if (checkResult.records.length > 0) {
        const zoneEntry = checkResult.records[0].get('z').properties;
        const expiryDate = zoneEntry.expiryDate;
        const now = new Date();
        const expiry = new Date(expiryDate);
        const daysRemaining = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

        results.push({
          candidateId: toNumber(candidateId),
          inZone: true,
          rejectedStatus: zoneEntry.rejectedStatus,
          reason: zoneEntry.reason,
          rejectedAt: zoneEntry.rejectedAt,
          expiryDate: expiryDate,
          daysRemaining: daysRemaining
        });
      } else {
        results.push({
          candidateId: toNumber(candidateId),
          inZone: false
        });
      }
    }

    const inZoneCount = results.filter(r => r.inZone).length;

    res.json({
      success: true,
      clientName: clientName,
      results: results,
      summary: {
        total: candidateIds.length,
        inZone: inZoneCount,
        eligible: candidateIds.length - inZoneCount
      }
    });

  } catch (err) {
    console.error("❌ Error checking multiple zone status:", err);
    res.status(500).json({
      success: false,
      message: "Failed to check zone status",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * DELETE /api/zone/cleanup
 * Remove expired zone entries (manual cleanup)
 */
router.delete("/cleanup", async (req, res) => {

  const driver = getDriver();
  const session = driver.session();

  try {
    // Find expired entries using datetime conversion
    const findResult = await session.run(`
      MATCH (z:Zone)
      WHERE datetime(z.expiryDate) <= datetime()
      RETURN z.candidateId as candidateId, z.clientName as clientName, z.expiryDate as expiryDate
    `);

    const expiredEntries = findResult.records.map(record => ({
      candidateId: record.get('candidateId'),
      clientName: record.get('clientName'),
      expiryDate: record.get('expiryDate')
    }));

    // Delete expired entries
    const result = await session.run(`
      MATCH (z:Zone)
      WHERE datetime(z.expiryDate) <= datetime()
      DELETE z
      RETURN count(z) as deletedCount
    `);

    const deletedCount = toNumber(result.records[0].get('deletedCount'));


    res.json({
      success: true,
      message: `Cleaned up ${deletedCount} expired zone entries`,
      deletedCount: deletedCount,
      expiredEntries: expiredEntries
    });

  } catch (err) {
    console.error("❌ Error cleaning up zone entries:", err);
    res.status(500).json({
      success: false,
      message: "Failed to cleanup zone entries",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/zone/list/:clientName
 * Get all active zone entries for a specific client
 */
router.get("/list/:clientName", async (req, res) => {
  const { clientName } = req.params;


  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (z:Zone {clientName: $clientName})
      WHERE datetime(z.expiryDate) > datetime()
      RETURN z
      ORDER BY z.expiryDate ASC
    `, { clientName });

    const zoneEntries = result.records.map(record => {
      const z = record.get('z').properties;
      const expiryDate = new Date(z.expiryDate);
      const now = new Date();
      const daysRemaining = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

      return {
        candidateId: toNumber(z.candidateId),
        demandId: toNumber(z.demandId),
        clientName: z.clientName,
        rejectedStatus: z.rejectedStatus,
        reason: z.reason,
        rejectedBy: z.rejectedBy,
        rejectedAt: z.rejectedAt,
        expiryDate: z.expiryDate,
        daysRemaining: daysRemaining
      };
    });


    res.json({
      success: true,
      clientName: clientName,
      zoneEntries: zoneEntries,
      count: zoneEntries.length
    });

  } catch (err) {
    console.error("❌ Error fetching zone entries:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch zone entries",
      error: err.message
    });
  } finally {
    await session.close();
  }
});
/**
 * DELETE /api/zone/remove/:candidateId/:clientName
 * Remove candidate from zone
 */
router.delete("/remove/:candidateId/:clientName", async (req, res) => {
  const { candidateId, clientName } = req.params;

  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
     MATCH (z:Zone)
WHERE toFloat(z.candidateId) = toFloat($candidateId)
AND toLower(trim(z.clientName)) = toLower(trim($clientName))

WITH collect(z) as zones, count(z) as deletedCount

FOREACH (zone IN zones | DELETE zone)

RETURN deletedCount
    `, {
      candidateId: Number(candidateId),
      clientName: String(clientName).trim()
    });

    const deletedCount = toNumber(result.records[0].get("deletedCount"));

    res.json({
      success: true,
      deletedCount,
      message: `Removed ${deletedCount} zone entries`
    });

  } catch (err) {
    console.error("❌ Error removing from zone:", err);

    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

module.exports = router;
module.exports.startAutoCleanup = startAutoCleanup;
module.exports.stopAutoCleanup = stopAutoCleanup;
module.exports.autoCleanupExpiredZones = autoCleanupExpiredZones;
