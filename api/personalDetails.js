const express = require("express");
const router = express.Router();

const getDriver = require("../lib/neo4j");

// ─── Field lists (keeps queries DRY) ───────────────────────────────────────
const RETURN_FIELDS = `
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
  const { email, employeeNumber } = req.query;

  try {
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
 * POST – Create new personal details
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
    console.log(`\n📡 POST /api/personal-details - Creating for: ${firstName} ${lastName}`);
    console.log("Received data:", req.body);

    // Validate required fields
    if (!firstName || !lastName || !emailId || !gender || !mobileNumber || !dateOfBirth) {
      console.log(`❌ Missing required fields`);
      return res.status(400).json({
        success: false,
        message: "Missing required fields: firstName, lastName, emailId, gender, mobileNumber, dateOfBirth"
      });
    }

    // Check if email already exists
    const emailCheck = await session.run(
      `MATCH (p:PersonalDetails {emailId: $email}) RETURN p`,
      { email: emailId }
    );

    if (emailCheck.records.length > 0) {
      console.log(`❌ Email ${emailId} already exists`);
      return res.status(400).json({ success: false, message: "Email already exists" });
    }

    // Generate full name
    const fullName = [firstName, middleName, lastName]
      .filter(n => n && n.trim())
      .join(" ");

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
    const employeeNumber = `EMP${year}${String(count + 1).padStart(4, "0")}`;
    console.log(`Generated employee number: ${employeeNumber} (Count: ${count})`);

    const currentTime = new Date().toISOString();

    const result = await session.run(
      `CREATE (p:PersonalDetails {
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
        firstName,
        middleName:                  middleName                  || "",
        lastName,
        fullName,
        emailId,
        personalEmailId:             personalEmailId             || "",
        employeeNumber,
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

    console.log(`✅ Created successfully with employee number: ${employeeNumber}`);

    res.json({
      success: true,
      message: "Personal details created successfully",
      data: result.records[0].get("personalDetails")
    });

  } catch (err) {
    console.error("❌ Error creating personal details:", err);
    res.status(500).json({ success: false, message: "Database error: " + err.message });
  } finally {
    await session.close();
  }
});

/**
 * =================================================
 * PUT – Update personal details by employee number
 * =================================================
 */
router.put("/:employeeNumber", async (req, res) => {
  const driver = getDriver();

  if (!driver) {
    console.error("❌ Neo4j driver not available");
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { employeeNumber } = req.params;

  const {
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
    // Auto-pick fields (HR/system may update these via PUT)
    jobTitle,
    employmentStartDate,
    employmentLocation,
    visaType,
    visaEndDate,
    supervisor,
    hr
  } = req.body;

  try {
    console.log(`\n📡 PUT /api/personal-details/${employeeNumber} - Updating`);

    // Check record exists
    const checkResult = await session.run(
      `MATCH (p:PersonalDetails {employeeNumber: $employeeNumber}) RETURN p`,
      { employeeNumber }
    );

    if (checkResult.records.length === 0) {
      console.log(`❌ Personal details for employee ${employeeNumber} not found`);
      return res.status(404).json({ success: false, message: "Personal details not found" });
    }

    const currentData = checkResult.records[0].get("p").properties;

    // Check if new email conflicts with another record
    if (emailId && emailId !== currentData.emailId) {
      const emailCheck = await session.run(
        `MATCH (p:PersonalDetails {emailId: $email}) RETURN p`,
        { email: emailId }
      );
      if (emailCheck.records.length > 0) {
        console.log(`❌ Email ${emailId} already exists`);
        return res.status(400).json({ success: false, message: "Email already exists" });
      }
    }

    // Recalculate full name
    const updatedFirstName  = firstName  || currentData.firstName;
    const updatedMiddleName = middleName !== undefined ? middleName : currentData.middleName;
    const updatedLastName   = lastName   || currentData.lastName;
    const fullName = [updatedFirstName, updatedMiddleName, updatedLastName]
      .filter(n => n && n.trim())
      .join(" ");

    const currentTime = new Date().toISOString();

    const result = await session.run(
      `MATCH (p:PersonalDetails {employeeNumber: $employeeNumber})
       SET
         p.firstName                   = COALESCE($firstName,                   p.firstName),
         p.middleName                  = COALESCE($middleName,                  p.middleName),
         p.lastName                    = COALESCE($lastName,                    p.lastName),
         p.fullName                    = $fullName,
         p.emailId                     = COALESCE($emailId,                     p.emailId),
         p.personalEmailId             = COALESCE($personalEmailId,             p.personalEmailId),
         p.gender                      = COALESCE($gender,                      p.gender),
         p.mobileNumber                = COALESCE($mobileNumber,                p.mobileNumber),
         p.emergencyNumber             = COALESCE($emergencyNumber,             p.emergencyNumber),
         p.aadharNumber                = COALESCE($aadharNumber,                p.aadharNumber),
         p.socialSecurityNumber        = COALESCE($socialSecurityNumber,        p.socialSecurityNumber),
         p.panNumber                   = COALESCE($panNumber,                   p.panNumber),
         p.dateOfBirth                 = COALESCE($dateOfBirth,                 p.dateOfBirth),
         p.nationality                 = COALESCE($nationality,                 p.nationality),
         p.maritalStatus               = COALESCE($maritalStatus,               p.maritalStatus),
         p.currentResidentialAddress   = COALESCE($currentResidentialAddress,   p.currentResidentialAddress),
         p.permanentResidentialAddress = COALESCE($permanentResidentialAddress, p.permanentResidentialAddress),
         p.jobTitle                    = COALESCE($jobTitle,                    p.jobTitle),
         p.employmentStartDate         = COALESCE($employmentStartDate,         p.employmentStartDate),
         p.employmentLocation          = COALESCE($employmentLocation,          p.employmentLocation),
         p.visaType                    = COALESCE($visaType,                    p.visaType),
         p.visaEndDate                 = COALESCE($visaEndDate,                 p.visaEndDate),
         p.supervisor                  = COALESCE($supervisor,                  p.supervisor),
         p.hr                          = COALESCE($hr,                          p.hr),
         p.updatedAt                   = $updatedAt
       RETURN p { ${RETURN_FIELDS} } as personalDetails`,
      {
        employeeNumber,
        firstName:                   firstName                   || null,
        middleName:                  middleName !== undefined     ? middleName  : null,
        lastName:                    lastName                    || null,
        fullName,
        emailId:                     emailId                     || null,
        personalEmailId:             personalEmailId             !== undefined ? personalEmailId             : null,
        gender:                      gender                      || null,
        mobileNumber:                mobileNumber                || null,
        emergencyNumber:             emergencyNumber             !== undefined ? emergencyNumber             : null,
        aadharNumber:                aadharNumber                !== undefined ? aadharNumber                : null,
        socialSecurityNumber:        socialSecurityNumber        !== undefined ? socialSecurityNumber        : null,
        panNumber:                   panNumber                   !== undefined ? panNumber                   : null,
        dateOfBirth:                 dateOfBirth                 || null,
        nationality:                 nationality                 !== undefined ? nationality                 : null,
        maritalStatus:               maritalStatus               !== undefined ? maritalStatus               : null,
        currentResidentialAddress:   currentResidentialAddress   !== undefined ? currentResidentialAddress   : null,
        permanentResidentialAddress: permanentResidentialAddress !== undefined ? permanentResidentialAddress : null,
        jobTitle:                    jobTitle                    !== undefined ? jobTitle                    : null,
        employmentStartDate:         employmentStartDate         !== undefined ? employmentStartDate         : null,
        employmentLocation:          employmentLocation          !== undefined ? employmentLocation          : null,
        visaType:                    visaType                    !== undefined ? visaType                    : null,
        visaEndDate:                 visaEndDate                 !== undefined ? visaEndDate                 : null,
        supervisor:                  supervisor                  !== undefined ? supervisor                  : null,
        hr:                          hr                          !== undefined ? hr                          : null,
        updatedAt:                   currentTime
      }
    );

    console.log(`✅ Updated successfully for employee: ${employeeNumber}`);

    res.json({
      success: true,
      message: "Personal details updated successfully",
      data: result.records[0].get("personalDetails")
    });

  } catch (err) {
    console.error("❌ Error updating personal details:", err);
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