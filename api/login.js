const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");

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
    console.log(`\n📡 POST /api/login - Login attempt for user: ${username}`);
    
const result = await session.run(
  `MATCH (u:User {username: $username}) 
   RETURN u.username AS username, 
          u.passwordHash AS hash, 
          u.role AS role,
          u.name AS name,
          u.assignedClient AS assignedClient`,  // ← ADD THIS LINE
  { username }
);

    // Check if user exists
    if (result.records.length === 0) {
      console.log(`❌ Login failed: User ${username} not found`);
      return res.status(401).json({ 
        success: false,
        message: "Invalid credentials" 
      });
    }

    const record = result.records[0];
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
    console.log(`✅ Login successful for user: ${username} (Role: ${record.get("role")})`);
    console.log(`   Display name: ${userName}`);
    
res.json({
  success: true,
  message: "Login successful",
  user: { 
    username: record.get("username"),
    name: userName,
    role: record.get("role"),
    clientName: record.get("assignedClient")  // ← ADD THIS LINE
  }
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
