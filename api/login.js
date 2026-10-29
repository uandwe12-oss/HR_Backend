const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

// Import the shared driver helper
const getDriver = require("../lib/neo4j");

/**
 * =================================================
 * POST – User Login
 * =================================================
 */
router.post("/", async (req, res) => {
const { username, password } = req.body;

if (
  typeof username !== "string" ||
  typeof password !== "string" ||
  !username.trim() ||
  !password
) {
  return res.status(400).json({
    success: false,
    message: "Username and password must be valid strings"
  });
}


const cleanUsername = username.trim();

const driver = getDriver();
const session = driver.session();

  
  try {
    
    const result = await session.run(
      `MATCH (u:User)
       WHERE toLower(u.username) = toLower($username) OR toLower(u.email) = toLower($username)
       SET u.loginCount = coalesce(u.loginCount, 0) + 1
       WITH u
       OPTIONAL MATCH (p:PersonalDetails)
       WHERE toLower(p.userId) = toLower(u.username) OR toLower(p.emailId) = toLower(u.username) OR (u.email IS NOT NULL AND toLower(p.emailId) = toLower(u.email))
       RETURN u.username AS username, 
              u.passwordHash AS hash, 
              u.role AS role,
              coalesce(u.name, p.fullName, p.firstName + ' ' + p.lastName) AS name,
              u.assignedCompany AS userAssignedCompany,
              u.assignedClient AS userAssignedClient,
              p.assignedCompany AS personalAssignedCompany,
              p.assignedClient AS personalAssignedClient,
              u.loginCount AS loginCount`,
{ username: cleanUsername }
    );

    // Check if user exists
    if (result.records.length === 0) {
      // console.log(`❌ Login failed: User ${username} not found`);
      return res.status(401).json({ 
        success: false, 
        message: "Invalid credentials" 
      });
    }

    const record = result.records[0];
    
    // Check Role-Based Auth Configuration
  const rawRole = record.get("role");

const roles = Array.isArray(rawRole)
  ? rawRole
  : rawRole
    ? [rawRole]
    : [];

const AUTH_CONFIG = require("../config/authConfig");

const authMethods = roles.map(
  role => AUTH_CONFIG[role] || "BOTH"
);

if (
  roles.length > 0 &&
  authMethods.every(method => method === "SSO_ONLY")
) {
  return res.status(403).json({
    success: false,
    message:
      "Username and password login is not available for your account. Please use Microsoft SSO to log in."
  });
}

    const hash = record.get("hash");
    
    // Verify password
    const isValid = await bcrypt.compare(password, hash);

    if (!isValid) {
      console.log(`❌ Login failed: Invalid password for user ${username}`);
      return res.status(401).json({ 
        success: false, 
        message: "Invalid credentials" 
      });
    }

    // Get name - if no name field exists, use username as fallback
    const userName = record.get("name") || username;

    // Login successful
    // console.log(`✅ Login successful for user: ${username} (Role: ${record.get("role")})`);
    
    const loginCount = record.get("loginCount").toNumber ? record.get("loginCount").toNumber() : record.get("loginCount");
    const isFirstLogin = loginCount === 1;

    const rawUserComp = record.get("userAssignedCompany");
    const rawUserClient = record.get("userAssignedClient");
    const rawPersComp = record.get("personalAssignedCompany");
    const rawPersClient = record.get("personalAssignedClient");

    const cleanVal = (val) => {
      if (!val) return null;
      if (Array.isArray(val)) {
        const filtered = val.filter(x => typeof x === 'string' && x.trim() !== '');
        return filtered.length > 0 ? (filtered.length === 1 ? filtered[0] : filtered) : null;
      }
      if (typeof val === 'string' && val.trim() !== '') return val.trim();
      return null;
    };

    const assignedCompany = cleanVal(rawPersComp) || cleanVal(rawUserComp);
    const assignedClient = cleanVal(rawUserClient) || cleanVal(rawPersClient) || null;

    const userObj = {
      username: record.get("username"),
      name: userName,
      role: record.get("role"),
      assignedCompany: assignedCompany || null,
      assignedClient: assignedClient || null,
      clientName: assignedClient || null,
      isFirstLogin: isFirstLogin
    };

    // Generate JWT token (same as SSO flow)
    const jwtSecret = process.env.JWT_SECRET || 'supersecretjwtkey';
    const token = jwt.sign(userObj, jwtSecret, { expiresIn: '12h' });

    res.json({
      success: true,
      message: "Login successful",
      token,
      user: userObj
    });

  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).json({ 
      success: false, 
      message: "Server error" 
    });
  } finally {
    await session.close();
  }
});

module.exports = router;
