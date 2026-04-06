const neo4j = require("neo4j-driver");
const bcrypt = require("bcrypt");

// Your Neo4j connection details
const URI = "neo4j+s://48046602.databases.neo4j.io";
const USER = "neo4j";
const PASSWORD = "rKuznpRuK690WrCGTfZJTV7HMOSzLposT25XgIbB0K8";

const driver = neo4j.driver(
  URI,
  neo4j.auth.basic(USER, PASSWORD)
);

async function createAdmin() {
  const session = driver.session();

  try {
    const hash = await bcrypt.hash("UAW@2026", 10);

    await session.run(
      `
      MERGE (u:User {username: $username})
      SET u.passwordHash = $hash,
          u.role = $role,
          u.createdAt = datetime()
      `,
      {
        username: "UAWadmin",
        hash,
        role: "Admin"
      }
    );

    console.log("✅ Admin user created successfully!");
    console.log("   Username: UAWadmin");
    console.log("   Password: UAW@2026");
    console.log("   Role: Admin");
  } catch (err) {
    console.error("❌ Error creating admin:", err);
  } finally {
    await session.close();
    await driver.close();
  }
}

createAdmin();