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
  
  // Get driver and create session
  const driver = getDriver();
  const session = driver.session();
  
  try {
    
    const result = await session.run(
      `MATCH (u:User {username: $username}) 
       SET u.loginCount = coalesce(u.loginCount, 0) + 1
       RETURN u.username AS username, 
              u.passwordHash AS hash, 
              u.role AS role,
              u.name AS name,
              u.assignedClient AS assignedClient,
              u.loginCount AS loginCount`,
      { username }
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
    const role = record.get("role");
    const AUTH_CONFIG = require("../config/authConfig");
    const authMethod = AUTH_CONFIG[role] || 'BOTH';

    if (authMethod === 'SSO_ONLY') {
      return res.status(403).json({ 
        success: false,
        message: "Username and password login is not available for your account. Please use Microsoft SSO to log in." 
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

    const userObj = {
      username: record.get("username"),
      name: userName,
      role: record.get("role"),
      clientName: record.get("assignedClient"),
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
