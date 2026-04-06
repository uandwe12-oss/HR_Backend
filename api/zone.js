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
  'Client Interview Reject',
  'Client Screening Reject', 
  'Screening Reject',
  'Interview Reject'
];

const isZoneStatus = (status) => {
  return ZONE_STATUSES.includes(status);
};

/**
 * Helper function to delete zone entry
 */
const deleteZoneEntry = async (candidateId, clientName) => {
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const result = await session.run(`
      MATCH (z:Zone {candidateId: $candidateId, clientName: $clientName})
      DELETE z
      RETURN count(z) as deletedCount
    `, {
      candidateId: parseInt(candidateId),
      clientName: clientName
    });
    
    const deletedCount = toNumber(result.records[0].get('deletedCount'));
    if (deletedCount > 0) {
      console.log(`🗑️ Deleted zone entry for candidate ${candidateId} (client: ${clientName})`);
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
  console.log(`\n🧹 [AUTO CLEANUP] Checking for expired zone entries at ${new Date().toISOString()}`);
  
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
      console.log(`📊 Found ${expiredCount} expired zone entries to delete`);
      
      // Log the expired entries
      findResult.records.forEach(record => {
        console.log(`   - Candidate ${record.get('candidateId')} for client ${record.get('clientName')} (expired: ${record.get('expiryDate')})`);
      });
      
      // Delete expired entries
      const result = await session.run(`
        MATCH (z:Zone)
        WHERE datetime(z.expiryDate) <= datetime()
        DELETE z
        RETURN count(z) as deletedCount
      `);
      
      const deletedCount = toNumber(result.records[0].get('deletedCount'));
      console.log(`✅ [AUTO CLEANUP] Successfully deleted ${deletedCount} expired zone entries`);
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
    console.log('⚠️ Auto cleanup already running');
    return;
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('🚀 STARTING AUTO CLEANUP SCHEDULER FOR ZONE ENTRIES');
  console.log('='.repeat(60));
  
  // Run cleanup immediately on startup
  setTimeout(() => {
    autoCleanupExpiredZones();
  }, 5000);
  
  // Run cleanup every hour (instead of 6 hours)
  cleanupInterval = setInterval(autoCleanupExpiredZones, 60 * 60 * 1000);
  
  console.log('⏰ Auto cleanup scheduled to run every hour');
  console.log('='.repeat(60) + '\n');
};

/**
 * Stop auto cleanup (useful for testing)
 */
const stopAutoCleanup = () => {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log('🛑 Auto cleanup stopped');
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
  console.log(`\n📡 GET /api/zone - Fetching ALL zone entries`);
  
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
    
    console.log(`📊 Found ${zoneEntries.length} total zone entries (${activeCount} active, ${expiredCount} expired)`);
    
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
  console.log(`\n📡 GET /api/zone/active - Fetching active zone entries only`);
  
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const result = await session.run(`
      MATCH (z:Zone)
      WHERE z.expiryDate > datetime()
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
    
    console.log(`📊 Found ${zoneEntries.length} active zone entries`);
    
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
  console.log(`\n📡 GET /api/zone/expired - Fetching expired zone entries only`);
  
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
    
    console.log(`📊 Found ${zoneEntries.length} expired zone entries`);
    
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
  
  console.log(`\n📡 POST /api/zone/add - Processing candidate ${candidateId} for client: ${clientName}`);
  
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
      MATCH (z:Zone {candidateId: $candidateId, clientName: $clientName})
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
  
  console.log(`🔄 Found existing zone entry for candidate ${candidateId} (client: ${clientName})`);
  console.log(`   Old demand: ${oldDemandId}, Old status: ${oldStatus}, Old expiry: ${oldExpiryDate}`);
  console.log(`   New demand: ${demandId}, New status: ${status}, New expiry: ${expiryDate.toISOString()}`);
  
  // Update the existing entry with new rejection details
  result = await session.run(`
    MATCH (z:Zone {candidateId: $candidateId, clientName: $clientName})
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
  
  console.log(`✅ Updated existing zone entry for candidate ${candidateId} (client: ${clientName})`);
  
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
}else {
      // No existing entry - CREATE new one
      console.log(`✨ No existing zone entry found, creating new for candidate ${candidateId} (client: ${clientName})`);
      
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
      
      console.log(`✅ Created new zone entry for candidate ${candidateId} (client: ${clientName}) until ${expiryDate.toISOString()}`);
      
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

/**
 * POST /api/zone/manage
 * Manage zone entry based on candidate status
 * - If status is one of the 4 rejection types: ADD/UPDATE zone entry
 * - If status is anything else: DELETE zone entry if exists
 */
router.post("/manage", async (req, res) => {
  const { candidateId, clientName, demandId, status, reason, rejectedBy } = req.body;
  
  console.log(`\n📡 POST /api/zone/manage - Processing candidate ${candidateId} for client: ${clientName}`);
  console.log(`   Status: ${status}`);
  
  if (!candidateId || !clientName) {
    return res.status(400).json({ 
      success: false, 
      message: "candidateId and clientName are required" 
    });
  }
  
  const driver = getDriver();
  const session = driver.session();
  
  try {
    // Check if this is a zone-status (one of the 4 rejection types)
    if (isZoneStatus(status)) {
      console.log(`✅ Status "${status}" is a zone status - Adding/Updating zone entry`);
      
      // Add or update zone entry
      const now = new Date();
      const expiryDate = new Date(now);
      expiryDate.setMonth(expiryDate.getMonth() + 6);
      
      // Check if candidate already has zone entry for this client
      const existingCheck = await session.run(`
        MATCH (z:Zone {candidateId: $candidateId, clientName: $clientName})
        RETURN z
        ORDER BY z.createdAt DESC
        LIMIT 1
      `, { 
        candidateId: parseInt(candidateId), 
        clientName: clientName 
      });
      
      if (existingCheck.records.length > 0) {
        // UPDATE existing entry
        const existingZone = existingCheck.records[0].get('z').properties;
        
        const previousRejection = JSON.stringify({
          demandId: toNumber(existingZone.demandId),
          status: existingZone.rejectedStatus,
          rejectedAt: existingZone.rejectedAt,
          expiryDate: existingZone.expiryDate,
          reason: existingZone.reason
        });
        
        await session.run(`
          MATCH (z:Zone {candidateId: $candidateId, clientName: $clientName})
          SET z.demandId = $demandId,
              z.rejectedStatus = $status,
              z.reason = $reason,
              z.rejectedBy = $rejectedBy,
              z.rejectedAt = $rejectedAt,
              z.expiryDate = $expiryDate,
              z.updatedAt = $updatedAt,
              z.previousRejection = $previousRejection
        `, {
          candidateId: parseInt(candidateId),
          clientName: clientName,
          demandId: demandId ? parseInt(demandId) : null,
          status: status,
          reason: reason || `Rejected with status: ${status}`,
          rejectedBy: rejectedBy || 'Unknown',
          rejectedAt: now.toISOString(),
          expiryDate: expiryDate.toISOString(),
          updatedAt: now.toISOString(),
          previousRejection: previousRejection
        });
        
        res.json({
          success: true,
          action: 'updated',
          message: `Zone entry updated for candidate ${candidateId}`
        });
      } else {
        // CREATE new entry
        await session.run(`
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
        `, {
          candidateId: parseInt(candidateId),
          demandId: demandId ? parseInt(demandId) : null,
          clientName: clientName,
          status: status,
          reason: reason || `Rejected with status: ${status}`,
          rejectedBy: rejectedBy || 'Unknown',
          rejectedAt: now.toISOString(),
          expiryDate: expiryDate.toISOString(),
          createdAt: now.toISOString()
        });
        
        res.json({
          success: true,
          action: 'created',
          message: `Zone entry created for candidate ${candidateId}`
        });
      }
      
    } else {
      // NOT a zone status - DELETE zone entry if exists
      console.log(`❌ Status "${status}" is NOT a zone status - Deleting zone entry if exists`);
      
      const deletedCount = await deleteZoneEntry(candidateId, clientName);
      
      res.json({
        success: true,
        action: deletedCount > 0 ? 'deleted' : 'none',
        message: deletedCount > 0 
          ? `Zone entry deleted for candidate ${candidateId}` 
          : `No zone entry found for candidate ${candidateId}`
      });
    }
    
  } catch (err) {
    console.error("❌ Error managing zone entry:", err);
    res.status(500).json({
      success: false,
      message: "Failed to manage zone entry",
      error: err.message
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
  
  console.log(`\n📡 GET /api/zone/history/${candidateId}/${clientName} - Fetching zone history`);
  
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const result = await session.run(`
      MATCH (z:Zone {candidateId: $candidateId, clientName: $clientName})
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
    
    console.log(`📊 Found ${history.length} zone history entries for candidate ${candidateId} with client ${clientName}`);
    
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
  
  console.log(`\n📡 GET /api/zone/check/${candidateId}/${clientName} - Checking zone status`);
  
  const driver = getDriver();
  const session = driver.session();
  
  try {
    // Convert expiryDate string to datetime for comparison
    const result = await session.run(`
      MATCH (z:Zone {candidateId: $candidateId, clientName: $clientName})
      WHERE datetime(z.expiryDate) > datetime()
      RETURN z
      ORDER BY z.rejectedAt DESC
      LIMIT 1
    `, {
      candidateId: parseInt(candidateId),
      clientName: clientName
    });
    
    if (result.records.length === 0) {
      console.log(`✅ Candidate ${candidateId} is not in zone for client ${clientName}`);
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
    
    console.log(`⚠️ Candidate ${candidateId} is in zone for client ${clientName} until ${expiryDate}`);
    
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
  
  console.log(`\n📡 POST /api/zone/check-multiple - Checking ${candidateIds?.length || 0} candidates for client: ${clientName}`);
  
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
        MATCH (z:Zone {candidateId: $candidateId, clientName: $clientName})
        WHERE z.expiryDate > datetime()
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
    console.log(`📊 Zone check results: ${inZoneCount}/${candidateIds.length} candidates are in zone`);
    
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
  console.log(`\n📡 DELETE /api/zone/cleanup - Manual cleanup of expired zone entries`);
  
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
    
    console.log(`✅ Manual cleanup: Deleted ${deletedCount} expired zone entries`);
    
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
  
  console.log(`\n📡 GET /api/zone/list/${clientName} - Fetching active zone entries`);
  
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const result = await session.run(`
      MATCH (z:Zone {clientName: $clientName})
      WHERE z.expiryDate > datetime()
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
    
    console.log(`📊 Found ${zoneEntries.length} active zone entries for client ${clientName}`);
    
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

module.exports = router; 
module.exports.startAutoCleanup = startAutoCleanup;
module.exports.stopAutoCleanup = stopAutoCleanup;
module.exports.autoCleanupExpiredZones = autoCleanupExpiredZones;
