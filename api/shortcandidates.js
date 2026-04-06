const express = require("express");
const router = express.Router();
const neo4j = require("neo4j-driver");
const path = require('path');
const fs = require('fs');
require("dotenv").config();

// ============================================
// NEO4J CONNECTION
// ============================================
console.log("\n" + "=".repeat(50));
console.log("🔌 Initializing Neo4j Connection for Shortlisted Candidates...");
console.log("=".repeat(50));

let driver;
try {
  const uri = process.env.NEO4J_URI || 'neo4j+s://48046602.databases.neo4j.io';
  const user = process.env.NEO4J_USER || 'neo4j';
  const password = process.env.NEO4J_PASSWORD || '5CFMv9N5rc4lJgSnXJm68eYpRw4DynDCov-0Fyy3m1Q';
  
  console.log(`📡 Connecting to Neo4j at: ${uri}`);
  
  driver = neo4j.driver(
    uri,
    neo4j.auth.basic(user, password),
    {
      maxConnectionLifetime: 3 * 60 * 60 * 1000,
      maxConnectionPoolSize: 50,
      connectionAcquisitionTimeout: 2 * 60 * 1000,
      disableLosslessIntegers: true
    }
  );

  // Test connection
  (async () => {
    try {
      const session = driver.session();
      const result = await session.run("RETURN 1 as test");
      console.log("✅ Neo4j connected successfully for Shortlisted Candidates");
      await session.close();
    } catch (err) {
      console.error("❌ Neo4j connection failed:", err.message);
    }
  })();
} catch (err) {
  console.error("❌ Failed to create Neo4j driver:", err.message);
}

// ============================================
// HELPER FUNCTIONS
// ============================================

const toNumber = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && value.low !== undefined) {
    return value.toNumber ? value.toNumber() : value.low;
  }
  return value;
};

/**

 * Get all candidates in Zone for a specific client

 */

const getCandidatesInZone = async (clientName) => {

  const session = driver.session();

 

  try {

    console.log(`🔍 Searching for Zone entries for client: ${clientName}`);

   

    // Get all zone entries for this client first

    const result = await session.run(`

      MATCH (z:Zone {clientName: $clientName})

      RETURN z.candidateId as candidateId, z.expiryDate as expiryDate

    `, { clientName });

   

    const currentDateTime = new Date();

    const activeCandidateIds = [];

   

    // Filter in JavaScript

    result.records.forEach(record => {

      const expiryDateStr = record.get('expiryDate');

      const expiryDate = new Date(expiryDateStr);

     

      if (expiryDate > currentDateTime) {

        const candidateId = toNumber(record.get('candidateId'));

        activeCandidateIds.push(candidateId);

      }

    });

   

    console.log(`✅ Found ${activeCandidateIds.length} active candidates in zone for client: ${clientName}`);

   

    return activeCandidateIds;

  } catch (err) {

    console.error("❌ Error getting candidates in zone:", err);

    return [];

  } finally {

    await session.close();

  }

};

router.use((req, res, next) => {
  const allowedOrigins = [
    "https://myuandwe.vercel.app",
    "https://recruitment-hiring-portal-ibsf.vercel.app",
    "http://localhost:5173"
  ];

  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header('Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization');

  res.header('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

router.use((req, res, next) => {
  console.log(`🔍 Shortlist Route accessed: ${req.method} ${req.originalUrl}`);
  next();
});

// Extract skills array from profile
const extractSkillsArray = (skills) => {
  if (!skills) return [];
  
  if (Array.isArray(skills)) {
    return skills;
  } else if (typeof skills === 'string') {
    try {
      const parsed = JSON.parse(skills);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return skills.split(',').map(s => s.trim()).filter(s => s);
    }
  }
  return [];
};

// Parse experience string to number (in years)
const parseExperience = (expString) => {
  if (!expString) return 0;
  
  // If it's already a number
  if (typeof expString === 'number') return expString;
  
  // Try to extract number from string (e.g., "5 years", "3.5 yrs", "2")
  const match = expString.toString().match(/(\d+(\.\d+)?)/);
  return match ? parseFloat(match[0]) : 0;
};

// Normalize field names
const normalizeProfileFields = (profile) => {
  const normalized = {};
  
  for (const [key, value] of Object.entries(profile)) {
    const lowerKey = key.toLowerCase().replace(/\s+/g, '');
    
    if (key === 'Candidate Name' || key === 'candidateName' || key === 'name') {
      normalized.name = value;
    } else if (key === 'Email' || key === 'email') {
      normalized.email = value;
    } else if (key === 'Mobile No' || key === 'mobileNo' || key === 'mobile') {
      normalized.mobile = value;
    } else if (key === 'Experience' || key === 'experience') {
      normalized.experience = value;
      normalized.experienceYears = parseExperience(value);
    } else if (key === 'Current Org' || key === 'currentOrg') {
      normalized.currentOrg = value;
    } else if (key === 'Current CTC' || key === 'currentCTC') {
      normalized.currentCTC = value;
    } else if (key === 'Expected CTC' || key === 'expectedCTC') {
      normalized.expectedCTC = value;
    } else if (key === 'Notice Period in days' || key === 'noticePeriod') {
      normalized.noticePeriod = value;
    } else if (key === 'Profiles sourced by' || key === 'profileSourcedBy') {
      normalized.profileSourcedBy = value;
    } else if (key === 'Client Name' || key === 'clientName') {
      normalized.clientName = value;
    } else if (key === 'Profile submission date' || key === 'profileSubmissionDate') {
      normalized.profileSubmissionDate = value;
    } else if (key === 'Key Skills' || key === 'keySkills') {
      normalized.keySkills = value;
    } else if (key === 'Can_ID' || key === 'canId' || key === 'Can ID') {
      normalized.canId = toNumber(value);
    } else if (key === 'Visa type' || key === 'visaType') {
      normalized.visaType = value;
    } else if (key === 'resumePath') {
      normalized.resumePath = value;
    } else if (key === 'googleDriveFileId') {
      normalized.googleDriveFileId = value;
    } else if (key === 'googleDriveViewLink') {
      normalized.googleDriveViewLink = value;
    } else if (key === 'googleDriveDownloadLink') {
      normalized.googleDriveDownloadLink = value;
    } else if (key === 'createdAt') {
      normalized.createdAt = value;
    } else if (key === 'updatedAt') {
      normalized.updatedAt = value;
    } else if (key === 'id') {
      normalized.id = toNumber(value);
    } else if (key === 'shortlistedAt' || key === 'shortlistedAt') {
      normalized.shortlistedAt = value;
    } else if (key === 'shortlistedBy' || key === 'shortlistedBy') {
      normalized.shortlistedBy = value;
    } else if (key === 'shortlistNotes' || key === 'shortlistNotes') {
      normalized.shortlistNotes = value;
    } else {
      normalized[key] = value;
    }
  }
  
  return normalized;
};


// Format profile for response
const formatProfileForResponse = (profile) => {
  const normalized = normalizeProfileFields(profile);
  
  // Ensure skills is always an array
  normalized.keySkills = extractSkillsArray(normalized.keySkills);
  
  // ✅ ADD THIS ONE LINE - Include isInProgress flag
  normalized.isInProgress = profile.isInProgress || false;
  
  return normalized;
};;

// ============================================
// SHORTLISTED CANDIDATES ROUTES
// ============================================

/**
 * GET /api/shortcandidates/filter
 * Filter candidate profiles by skills, experience, and exclude candidates in Zone
 */
router.get("/filter", async (req, res) => {
  console.log("\n📡 GET /api/shortcandidates/filter - Filtering candidate profiles");
  console.log("Query parameters:", req.query);
  
  // Extract query parameters
  const { 
    primarySkills: primarySkillsParam, 
    secondarySkills: secondarySkillsParam,
    minExperience = 0,
    maxExperience = 100,
    clientName  // NEW: Client name from demand to filter out Zone candidates
  } = req.query;
  
  // Parse comma-separated skills into arrays
  const primarySkills = primarySkillsParam 
    ? primarySkillsParam.split(',').map(s => s.trim()).filter(s => s) 
    : [];
    
  const secondarySkills = secondarySkillsParam 
    ? secondarySkillsParam.split(',').map(s => s.trim()).filter(s => s) 
    : [];
  
  console.log("Parsed primary skills:", primarySkills);
  console.log("Parsed secondary skills:", secondarySkills);
  console.log(`Experience range: ${minExperience} - ${maxExperience} years`);
  console.log(`Client name for Zone filtering: ${clientName || 'None'}`);
  
  const session = driver.session();
  
  try {
    // Get candidates in Zone for this client (if clientName provided)
    let zoneCandidateIds = [];
    if (clientName) {
      zoneCandidateIds = await getCandidatesInZone(clientName);
      console.log(`🚫 Will exclude ${zoneCandidateIds.length} candidates in Zone for client: ${clientName}`);
      if (zoneCandidateIds.length > 0) {
        console.log(`   Excluded candidate IDs: ${zoneCandidateIds.join(', ')}`);
      }
    }
    
    // Get all candidate profiles
    const result = await session.run(`
      MATCH (c:Candidate_Profile)
      RETURN c 
      ORDER BY c.id DESC
    `);
    
    console.log(`📊 Found ${result.records.length} total candidate profiles`);
    
    // Format all profiles
    const allProfiles = result.records.map(r => {
      const profile = r.get("c").properties;
      const formatted = formatProfileForResponse(profile);
      
      // Add parsed experience for filtering
      formatted.experienceYears = parseExperience(formatted.experience);
      
      return formatted;
    });
    
    // First, filter out candidates in Zone
    let filteredProfiles = allProfiles;
    if (zoneCandidateIds.length > 0) {
      filteredProfiles = allProfiles.filter(profile => {
        const candidateId = profile.canId || profile.id;
        const isInZone = zoneCandidateIds.includes(candidateId);
        if (isInZone) {
          console.log(`   Excluding candidate ${candidateId} (${profile.name}) - in Zone for ${clientName}`);
        }
        return !isInZone;
      });
      console.log(`📊 After Zone filter: ${filteredProfiles.length} candidates remaining`);
    }
    
    // Apply experience filter
    const minExp = parseFloat(minExperience) || 0;
    const maxExp = parseFloat(maxExperience) || 100;
    
    const filteredByExperience = filteredProfiles.filter(profile => {
      const expYears = profile.experienceYears || 0;
      return expYears >= minExp && expYears <= maxExp;
    });
    
    console.log(`📊 After experience filter (${minExp}-${maxExp} years): ${filteredByExperience.length} candidates`);
    
    // If no search skills, return experience-filtered profiles sorted by experience descending
    if (primarySkills.length === 0 && secondarySkills.length === 0) {
      // Sort by experience in descending order
      const sortedByExperience = [...filteredByExperience].sort((a, b) => {
        return (b.experienceYears || 0) - (a.experienceYears || 0);
      });
      
      return res.json({
        success: true,
        data: sortedByExperience,
        totalCount: sortedByExperience.length,
        excludedZoneCount: zoneCandidateIds.length,
        filters: {
          primarySkills: [],
          secondarySkills: [],
          minExperience: minExp,
          maxExperience: maxExp,
          clientName: clientName || null
        }
      });
    }
    
    // Normalize search skills to lowercase
    const normalizedPrimary = primarySkills.map(s => s.toLowerCase().trim());
    const normalizedSecondary = secondarySkills.map(s => s.toLowerCase().trim());
    
    // Score and categorize each candidate based on skill matches
    const scoredCandidates = filteredByExperience.map(profile => {
      const profileSkills = profile.keySkills.map(s => s.toLowerCase().trim());
      
      // Check primary skills matches
      const hasAllPrimary = normalizedPrimary.length > 0 && 
        normalizedPrimary.every(skill => profileSkills.includes(skill));
      
      const hasSomePrimary = normalizedPrimary.length > 0 && 
        normalizedPrimary.some(skill => profileSkills.includes(skill));
      
      const primaryMatches = normalizedPrimary.filter(skill => 
        profileSkills.includes(skill)
      ).length;
      
      // Check secondary skills matches
      const hasAllSecondary = normalizedSecondary.length > 0 && 
        normalizedSecondary.every(skill => profileSkills.includes(skill));
      
      const hasSomeSecondary = normalizedSecondary.length > 0 && 
        normalizedSecondary.some(skill => profileSkills.includes(skill));
      
      const secondaryMatches = normalizedSecondary.filter(skill => 
        profileSkills.includes(skill)
      ).length;
      
      // Determine category (1 is highest priority)
      let category = 5; // Default: No matches at all
      
      if (hasAllPrimary && hasAllSecondary) {
        category = 1; // Has ALL primary AND ALL secondary - TOP PRIORITY
      } else if (hasAllPrimary) {
        category = 2; // Has ALL primary only - SECOND PRIORITY
      } else if (hasSomePrimary) {
        category = 3; // Has SOME primary only - THIRD PRIORITY
      } else if (hasAllSecondary) {
        category = 4; // Has ALL secondary only - FOURTH PRIORITY
      } else if (hasSomeSecondary) {
        category = 5; // Has SOME secondary only - FIFTH PRIORITY
      }
      
      return {
        ...profile,
        matchScore: {
          category,
          primaryMatches,
          secondaryMatches,
          hasAllPrimary,
          hasAllSecondary,
          hasSomePrimary,
          hasSomeSecondary
        }
      };
    });
    
    // Filter out candidates with no matches if there are search skills
    const matchedCandidates = scoredCandidates.filter(c => {
      if (primarySkills.length > 0 && secondarySkills.length > 0) {
        return c.matchScore.primaryMatches > 0 || c.matchScore.secondaryMatches > 0;
      } else if (primarySkills.length > 0) {
        return c.matchScore.primaryMatches > 0;
      } else if (secondarySkills.length > 0) {
        return c.matchScore.secondaryMatches > 0;
      }
      return true;
    });
    
    // Separate matched candidates by category
    const category1 = matchedCandidates.filter(c => c.matchScore.category === 1);
    const category2 = matchedCandidates.filter(c => c.matchScore.category === 2);
    const category3 = matchedCandidates.filter(c => c.matchScore.category === 3);
    const category4 = matchedCandidates.filter(c => c.matchScore.category === 4);
    const category5 = matchedCandidates.filter(c => c.matchScore.category === 5);
    
    // Sort each category by experience in descending order
    const sortByExperienceDesc = (a, b) => (b.experienceYears || 0) - (a.experienceYears || 0);
    
    category1.sort(sortByExperienceDesc);
    category2.sort(sortByExperienceDesc);
    category3.sort(sortByExperienceDesc);
    category4.sort(sortByExperienceDesc);
    category5.sort(sortByExperienceDesc);
    
    // Combine categories in the desired order
    const sortedCandidates = [...category1, ...category2, ...category3, ...category4, ...category5];
    
    const totalCount = sortedCandidates.length;
    
    console.log(`📊 Final filtered candidates: ${totalCount}`);
    console.log(`   Category distribution:`, {
      category1: category1.length,
      category2: category2.length,
      category3: category3.length,
      category4: category4.length,
      category5: category5.length
    });
    
    res.json({
      success: true,
      data: sortedCandidates,
      totalCount: totalCount,
      excludedZoneCount: zoneCandidateIds.length,
      filters: {
        primarySkills,
        secondarySkills,
        minExperience: minExp,
        maxExperience: maxExp,
        clientName: clientName || null
      }
    });
    
  } catch (err) {
    console.error("❌ Error filtering candidates:", err);
    res.status(500).json({ 
      success: false, 
      message: "Failed to filter candidates",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/shortcandidates
 * Get all candidate profiles (excluding Zone candidates if clientName provided)
 */
router.get("/", async (req, res) => {
  console.log("\n📡 GET /api/shortcandidates - Fetching all candidate profiles");
  
  const { minExperience, maxExperience, clientName } = req.query;
  const session = driver.session();
  
  try {
    // Get candidates in Zone for this client (if clientName provided)
    let zoneCandidateIds = [];
    if (clientName) {
      zoneCandidateIds = await getCandidatesInZone(clientName);
      console.log(`🚫 Will exclude ${zoneCandidateIds.length} candidates in Zone for client: ${clientName}`);
    }
    
    // Get all candidate profiles
    const result = await session.run(`
      MATCH (c:Candidate_Profile)
      RETURN c 
      ORDER BY c.id DESC
    `);
    
    console.log(`📊 Found ${result.records.length} total candidate profiles`);
    
    let profiles = result.records.map(r => {
      const profile = r.get("c").properties;
      const formatted = formatProfileForResponse(profile);
      formatted.experienceYears = parseExperience(formatted.experience);
      return formatted;
    });
    
    // Filter out Zone candidates
    if (zoneCandidateIds.length > 0) {
      profiles = profiles.filter(profile => {
        const candidateId = profile.canId || profile.id;
        const isInZone = zoneCandidateIds.includes(candidateId);
        if (isInZone) {
          console.log(`   Excluding candidate ${candidateId} (${profile.name}) - in Zone for ${clientName}`);
        }
        return !isInZone;
      });
      console.log(`📊 After Zone filter: ${profiles.length} candidates remaining`);
    }
    
    // Apply experience filters if provided
    if (minExperience !== undefined || maxExperience !== undefined) {
      const minExp = minExperience ? parseFloat(minExperience) : 0;
      const maxExp = maxExperience ? parseFloat(maxExperience) : 100;
      
      profiles = profiles.filter(profile => {
        const expYears = profile.experienceYears || 0;
        return expYears >= minExp && expYears <= maxExp;
      });
      
      console.log(`📊 After experience filter: ${profiles.length} candidates`);
    }
    
    // Sort by experience descending
    profiles.sort((a, b) => (b.experienceYears || 0) - (a.experienceYears || 0));
    
    res.json({
      success: true,
      data: profiles,
      totalCount: profiles.length,
      excludedZoneCount: zoneCandidateIds.length
    });
    
  } catch (err) {
    console.error("❌ Error fetching candidates:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch candidates",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/shortcandidates/:candidateId
 * Get a specific candidate profile by ID
 */
router.get("/:candidateId", async (req, res) => {
  console.log(`\n📡 GET /api/shortcandidates/${req.params.candidateId}`);
  
  const session = driver.session();
  const candidateId = parseInt(req.params.candidateId);
  
  try {
    const result = await session.run(`
      MATCH (c:Candidate_Profile)
      WHERE c.canId = $id OR c.id = $id
      RETURN c
    `, {
      id: candidateId
    });
    
    if (!result.records.length) {
      return res.status(404).json({
        success: false,
        message: "Candidate not found"
      });
    }
    
    const profile = result.records[0].get("c").properties;
    const formatted = formatProfileForResponse(profile);
    formatted.experienceYears = parseExperience(formatted.experience);
    
    res.json({
      success: true,
      data: formatted
    });
    
  } catch (err) {
    console.error("❌ Error fetching candidate:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch candidate",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

module.exports = router;
