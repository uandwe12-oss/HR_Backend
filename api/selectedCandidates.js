const express = require("express");
const router = express.Router();
const axios = require('axios');
// Import the shared driver helper
const getDriver = require("../lib/neo4j");

// Helper function to parse skills
const parseKeySkills = (skills) => {
  if (!skills) return [];
  if (Array.isArray(skills)) return skills;
  if (typeof skills === 'string') {
    try {
      const parsed = JSON.parse(skills);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return skills.split(',').map(s => s.trim()).filter(s => s);
    }
  }
  return [];
};

// Helper function to convert Neo4j integer to number
const toNumber = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && value.low !== undefined) {
    return value.toNumber ? value.toNumber() : value.low;
  }
  return value;
};

// Add to Zone function
const addToZone = async (driver, candidateId, demandId, clientName, status, reason, changedBy) => {
  const session = driver.session();
  
  try {
    console.log(`\n🔍 Checking if candidate ${candidateId} already in zone for client ${clientName}`);
    
    // Check if candidate already has ANY zone entry for this client
    const existingCheck = await session.run(`
      MATCH (z:Zone {candidateId: $candidateId, clientName: $clientName})
      RETURN z
      ORDER BY z.createdAt DESC
      LIMIT 1
    `, { 
      candidateId: parseInt(candidateId), 
      clientName: clientName 
    });
    
    const now = new Date();
    const expiryDate = new Date(now);
    expiryDate.setMonth(expiryDate.getMonth() + 6);
    
    if (existingCheck.records.length > 0) {
      // UPDATE existing entry
      const existingZone = existingCheck.records[0].get('z').properties;
      
      // Create previous rejection as a JSON string (not a map/object)
      const previousRejection = JSON.stringify({
        demandId: toNumber(existingZone.demandId),
        status: existingZone.rejectedStatus,
        rejectedAt: existingZone.rejectedAt,
        expiryDate: existingZone.expiryDate,
        reason: existingZone.reason
      });
      
      console.log(`🔄 Updating existing zone entry for candidate ${candidateId} with client ${clientName}`);
      console.log(`   Old status: ${existingZone.rejectedStatus}, New status: ${status}`);
      console.log(`   Old demand: ${existingZone.demandId}, New demand: ${demandId}`);
      
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
        demandId: parseInt(demandId),
        status: status,
        reason: reason || `Rejected with status: ${status}`,
        rejectedBy: changedBy,
        rejectedAt: now.toISOString(),
        expiryDate: expiryDate.toISOString(),
        updatedAt: now.toISOString(),
        previousRejection: previousRejection  // Store as JSON string
      });
      
      console.log(`✅ Updated existing zone entry for candidate ${candidateId}`);
      return true;
    } else {
      // CREATE new entry
      console.log(`✨ Creating new zone entry for candidate ${candidateId} with client ${clientName}`);
      
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
        demandId: parseInt(demandId),
        clientName: clientName,
        status: status,
        reason: reason || `Rejected with status: ${status}`,
        rejectedBy: changedBy,
        rejectedAt: now.toISOString(),
        expiryDate: expiryDate.toISOString(),
        createdAt: now.toISOString()
      });
      
      console.log(`✅ Created new zone entry for candidate ${candidateId}`);
      return true;
    }
  } catch (err) {
    console.error(`❌ Error adding/updating zone:`, err);
    return false;
  } finally {
    await session.close();
  }
};

/**
 * POST /api/selected-candidates/:demandId
 * Save selected candidates for a demand
 */
router.post("/:demandId", async (req, res) => {
  const { demandId } = req.params;
  const { candidates, selectedBy } = req.body;
  
  console.log(`\n📡 POST /api/selected-candidates/${demandId} - Saving candidates`);
  
  if (!demandId) {
    return res.status(400).json({ success: false, message: "Demand ID is required" });
  }
  
  let candidatesArray = candidates;
  if (!Array.isArray(candidates)) {
    candidatesArray = [candidates];
  }
  
  if (!candidatesArray || candidatesArray.length === 0) {
    return res.status(400).json({ success: false, message: "Candidates are required" });
  }
  
  let driver;
  try {
    driver = getDriver();
    const session = driver.session();
    
    // Check if demand exists
    const demandCheck = await session.run(
      "MATCH (d:Demand {id: $demandId}) RETURN d",
      { demandId: parseInt(demandId) }
    );
    
    if (demandCheck.records.length === 0) {
      await session.close();
      return res.status(404).json({ 
        success: false, 
        message: `Demand with ID ${demandId} not found` 
      });
    }
    
    // Process each candidate
    for (const candidate of candidatesArray) {
      const canId = candidate.canId || candidate.actualId || candidate.id;
      
      if (!canId) {
        console.warn("Candidate missing ID:", candidate);
        continue;
      }
      
      console.log(`Processing candidate with Can_ID: ${canId}`);
      
      const now = new Date().toISOString();
      const selectedByName = selectedBy || 'Unknown';
      
      // Create history entry for selection
      const historyEntry = {
        action: 'SELECTED',
        status: 'In Progress',
        changedBy: selectedByName,
        changedAt: now,
        reason: 'Candidate selected for demand'
      };
      
      // Create or update the relationship with history array
      await session.run(`
        MATCH (d:Demand {id: $demandId})
        MATCH (c:Candidate_Profile {Can_ID: $canId})
        MERGE (d)-[r:HAS_SELECTED_CANDIDATE]->(c)
        SET r.selectedAt = $selectedAt,
            r.selectedBy = $selectedBy,
            r.status = $status,
            r.history = $history,
            r.updatedAt = $selectedAt
      `, {
        demandId: parseInt(demandId),
        canId: parseInt(canId),
        selectedAt: now,
        selectedBy: selectedByName,
        status: 'In Progress',
        history: JSON.stringify([historyEntry]) // Store as JSON array
      });
    }
    
    // Count total selected candidates
    const countResult = await session.run(`
      MATCH (d:Demand {id: $demandId})-[:HAS_SELECTED_CANDIDATE]->(c:Candidate_Profile)
      RETURN count(c) as count
    `, { demandId: parseInt(demandId) });
    
    const count = countResult.records[0].get('count').low || countResult.records[0].get('count');
    
    await session.close();
    
    res.json({
      success: true,
      message: `Successfully saved candidates for demand ${demandId}`,
      count: count
    });
    
  } catch (err) {
    console.error("❌ Error saving selected candidates:", err);
    res.status(500).json({
      success: false,
      message: "Failed to save selected candidates",
      error: err.message
    });
  }
});

/**
 * GET /api/selected-candidates/:demandId
 * Get selected candidates for a demand with full history
 */
router.get("/:demandId", async (req, res) => {
  const { demandId } = req.params;
  
  console.log(`\n📡 GET /api/selected-candidates/${demandId} - Fetching selected candidates`);
  
  if (!demandId) {
    return res.status(400).json({ success: false, message: "Demand ID is required" });
  }
  
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const result = await session.run(`
      MATCH (d:Demand {id: $demandId})-[r:HAS_SELECTED_CANDIDATE]->(c:Candidate_Profile)
      RETURN c, r
      ORDER BY r.selectedAt DESC
    `, { demandId: parseInt(demandId) });
    
    const candidates = result.records.map(record => {
      const candidate = record.get('c').properties;
      const relationship = record.get('r').properties;
      
      // Parse history - it's stored as JSON string
      let history = [];
      if (relationship.history) {
        try {
          history = typeof relationship.history === 'string' 
            ? JSON.parse(relationship.history) 
            : relationship.history;
        } catch (e) {
          console.error("Error parsing history:", e);
          history = [];
        }
      }
      
      return {
        // Candidate basic info (what you want to show)
        id: candidate.Can_ID,
        name: candidate['Candidate Name'] || '',
        resumePath: candidate.resumePath || '',
        googleDriveViewLink: candidate.googleDriveViewLink || '',
        
        // Who added them and when
        selectedBy: relationship.selectedBy,
        selectedAt: relationship.selectedAt,
        
        // Current status
        status: relationship.status || 'In Progress',
        
        // Full history of all actions
        history: history,
        
        // Additional fields if needed for display
        email: candidate.Email || '',
        mobile: candidate['Mobile No'] || '',
        experience: candidate.Experience || '',
        currentOrg: candidate['Current Org'] || '',
        keySkills: parseKeySkills(candidate['Key Skills'])
      };
    });
    
    console.log(`✅ Found ${candidates.length} selected candidates for demand ${demandId}`);
    
    res.json({
      success: true,
      data: candidates,
      totalCount: candidates.length,
      demandId: demandId
    });
    
  } catch (err) {
    console.error("❌ Error fetching selected candidates:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch selected candidates",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * PUT /api/selected-candidates/status
 * Update candidate status with reason and track who did it (WITH ZONE INTEGRATION)
 */
router.put("/status", async (req, res) => {
  const { candidateId, demandId, status, reason, changedBy } = req.body;
  
  console.log(`\n📡 PUT /api/selected-candidates/status - Updating candidate ${candidateId} to ${status}`);
  console.log(`Reason: ${reason}, Changed by: ${changedBy}`);
  
  if (!candidateId || !demandId || !status) {
    return res.status(400).json({ 
      success: false, 
      message: "candidateId, demandId, and status are required" 
    });
  }
  
  const driver = getDriver();
  const session = driver.session();
  
  try {
    // First get the current relationship to get existing history and demand details
    const getResult = await session.run(`
      MATCH (d:Demand {id: $demandId})-[r:HAS_SELECTED_CANDIDATE]->(c:Candidate_Profile {Can_ID: $candidateId})
      RETURN r, d
    `, {
      demandId: parseInt(demandId),
      candidateId: parseInt(candidateId)
    });
    
    if (!getResult.records.length) {
      return res.status(404).json({ 
        success: false, 
        message: "Candidate not found for this demand" 
      });
    }
    
    const relationship = getResult.records[0].get('r').properties;
    const demand = getResult.records[0].get('d').properties;
    const clientName = demand.clientName;
    
    // Parse existing history
    let history = [];
    if (relationship.history) {
      try {
        history = typeof relationship.history === 'string' 
          ? JSON.parse(relationship.history) 
          : relationship.history;
      } catch (e) {
        history = [];
      }
    }
    
    // Create new history entry for this status change
    const now = new Date().toISOString();
    const changedByName = changedBy || relationship.selectedBy || 'Unknown';
    
    const historyEntry = {
      action: 'STATUS_CHANGED',
      fromStatus: relationship.status || 'In Progress',
      toStatus: status,
      changedBy: changedByName,
      changedAt: now,
      reason: reason || `Status changed to ${status}`
    };
    
    // Add to history array
    history.push(historyEntry);
    
    // Update the relationship with new status and history
    const updateResult = await session.run(`
      MATCH (d:Demand {id: $demandId})-[r:HAS_SELECTED_CANDIDATE]->(c:Candidate_Profile {Can_ID: $candidateId})
      SET r.status = $status,
          r.history = $history,
          r.updatedAt = $updatedAt,
          r.updatedBy = $changedBy
      RETURN r, c
    `, {
      demandId: parseInt(demandId),
      candidateId: parseInt(candidateId),
      status: status,
      history: JSON.stringify(history),
      updatedAt: now,
      changedBy: changedByName
    });
    
    const updatedRelationship = updateResult.records[0].get('r').properties;
    const candidate = updateResult.records[0].get('c').properties;
    
  
    
   // ✅ MOVED THIS INSIDE try block - UPDATE CANDIDATE'S isInProgress FLAG
const pendingStatuses = [
  'Pending Screening',
  'Pending Interview',
  'Pending Client Screening',
  'Pending Client Interview',
  'Pending Offer',
  'Pending Joinee'
];

const isInProgress = pendingStatuses.includes(status);

try {
  await axios.put(`https://myuandwe-bg.vercel.app/api/candidates/${candidateId}/progress`, {
    isInProgress: isInProgress
  });
  console.log(`✅ Updated candidate ${candidateId} isInProgress to ${isInProgress}`);
} catch (syncErr) {
  console.error('⚠️ Failed to sync progress status:', syncErr.message);
  // Don't fail the main request if sync fails
}
    
    // ADD TO ZONE FOR REJECTION STATUSES
    const rejectionStatuses = [
      'Offer Decline',
      'Interview Reject',
      'Client Interview Reject',
      'Client Screening Reject'
    ];
    
    if (rejectionStatuses.includes(status) && clientName) {
      console.log(`🚫 Candidate rejected with status: ${status}. Adding to zone for client: ${clientName}`);
      await addToZone(driver, candidateId, demandId, clientName, status, reason, changedByName);
    }
    
    console.log(`✅ Candidate ${candidateId} status updated to ${status}`);
    
    // Return updated info
    res.json({
      success: true,
      message: `Candidate status updated to ${status}`,
      data: {
        id: candidate.Can_ID,
        name: candidate['Candidate Name'] || '',
        status: updatedRelationship.status,
        selectedBy: updatedRelationship.selectedBy,
        selectedAt: updatedRelationship.selectedAt,
        history: history,
        updatedAt: updatedRelationship.updatedAt,
        updatedBy: updatedRelationship.updatedBy,
        isInProgress: isInProgress, // ✅ Add this to response
        // Add zone info if applicable
        inZone: rejectionStatuses.includes(status) ? true : false,
        zoneExpiry: rejectionStatuses.includes(status) ? 
          new Date(new Date().setMonth(new Date().getMonth() + 6)).toISOString() : null
      }
    });
    
  } catch (err) {
    console.error("❌ Error updating candidate status:", err);
    res.status(500).json({
      success: false,
      message: "Failed to update candidate status",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/selected-candidates/history/:demandId/:candidateId
 * Get full history for a specific candidate in a demand
 */
router.get("/history/:demandId/:candidateId", async (req, res) => {
  const { demandId, candidateId } = req.params;
  
  console.log(`\n📡 GET /api/selected-candidates/history/${demandId}/${candidateId} - Fetching candidate history`);
  
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const result = await session.run(`
      MATCH (d:Demand {id: $demandId})-[r:HAS_SELECTED_CANDIDATE]->(c:Candidate_Profile {Can_ID: $candidateId})
      RETURN r.history as history, r.status as status, r.selectedBy as selectedBy, r.selectedAt as selectedAt
    `, {
      demandId: parseInt(demandId),
      candidateId: parseInt(candidateId)
    });
    
    if (!result.records.length) {
      return res.status(404).json({
        success: false,
        message: "Candidate not found for this demand"
      });
    }
    
    const historyValue = result.records[0].get('history');
    let history = [];
    
    if (historyValue) {
      try {
        history = typeof historyValue === 'string' 
          ? JSON.parse(historyValue) 
          : historyValue;
      } catch (e) {
        history = [];
      }
    }
    
    res.json({
      success: true,
      data: {
        history: history,
        currentStatus: result.records[0].get('status'),
        selectedBy: result.records[0].get('selectedBy'),
        selectedAt: result.records[0].get('selectedAt')
      }
    });
    
  } catch (err) {
    console.error("❌ Error fetching history:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch history",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * DELETE /api/selected-candidates/:demandId/:candidateId
 * Remove a specific candidate from a demand
 */
router.delete("/:demandId/:candidateId", async (req, res) => {
  const { demandId, candidateId } = req.params;
  
  console.log(`\n📡 DELETE /api/selected-candidates/${demandId}/${candidateId} - Removing candidate`);
  
  const driver = getDriver();
  const session = driver.session();
  
  try {
    await session.run(`
      MATCH (d:Demand {id: $demandId})-[r:HAS_SELECTED_CANDIDATE]->(c:Candidate_Profile {Can_ID: $candidateId})
      DELETE r
    `, {
      demandId: parseInt(demandId),
      candidateId: parseInt(candidateId)
    });
    
    res.json({
      success: true,
      message: `Candidate removed from demand ${demandId}`
    });
    
  } catch (err) {
    console.error("❌ Error removing candidate:", err);
    res.status(500).json({
      success: false,
      message: "Failed to remove candidate",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * DELETE /api/selected-candidates/:demandId
 * Delete all selected candidates for a demand
 */
router.delete("/:demandId", async (req, res) => {
  const { demandId } = req.params;
  
  console.log(`\n📡 DELETE /api/selected-candidates/${demandId} - Clearing all selected candidates`);
  
  const driver = getDriver();
  const session = driver.session();
  
  try {
    await session.run(`
      MATCH (d:Demand {id: $demandId})-[r:HAS_SELECTED_CANDIDATE]->()
      DELETE r
    `, { demandId: parseInt(demandId) });
    
    res.json({
      success: true,
      message: `All selected candidates cleared for demand ${demandId}`
    });
    
  } catch (err) {
    console.error("❌ Error clearing candidates:", err);
    res.status(500).json({
      success: false,
      message: "Failed to clear candidates",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

module.exports = router;
