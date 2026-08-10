const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");

// Import the shared driver helper
const getDriver = require("../lib/neo4j");

const VALID_ROLES = ["Admin", "Recruiter", "Interviewer", "Client Interviewer", "Employee", "HR", "Sales"];

/**
 * =================================================
 * GET – Get All Users (Admin only)
 * =================================================
 */
router.get("/", async (req, res) => {
  // console.log("\n📡 GET /api/users - Fetching all users");
  
  const driver = getDriver();
  const session = driver.session();

  try {
    // console.log("🔍 Executing Neo4j query...");
    
    const result = await session.run(
      `MATCH (u:User)
       RETURN u.username as username, 
              u.role as role,
              u.assignedClient as assignedClient,
              u.pid as pid,
              u.createdAt as createdAt
       ORDER BY u.createdAt DESC`
    );

    // console.log(`📊 Found ${result.records.length} users`);

    const users = result.records.map(record => {
      const username = record.get("username");
      const role = record.get("role");
      const assignedClient = record.get("assignedClient");
      const pid = record.get("pid"); // This will be null initially
      const createdAt = record.get("createdAt");
      
      return {
        username: username,
        role: role,
        assignedClient: assignedClient || null,
        pid: pid || null, // Return null if no PID exists
        createdAt: createdAt ? new Date(createdAt).toISOString() : null
      };
    });

    // console.log("✅ Users fetched successfully");

    res.json({
      success: true,
      users: users
    });

  } catch (err) {
    console.error("❌ Error fetching users:", err);
    res.status(500).json({ 
      success: false,
      message: "Failed to fetch users",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});

/**
 * =================================================
 * POST – Create New User (PID is initially null)
 * =================================================
 */
router.post("/", async (req, res) => {
  // console.log("\n📡 POST /api/users - Creating new user");
  // console.log("Request body:", { ...req.body, password: "[HIDDEN]" });
  
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const { username, password, role, assignedClient } = req.body; // Remove assignedCompany

    // Validation
    if (!username || !password || !role) {
      return res.status(400).json({ 
        success: false,
        message: "Username, password and role are required" 
      });
    }

    // Check if username exists
    const checkResult = await session.run(
      "MATCH (u:User {username: $username}) RETURN u",
      { username }
    );

    if (checkResult.records.length > 0) {
      console.log(`❌ Username already exists: ${username}`);
      return res.status(400).json({ 
        success: false,
        message: "Username already exists" 
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Validate role
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Invalid role. Valid roles: ${VALID_ROLES.join(", ")}`
      });
    }

    // Role-specific validation
    if ((role === "Interviewer" || role === "Client Interviewer") && !assignedClient) {
      return res.status(400).json({
        success: false,
        message: `${role} role requires an assigned client. Please select a client.`
      });
    }

    // Prepare data for Neo4j
    const neo4jData = {
      username,
      passwordHash,
      role,
      assignedClient: (role === "Interviewer" || role === "Client Interviewer") ? (assignedClient || null) : null,
      createdAt: new Date().toISOString()
    };

    // console.log(`📝 Creating user with data:`, {
    //   username: neo4jData.username,
    //   role: neo4jData.role,
    //   assignedClient: neo4jData.assignedClient,
    //   createdAt: neo4jData.createdAt
    // });

    // Create user in Neo4j
    const result = await session.run(
      `
      CREATE (u:User {
        username: $username,
        passwordHash: $passwordHash,
        role: $role,
        assignedClient: $assignedClient,
        createdAt: datetime($createdAt)
      })
      RETURN u.username as username, 
             u.role as role, 
             u.assignedClient as assignedClient,
             u.createdAt as createdAt
      `,
      {
        username: neo4jData.username,
        passwordHash: neo4jData.passwordHash,
        role: neo4jData.role,
        assignedClient: neo4jData.assignedClient,
        createdAt: neo4jData.createdAt
      }
    );

    const createdUser = result.records[0];
    const createdUsername = createdUser.get("username");
    const createdRole = createdUser.get("role");
    const createdClient = createdUser.get("assignedClient");
    const createdDate = createdUser.get("createdAt");

    // console.log(`✅ User created successfully:`);
    // console.log(`   Username: ${createdUsername}`);
    // console.log(`   Role: ${createdRole}`);
    // if (createdClient) console.log(`   Assigned Client: ${createdClient}`);
    // console.log(`   PID: null`);
    // console.log(`   Created At: ${createdDate}`);

    res.status(201).json({
      success: true,
      message: "User created successfully",
      user: {
        username: createdUsername,
        role: createdRole,
        assignedClient: createdClient || null,
        pid: null,
        createdAt: createdDate ? createdDate.toString() : null
      }
    });

  } catch (err) {
    console.error("❌ Error creating user:", err);
    res.status(500).json({ 
      success: false,
      message: "Failed to create user",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});

/**
 * =================================================
 * POST – Login User
 * =================================================
 */
router.post("/login", async (req, res) => {
  // console.log("\n📡 POST /api/users/login - User login");
  
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: "Username and password are required"
      });
    }

    // Find user with all fields
    const result = await session.run(
      `MATCH (u:User {username: $username})
       RETURN u.username as username,
              u.passwordHash as passwordHash,
              u.role as role,
              u.assignedClient as assignedClient,
              u.assignedCompany as assignedCompany,
              u.pid as pid,
              u.createdAt as createdAt`,
      { username }
    );

    if (result.records.length === 0) {
      console.log(`❌ Login failed: User ${username} not found`);
      return res.status(401).json({
        success: false,
        message: "Invalid username or password"
      });
    }

    const user = result.records[0];
    const passwordHash = user.get("passwordHash");
    const role = user.get("role");
    const assignedClient = user.get("assignedClient");
    const assignedCompany = user.get("assignedCompany");
    const pid = user.get("pid"); // This will be null if not set yet
    const createdAt = user.get("createdAt");

    // Verify password
    const isValidPassword = await bcrypt.compare(password, passwordHash);
    
    if (!isValidPassword) {
      console.log(`❌ Login failed: Invalid password for ${username}`);
      return res.status(401).json({
        success: false,
        message: "Invalid username or password"
      });
    }

    // console.log(`✅ User logged in successfully: ${username} (${role})`);
    // console.log(`   PID: ${pid || "Not assigned yet (will be created when you submit personal details)"}`);
    if (assignedClient) console.log(`   Assigned client: ${assignedClient}`);
    if (assignedCompany) console.log(`   Assigned company: ${assignedCompany}`);

    // Return user data (without password)
    res.json({
      success: true,
      message: "Login successful",
      user: {
        username: username,
        role: role,
        assignedClient: assignedClient || null,
        assignedCompany: assignedCompany || null,
        pid: pid || null, // Return null if not set
        createdAt: createdAt ? createdAt.toString() : null
      }
    });

  } catch (err) {
    console.error("❌ Error during login:", err);
    res.status(500).json({
      success: false,
      message: "Login failed",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * =================================================
 * PUT – Update User PID (Called after personal details submitted)
 * =================================================
 */
router.put("/:username/pid", async (req, res) => {
  // console.log(`\n📡 PUT /api/users/${req.params.username}/pid - Updating PID`);
  
  const driver = getDriver();
  const session = driver.session();
  const { username } = req.params;
  const { pid } = req.body;

  try {
    if (!pid) {
      return res.status(400).json({
        success: false,
        message: "PID is required"
      });
    }

    // console.log(`📝 Updating PID for user: ${username}`);
    // console.log(`   New PID: ${pid}`);

    // Check if user exists
    const checkResult = await session.run(
      "MATCH (u:User {username: $username}) RETURN u",
      { username }
    );

    if (!checkResult.records.length) {
      console.log(`❌ User ${username} not found`);
      return res.status(404).json({ 
        success: false,
        message: "User not found" 
      });
    }

    // Update the user's PID
    await session.run(
      `MATCH (u:User {username: $username})
       SET u.pid = $pid`,
      { username, pid }
    );
    
    // Fetch updated user data
    const result = await session.run(
      `
      MATCH (u:User {username: $username})
      RETURN u.username as username, 
             u.role as role, 
             u.assignedClient as assignedClient,
             u.assignedCompany as assignedCompany,
             u.pid as pid,
             u.createdAt as createdAt
      `,
      { username }
    );

    const updatedUser = result.records[0];
    const updatedUsername = updatedUser.get("username");
    const updatedRole = updatedUser.get("role");
    const updatedClient = updatedUser.get("assignedClient");
    const updatedCompany = updatedUser.get("assignedCompany");
    const updatedPid = updatedUser.get("pid");
    const updatedDate = updatedUser.get("createdAt");

    // console.log(`✅ PID updated successfully for ${username}: ${updatedPid}`);

    res.json({
      success: true,
      message: "PID updated successfully",
      user: {
        username: updatedUsername,
        role: updatedRole,
        assignedClient: updatedClient || null,
        assignedCompany: updatedCompany || null,
        pid: updatedPid,
        createdAt: updatedDate ? updatedDate.toString() : null
      }
    });

  } catch (err) {
    console.error("❌ Error updating PID:", err);
    res.status(500).json({ 
      success: false,
      message: "Failed to update PID",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});

/**
 * =================================================
 * PUT – Update User (Role and Assigned fields)
 * =================================================
 */
router.put("/:username", async (req, res) => {
  // console.log(`\n📡 PUT /api/users/${req.params.username} - Updating user`);
  
  const driver = getDriver();
  const session = driver.session();
  const { username } = req.params;
  const { role, assignedClient, assignedCompany } = req.body;

  try {
    // console.log(`📝 Updating user: ${username}`);
    // console.log(`   New role: ${role}`);
    if (assignedClient) console.log(`   New assigned client: ${assignedClient}`);
    if (assignedCompany) console.log(`   New assigned company: ${assignedCompany}`);

    if (!role) {
      return res.status(400).json({ 
        success: false,
        message: "Role is required" 
      });
    }

    // Validate role
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Invalid role. Valid roles: ${VALID_ROLES.join(", ")}`
      });
    }

    // Role-specific validation
    if ((role === "Interviewer" || role === "Client Interviewer") && !assignedClient) {
      return res.status(400).json({
        success: false,
        message: `${role} role requires an assigned client.`
      });
    }

    // Check if user exists
    const checkResult = await session.run(
      "MATCH (u:User {username: $username}) RETURN u",
      { username }
    );

    if (!checkResult.records.length) {
      console.log(`❌ User ${username} not found`);
      return res.status(404).json({ 
        success: false,
        message: "User not found" 
      });
    }

    // Build dynamic update query
    let updateQuery = `MATCH (u:User {username: $username}) SET u.role = $role`;
    const params = { username, role };

    // Handle assignedClient for Interviewer and Client Interviewer
    if (role === "Interviewer" || role === "Client Interviewer") {
      if (assignedClient) {
        updateQuery += `, u.assignedClient = $assignedClient`;
        params.assignedClient = assignedClient;
        console.log(`   Setting assigned client: ${assignedClient}`);
      } else {
        updateQuery += `, u.assignedClient = null`;
        console.log(`   Setting assigned client to null`);
      }
      // Remove assignedCompany if it exists
      updateQuery += ` REMOVE u.assignedCompany`;
    } 
   // Handle Employee role - remove both assigned fields
else if (role === "Employee") {
  // For Employee, remove both assignedClient and assignedCompany
  updateQuery += ` REMOVE u.assignedClient, u.assignedCompany`;
  // console.log(`   Removing both assigned client and assigned company for Employee`);
}
// For Admin and Recruiter, remove both assigned fields
else {
  updateQuery += ` REMOVE u.assignedClient, u.assignedCompany`;
  // console.log(`   Removing both assigned client and assigned company`);
}
    
    // Execute update
    await session.run(updateQuery, params);
    
    // Fetch updated user data
    const result = await session.run(
      `
      MATCH (u:User {username: $username})
      RETURN u.username as username, 
             u.role as role, 
             u.assignedClient as assignedClient,
             u.assignedCompany as assignedCompany,
             u.pid as pid,
             u.createdAt as createdAt
      `,
      { username }
    );

    const updatedUser = result.records[0];
    const updatedUsername = updatedUser.get("username");
    const updatedRole = updatedUser.get("role");
    const updatedClient = updatedUser.get("assignedClient");
    const updatedCompany = updatedUser.get("assignedCompany");
    const updatedPid = updatedUser.get("pid");
    const updatedDate = updatedUser.get("createdAt");

    console.log(`✅ User ${username} updated successfully to role: ${updatedRole}`);
    if (updatedClient) console.log(`   Client: ${updatedClient}`);
    if (updatedCompany) console.log(`   Company: ${updatedCompany}`);
    if (updatedPid) console.log(`   PID: ${updatedPid}`);

    res.json({
      success: true,
      message: "User updated successfully",
      user: {
        username: updatedUsername,
        role: updatedRole,
        assignedClient: updatedClient || null,
        assignedCompany: updatedCompany || null,
        pid: updatedPid || null,
        createdAt: updatedDate ? updatedDate.toString() : null
      }
    });

  } catch (err) {
    console.error("❌ Error updating user:", err);
    res.status(500).json({ 
      success: false,
      message: "Failed to update user",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});

/**
 * =================================================
 * DELETE – Delete User (Admin only)
 * =================================================
 */
router.delete("/:username", async (req, res) => {
  // console.log(`\n📡 DELETE /api/users/${req.params.username} - Deleting user`);
  
  const driver = getDriver();
  const session = driver.session();
  const { username } = req.params;

  try {
    // console.log(`🔍 Checking if user ${username} exists`);

    // Check if user exists
    const checkResult = await session.run(
      "MATCH (u:User {username: $username}) RETURN u",
      { username }
    );

    if (!checkResult.records.length) {
      console.log(`❌ User ${username} not found`);
      return res.status(404).json({ 
        success: false,
        message: "User not found" 
      });
    }

    // Delete user
    await session.run(
      "MATCH (u:User {username: $username}) DELETE u",
      { username }
    );

    console.log(`✅ User ${username} deleted successfully`);

    res.json({
      success: true,
      message: "User deleted successfully"
    });

  } catch (err) {
    console.error("❌ Error deleting user:", err);
    res.status(500).json({ 
      success: false,
      message: "Failed to delete user",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});

module.exports = router;
