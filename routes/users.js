const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const neo4j = require("neo4j-driver");
require("dotenv").config();

// Create driver
const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(
    process.env.NEO4J_USER,
    process.env.NEO4J_PASSWORD
  )
);

/**
 * =================================================
 * POST – Create New User (Admin only)
 * =================================================
 */
router.post("/", async (req, res) => {
  const session = driver.session();
  
  try {
    const { username, password, role } = req.body;

    // Validate input
    if (!username || !password || !role) {
      return res.status(400).json({ 
        message: "Username, password and role are required" 
      });
    }

    // Check if username already exists
    const checkResult = await session.run(
      "MATCH (u:User {username: $username}) RETURN u",
      { username }
    );

    if (checkResult.records.length > 0) {
      return res.status(400).json({ 
        message: "Username already exists" 
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user in Neo4j
    const result = await session.run(
      `
      CREATE (u:User {
        username: $username,
        passwordHash: $passwordHash,
        role: $role,
        createdAt: datetime()
      })
      RETURN u.username as username, u.role as role, u.createdAt as createdAt
      `,
      {
        username,
        passwordHash,
        role
      }
    );

    const createdUser = result.records[0].toObject();

    res.status(201).json({
      success: true,
      message: "User created successfully",
      user: {
        username: createdUser.username,
        role: createdUser.role,
        createdAt: createdUser.createdAt
      }
    });

  } catch (err) {
    console.error("❌ Error creating user:", err);
    res.status(500).json({ 
      message: "Failed to create user",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});

/**
 * =================================================
 * GET – Get All Users (Admin only)
 * =================================================
 */
router.get("/", async (req, res) => {
  const session = driver.session();

  try {
    const result = await session.run(
      `
      MATCH (u:User)
      RETURN u.username as username, u.role as role, u.createdAt as createdAt
      ORDER BY u.createdAt DESC
      `
    );

    const users = result.records.map(record => record.toObject());

    res.json({
      success: true,
      users
    });

  } catch (err) {
    console.error("❌ Error fetching users:", err);
    res.status(500).json({ 
      message: "Failed to fetch users",
      error: err.message 
    });
  } finally {
    await session.close();
  }
});

module.exports = router;