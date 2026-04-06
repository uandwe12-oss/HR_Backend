const express = require("express");
const router = express.Router();
const neo4j = require("neo4j-driver");
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { google } = require('googleapis');
const { Readable } = require('stream');
require("dotenv").config();

// ============================================
// GOOGLE DRIVE CONFIGURATION
// ============================================
const DRIVE_FOLDER_ID = '1wIQXwyPPYyfXWJ35TsmDByeg4FTxyNle'; // Your folder ID
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
// Add this function near your other Google Drive helper functions
const deleteFromGoogleDrive = async (fileId) => {
  try {
    console.log(`🗑️ Deleting file from Google Drive with ID: ${fileId}`);
    
    const auth = await authorize();
    if (!auth) {
      console.log('⚠️ Google Drive not configured, skipping deletion');
      return false;
    }
    
    const drive = google.drive({ version: 'v3', auth });
    
    await drive.files.delete({
      fileId: fileId
    });
    
    console.log('✅ File deleted from Google Drive successfully');
    return true;
  } catch (error) {
    console.error('❌ Google Drive delete error:', error);
    return false;
  }
};
const uploadToGoogleDrive = async (file, candidateName) => {
  try {
    console.log('📤 Uploading to Google Drive...');
    
    const auth = await authorize();
    if (!auth) {
      console.log('⚠️ Google Drive not configured, using local storage only');
      return null;
    }
    
    const drive = google.drive({ version: 'v3', auth });
    
    const bufferStream = new Readable();
    bufferStream.push(file.buffer);
    bufferStream.push(null);
    
    const sanitizedName = candidateName.replace(/[^a-zA-Z0-9]/g, '_');
    const timestamp = Date.now();
    const fileName = `${sanitizedName}_${timestamp}_${file.originalname}`;
    
    const fileMetadata = {
      name: fileName,
      parents: [DRIVE_FOLDER_ID],
      description: `Resume for ${candidateName} uploaded on ${new Date().toISOString()}`
    };
    
    const media = {
      mimeType: 'application/pdf',
      body: bufferStream
    };
    
    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink, size, createdTime'
    });
    
    // Make the file publicly accessible
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });
    
    console.log('✅ File uploaded to Google Drive with ID:', response.data.id);
    
    return {
      googleDriveFileId: response.data.id,
      googleDriveViewLink: `https://drive.google.com/file/d/${response.data.id}/preview`,
      googleDriveDownloadLink: `https://drive.google.com/uc?export=download&id=${response.data.id}`,
      fileName: response.data.name,
      fileSize: response.data.size
    };
    
  } catch (error) {
    console.error('❌ Google Drive upload error:', error);
    return null;
  }
};

const saveFileLocally = (file, candidateName) => {
  try {
    console.log('📁 Saving file locally as fallback...');
    
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
      console.log(`✅ Neo4j connected successfully. Found ${count} Candidate_Profile nodes`);
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
  console.log(`🔍 Route accessed: ${req.method} ${req.originalUrl}`);
  next();
});

// Replace your extractSkillsArray function with this improved version
const extractSkillsArray = (skills) => {
  console.log(`🔍 extractSkillsArray input:`, skills);
  console.log(`   Type: ${typeof skills}`);
  
  if (!skills) {
    console.log(`   → Returning empty array (null/undefined)`);
    return [];
  }
  
  // If it's already an array
  if (Array.isArray(skills)) {
    console.log(`   → Already array with ${skills.length} items`);
    // Filter out empty strings and trim
    const cleaned = skills.filter(s => s && typeof s === 'string' && s.trim());
    console.log(`   → Cleaned array:`, cleaned);
    return cleaned;
  }
  
  // If it's a string
  if (typeof skills === 'string') {
    console.log(`   Processing string: "${skills}"`);
    
    // Try to parse as JSON first
    try {
      const parsed = JSON.parse(skills);
      console.log(`   Parsed as JSON:`, parsed);
      
      if (Array.isArray(parsed)) {
        const cleaned = parsed.filter(s => s && typeof s === 'string' && s.trim());
        console.log(`   → JSON array with ${cleaned.length} items:`, cleaned);
        return cleaned;
      }
      if (typeof parsed === 'string') {
        // Handle case where JSON string contains comma-separated values
        if (parsed.includes(',')) {
          const split = parsed.split(',').map(s => s.trim()).filter(s => s);
          console.log(`   → Split JSON string by comma:`, split);
          return split;
        }
        const cleaned = parsed.trim() ? [parsed.trim()] : [];
        console.log(`   → Single skill from JSON string:`, cleaned);
        return cleaned;
      }
    } catch (e) {
      console.log(`   Not JSON, treating as regular string: ${e.message}`);
    }
    
    // Check if it contains commas (multiple skills)
    if (skills.includes(',')) {
      const split = skills.split(',').map(s => s.trim()).filter(s => s);
      console.log(`   → Split by comma into ${split.length} skills:`, split);
      return split;
    }
    
    // Single skill
    const trimmed = skills.trim();
    if (trimmed) {
      console.log(`   → Single skill: "${trimmed}"`);
      return [trimmed];
    }
    
    return [];
  }
  
  // If it's an object (like from Neo4j)
  if (typeof skills === 'object' && skills !== null) {
    console.log(`   Processing object:`, skills);
    
    // Check if it has a 'skills' property
    if (skills.skills) {
      console.log(`   Found skills.skills property`);
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
      console.log(`   → Array-like object with ${result.length} items:`, result);
      return result;
    }
    
    // Get all string values from the object
    const values = Object.values(skills).filter(v => v && typeof v === 'string');
    console.log(`   → Extracted ${values.length} string values:`, values);
    return values;
  }
  
  console.log(`   → No match, returning empty array`);
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
      // CRITICAL: Store the Can_ID properly
      const numValue = toNumber(value);
      normalized.canId = numValue;
      normalized.id = numValue; // Also set id for frontend
      console.log(`   Found Can_ID: ${key} = ${value} -> converted to ${numValue}`);
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
    } else {
      normalized[key] = value;
    }
  }
  
  // Ensure canId and id are set if they weren't found
  if (!normalized.canId && profile.Can_ID) {
    normalized.canId = toNumber(profile.Can_ID);
    normalized.id = normalized.canId;
    console.log(`   Fallback: Set canId from profile.Can_ID: ${normalized.canId}`);
  }
  
  return normalized;
};

const formatProfileForResponse = (profile) => {
  console.log(`\n📝 Formatting profile for response...`);
  console.log(`   Raw profile keys:`, Object.keys(profile));
  console.log(`   Can_ID value:`, profile.Can_ID);
  console.log(`   Candidate Name:`, profile["Candidate Name"]);
  
  const normalized = normalizeProfileFields(profile);
  
  // CRITICAL: Ensure canId is properly set from the original Can_ID
  // The normalizeProfileFields function should have set normalized.canId
  if (!normalized.canId && profile.Can_ID) {
    normalized.canId = toNumber(profile.Can_ID);
    console.log(`   Setting canId from profile.Can_ID: ${normalized.canId}`);
  }
  
  // Also set id to match canId for frontend
  if (normalized.canId && !normalized.id) {
    normalized.id = normalized.canId;
  }
  
  // Extract skills with improved function
  const rawSkills = profile['Key Skills'] || profile.keySkills || profile.skills || [];
  console.log(`   Raw skills from profile:`, rawSkills);
  console.log(`   Raw skills type: ${typeof rawSkills}`);
  
  normalized.keySkills = extractSkillsArray(rawSkills);
  
  console.log(`   Final skills array (${normalized.keySkills.length} items):`, normalized.keySkills);
  console.log(`   Final canId: ${normalized.canId}, id: ${normalized.id}`);
  
  // Add isInProgress flag
  normalized.isInProgress = profile.isInProgress || false;
  
  return normalized;
};

// ============================================
// SWAGGER COMPONENTS SCHEMAS
// ============================================

/**
 * @swagger
 * components:
 *   schemas:
 *     CandidateProfile:
 *       type: object
 *       properties:
 *         canId:
 *           type: integer
 *           description: Candidate ID (Can_ID)
 *         name:
 *           type: string
 *           description: Candidate name
 *         email:
 *           type: string
 *           description: Candidate email
 *         mobile:
 *           type: string
 *           description: Candidate mobile number
 *         experience:
 *           type: string
 *           description: Experience in years
 *         experienceYears:
 *           type: number
 *           description: Experience as numeric value
 *         currentOrg:
 *           type: string
 *           description: Current organization
 *         currentCTC:
 *           type: string
 *           description: Current CTC
 *         expectedCTC:
 *           type: string
 *           description: Expected CTC
 *         noticePeriod:
 *           type: string
 *           description: Notice period in days
 *         profileSourcedBy:
 *           type: string
 *           description: Source of profile
 *         clientName:
 *           type: string
 *           description: Client name
 *         profileSubmissionDate:
 *           type: string
 *           description: Profile submission date
 *         keySkills:
 *           type: array
 *           items:
 *             type: string
 *           description: Candidate skills
 *         visaType:
 *           type: string
 *           description: Visa type
 *         resumePath:
 *           type: string
 *           description: Local resume path
 *         googleDriveFileId:
 *           type: string
 *           description: Google Drive file ID
 *         googleDriveViewLink:
 *           type: string
 *           description: Google Drive view link
 *         googleDriveDownloadLink:
 *           type: string
 *           description: Google Drive download link
 *         createdAt:
 *           type: string
 *           format: date-time
 *         updatedAt:
 *           type: string
 *           format: date-time
 *     
 *     CandidateInput:
 *       type: object
 *       required:
 *         - name
 *         - email
 *         - mobile
 *       properties:
 *         name:
 *           type: string
 *         email:
 *           type: string
 *         mobile:
 *           type: string
 *         experience:
 *           type: string
 *         currentOrg:
 *           type: string
 *         currentCTC:
 *           type: string
 *         expectedCTC:
 *           type: string
 *         noticePeriod:
 *           type: string
 *         profileSourcedBy:
 *           type: string
 *         clientName:
 *           type: string
 *         profileSubmissionDate:
 *           type: string
 *         keySkills:
 *           type: array
 *           items:
 *             type: string
 *         visaType:
 *           type: string
 *         resume:
 *           type: string
 *           format: binary
 *     
 *     ApiResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         message:
 *           type: string
 *         data:
 *           oneOf:
 *             - type: array
 *               items:
 *                 $ref: '#/components/schemas/CandidateProfile'
 *             - $ref: '#/components/schemas/CandidateProfile'
 *         count:
 *           type: integer
 *         totalCount:
 *           type: integer
 *         currentPage:
 *           type: integer
 *         totalPages:
 *           type: integer
 *         limit:
 *           type: integer
 *     
 *     NextIdResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         nextCanId:
 *           type: integer
 *         currentMaxId:
 *           type: integer
 */

// ============================================
// CANDIDATE ROUTES
// ============================================

/**
 * @swagger
 * /api/candidates:
 *   get:
 *     summary: Get all candidates with pagination
 *     tags: [Candidates]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 4
 *     responses:
 *       200:
 *         description: Successful response
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiResponse'
 */
router.get("/", async (req, res) => {
  console.log("\n📡 GET /api/candidates - Fetching candidates with pagination");
  
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

    console.log(`📊 Found ${result.records.length} candidate profiles (page ${page})`);
    
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

/**
 * @swagger
 * /api/candidates/all:
 *   get:
 *     summary: Get ALL candidate profiles
 *     tags: [Candidates]
 *     responses:
 *       200:
 *         description: Successful response
 */
router.get("/all", async (req, res) => {
  console.log("🔥 /all API HIT");

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
/**
 * @swagger
 * /api/candidates/next-id:
 *   get:
 *     summary: Get next available Can_ID
 *     tags: [Candidates]
 *     responses:
 *       200:
 *         description: Successful response
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/NextIdResponse'
 */
router.get("/next-id", async (req, res) => {
  console.log("\n📡 GET /api/candidates/next-id - Getting next available Can_ID");
  
  const session = driver.session();
  
  try {
    // FIXED: Use the correct property name 'Can_ID'
    const result = await session.run(
      "MATCH (c:Candidate_Profile) RETURN max(c.Can_ID) as maxCanId"
    );
    
    const maxCanId = toNumber(result.records[0].get('maxCanId')) || 0;
    const nextCanId = maxCanId + 1;
    
    console.log(`📊 Current max Can_ID: ${maxCanId}`);
    console.log(`🔢 Next available Can_ID: ${nextCanId}`);
    
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

/**
 * @swagger
 * /api/candidates/check-email/{email}:
 *   get:
 *     summary: Check if email already exists
 *     tags: [Candidates]
 *     parameters:
 *       - in: path
 *         name: email
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: excludeId
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Successful response
 */
router.get("/check-email/:email", async (req, res) => {
  console.log(`\n📡 GET /api/candidates/check-email/${req.params.email}`);
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

/**
 * @swagger
 * /api/candidates/check-mobile/{mobile}:
 *   get:
 *     summary: Check if mobile number already exists
 *     tags: [Candidates]
 *     parameters:
 *       - in: path
 *         name: mobile
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: excludeId
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Successful response
 */
router.get("/check-mobile/:mobile", async (req, res) => {
  console.log(`\n📡 GET /api/candidates/check-mobile/${req.params.mobile}`);
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
 * GET /api/candidates/:candidateId/status
 * Get overall candidate status (for all clients)
 */
router.get("/:candidateId/status", async (req, res) => {
  const { candidateId } = req.params;
  
  console.log(`\n📡 GET /api/candidates/${candidateId}/status`);
  
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
  
  console.log(`\n📡 GET /api/candidates/${candidateId}/status-for-client/${clientName}`);
  
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
 * PUT /api/candidates/:candidateId/status-for-client/:clientName
 * Update candidate's status for a specific client
 */
router.put("/:candidateId/status-for-client/:clientName", async (req, res) => {
  const { candidateId, clientName } = req.params;
  const { status, reason } = req.body;
  
  console.log(`\n📡 PUT /api/candidates/${candidateId}/status-for-client/${clientName}`);
  console.log(`   New status: ${status}`);
  
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

/**
 * @swagger
 * /api/candidates/{id}:
 *   get:
 *     summary: Get candidate profile by ID
 *     tags: [Candidates]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Successful response
 *       404:
 *         description: Candidate not found
 */
router.get("/:id", async (req, res) => {
  console.log(`\n📡 GET /api/candidates/${req.params.id}`);
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

/**
 * @swagger
 * /api/candidates/:
 *   post:
 *     summary: Create new candidate profile
 *     tags: [Candidates]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             $ref: '#/components/schemas/CandidateInput'
 *     responses:
 *       201:
 *         description: Candidate created successfully
 *       400:
 *         description: Validation error or duplicate entry
 *       500:
 *         description: Server error
 */
router.post("/", upload.single('resume'), async (req, res) => {
  console.log("\n📡 POST /api/candidates - Creating new candidate profile");
  console.log("Request body:", req.body);
  console.log("Request file:", req.file ? {
    originalname: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype
  } : 'No file');
  
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
    
    console.log("📊 Existing Can_IDs in database:", existingIds);
    
    let nextCanId = 1;
    for (let i = 0; i < existingIds.length; i++) {
      if (existingIds[i] === nextCanId) {
        nextCanId++;
      } else if (existingIds[i] > nextCanId) {
        break;
      }
    }
    
    console.log("🔢 Generated new Can_ID:", nextCanId);

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
console.log("PUT - Raw keySkills:", keySkills);

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

    console.log("Saving candidate profile with Can_ID:", nextCanId);
    console.log("Skills:", keySkills);

    // Create the candidate
    const result = await session.run(
      "CREATE (c:Candidate_Profile) SET c = $data RETURN c",
      { data: profileData }
    );

    const created = result.records[0].get("c").properties;
    const formatted = formatProfileForResponse(created);

    console.log("✅ Candidate profile created successfully with Can_ID:", nextCanId);

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
  console.log(`\n📡 PUT /api/candidates/${req.params.id}/progress - Updating in-progress status`);
  
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
    
    console.log(`✅ Candidate ${candidateId} in-progress status updated to: ${isInProgress}`);

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
 */
router.post("/progress/batch", async (req, res) => {
  console.log(`\n📡 POST /api/candidates/progress/batch - Getting batch progress status`);
  
  const session = driver.session();
  const { candidateIds } = req.body;

  if (!candidateIds || !Array.isArray(candidateIds) || candidateIds.length === 0) {
    return res.status(400).json({
      success: false,
      message: "candidateIds array is required"
    });
  }

  try {
    const results = [];
    
    for (const candidateId of candidateIds) {
      const result = await session.run(
        "MATCH (c:Candidate_Profile) WHERE c.Can_ID = $id RETURN c.isInProgress as isInProgress",
        { id: parseInt(candidateId) }
      );
      
      const isInProgress = result.records.length > 0 ? result.records[0].get('isInProgress') || false : false;
      
      results.push({
        candidateId: parseInt(candidateId),
        isInProgress: isInProgress
      });
    }
    
    const inProgressCount = results.filter(r => r.isInProgress).length;
    
    console.log(`✅ Batch status: ${inProgressCount}/${candidateIds.length} candidates are in progress`);

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

/**
 * @swagger
 * /api/candidates/{id}:
 *   put:
 *     summary: Update candidate profile
 *     tags: [Candidates]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             $ref: '#/components/schemas/CandidateInput'
 *     responses:
 *       200:
 *         description: Candidate updated successfully
 *       404:
 *         description: Candidate not found
 *       500:
 *         description: Server error
 */
router.put("/:id", upload.single('resume'), async (req, res) => {
  console.log(`\n📡 PUT /api/candidates/${req.params.id} - Updating candidate profile`);
  
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
      console.log("New file received for update:", {
        originalname: req.file.originalname,
        size: req.file.size
      });
      
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
console.log("PUT - Raw keySkills:", keySkills);

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
  "Profile submission date": formattedExisting.profileSubmissionDate || "",
  "Key Skills": Array.isArray(keySkills) ? keySkills : (keySkills || formattedExisting.keySkills || []),
  "Can_ID": formattedExisting.canId || id,
  "Visa type": req.body.visaType || formattedExisting.visaType || "NA",
  "resumePath": resumePath,
  "googleDriveFileId": googleDriveFileId,
  "googleDriveViewLink": googleDriveViewLink,
  "googleDriveDownloadLink": googleDriveDownloadLink,
  "updatedAt": new Date().toISOString(),
  "createdAt": formattedExisting.createdAt,
  "id": formattedExisting.id || id
};

    console.log("Updating candidate profile...");

    const result = await session.run(
      `MATCH (c:Candidate_Profile) WHERE c.Can_ID = $id
       SET c = $data
       RETURN c`,
      { id, data: updateData }
    );

    const updated = result.records[0].get("c").properties;
    const formatted = formatProfileForResponse(updated);

    console.log("✅ Candidate profile updated successfully with Can_ID:", id);

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

/**
 * @swagger
 * /api/candidates/{id}:
 *   delete:
 *     summary: Delete candidate profile
 *     tags: [Candidates]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Candidate deleted successfully
 *       404:
 *         description: Candidate not found
 *       500:
 *         description: Server error
 */
router.delete("/:id", async (req, res) => {
  console.log(`\n📡 DELETE /api/candidates/${req.params.id} - Deleting candidate profile`);
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
      await deleteFromGoogleDrive(formatted.googleDriveFileId);
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
      "MATCH (c:Candidate_Profile) WHERE c.Can_ID = $id DELETE c RETURN count(c) as deletedCount",
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

    console.log("✅ Candidate profile deleted successfully with Can_ID:", id);

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
/**
 * @swagger
 * /api/candidates/resume/{filename}:
 *   get:
 *     summary: Serve resume file
 *     tags: [Candidates]
 *     parameters:
 *       - in: path
 *         name: filename
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Resume file
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Resume not found
 */
router.get("/resume/:filename", (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, "../uploads", filename);
  
  console.log("Looking for resume at:", filePath);
  
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
  
  console.log(`\n📡 GET /api/candidates/check-zone/${candidateId}/${clientName}`);
  
  
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
module.exports = router;
