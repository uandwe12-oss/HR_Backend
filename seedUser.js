const neo4j = require("neo4j-driver");
const bcrypt = require("bcrypt");

// ✅ Neo4j Aura connection
const URI = "neo4j+s://48046602.databases.neo4j.io";
const USER = "neo4j";
const PASSWORD = "rKuznpRuK690WrCGTfZJTV7HMOSzLposT25XgIbB0K8"; 
// 👆 this MUST exactly match the Aura DB password

const driver = neo4j.driver(
  URI,
  neo4j.auth.basic(USER, PASSWORD)
);

async function createUser() {
  const session = driver.session();

  try {
    const hash = await bcrypt.hash("swathi@2026", 10);

    await session.run(
      `
      MERGE (u:User {username: $username})
      SET u.passwordHash = $hash,
          u.role = "HR",
          u.createdAt = datetime()
      `,
      {
        username: "Swathi",
        hash
      }
    );

    console.log("✅ User node created in Neo4j Aura");
  } catch (err) {
    console.error("❌ Error creating user:", err);
  } finally {
    await session.close();
    await driver.close();
  }
}

createUser();
