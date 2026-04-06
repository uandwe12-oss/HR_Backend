require("dotenv").config();
const fs = require("fs");
const csv = require("csv-parser");
const neo4j = require("neo4j-driver");

// Neo4j Aura Connection
const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);

async function uploadCSV() {
  const records = [];

  fs.createReadStream("C:\\Users\\dhara\\OneDrive\\Desktop\\Profile Upload.csv")
    .pipe(csv())
    .on("data", (row) => records.push(row))
    .on("end", async () => {
      const session = driver.session();

      try {
        for (const row of records) {
          await session.executeWrite(tx =>
            tx.run(
              `
              MERGE (c:Candidate_Profile {Can_ID: toInteger($canId)})
              SET
                c.\`Current Org\` = $currentOrg,
                c.\`Client Name\` = $clientName,
                c.\`Candidate Name\` = $candidateName,
                c.\`Profile submission date\` = $submissionDate,
                c.\`Key Skills\` = $keySkills,
                c.Experience = $experience,
                c.\`Current CTC\` = $currentCTC,
                c.\`Expected CTC\` = $expectedCTC,
                c.\`Notice Period in days\` = $noticePeriod,
                c.\`Mobile No\` = $mobileNo,
                c.Email = $email,
                c.\`Profiles sourced by\` = $source,
                c.\`Visa type\` = $visaType,
                c.id = toInteger($id),
                c.updatedAt = datetime()
              `,
              {
                currentOrg: String(row["Current Org"] || ""),
                clientName: String(row["Client Name"] || ""),
                candidateName: String(row["Candidate Name"] || ""),
                submissionDate: String(row["Profile submission date"] || ""),
                keySkills: String(row["Key Skills"] || ""),
                experience: String(row["Experience"] || ""),
                currentCTC: String(row["Current CTC"] || ""),
                expectedCTC: String(row["Expected CTC"] || ""),
                noticePeriod: String(row["Notice Period in days"] || ""),
                mobileNo: String(row["Mobile No"] || ""),
                email: String(row["Email"] || ""),
                source: String(row["Profiles sourced by"] || ""),
                visaType: String(row["Visa type"] || ""),
                canId: row["Can_ID"],
                id: row["id"]
              }
            )
          );

          console.log("Updated:", row["Candidate Name"]);
        }

        console.log("✅ CSV Upload Completed");
      } catch (err) {
        console.error("❌ Upload Error:", err);
      } finally {
        await session.close();
        await driver.close();
      }
    });
}

uploadCSV();