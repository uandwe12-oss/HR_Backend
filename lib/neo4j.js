const neo4j = require("neo4j-driver");

let driver;

function getDriver() {
  if (!driver) {
    driver = neo4j.driver(
      process.env.NEO4J_URI,
      neo4j.auth.basic(
        process.env.NEO4J_USER,
        process.env.NEO4J_PASSWORD
      ),
      {
        maxConnectionPoolSize: 10,
        disableLosslessIntegers: true
      }
    );
  }
  return driver;
}

module.exports = getDriver;
