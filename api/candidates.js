const express = require("express");
const router = express.Router();
const neo4j = require("neo4j-driver");
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { google } = require('googleapis');
const { Readable } = require('stream');
const XLSX = require('xlsx');
// Add this line after your other requires
const { manualExport } = require('../services/autoExport');
require("dotenv").config();

// At the very top of candidates.js, update this line:
// Update line 13
const { uploadToDrive, uploadCandidateProfileResume, uploadResume, deleteFileFromDrive } = require('../services/googleDrive');// GOOGLE DRIVE CONFIGURATION
// ============================================
const DRIVE_FOLDER_ID = '1Nehh6KSypnEo77JZqf2gVtkIwYIi8rgp'
const TOKEN_PATH = path.join(__dirname, '../config/token.json');
const CREDENTIALS_PATH = path.join(__dirname, '../config/credentials.json');

// Configure multer for memory storage (for Google Drive)
const memoryStorage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Only PDF files are allowed'), false);
  }
};

const upload = multer({
  storage: memoryStorage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});


// ============================================
// GOOGLE DRIVE HELPER FUNCTIONS
// ============================================

async function authorize() {
  try {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      console.warn('⚠️ Google Drive credentials not found. Local storage will be used as fallback.');
      return null;
    }

    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    if (fs.existsSync(TOKEN_PATH)) {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
      oAuth2Client.setCredentials(token);
      return oAuth2Client;
    } else {
      console.warn('⚠️ Google Drive token not found. Local storage will be used as fallback.');
      return null;
    }
  } catch (error) {
    console.error('❌ Error in authorize:', error.message);
    return null;
  }
}

const uploadToGoogleDrive = async (file, candidateName) => {
  try {
    console.log('📤 Uploading to Google Drive via shared service...');
    
    // Create temp file from buffer
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const tempFilePath = path.join(tempDir, `${Date.now()}_${file.originalname}`);
    fs.writeFileSync(tempFilePath, file.buffer);
    
    const sanitizedName = candidateName.replace(/[^a-zA-Z0-9]/g, '_');
    const timestamp = Date.now();
    const fileName = `${sanitizedName}_${timestamp}_${file.originalname}`;
    
    // ✅ Use the Candidate Profile specific function
    const result = await uploadCandidateProfileResume(tempFilePath, fileName);
    
    // Clean up temp file
    try {
      fs.unlinkSync(tempFilePath);
    } catch(e) {}
    
    if (result && result.success) {
      return {
        googleDriveFileId: result.fileId,
        googleDriveViewLink: result.viewLink,
        googleDriveDownloadLink: result.downloadLink,
        fileName: result.fileName,
        fileSize: file.size
      };
    }
    
    return null;
  } catch (error) {
    console.error('❌ Google Drive upload error:', error);
    return null;
  }
};

const saveFileLocally = (file, candidateName) => {
  try {
    console.log('📁 Saving file locally as fallback...');
    
    // Define upload directory
    const uploadDir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    
    const timestamp = Date.now();
    const uniqueSuffix = timestamp + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    const filename = 'resume-' + uniqueSuffix + ext;
    const filePath = path.join(uploadDir, filename);
    
    fs.writeFileSync(filePath, file.buffer);
    console.log('✅ File saved locally at:', filePath);
    
    return {
      resumePath: `/uploads/${filename}`,
      fileName: filename,
      localPath: filePath
    };
  } catch (error) {
    console.error('❌ Local file save error:', error);
    return null;
  }
};

// ============================================
// NEO4J CONNECTION
// ============================================
console.log("\n" + "=".repeat(50));
console.log("🔌 Initializing Neo4j Connection for Candidate Profiles...");
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
      const result = await session.run("MATCH (c:Candidate_Profile) RETURN count(c) as count");
      const count = toNumber(result.records[0].get('count'));

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
  // Handle string numbers
  if (typeof value === 'string' && !isNaN(parseFloat(value))) {
    return parseFloat(value);
  }
  return value;
};

const allowedOrigins = [
  'http://localhost:5173',
  'https://myuandwe.vercel.app'
];

router.use((req, res, next) => {
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );

  res.header(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, OPTIONS'
  );

  res.header('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

router.use((req, res, next) => {

  next();
});

const extractSkillsArray = (skills) => {
  if (!skills) {
    return [];
  }
  
  // If it's already an array
  if (Array.isArray(skills)) {
    // Filter out empty strings and trim
    const cleaned = skills.filter(s => s && typeof s === 'string' && s.trim());
    return cleaned;
  }
  
  // If it's a string
  if (typeof skills === 'string') {
    // Try to parse as JSON first
    try {
      const parsed = JSON.parse(skills);
      
      if (Array.isArray(parsed)) {
        const cleaned = parsed.filter(s => s && typeof s === 'string' && s.trim());
        return cleaned;
      }
      if (typeof parsed === 'string') {
        // Handle case where JSON string contains comma-separated values
        if (parsed.includes(',')) {
          const split = parsed.split(',').map(s => s.trim()).filter(s => s);
          return split;
        }
        const cleaned = parsed.trim() ? [parsed.trim()] : [];
        return cleaned;
      }
    } catch (e) {
      // Not JSON, fall through to regular string processing
    }
    
    // Check if it contains commas (multiple skills)
    if (skills.includes(',')) {
      const split = skills.split(',').map(s => s.trim()).filter(s => s);
      return split;
    }
    
    // Single skill
    const trimmed = skills.trim();
    if (trimmed) {
      return [trimmed];
    }
    
    return [];
  }
  
  // If it's an object (like from Neo4j)
  if (typeof skills === 'object' && skills !== null) {
    // Check if it has a 'skills' property
    if (skills.skills) {
      return extractSkillsArray(skills.skills);
    }
    
    // Check if it's array-like (has length)
    if (skills.length !== undefined) {
      const result = [];
      for (let i = 0; i < skills.length; i++) {
        const skill = skills[i];
        if (skill && typeof skill === 'string') {
          result.push(skill.trim());
        } else if (skill && skill.properties) {
          result.push(skill.properties);
        } else if (skill && skill.low !== undefined) {
          // Neo4j integer handling
          result.push(skill.toString());
        }
      }
      return result;
    }
    
    // Get all string values from the object
    const values = Object.values(skills).filter(v => v && typeof v === 'string');
    return values;
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
      // CRITICAL: Store the Can_ID properly - convert to integer
      let numValue = toNumber(value);
      // Ensure it's an integer (remove .0)
      if (typeof numValue === 'number') {
        numValue = Math.floor(numValue);
      } else if (typeof numValue === 'string') {
        numValue = parseInt(numValue);
      }
      normalized.canId = numValue;
      normalized.id = numValue; // Also set id for frontend
    } else if (key === 'Visa type' || key === 'visaType') {
      normalized.visaType = value;
    } else if (key === 'Visa Validity Date' || key === 'visaValidityDate' || key === 'visaValidity') {
      normalized.visaValidityDate = value;
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
      // Convert id to integer
      let idValue = toNumber(value);
      if (typeof idValue === 'number') {
        idValue = Math.floor(idValue);
      } else if (typeof idValue === 'string') {
        idValue = parseInt(idValue);
      }
      normalized.id = idValue;
    } else if (key === 'isInProgress') {
      normalized.isInProgress = value === true || value === 'true';
    } else {
      normalized[key] = value;
    }
  }
  
  // Ensure canId and id are set if they weren't found
  if (!normalized.canId && profile.Can_ID) {
    let rawCanId = profile.Can_ID;
    if (typeof rawCanId === 'number') {
      rawCanId = Math.floor(rawCanId);
    } else if (typeof rawCanId === 'string') {
      rawCanId = parseInt(rawCanId);
    }
    normalized.canId = rawCanId;
    normalized.id = rawCanId;
  }
  
  return normalized;
};

const formatProfileForResponse = (profile) => {

  
  const normalized = normalizeProfileFields(profile);
  
  // CRITICAL: Ensure canId is properly set from the original Can_ID
  // The normalizeProfileFields function should have set normalized.canId
  if (!normalized.canId && profile.Can_ID) {
    // Convert to integer (remove .0 if present)
    const rawCanId = profile.Can_ID;
    normalized.canId = typeof rawCanId === 'number' ? Math.floor(rawCanId) : parseInt(rawCanId);
  }
  
  // Also set id to match canId for frontend
  if (normalized.canId && !normalized.id) {
    normalized.id = normalized.canId;
  }
  
  // Ensure id is integer
  if (normalized.id) {
    normalized.id = typeof normalized.id === 'number' ? Math.floor(normalized.id) : parseInt(normalized.id);
  }
  
  if (normalized.canId) {
    normalized.canId = typeof normalized.canId === 'number' ? Math.floor(normalized.canId) : parseInt(normalized.canId);
  }
  
  // Extract skills with improved function
  const rawSkills = profile['Key Skills'] || profile.keySkills || profile.skills || [];

  
  normalized.keySkills = extractSkillsArray(rawSkills);
  

  
  // Add isInProgress flag
  normalized.isInProgress = profile.isInProgress || false;
  
  return normalized;
};




// ============================================
// CANDIDATE ROUTES
// ============================================


router.get("/", async (req, res) => {
  
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 4;
  const skip = (page - 1) * limit;
  
  const session = driver.session();
  
  try {
    // Get total count
    const countResult = await session.run("MATCH (c:Candidate_Profile) RETURN count(c) as total");
    const totalCount = toNumber(countResult.records[0].get('total'));
    
    // Get paginated results
    const result = await session.run(
      "MATCH (c:Candidate_Profile) RETURN c ORDER BY c.Can_ID DESC SKIP $skip LIMIT $limit",
      { skip: neo4j.int(skip), limit: neo4j.int(limit) }
    );

    
    const profiles = result.records.map(r => {
      const profile = r.get("c").properties;
      return formatProfileForResponse(profile);
    });

    res.json({
      success: true,
      data: profiles,
      currentPage: page,
      limit: limit,
      totalCount: totalCount,
      totalPages: Math.ceil(totalCount / limit)
    });
  } catch (err) {
    console.error("❌ Error fetching candidate profiles:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch candidate profiles",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});

router.get("/all", async (req, res) => {

  if (!driver) {
    console.error("❌ Driver is not initialized");
    return res.status(500).json({
      success: false,
      message: "Database driver not initialized"
    });
  }

  const session = driver.session();

  try {
    const result = await session.run(
      "MATCH (c:Candidate_Profile) RETURN c ORDER BY c.Can_ID DESC"
    );

    const profiles = [];
    
    for (const record of result.records) {
      try {
        if (!record.get("c")) continue;
        const profile = formatProfileForResponse(record.get("c").properties);
        profiles.push(profile);
      } catch (err) {
        console.error("Error processing candidate:", err);
        // Continue with next candidate
        continue;
      }
    }

    res.json({
      success: true,
      data: profiles,
      count: profiles.length
    });

  } catch (err) {
    console.error("❌ FULL ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch candidate profiles",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

router.get("/next-id", async (req, res) => {
  
  const session = driver.session();
  
  try {
    // FIXED: Use the correct property name 'Can_ID'
    const result = await session.run(
      "MATCH (c:Candidate_Profile) RETURN max(c.Can_ID) as maxCanId"
    );
    
    const maxCanId = toNumber(result.records[0].get('maxCanId')) || 0;
    const nextCanId = maxCanId + 1;
    

    
    res.json({
      success: true,
      nextCanId: nextCanId,
      currentMaxId: maxCanId
    });
  } catch (err) {
    console.error("❌ Error getting next ID:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Failed to get next ID",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});


router.get("/check-email/:email", async (req, res) => {
  const session = driver.session();
  const email = req.params.email;
  const excludeId = req.query.excludeId ? parseInt(req.query.excludeId) : null;

  try {
    const result = await session.run(
      "MATCH (c:Candidate_Profile {Email: $email}) RETURN c",
      { email }
    );

    let exists = false;
    if (result.records.length > 0) {
      if (excludeId) {
        exists = result.records.some(record => {
          const profile = record.get("c").properties;
          const canId = toNumber(profile.Can_ID);
          return canId !== excludeId;
        });
      } else {
        exists = true;
      }
    }

    res.json({
      success: true,
      exists
    });
  } catch (err) {
    console.error("❌ Error checking email:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Failed to check email",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});


router.get("/check-mobile/:mobile", async (req, res) => {
  const session = driver.session();
  const mobile = req.params.mobile;
  const excludeId = req.query.excludeId ? parseInt(req.query.excludeId) : null;

  try {
    const result = await session.run(
      "MATCH (c:Candidate_Profile {`Mobile No`: $mobile}) RETURN c",
      { mobile }
    );

    let exists = false;
    if (result.records.length > 0) {
      if (excludeId) {
        exists = result.records.some(record => {
          const profile = record.get("c").properties;
          const canId = toNumber(profile.Can_ID);
          return canId !== excludeId;
        });
      } else {
        exists = true;
      }
    }

    res.json({
      success: true,
      exists
    });
  } catch (err) {
    console.error("❌ Error checking mobile:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Failed to check mobile",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});

// ============================================
// CANDIDATE STATUS ROUTES
// ============================================

/**
 * GET /api/candidates/personal-resume/:fileId
 * Get personal resume by Google Drive file ID
 */
router.get("/personal-resume/:fileId", async (req, res) => {
  const { fileId } = req.params;
  
  try {
    const { getDriveService } = require('../services/googleDrive');
    const drive = await getDriveService();
    
    // Get file metadata to verify it exists and get download link
    const file = await drive.files.get({
      fileId: fileId,
      fields: 'id,name,mimeType,webViewLink',
      supportsAllDrives: true
    });
    
    if (!file.data) {
      return res.status(404).json({
        success: false,
        message: "Resume not found"
      });
    }
    
    // Return the view link so frontend can display the PDF
    res.json({
      success: true,
      data: {
        fileId: file.data.id,
        fileName: file.data.name,
        viewLink: file.data.webViewLink,
        downloadLink: `https://drive.google.com/uc?export=download&id=${file.data.id}`
      }
    });
    
  } catch (err) {
    console.error("❌ Error fetching personal resume:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch resume",
      error: err.message
    });
  }
});


/**
 * GET /api/candidates/joined
 * Get all candidates with "Joined" status from any demand
 */
router.get("/joined/all", async (req, res) => {
  
  const session = driver.session();
  
  try {
    // Query to find candidates with "Joined" status from any demand
    const result = await session.run(`
      MATCH (d:Demand)-[r:HAS_SELECTED_CANDIDATE]->(c:Candidate_Profile)
      WHERE r.status = 'Joined'
      RETURN c, d.id as demandId, d.rrNumber as demandRrNumber, r.status as status, r.selectedAt as joinedAt
      ORDER BY r.updatedAt DESC
    `);
    
    
    const joinedCandidates = [];
    
    for (const record of result.records) {
      const candidateProps = record.get('c').properties;
      const demandId = record.get('demandId');
      const demandRrNumber = record.get('demandRrNumber');
      const joinedAt = record.get('joinedAt');
      
      // Format the candidate profile
      const formatted = formatProfileForResponse(candidateProps);
      
      // Add joined-specific fields
      joinedCandidates.push({
        ...formatted,
        joinedDemandId: demandId ? (demandId.low !== undefined ? demandId.toNumber() : demandId) : null,
        joinedDemandRrNumber: demandRrNumber || `RR${String(demandId).padStart(3, "0")}`,
        joinedAt: joinedAt,
        status: 'Joined'
      });
    }
    
    res.json({
      success: true,
      data: joinedCandidates,
      totalCount: joinedCandidates.length
    });
    
  } catch (err) {
    console.error("❌ Error fetching joined candidates:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch joined candidates",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});
router.get("/:candidateId/status", async (req, res) => {
  const { candidateId } = req.params;
  
  
  const session = driver.session();
  
  try {
    // Get candidate's in-progress status
    const result = await session.run(
      "MATCH (c:Candidate_Profile {Can_ID: $id}) RETURN c.isInProgress as isInProgress, c.lastStatusUpdate as lastUpdate",
      { id: parseInt(candidateId) }
    );
    
    if (result.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Candidate not found"
      });
    }
    
    res.json({
      success: true,
      data: {
        candidateId: parseInt(candidateId),
        isInProgress: result.records[0].get('isInProgress') || false,
        lastStatusUpdate: result.records[0].get('lastUpdate')
      }
    });
    
  } catch (err) {
    console.error(`❌ Error fetching candidate status:`, err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch candidate status",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/candidates/:candidateId/status-for-client/:clientName
 * Get candidate's status for a specific client
 */
router.get("/:candidateId/status-for-client/:clientName", async (req, res) => {
  const { candidateId, clientName } = req.params;
  
  
  const session = driver.session();
  
  try {
    // Check zone first (rejection status)
    const zoneResult = await session.run(`
      MATCH (z:Zone {candidateId: $candidateId, clientName: $clientName})
      WHERE z.expiryDate > datetime()
      RETURN z
    `, {
      candidateId: parseInt(candidateId),
      clientName: clientName
    });
    
    if (zoneResult.records.length > 0) {
      const zoneEntry = zoneResult.records[0].get('z').properties;
      const expiryDate = new Date(zoneEntry.expiryDate);
      const now = new Date();
      const daysRemaining = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
      
      return res.json({
        success: true,
        status: "Rejected",
        statusType: "rejected",
        details: {
          reason: zoneEntry.reason || "Not specified",
          rejectedAt: zoneEntry.rejectedAt,
          expiryDate: zoneEntry.expiryDate,
          daysRemaining: daysRemaining
        }
      });
    }
    
    // Check if candidate is in progress for this client
    const candidateResult = await session.run(`
      MATCH (c:Candidate_Profile {Can_ID: $candidateId})
      WHERE c.clientName = $clientName AND c.isInProgress = true
      RETURN c
    `, {
      candidateId: parseInt(candidateId),
      clientName: clientName
    });
    
    if (candidateResult.records.length > 0) {
      return res.json({
        success: true,
        status: "In Progress",
        statusType: "in-progress",
        details: {
          lastUpdate: candidateResult.records[0].get('c').properties.lastStatusUpdate
        }
      });
    }
    
    // Default status
    res.json({
      success: true,
      status: "Not Started",
      statusType: "not-started",
      message: "Candidate is available for this client"
    });
    
  } catch (err) {
    console.error(`❌ Error fetching client-specific status:`, err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch candidate status",
      error: err.message
    });
  } finally {
    await session.close();
  }
});
/**
 * POST /api/candidates/upload-personal-resume
 * Upload resume for personal details (stores in Personal Details folder)
 */
router.post("/upload-personal-resume", upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No resume file provided"
      });
    }

    console.log("📄 Personal Details Resume received:", {
      originalname: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype
    });

    // Upload to Personal Details folder using uploadResume function
    const userId = req.body.userId || `user_${Date.now()}`;
    const result = await uploadResume(req.file.buffer, req.file.originalname, req.file.mimetype, userId);

    if (!result || !result.success) {
      return res.status(500).json({
        success: false,
        message: "Failed to upload resume to Google Drive",
        error: result?.error || "Unknown error"
      });
    }

    // Return the Google Drive file info
    res.json({
      success: true,
      message: "Resume uploaded successfully to Personal Details folder",
      data: {
        googleDriveFileId: result.fileId,
        googleDriveViewLink: result.viewLink,
        googleDriveDownloadLink: result.directLink,
        fileName: result.fileName
      }
    });

  } catch (err) {
    console.error("❌ Error uploading personal resume:", err);
    res.status(500).json({
      success: false,
      message: "Failed to upload resume",
      error: err.message
    });
  }
});
/**
 * PUT /api/candidates/:candidateId/status-for-client/:clientName
 * Update candidate's status for a specific client
 */
router.put("/:candidateId/status-for-client/:clientName", async (req, res) => {
  const { candidateId, clientName } = req.params;
  const { status, reason } = req.body;
  
  
  const session = driver.session();
  
  try {
    if (status === "rejected") {
      // Add to zone for 90 days
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 90);
      
      await session.run(`
        CREATE (z:Zone {
          candidateId: $candidateId,
          clientName: $clientName,
          rejectedStatus: $status,
          reason: $reason,
          rejectedAt: datetime(),
          expiryDate: datetime($expiryDate)
        })
      `, {
        candidateId: parseInt(candidateId),
        clientName: clientName,
        status: status,
        reason: reason || "Rejected by recruiter",
        expiryDate: expiryDate.toISOString()
      });
      
      res.json({
        success: true,
        message: `Candidate ${candidateId} rejected for ${clientName}. In zone until ${expiryDate.toISOString()}`
      });
      
    } else if (status === "in-progress") {
      // Update candidate's in-progress status
      await session.run(`
        MATCH (c:Candidate_Profile {Can_ID: $candidateId})
        SET c.isInProgress = true,
            c.lastStatusUpdate = datetime(),
            c.clientName = $clientName
        RETURN c
      `, {
        candidateId: parseInt(candidateId),
        clientName: clientName
      });
      
      res.json({
        success: true,
        message: `Candidate ${candidateId} marked as in progress for ${clientName}`
      });
      
    } else {
      res.status(400).json({
        success: false,
        message: "Invalid status. Must be 'rejected' or 'in-progress'"
      });
    }
    
  } catch (err) {
    console.error(`❌ Error updating candidate status:`, err);
    res.status(500).json({
      success: false,
      message: "Failed to update candidate status",
      error: err.message
    });
  } finally {
    await session.close();
  }
});


router.get("/:id", async (req, res) => {
  const session = driver.session();
  const id = parseInt(req.params.id);

  try {
    const result = await session.run(
      "MATCH (c:Candidate_Profile) WHERE c.Can_ID = $id RETURN c",
      { id }
    );

    if (!result.records.length) {
      return res.status(404).json({ 
        success: false,
        message: "Candidate profile not found" 
      });
    }

    const profile = result.records[0].get("c").properties;
    const formatted = formatProfileForResponse(profile);

    res.json({
      success: true,
      data: formatted
    });
  } catch (err) {
    console.error(`❌ Error fetching candidate profile ${id}:`, err.message);
    res.status(500).json({ 
      success: false,
      message: "Error fetching candidate profile",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});


router.post("/", upload.single('resume'), async (req, res) => {

  
  const session = driver.session();

  try {
    // Validation
    if (!req.body.name || !req.body.email || !req.body.mobile) {
      return res.status(400).json({
        success: false,
        message: "Name, email, and mobile are required fields"
      });
    }

    // Check for duplicate email
    const emailCheck = await session.run(
      "MATCH (c:Candidate_Profile {Email: $email}) RETURN c",
      { email: req.body.email }
    );

    if (emailCheck.records.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Candidate with this email already exists"
      });
    }

    // Check for duplicate mobile
    const mobileCheck = await session.run(
      "MATCH (c:Candidate_Profile {`Mobile No`: $mobile}) RETURN c",
      { mobile: req.body.mobile }
    );

    if (mobileCheck.records.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Candidate with this mobile number already exists"
      });
    }



    // ✅ FIXED: Get all existing IDs and find next available
    const existingIdsResult = await session.run(
      "MATCH (c:Candidate_Profile) RETURN c.Can_ID as canId ORDER BY c.Can_ID"
    );
    
    const existingIds = existingIdsResult.records
      .map(record => toNumber(record.get('canId')))
      .filter(id => id !== null && id !== undefined)
      .sort((a, b) => a - b);
    
    
    let nextCanId = 1;
    for (let i = 0; i < existingIds.length; i++) {
      if (existingIds[i] === nextCanId) {
        nextCanId++;
      } else if (existingIds[i] > nextCanId) {
        break;
      }
    }
    

    // Initialize storage variables
    let googleDriveFileId = null;
    let googleDriveViewLink = null;
    let googleDriveDownloadLink = null;
    let resumePath = null;

    // Handle file upload if present
    if (req.file) {
      console.log("File received:", {
        originalname: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype
      });
      
      // Try Google Drive first
      const driveResult = await uploadToGoogleDrive(req.file, req.body.name);
      
      if (driveResult) {
        googleDriveFileId = driveResult.googleDriveFileId;
        googleDriveViewLink = driveResult.googleDriveViewLink;
        googleDriveDownloadLink = driveResult.googleDriveDownloadLink;
        console.log("✅ Resume stored in Google Drive");
      } else {
        // Fallback to local storage
        const localResult = saveFileLocally(req.file, req.body.name);
        if (localResult) {
          resumePath = localResult.resumePath;
          console.log("✅ Resume stored locally");
        }
      }
    }

  let keySkills = req.body.keySkills;

if (typeof keySkills === 'string') {
  try {
    const parsed = JSON.parse(keySkills);
    if (Array.isArray(parsed)) {
      keySkills = parsed;
    } else {
      keySkills = [parsed];
    }
  } catch (e) {
    if (keySkills.includes(',')) {
      keySkills = keySkills.split(',').map(s => s.trim()).filter(s => s);
    } else {
      keySkills = [keySkills.trim()];
    }
  }
} else if (Array.isArray(keySkills)) {
  keySkills = keySkills.filter(s => s && s.trim()).map(s => s.trim());
} else {
  keySkills = [];
}

// Prepare profile data
const profileData = {
  "Candidate Name": req.body.name,
  "Email": req.body.email,
  "Mobile No": req.body.mobile,
  "Experience": req.body.experience || "",
  "Current Org": req.body.currentOrg || "",
  "Current CTC": req.body.currentCTC || "",
  "Expected CTC": req.body.expectedCTC || "",
  "Notice Period in days": req.body.noticePeriod || "",
  "Profiles sourced by": req.body.profileSourcedBy || "",
  "Client Name": req.body.clientName || "",
  "Profile submission date": req.body.profileSubmissionDate || "",
  "Key Skills": keySkills,
  "Can_ID": nextCanId,
  "Visa type": req.body.visaType || "NA",
   "Visa Validity Date": req.body.visaValidityDate || "",  
  "resumePath": resumePath,
  "googleDriveFileId": googleDriveFileId,
  "googleDriveViewLink": googleDriveViewLink,
  "googleDriveDownloadLink": googleDriveDownloadLink,
  "createdAt": new Date().toISOString(),
  "updatedAt": new Date().toISOString(),
  "id": nextCanId,
  // ✅ ADD THIS FLAG
  "isInProgress": false,  // false = not in progress, true = in progress
  "lastStatusUpdate": new Date().toISOString()
};

  

    // Create the candidate
    const result = await session.run(
      "CREATE (c:Candidate_Profile) SET c = $data RETURN c",
      { data: profileData }
    );

    const created = result.records[0].get("c").properties;
    const formatted = formatProfileForResponse(created);


    res.status(201).json({
      success: true,
      message: "Candidate profile created successfully",
      data: formatted
    });

  } catch (err) {
    console.error("❌ Error creating candidate profile:", err);
    
    // Check for duplicate email/mobile errors
    if (err.message && (err.message.includes("Email") || err.message.includes("Mobile"))) {
      return res.status(400).json({
        success: false,
        message: err.message,
        error: err.message
      });
    }
    
    res.status(500).json({
      success: false,
      message: "Failed to create candidate profile",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * PUT /api/candidates/:id/progress
 * Update candidate's in-progress status based on demand selection
 */
router.put("/:id/progress", async (req, res) => {
  
  const session = driver.session();
  const candidateId = parseInt(req.params.id);
  const { isInProgress } = req.body;

  try {
    // Check if candidate exists
    const checkResult = await session.run(
      "MATCH (c:Candidate_Profile) WHERE c.Can_ID = $id RETURN c",
      { id: candidateId }
    );

    if (!checkResult.records.length) {
      return res.status(404).json({ 
        success: false,
        message: "Candidate not found" 
      });
    }

    // Update the isInProgress flag
    const result = await session.run(
      `MATCH (c:Candidate_Profile) WHERE c.Can_ID = $id
       SET c.isInProgress = $isInProgress,
           c.lastStatusUpdate = $lastUpdate
       RETURN c`,
      { 
        id: candidateId, 
        isInProgress: isInProgress,
        lastUpdate: new Date().toISOString()
      }
    );

    const updated = result.records[0].get("c").properties;
    

    res.json({
      success: true,
      message: `Candidate in-progress status updated to ${isInProgress}`,
      data: {
        candidateId: candidateId,
        isInProgress: isInProgress,
        lastStatusUpdate: updated.lastStatusUpdate
      }
    });
    
  } catch (err) {
    console.error(`❌ Error updating in-progress status for candidate ${candidateId}:`, err);
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
 * POST /api/candidates/progress/batch
 * Get in-progress status for multiple candidates at once
 * Now checks both isInProgress flag AND status from selected-candidates
 */
router.post("/progress/batch", async (req, res) => {
  
  const session = driver.session();
  const { candidateIds, demandId } = req.body;

  if (!candidateIds || !Array.isArray(candidateIds) || candidateIds.length === 0) {
    return res.status(400).json({
      success: false,
      message: "candidateIds array is required"
    });
  }

  try {

    
    // Define active statuses that should show "In Progress"
    const activeStatuses = [
      'In Progress',
      'Pending Screening',
      'Pending Interview',
      'Pending Client Screening',
      'Pending Client Interview',
      'Pending Offer',
      'Pending Joinee'
    ];
    
    // OPTIMIZED BATCH QUERIES
    const ids = candidateIds.map(id => parseInt(id)).filter(id => !isNaN(id));
    const progressMap = {};
    ids.forEach(id => {
      progressMap[id] = { candidateId: id, isInProgress: false, status: null };
    });
    
    // 1. Fetch isInProgress for all candidates in one query
    const candidateResult = await session.run(
      "MATCH (c:Candidate_Profile) WHERE c.Can_ID IN $ids RETURN c.Can_ID as canId, c.isInProgress as isInProgress",
      { ids }
    );
    
    candidateResult.records.forEach(record => {
      const canId = record.get('canId');
      const numCanId = typeof canId === 'number' ? Math.floor(canId) : (canId && canId.low !== undefined ? canId.low : parseInt(canId));
      if (progressMap[numCanId]) {
        progressMap[numCanId].isInProgress = record.get('isInProgress') === true;
      }
    });
    
    // 2. If demandId is provided, fetch selected-candidates statuses in one query
    if (demandId) {
      const selectedResult = await session.run(
        "MATCH (sc:SelectedCandidate) WHERE sc.demandId = $demandId AND sc.canId IN $ids RETURN sc.canId as canId, sc.status as status",
        { demandId: parseInt(demandId), ids }
      );
      
      selectedResult.records.forEach(record => {
        const canId = record.get('canId');
        const numCanId = typeof canId === 'number' ? Math.floor(canId) : (canId && canId.low !== undefined ? canId.low : parseInt(canId));
        const status = record.get('status');
        
        if (progressMap[numCanId]) {
          progressMap[numCanId].status = status;
          if (status && activeStatuses.includes(status) && !progressMap[numCanId].isInProgress) {
            progressMap[numCanId].isInProgress = true;
          }
        }
      });
    }
    
    const results = Object.values(progressMap);
    
    const inProgressCount = results.filter(r => r.isInProgress).length;
    

    res.json({
      success: true,
      data: results,
      summary: {
        total: candidateIds.length,
        inProgress: inProgressCount,
        notInProgress: candidateIds.length - inProgressCount
      }
    });
    
  } catch (err) {
    console.error(`❌ Error fetching batch progress status:`, err);
    res.status(500).json({ 
      success: false,
      message: "Failed to fetch candidate statuses",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});


router.put("/:id", upload.single('resume'), async (req, res) => {
  
  const session = driver.session();
  const id = parseInt(req.params.id);

  try {
    // Check if candidate profile exists
    const checkResult = await session.run(
      "MATCH (c:Candidate_Profile) WHERE c.Can_ID = $id RETURN c",
      { id }
    );

    if (!checkResult.records.length) {
      return res.status(404).json({ 
        success: false,
        message: "Candidate profile not found" 
      });
    }

    const existingProfile = checkResult.records[0].get("c").properties;
    const formattedExisting = formatProfileForResponse(existingProfile);

    // Validation
    if (!req.body.name || !req.body.email || !req.body.mobile) {
      return res.status(400).json({
        success: false,
        message: "Name, email, and mobile are required fields"
      });
    }

    // Check for duplicate email (excluding current candidate)
    const emailCheck = await session.run(
      "MATCH (c:Candidate_Profile {Email: $email}) WHERE c.Can_ID <> $id RETURN c",
      { email: req.body.email, id }
    );

    if (emailCheck.records.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Candidate with this email already exists"
      });
    }

    // Check for duplicate mobile (excluding current candidate)
    const mobileCheck = await session.run(
      "MATCH (c:Candidate_Profile {`Mobile No`: $mobile}) WHERE c.Can_ID <> $id RETURN c",
      { mobile: req.body.mobile, id }
    );

    if (mobileCheck.records.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Candidate with this mobile number already exists"
      });
    }

    // Initialize storage variables with existing values
    let googleDriveFileId = formattedExisting.googleDriveFileId;
    let googleDriveViewLink = formattedExisting.googleDriveViewLink;
    let googleDriveDownloadLink = formattedExisting.googleDriveDownloadLink;
    let resumePath = formattedExisting.resumePath;

    // Handle new file upload if present
    if (req.file) {
   
      
      // Try Google Drive first
      const driveResult = await uploadToGoogleDrive(req.file, req.body.name);
      
      if (driveResult) {
        // Google Drive upload successful
        googleDriveFileId = driveResult.googleDriveFileId;
        googleDriveViewLink = driveResult.googleDriveViewLink;
        googleDriveDownloadLink = driveResult.googleDriveDownloadLink;
        
        // If there was an old local file, delete it
        if (formattedExisting.resumePath) {
          const oldResumePath = path.join(__dirname, '..', formattedExisting.resumePath);
          if (fs.existsSync(oldResumePath)) {
            fs.unlinkSync(oldResumePath);
            console.log("✅ Old local resume deleted");
          }
        }
        
        resumePath = null;
        console.log("✅ New resume stored in Google Drive");
      } else {
        // Fallback to local storage
        const localResult = saveFileLocally(req.file, req.body.name);
        if (localResult) {
          resumePath = localResult.resumePath;
          console.log("✅ New resume stored locally");
        }
      }
    }

   let keySkills = req.body.keySkills;

if (typeof keySkills === 'string') {
  try {
    const parsed = JSON.parse(keySkills);
    if (Array.isArray(parsed)) {
      keySkills = parsed;
    } else {
      keySkills = [parsed];
    }
  } catch (e) {
    if (keySkills.includes(',')) {
      keySkills = keySkills.split(',').map(s => s.trim()).filter(s => s);
    } else {
      keySkills = [keySkills.trim()];
    }
  }
} else if (Array.isArray(keySkills)) {
  keySkills = keySkills.filter(s => s && s.trim()).map(s => s.trim());
} else {
  keySkills = [];
}

    // Prepare update data
// Prepare update data - with non-editable submission date
const updateData = {
  "Candidate Name": req.body.name,
  "Email": req.body.email,
  "Mobile No": req.body.mobile,
  "Experience": req.body.experience || formattedExisting.experience || "",
  "Current Org": req.body.currentOrg || formattedExisting.currentOrg || "",
  "Current CTC": req.body.currentCTC || formattedExisting.currentCTC || "",
  "Expected CTC": req.body.expectedCTC || formattedExisting.expectedCTC || "",
  "Notice Period in days": req.body.noticePeriod || formattedExisting.noticePeriod || "",
  "Profiles sourced by": req.body.profileSourcedBy || formattedExisting.profileSourcedBy || "",
  "Client Name": req.body.clientName || formattedExisting.clientName || "",
  // IMPORTANT: Always use existing submission date - never allow updates
"Profile submission date": req.body.profileSubmissionDate || formattedExisting.profileSubmissionDate || "",
  "Key Skills": Array.isArray(keySkills) ? keySkills : (keySkills || formattedExisting.keySkills || []),
  "Can_ID": formattedExisting.canId || id,
  "Visa type": req.body.visaType || formattedExisting.visaType || "NA",
    "Visa Validity Date": req.body.visaValidityDate || "",
  "resumePath": resumePath,
  "googleDriveFileId": googleDriveFileId,
  "googleDriveViewLink": googleDriveViewLink,
  "googleDriveDownloadLink": googleDriveDownloadLink,
  "updatedAt": new Date().toISOString(),
  "createdAt": formattedExisting.createdAt,
  "id": formattedExisting.id || id
};


    const result = await session.run(
      `MATCH (c:Candidate_Profile) WHERE c.Can_ID = $id
       SET c = $data
       RETURN c`,
      { id, data: updateData }
    );

    const updated = result.records[0].get("c").properties;
    const formatted = formatProfileForResponse(updated);


    res.json({
      success: true,
      message: "Candidate profile updated successfully",
      data: formatted
    });
  } catch (err) {
    console.error(`❌ Error updating candidate profile ${id}:`, err);
    res.status(500).json({ 
      success: false,
      message: "Failed to update candidate profile",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});

router.delete("/:id", async (req, res) => {
  const session = driver.session();
  const id = parseInt(req.params.id);

  try {
    // First get the candidate profile to check for resume
    const checkResult = await session.run(
      "MATCH (c:Candidate_Profile) WHERE c.Can_ID = $id RETURN c",
      { id }
    );

    if (!checkResult.records.length) {
      return res.status(404).json({
        success: false,
        message: "Candidate profile not found"
      });
    }

    const profile = checkResult.records[0].get("c").properties;
    const formatted = formatProfileForResponse(profile);

    // Delete from Google Drive if file exists
    if (formatted.googleDriveFileId) {
      console.log(`🗑️ Deleting from Google Drive: ${formatted.googleDriveFileId}`);
      await deleteFileFromDrive(formatted.googleDriveFileId);
    }

    // Delete local resume file if it exists
    if (formatted.resumePath) {
      const resumeFilePath = path.join(__dirname, '..', formatted.resumePath);
      if (fs.existsSync(resumeFilePath)) {
        fs.unlinkSync(resumeFilePath);
        console.log("✅ Local resume deleted");
      }
    }

    // Delete the candidate profile node
    const result = await session.run(
      "MATCH (c:Candidate_Profile) WHERE c.Can_ID = $id DETACH DELETE c RETURN count(c) as deletedCount",
      { id }
    );

    const countValue = result.records[0].get("deletedCount");
    const deletedCount = toNumber(countValue);

    if (deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Candidate profile not found"
      });
    }


    res.json({
      success: true,
      message: "Candidate profile deleted successfully"
    });
  } catch (err) {
    console.error(`❌ Error deleting candidate profile ${id}:`, err.message);
    res.status(500).json({
      success: false,
      message: "Failed to delete candidate profile",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

router.get("/resume/:filename", (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, "../uploads", filename);
  
  
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.sendFile(filePath);
  } else {
    console.error("Resume not found:", filePath);
    res.status(404).json({ 
      success: false, 
      message: "Resume not found" 
    });
  }
});
// Add to candidates.js
/**
 * GET /api/candidates/check-zone/:candidateId/:clientName
 * Check if candidate is in zone for a specific client
 */
router.get("/check-zone/:candidateId/:clientName", async (req, res) => {
  const { candidateId, clientName } = req.params;
  
  
  
  const session = driver.session();
  
  try {
    const result = await session.run(`
      MATCH (z:Zone {candidateId: $candidateId, clientName: $clientName})
      WHERE z.expiryDate > datetime()
      RETURN z
    `, {
      candidateId: parseInt(candidateId),
      clientName: clientName
    });
    
    if (result.records.length === 0) {
      return res.json({
        success: true,
        inZone: false,
        eligible: true,
        message: "Candidate is eligible for this client"
      });
    }
    
    const zoneEntry = result.records[0].get('z').properties;
    const expiryDate = new Date(zoneEntry.expiryDate);
    const now = new Date();
    const daysRemaining = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
    
    res.json({
      success: true,
      inZone: true,
      eligible: false,
      data: {
        candidateId: toNumber(zoneEntry.candidateId),
        clientName: zoneEntry.clientName,
        rejectedStatus: zoneEntry.rejectedStatus,
        reason: zoneEntry.reason,
        rejectedAt: zoneEntry.rejectedAt,
        expiryDate: zoneEntry.expiryDate,
        daysRemaining: daysRemaining
      },
      message: `Candidate cannot be selected for ${clientName}. In zone for ${daysRemaining} more days.`
    });
    
  } catch (err) {
    console.error("❌ Error checking zone:", err);
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
 * GET /api/candidates/export/status
 * Check auto-export status and history
 */
router.get("/export/status", async (req, res) => {
  
  try {
    const fs = require('fs');
    const path = require('path');
    const historyFile = path.join(__dirname, '../../exports/export_history.json');
    
    let history = [];
    if (fs.existsSync(historyFile)) {
      history = JSON.parse(fs.readFileSync(historyFile));
    }
    
    const { listFiles } = require('../services/googleDrive');
    const driveFiles = await listFiles();
    
    res.json({
      success: true,
      autoExportEnabled: true,
      schedule: "Every 5 days at 2:00 AM",
      lastExports: history.slice(0, 5),
      driveFiles: driveFiles.slice(0, 5),
      driveFolderLink: "https://drive.google.com/drive/folders/1Nehh6KSypnEo77JZqf2gVtkIwYIi8rgp"
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Change from GET to POST
router.post("/export/trigger", async (req, res) => {
  
  try {
    const { manualExport } = require('../services/autoExport');
    const result = await manualExport();
    
    res.json(result);
  } catch (err) {
    console.error("Manual export error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
// Temporary GET version for browser testing
router.get("/export/trigger", async (req, res) => {
  
  try {
    const { manualExport } = require('../services/autoExport');
    const result = await manualExport();
    
    res.json(result);
  } catch (err) {
    console.error("Manual export error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/export/excel", async (req, res) => {
  
  const session = driver.session();
  
  try {
    // Get all candidates
    const result = await session.run(
      "MATCH (c:Candidate_Profile) RETURN c ORDER BY c.Can_ID DESC"
    );
    
    const candidates = [];
    
    for (const record of result.records) {
      const profile = record.get("c").properties;
      const formatted = formatProfileForResponse(profile);
      candidates.push(formatted);
    }
    
    
    // Prepare data for Excel
    const excelData = candidates.map(candidate => {
      // Format skills as string
      let skillsString = '';
      if (Array.isArray(candidate.keySkills)) {
        skillsString = candidate.keySkills.join('; ');
      } else if (typeof candidate.keySkills === 'string') {
        skillsString = candidate.keySkills;
      }
      
      // Format dates
      const formatDate = (dateValue) => {
        if (!dateValue) return '';
        try {
          const date = new Date(dateValue);
          return date.toISOString().split('T')[0];
        } catch {
          return dateValue;
        }
      };
      
      return {
        'Can_ID': candidate.canId || candidate.id || '',
        'Candidate Name': candidate.name || '',
        'Email': candidate.email || '',
        'Mobile No': candidate.mobile || '',
        'Experience (Years)': candidate.experience || '',
        'Current Organization': candidate.currentOrg || '',
        'Current CTC': candidate.currentCTC || '',
        'Expected CTC': candidate.expectedCTC || '',
        'Notice Period (days)': candidate.noticePeriod || '',
        'Profile Sourced By': candidate.profileSourcedBy || '',
        'Client Name': candidate.clientName || '',
        'Profile Submission Date': candidate.profileSubmissionDate || '',
        'Visa Type': candidate.visaType || 'NA',
        'Visa Validity Date': candidate.visaValidityDate || '',
        'Key Skills': skillsString,
        'Google Drive File ID': candidate.googleDriveFileId || '',
        'Google Drive View Link': candidate.googleDriveViewLink || '',
        'Google Drive Download Link': candidate.googleDriveDownloadLink || '',
        'Resume Path': candidate.resumePath || '',
        'Created At': formatDate(candidate.createdAt),
        'Updated At': formatDate(candidate.updatedAt),
        'Last Status Update': formatDate(candidate.lastStatusUpdate),
        'Is In Progress': candidate.isInProgress ? 'true' : 'false'
      };
    });
    
    // Create Excel file
    const worksheet = XLSX.utils.json_to_sheet(excelData);
    
    // Auto-size columns
    worksheet['!cols'] = [
      { wch: 10 }, // Can_ID
      { wch: 25 }, // Candidate Name
      { wch: 30 }, // Email
      { wch: 15 }, // Mobile No
      { wch: 15 }, // Experience
      { wch: 25 }, // Current Organization
      { wch: 15 }, // Current CTC
      { wch: 15 }, // Expected CTC
      { wch: 18 }, // Notice Period
      { wch: 20 }, // Profile Sourced By
      { wch: 20 }, // Client Name
      { wch: 20 }, // Profile Submission Date
      { wch: 12 }, // Visa Type
      { wch: 18 }, // Visa Validity Date
      { wch: 40 }, // Key Skills
      { wch: 30 }, // Google Drive File ID
      { wch: 50 }, // Google Drive View Link
      { wch: 50 }, // Google Drive Download Link
      { wch: 30 }, // Resume Path
      { wch: 20 }, // Created At
      { wch: 20 }, // Updated At
      { wch: 20 }, // Last Status Update
      { wch: 12 }  // Is In Progress
    ];
    
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'All Candidates');
    
    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `candidates_export_${timestamp}.xlsx`;
    
    // Set response headers for file download
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    // Write to response
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.send(buffer);
    
    console.log(`✅ Excel export completed for ${candidates.length} candidates`);
    
  } catch (err) {
    console.error("❌ Error exporting candidates to Excel:", err);
    res.status(500).json({
      success: false,
      message: "Failed to export candidates",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

module.exports = router;
