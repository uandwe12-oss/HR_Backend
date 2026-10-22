const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");

// Import the shared driver helper
const getDriver = require("../lib/neo4j");

const VALID_ROLES = ["Admin", "Recruiter", "Interviewer", "Client Interviewer", "UANDWE Interviewer", "Employee", "HR", "Sales", "Finance", "Pending", "Rejected"];

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
       OPTIONAL MATCH (p:PersonalDetails) WHERE toLower(p.userId) = toLower(u.username)
       RETURN u.username as username,
              COALESCE(p.firstName + ' ' + p.lastName, p.fullName, u.name) as name,
              COALESCE(u.role, 'Employee') as role,
              u.assignedClient as userAssignedClient,
              u.assignedCompany as userAssignedCompany,
              p.assignedCompany as personalAssignedCompany,
              p.assignedClient as personalAssignedClient,
              p.nationality as nationality,
              COALESCE(p.employeeNumber, u.pid) as pid,
              u.createdAt as createdAt,
              p.profileStatus as approvalStatus
       ORDER BY u.createdAt DESC`
    );

    const users = result.records.map(record => {
      const username = record.get("username");
      const name = record.get("name");
      const role = record.get("role");
      const rawUserClient = record.get("userAssignedClient");
      const rawUserComp = record.get("userAssignedCompany");
      const rawPersComp = record.get("personalAssignedCompany");
      const rawPersClient = record.get("personalAssignedClient");
      const pid = record.get("pid");
      const createdAt = record.get("createdAt");
      const approvalStatus = record.get("approvalStatus");
      const nationality = record.get("nationality");

      const cleanVal = (val) => {
        if (!val) return null;
        if (Array.isArray(val)) {
          const filtered = val.filter(x => typeof x === 'string' && x.trim() !== '');
          return filtered.length > 0 ? (filtered.length === 1 ? filtered[0] : filtered) : null;
        }
        if (typeof val === 'string' && val.trim() !== '') return val.trim();
        return null;
      };

      const assignedCompany = cleanVal(rawPersComp) || cleanVal(rawUserComp) || null;
      const rawClient = cleanVal(rawUserClient) || cleanVal(rawPersClient) || null;

      const CLIENT_ROLES = ["Interviewer", "Client Interviewer", "Sales", "UANDWE Interviewer"];
      const rolesArray = Array.isArray(role) ? role : [role];
      const hasClientRole = rolesArray.some(r => CLIENT_ROLES.includes(r));

      const isCompanyVal = (val) => {
        if (!val || typeof val !== 'string') return false;
        const s = val.trim().toLowerCase();
        // Specifically filter out known internal company branches, NOT clients like "Microchip"
        if (
          s === 'bangaloreuandwe' ||
          s === 'bangalore uandwe' ||
          s === 'bangaloreuandwelabs' ||
          s === 'bangalore uandwe labs' ||
          s === 'shanghainvidia' ||
          s === 'shanghai nvidia' ||
          s === 'uandweshanghai' ||
          s === 'uandwe shanghai' ||
          s === 'bangaloremicrochip' ||
          s === 'bangalore microchip'
        ) {
          return true;
        }
        return (
          s.startsWith('bangalore uandwe') ||
          s.startsWith('shanghai nvidia') ||
          s.includes('uandwe') ||
          (assignedCompany && s === assignedCompany.trim().toLowerCase() && s !== 'microchip')
        );
      };

      let assignedClient = null;
      if (hasClientRole && rawClient) {
        if (Array.isArray(rawClient)) {
          const filtered = rawClient.filter(c => !isCompanyVal(c));
          assignedClient = filtered.length > 0 ? filtered : null;
        } else if (!isCompanyVal(rawClient)) {
          assignedClient = rawClient;
        }
      }

      let formattedCreatedAt = null;
      if (createdAt) {
        if (typeof createdAt === 'string') {
          formattedCreatedAt = createdAt;
        } else if (typeof createdAt === 'object' && typeof createdAt.toString === 'function') {
          formattedCreatedAt = createdAt.toString();
        } else {
          try {
            const d = new Date(createdAt);
            formattedCreatedAt = isNaN(d.getTime()) ? null : d.toISOString();
          } catch (e) {
            formattedCreatedAt = null;
          }
        }
      }

      return {
        username: username,
        name: name || null,
        role: role,
        assignedClient: assignedClient || null,
        assignedCompany: assignedCompany || null,
        nationality: nationality || null,
        pid: pid || null,
        createdAt: formattedCreatedAt,
        approvalStatus: approvalStatus || "PENDING"
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

    let roles = Array.isArray(role) ? role : [role];

    // Validation
    if (!username || !password || roles.length === 0) {
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

    // Validate roles
    if (!roles.every(r => VALID_ROLES.includes(r))) {
      return res.status(400).json({
        success: false,
        message: `Invalid role. Valid roles: ${VALID_ROLES.join(", ")}`
      });
    }

    // Role-specific validation
    const needsClient = roles.some(r => ["Interviewer", "Client Interviewer", "Sales"].includes(r));
    const clientList = Array.isArray(assignedClient)
      ? assignedClient.filter(c => typeof c === 'string' && c.trim() !== '').map(c => c.trim())
      : (assignedClient && typeof assignedClient === 'string' && assignedClient.trim() !== ''
        ? assignedClient.split(',').map(s => s.trim()).filter(Boolean)
        : []);

    if (needsClient && clientList.length === 0) {
      return res.status(400).json({
        success: false,
        message: `Selected role(s) require an assigned client. Please select at least one client.`
      });
    }

    // Prepare data for Neo4j
    const neo4jData = {
      username,
      passwordHash,
      role: roles,
      assignedClient: needsClient ? (clientList.length > 0 ? clientList : null) : null,
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

    // Find user with all fields, falling back to PersonalDetails if needed
    const result = await session.run(
      `MATCH (u:User)
       WHERE toLower(u.username) = toLower($username)
       OPTIONAL MATCH (p:PersonalDetails)
       WHERE toLower(p.userId) = toLower($username) OR toLower(p.emailId) = toLower($username)
       RETURN u.username as username,
              u.passwordHash as passwordHash,
              u.role as role,
              u.assignedClient as userAssignedClient,
              u.assignedCompany as userAssignedCompany,
              p.assignedCompany as personalAssignedCompany,
              p.assignedClient as personalAssignedClient,
              coalesce(u.pid, p.employeeNumber) as pid,
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
    const pid = user.get("pid");
    const createdAt = user.get("createdAt");

    const rawUserClient = user.get("userAssignedClient");
    const rawUserComp = user.get("userAssignedCompany");
    const rawPersComp = user.get("personalAssignedCompany");
    const rawPersClient = user.get("personalAssignedClient");

    const cleanVal = (val) => {
      if (!val) return null;
      if (Array.isArray(val)) {
        const filtered = val.filter(x => typeof x === 'string' && x.trim() !== '');
        return filtered.length > 0 ? (filtered.length === 1 ? filtered[0] : filtered) : null;
      }
      if (typeof val === 'string' && val.trim() !== '') return val.trim();
      return null;
    };

    const assignedCompany = cleanVal(rawPersComp) || cleanVal(rawUserComp) || null;
    const rawClient = cleanVal(rawUserClient) || cleanVal(rawPersClient) || null;

    const CLIENT_ROLES = ["Interviewer", "Client Interviewer", "Sales", "UANDWE Interviewer"];
    const rolesArray = Array.isArray(role) ? role : [role];
    const hasClientRole = rolesArray.some(r => CLIENT_ROLES.includes(r));

    const isCompanyVal = (val) => {
      if (!val || typeof val !== 'string') return false;
      const s = val.trim().toLowerCase();
      // Specifically filter out known internal company branches, NOT clients like "Microchip"
      if (
        s === 'bangaloreuandwe' ||
        s === 'bangalore uandwe' ||
        s === 'bangaloreuandwelabs' ||
        s === 'bangalore uandwe labs' ||
        s === 'shanghainvidia' ||
        s === 'shanghai nvidia' ||
        s === 'uandweshanghai' ||
        s === 'uandwe shanghai' ||
        s === 'bangaloremicrochip' ||
        s === 'bangalore microchip'
      ) {
        return true;
      }
      return (
        s.startsWith('bangalore uandwe') ||
        s.startsWith('shanghai nvidia') ||
        s.includes('uandwe') ||
        (assignedCompany && s === assignedCompany.trim().toLowerCase() && s !== 'microchip')
      );
    };

    let assignedClient = null;
    if (hasClientRole && rawClient) {
      if (Array.isArray(rawClient)) {
        const filtered = rawClient.filter(c => !isCompanyVal(c));
        assignedClient = filtered.length > 0 ? filtered : null;
      } else if (!isCompanyVal(rawClient)) {
        assignedClient = rawClient;
      }
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, passwordHash);

    if (!isValidPassword) {
      console.log(`❌ Login failed: Invalid password for ${username}`);
      return res.status(401).json({
        success: false,
        message: "Invalid username or password"
      });
    }

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

    let roles = Array.isArray(role) ? role : [role];

    if (roles.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Role is required"
      });
    }

    // Validate role
    if (!roles.every(r => VALID_ROLES.includes(r))) {
      return res.status(400).json({
        success: false,
        message: `Invalid role. Valid roles: ${VALID_ROLES.join(", ")}`
      });
    }

    const needsClient = roles.some(r => ["Interviewer", "Client Interviewer", "Sales", "UANDWE Interviewer"].includes(r));
    const clientList = Array.isArray(assignedClient)
      ? assignedClient.filter(c => typeof c === 'string' && c.trim() !== '').map(c => c.trim())
      : (assignedClient && typeof assignedClient === 'string' && assignedClient.trim() !== ''
        ? assignedClient.split(',').map(s => s.trim()).filter(Boolean)
        : []);

    // Role-specific validation
    if (needsClient && clientList.length === 0) {
      return res.status(400).json({
        success: false,
        message: `Selected role(s) require an assigned client. Please select at least one client.`
      });
    }

    // Check if user exists (case-insensitive)
    const checkResult = await session.run(
      "MATCH (u:User) WHERE toLower(trim(u.username)) = toLower(trim($username)) RETURN u.username as actualUsername",
      { username }
    );

    if (!checkResult.records.length) {
      console.log(`❌ User ${username} not found`);
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const targetUsername = checkResult.records[0].get("actualUsername") || username;

    // Build dynamic update query
    let updateQuery = `MATCH (u:User {username: $targetUsername}) SET u.role = $role`;
    const params = { targetUsername, role: roles };

    // Handle assignedClient for Interviewer, Client Interviewer, and Sales
    if (needsClient) {
      if (clientList.length > 0) {
        updateQuery += `, u.assignedClient = $assignedClient`;
        params.assignedClient = clientList;
      } else {
        updateQuery += `, u.assignedClient = null`;
        params.assignedClient = null;
      }
    } else if (assignedClient !== undefined) {
      if (clientList.length > 0) {
        updateQuery += `, u.assignedClient = $assignedClient`;
        params.assignedClient = clientList;
      } else {
        updateQuery += `, u.assignedClient = null`;
        params.assignedClient = null;
      }
    }

    // Handle assignedCompany if provided without wiping existing values
    if (assignedCompany !== undefined) {
      if (assignedCompany && typeof assignedCompany === 'string' && assignedCompany.trim() !== '') {
        updateQuery += `, u.assignedCompany = $assignedCompany`;
        params.assignedCompany = assignedCompany.trim();
        if (!needsClient && (!assignedClient || clientList.length === 0)) {
          updateQuery += `, u.assignedClient = $assignedCompany`;
        }
      } else if (assignedCompany === null || assignedCompany === '') {
        updateQuery += ` REMOVE u.assignedCompany`;
      }
    }

    // Execute update
    await session.run(updateQuery, params);

    // Sync assignedCompany to PersonalDetails node if updated
    if (params.assignedCompany) {
      try {
        await session.run(
          `MATCH (p:PersonalDetails)
           WHERE toLower(trim(p.userId)) = toLower(trim($targetUsername)) OR toLower(trim(p.emailId)) = toLower(trim($targetUsername))
           SET p.assignedCompany = $assignedCompany`,
          { targetUsername, assignedCompany: params.assignedCompany }
        );
      } catch (pErr) {
        console.error("Error syncing assignedCompany to PersonalDetails:", pErr);
      }
    }

    // Sync assignedClient to PersonalDetails node if updated
    if (params.assignedClient !== undefined) {
      try {
        await session.run(
          `MATCH (p:PersonalDetails)
           WHERE toLower(trim(p.userId)) = toLower(trim($targetUsername)) OR toLower(trim(p.emailId)) = toLower(trim($targetUsername))
           SET p.assignedClient = $assignedClient`,
          { targetUsername, assignedClient: params.assignedClient }
        );
      } catch (pErr) {
        console.error("Error syncing assignedClient to PersonalDetails:", pErr);
      }
    }

    // Fetch updated user data
    const result = await session.run(
      `
      MATCH (u:User {username: $targetUsername})
      RETURN u.username as username, 
             u.role as role, 
             u.assignedClient as assignedClient,
             u.assignedCompany as assignedCompany,
             u.pid as pid,
             u.createdAt as createdAt
      `,
      { targetUsername }
    );

    const updatedUser = result.records[0];
    const updatedUsername = updatedUser.get("username");
    const updatedRole = updatedUser.get("role");
    const updatedClient = updatedUser.get("assignedClient");
    const updatedCompany = updatedUser.get("assignedCompany");
    const updatedPid = updatedUser.get("pid");
    const updatedDate = updatedUser.get("createdAt");

    // console.log(`✅ User ${username} updated successfully to role: ${updatedRole}`);
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

    // Delete user, their relationships, and their floating PersonalDetails node
    await session.run(
      `MATCH (u:User {username: $username})
       OPTIONAL MATCH (p:PersonalDetails {emailId: $username})
       DETACH DELETE u, p`,
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
