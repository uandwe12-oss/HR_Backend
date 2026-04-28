const express = require("express");
const router = express.Router();

const getDriver = require("../lib/neo4j");

// ─── Field lists (keeps queries DRY) ───────────────────────────────────────
const RETURN_FIELDS = `
  .userId,
  .firstName,
  .middleName,
  .lastName,
  .fullName,
  .emailId,
  .personalEmailId,
  .employeeNumber,
  .gender,
  .mobileNumber,
  .emergencyNumber,
  .aadharNumber,
  .socialSecurityNumber,
  .panNumber,
  .dateOfBirth,
  .nationality,
  .maritalStatus,
  .currentResidentialAddress,
  .permanentResidentialAddress,
  .city,
  .state,
  .jobTitle,
  .employmentStartDate,
  .employmentLocation,
  .visaType,
  .visaEndDate,
  .supervisor,
  .hr,
  .createdAt,
  .updatedAt
`;

/**
 * =================================================
 * GET – Get personal details (by query param or all)
 * =================================================
 */
router.get("/", async (req, res) => {
  const driver = getDriver();

  if (!driver) {
    console.error("❌ Neo4j driver not available");
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { userId, email, employeeNumber } = req.query;

  try {
    if (userId) {
      console.log(`\n📡 GET /api/personal-details?userId=${userId}`);
      const result = await session.run(
        `MATCH (p:PersonalDetails {userId: $userId})
         RETURN p { ${RETURN_FIELDS} } as personalDetails`,
        { userId }
      );

      if (result.records.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Personal details not found for this user"
        });
      }
      return res.json({ success: true, data: result.records[0].get("personalDetails") });
    }

    if (email) {
      console.log(`\n📡 GET /api/personal-details?email=${email}`);

      const result = await session.run(
        `MATCH (p:PersonalDetails {emailId: $email})
         RETURN p { ${RETURN_FIELDS} } as personalDetails`,
        { email }
      );

      if (result.records.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Personal details not found for this email"
        });
      }

      return res.json({ success: true, data: result.records[0].get("personalDetails") });
    }

    if (employeeNumber) {
      console.log(`\n📡 GET /api/personal-details?employeeNumber=${employeeNumber}`);

      const result = await session.run(
        `MATCH (p:PersonalDetails {employeeNumber: $employeeNumber})
         RETURN p { ${RETURN_FIELDS} } as personalDetails`,
        { employeeNumber }
      );

      if (result.records.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Personal details not found for this employee number"
        });
      }

      return res.json({ success: true, data: result.records[0].get("personalDetails") });
    }

    // Fetch all
    console.log(`\n📡 GET /api/personal-details - Fetching all`);

    const result = await session.run(
      `MATCH (p:PersonalDetails)
       RETURN p { ${RETURN_FIELDS} } as personalDetails
       ORDER BY p.createdAt DESC`
    );

    const personalDetails = result.records.map(r => r.get("personalDetails"));
    console.log(`✅ Found ${personalDetails.length} records`);

    res.json({ success: true, count: personalDetails.length, data: personalDetails });

  } catch (err) {
    console.error("❌ Error fetching personal details:", err);
    res.status(500).json({ success: false, message: "Database error: " + err.message });
  } finally {
    await session.close();
  }
});

/**
 * =================================================
 * POST – Upsert personal details (Create or Update based on userId)
 * =================================================
 */
router.post("/", async (req, res) => {
  const driver = getDriver();

  if (!driver) {
    console.error("❌ Neo4j driver not available");
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();

  const {
    userId,
    firstName,
    middleName,
    lastName,
    emailId,
    personalEmailId,
    gender,
    mobileNumber,
    emergencyNumber,
    aadharNumber,
    socialSecurityNumber,
    panNumber,
    dateOfBirth,
    nationality,
    maritalStatus,
    currentResidentialAddress,
    permanentResidentialAddress,
    city,
    state,
    // Auto-pick fields – supplied by system/HR, not editable by employee
    jobTitle,
    employmentStartDate,
    employmentLocation,
    visaType,
    visaEndDate,
    supervisor,
    hr
  } = req.body;

  try {
    console.log(`\n📡 POST /api/personal-details - Upserting for userId: ${userId}`);
    
    if (!userId || !firstName || !lastName || !gender || !mobileNumber || !dateOfBirth) {
      console.log(`❌ Missing required fields`);
      return res.status(400).json({
        success: false,
        message: "Missing required fields: userId, firstName, lastName, gender, mobileNumber, dateOfBirth"
      });
    }

    // Generate full name
    const fullName = [firstName, middleName, lastName]
      .filter(n => n && n.trim())
      .join(" ");

    const currentTime = new Date().toISOString();

    // Check if record exists for this userId
    const checkResult = await session.run(
      `MATCH (p:PersonalDetails {userId: $userId}) RETURN p`,
      { userId }
    );

    let employeeNumberToUse;

    if (checkResult.records.length > 0) {
      // Record exists, we UPDATE
      console.log(`Updating existing record for userId: ${userId}`);
      employeeNumberToUse = checkResult.records[0].get("p").properties.employeeNumber;

      const result = await session.run(
        `MATCH (p:PersonalDetails {userId: $userId})
         SET
           p.firstName                   = COALESCE($firstName, p.firstName),
           p.middleName                  = $middleName,
           p.lastName                    = COALESCE($lastName, p.lastName),
           p.fullName                    = $fullName,
           p.emailId                     = COALESCE($emailId, p.emailId),
           p.personalEmailId             = $personalEmailId,
           p.gender                      = COALESCE($gender, p.gender),
           p.mobileNumber                = COALESCE($mobileNumber, p.mobileNumber),
           p.emergencyNumber             = $emergencyNumber,
           p.aadharNumber                = $aadharNumber,
           p.socialSecurityNumber        = $socialSecurityNumber,
           p.panNumber                   = $panNumber,
           p.dateOfBirth                 = COALESCE($dateOfBirth, p.dateOfBirth),
           p.nationality                 = $nationality,
           p.maritalStatus               = $maritalStatus,
           p.currentResidentialAddress   = $currentResidentialAddress,
           p.permanentResidentialAddress = $permanentResidentialAddress,
           p.city                        = $city,
           p.state                       = $state,
           p.visaType                    = $visaType,
           p.visaEndDate                 = $visaEndDate,
           p.updatedAt                   = $updatedAt
         RETURN p { ${RETURN_FIELDS} } as personalDetails`,
        {
          userId,
          firstName,
          middleName: middleName || "",
          lastName,
          fullName,
          emailId: emailId || "",
          personalEmailId: personalEmailId || "",
          gender,
          mobileNumber,
          emergencyNumber: emergencyNumber || "",
          aadharNumber: aadharNumber || "",
          socialSecurityNumber: socialSecurityNumber || "",
          panNumber: panNumber || "",
          dateOfBirth,
          nationality: nationality || "",
          maritalStatus: maritalStatus || "",
          currentResidentialAddress: currentResidentialAddress || "",
          permanentResidentialAddress: permanentResidentialAddress || "",
          city: city || "",
          state: state || "",
          visaType: visaType || "",
          visaEndDate: visaEndDate || "",
          updatedAt: currentTime
        }
      );

      return res.json({
        success: true,
        message: "Personal details updated successfully",
        data: result.records[0].get("personalDetails")
      });

    } else {
      // Record doesn't exist, we CREATE
      console.log(`Creating new record for userId: ${userId}`);

      // Generate employee number
      const countResult = await session.run(
        `MATCH (p:PersonalDetails) RETURN COUNT(p) as count`
      );

      let count = 0;
      if (countResult.records.length > 0) {
        const countValue = countResult.records[0].get("count");
        count = countValue && typeof countValue.toNumber === "function"
          ? countValue.toNumber()
          : Number(countValue);
      }

      const year = new Date().getFullYear();
      employeeNumberToUse = `EMP${year}${String(count + 1).padStart(4, "0")}`;

      const result = await session.run(
        `CREATE (p:PersonalDetails {
           userId:                     $userId,
           firstName:                  $firstName,
           middleName:                 $middleName,
           lastName:                   $lastName,
           fullName:                   $fullName,
           emailId:                    $emailId,
           personalEmailId:            $personalEmailId,
           employeeNumber:             $employeeNumber,
           gender:                     $gender,
           mobileNumber:               $mobileNumber,
           emergencyNumber:            $emergencyNumber,
           aadharNumber:               $aadharNumber,
           socialSecurityNumber:       $socialSecurityNumber,
           panNumber:                  $panNumber,
           dateOfBirth:                $dateOfBirth,
           nationality:                $nationality,
           maritalStatus:              $maritalStatus,
           currentResidentialAddress:  $currentResidentialAddress,
           permanentResidentialAddress:$permanentResidentialAddress,
           city:                       $city,
           state:                      $state,
           jobTitle:                   $jobTitle,
           employmentStartDate:        $employmentStartDate,
           employmentLocation:         $employmentLocation,
           visaType:                   $visaType,
           visaEndDate:                $visaEndDate,
           supervisor:                 $supervisor,
           hr:                         $hr,
           createdAt:                  $createdAt,
           updatedAt:                  $updatedAt
         })
         RETURN p { ${RETURN_FIELDS} } as personalDetails`,
        {
          userId,
          firstName,
          middleName:                  middleName                  || "",
          lastName,
          fullName,
          emailId:                     emailId                     || "",
          personalEmailId:             personalEmailId             || "",
          employeeNumber:              employeeNumberToUse,
          gender,
          mobileNumber,
          emergencyNumber:             emergencyNumber             || "",
          aadharNumber:                aadharNumber                || "",
          socialSecurityNumber:        socialSecurityNumber        || "",
          panNumber:                   panNumber                   || "",
          dateOfBirth,
          nationality:                 nationality                 || "",
          maritalStatus:               maritalStatus               || "",
          currentResidentialAddress:   currentResidentialAddress   || "",
          permanentResidentialAddress: permanentResidentialAddress || "",
          city:                        city                        || "",
          state:                       state                       || "",
          jobTitle:                    jobTitle                    || "",
          employmentStartDate:         employmentStartDate         || "",
          employmentLocation:          employmentLocation          || "",
          visaType:                    visaType                    || "",
          visaEndDate:                 visaEndDate                 || "",
          supervisor:                  supervisor                  || "",
          hr:                          hr                          || "",
          createdAt:                   currentTime,
          updatedAt:                   currentTime
        }
      );

      return res.json({
        success: true,
        message: "Personal details created successfully",
        data: result.records[0].get("personalDetails")
      });
    }

  } catch (err) {
    console.error("❌ Error upserting personal details:", err);
    res.status(500).json({ success: false, message: "Database error: " + err.message });
  } finally {
    await session.close();
  }
});

/**
 * =================================================
 * DELETE – Delete personal details by employee number
 * =================================================
 */
router.delete("/:employeeNumber", async (req, res) => {
  const driver = getDriver();

  if (!driver) {
    console.error("❌ Neo4j driver not available");
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { employeeNumber } = req.params;

  try {
    console.log(`\n📡 DELETE /api/personal-details/${employeeNumber} - Deleting`);

    const result = await session.run(
      `MATCH (p:PersonalDetails {employeeNumber: $employeeNumber})
       DELETE p
       RETURN COUNT(p) as deleted`,
      { employeeNumber }
    );

    let deletedCount = 0;
    if (result.records.length > 0) {
      const deletedValue = result.records[0].get("deleted");
      deletedCount = deletedValue && typeof deletedValue.toNumber === "function"
        ? deletedValue.toNumber()
        : Number(deletedValue);
    }

    if (deletedCount === 0) {
      console.log(`❌ Personal details for employee ${employeeNumber} not found`);
      return res.status(404).json({ success: false, message: "Personal details not found" });
    }

    console.log(`✅ Deleted successfully for employee: ${employeeNumber}`);

    res.json({ success: true, message: "Personal details deleted successfully" });

  } catch (err) {
    console.error("❌ Error deleting personal details:", err);
    res.status(500).json({ success: false, message: "Database error: " + err.message });
  } finally {
    await session.close();
  }
});

module.exports = router;