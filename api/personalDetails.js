const express = require("express");
const router = express.Router();
const multer = require('multer');
const getDriver = require("../lib/neo4j");
const googleDrive = require("../services/googleDrive");

const extractDriveFileId = (link) => {
  if (!link) return null;
  if (link.includes('/d/')) {
    return link.split('/d/')[1].split('/')[0];
  } else if (link.includes('id=')) {
    return link.split('id=')[1].split('&')[0];
  }
  return link.split('/').pop();
};




// Add this at the very top, right after the router initialization
router.all("/test-route", (req, res) => {
  res.json({ success: true, message: "Route is working!" });
});

router.get("/test", (req, res) => {
  res.json({ success: true, message: "Personal Details API is working!" });
});

router.get("/validate-unique", async (req, res) => {
  const driver = getDriver();
  if (!driver) {
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { mobileNumber, personalEmailId, employeeNumber, excludeUserId, emailId } = req.query;

  try {
    let conditions = [];
    let params = { excludeUserId: excludeUserId || "" };

    if (mobileNumber) {
      conditions.push(`p.mobileNumber = $mobileNumber`);
      params.mobileNumber = mobileNumber;
    }
    if (personalEmailId) {
      conditions.push(`p.personalEmailId = $personalEmailId`);
      params.personalEmailId = personalEmailId;
    }
    if (employeeNumber) {
      conditions.push(`p.employeeNumber = $employeeNumber`);
      params.employeeNumber = employeeNumber;
    }
    if (emailId) {
      conditions.push(`p.emailId = $emailId`);
      params.emailId = emailId;
    }

    if (conditions.length === 0) {
      return res.json({ success: true, isUnique: true, errors: {} });
    }

    const query = `
      MATCH (p:PersonalDetails) 
      WHERE p.userId <> $excludeUserId AND (${conditions.join(" OR ")})
      RETURN p.mobileNumber as mobile, p.personalEmailId as email, p.employeeNumber as empNo, p.emailId as workEmail
    `;

    const result = await session.run(query, params);
    
    let errors = {};
    if (result.records.length > 0) {
      for (const record of result.records) {
        if (mobileNumber && record.get("mobile") === mobileNumber) errors.mobileNumber = "Mobile Number already exists.";
        if (personalEmailId && record.get("email") === personalEmailId) errors.personalEmailId = "Personal Email already exists.";
        if (employeeNumber && record.get("empNo") === employeeNumber) errors.employeeNumber = "Employee Number already exists.";
        if (emailId && record.get("workEmail") === emailId) errors.emailId = "Work Email already exists.";
      }
    }

    res.json({ success: true, isUnique: Object.keys(errors).length === 0, errors });
  } catch (err) {
    console.error("Error validating uniqueness:", err);
    res.status(500).json({ success: false, message: "Validation error: " + err.message });
  } finally {
    await session.close();
  }
});

router.get("/birthdays", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (p:PersonalDetails)
      WHERE p.dateOfBirth IS NOT NULL
      RETURN p.fullName AS fullName,
             p.employeeNumber AS employeeNumber,
             p.jobTitle AS jobTitle,
             p.profilePhotoLink AS profilePhotoLink,
             p.dateOfBirth AS dateOfBirth,
             p.emailId AS emailId,
             p.supervisor AS supervisor
    `);

    const today = new Date();
    const todayMonth = today.getMonth();
    const todayDate = today.getDate();

    const todayBirthdays = [];
    const upcomingBirthdays = [];

    result.records.forEach((record) => {
      const dobStr = record.get("dateOfBirth");
      if (!dobStr) return;

      const dob = new Date(dobStr);
      if (isNaN(dob.getTime())) return;

      const dobMonth = dob.getMonth();
      const dobDate = dob.getDate();

      const employee = {
        fullName: record.get("fullName"),
        employeeNumber: record.get("employeeNumber"),
        jobTitle: record.get("jobTitle") || "Employee",
        profilePhotoLink: record.get("profilePhotoLink") || null,
        emailId: record.get("emailId") || null,
        supervisor: record.get("supervisor") || null,
      };

      if (dobMonth === todayMonth && dobDate === todayDate) {
        todayBirthdays.push(employee);
      } else {
        // Calculate next birthday date
        let nextBirthdayYear = today.getFullYear();
        if (
          dobMonth < todayMonth ||
          (dobMonth === todayMonth && dobDate < todayDate)
        ) {
          nextBirthdayYear++;
        }
        
        const nextBirthday = new Date(nextBirthdayYear, dobMonth, dobDate);
        
        // Calculate days remaining without time component to avoid timezone issues
        const diffTime = nextBirthday.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
        const daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        upcomingBirthdays.push({
          ...employee,
          daysRemaining,
        });
      }
    });

    upcomingBirthdays.sort((a, b) => a.daysRemaining - b.daysRemaining);

    res.json({
      success: true,
      todayBirthdays,
      upcomingBirthdays,
    });
  } catch (error) {
    console.error("❌ Error fetching birthdays:", error.message);
    res.status(500).json({ success: false, message: "Failed to fetch birthdays" });
  } finally {
    await session.close();
  }
});

const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 1 * 1024 * 1024, // 1MB limit
  },
  fileFilter: (req, file, cb) => {
    // Profile photo must be image only (no PDF)
    if (file.fieldname === 'profilePhoto') {
      const imageTypes = ['image/jpeg', 'image/jpg', 'image/png'];
      if (imageTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Profile photo must be an image (JPG or PNG only, no PDF).'));
      }
    } else {
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Invalid file type. Only JPG, PNG, and PDF are allowed.'));
      }
    }
  },
});

const healthCardUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 1 * 1024 * 1024, // 1MB limit for health cards
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPG, PNG, and PDF are allowed.'));
    }
  },
});

const RETURN_FIELDS = `
  .userId,
  .firstName,
  .middleName,
  .lastName,
  .fullName,
  .emailId,
  .personalEmailId,
  .pid,
  .gender,
  .mobileNumber,
  .emergencyNumber,
  .emergencyRelationship,
  .aadharNumber,
  .aadharDocumentLink,
  .ssnNumber,
  .ssnDocumentLink,
  .nationalId,
  .nationalIdDocumentLink,
  .higherSchoolCertificateLink,
  .panNumber,
  .panDocumentLink,
  .tenthCertificateLink,
  .twelfthCertificateLink,
  .resumeDocumentLink,
  .visaDocumentLink,
  .profilePhotoLink,
  .graduationCertificateLink,
  .postGraduationCertificateLink,
  .skills,
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
  .employeeNumber,
  .assignedCompany,
  .selectedDemand,
  .bankName,
  .bankAccountNumber,
  .ifscCode,
  .bankBranch,
  .createdAt,
  .updatedAt,
  .profileStatus,
  .profileSubmittedAt,
  .profileApprovedAt,
  .profileRejectedAt,
  .profileRejectionReason,
  .healthCardLink,
  .healthCardUploadedAt,
  .experienceType,
  .yearsOfExperience,
  .relievingLetterLink,
  .relievingLetterUploadedAt,
  .relievingLetter1Link,
  .relievingLetter2Link,
  .pfPassbookLink,
  .pfNumber,
  .previousUan,
  .firstTimeEmployment,
  .pfNomineeName,
  .pfNomineeRelationship,
  .previousPayslip1Link,
  .previousPayslip2Link,
  .previousPayslip3Link
`;


router.get("/", async (req, res) => {
  const driver = getDriver();

  if (!driver) {
    console.error("❌ Neo4j driver not available");
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { userId, email, pid, nationality } = req.query;

  try {
    if (userId) {
      const result = await session.run(
        `MATCH (p:PersonalDetails {userId: $userId})
         RETURN p { ${RETURN_FIELDS} } as personalDetails`,
        { userId }
      );

      if (result.records.length === 0) {
        return res.json({
          success: true,
          profileCompleted: false,
          data: null
        });
      }

      const personalDetails = result.records[0].get("personalDetails");

      // Parse skills if it's a string
      if (personalDetails.skills && typeof personalDetails.skills === 'string') {
        try {
          personalDetails.skills = JSON.parse(personalDetails.skills);
        } catch (e) {
          personalDetails.skills = [];
        }
      }

      return res.json({
        success: true,
        profileCompleted: true,
        data: personalDetails
      });
    }

    if (email) {

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

      const personalDetails = result.records[0].get("personalDetails");
      if (personalDetails.skills && typeof personalDetails.skills === 'string') {
        try {
          personalDetails.skills = JSON.parse(personalDetails.skills);
        } catch (e) {
          personalDetails.skills = [];
        }
      }

      return res.json({ success: true, data: personalDetails });
    }

    if (pid) {

      const result = await session.run(
        `MATCH (p:PersonalDetails {pid: $pid})
         RETURN p { ${RETURN_FIELDS} } as personalDetails`,
        { pid }
      );

      if (result.records.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Personal details not found for this PID"
        });
      }

      const personalDetails = result.records[0].get("personalDetails");
      if (personalDetails.skills && typeof personalDetails.skills === 'string') {
        try {
          personalDetails.skills = JSON.parse(personalDetails.skills);
        } catch (e) {
          personalDetails.skills = [];
        }
      }

      return res.json({ success: true, data: personalDetails });
    }

    // Fetch all
    let query = `MATCH (p:PersonalDetails)`;
    let params = {};

    if (nationality) {
      if (nationality.toLowerCase() === 'india') {
        query += ` WHERE toLower(p.nationality) = toLower($nationality) OR p.nationality IS NULL OR p.nationality = ''`;
      } else {
        query += ` WHERE toLower(p.nationality) = toLower($nationality)`;
      }
      params.nationality = nationality;
    }

    query += ` RETURN p { ${RETURN_FIELDS} } as personalDetails ORDER BY p.createdAt DESC`;

    const result = await session.run(query, params);

    const personalDetails = result.records.map(r => {
      const details = r.get("personalDetails");
      if (details.skills && typeof details.skills === 'string') {
        try {
          details.skills = JSON.parse(details.skills);
        } catch (e) {
          details.skills = [];
        }
      }
      return details;
    });


    res.json({ success: true, count: personalDetails.length, data: personalDetails });

  } catch (err) {
    console.error("❌ Error fetching personal details:", err);
    res.status(500).json({ success: false, message: "Database error: " + err.message });
  } finally {
    await session.close();
  }
});





router.post("/", (req, res, next) => {
  const uploadMiddleware = upload.fields([
    { name: 'aadharDocument', maxCount: 1 },
    { name: 'panDocument', maxCount: 1 },
    { name: 'nationalIdDocument', maxCount: 1 },
    { name: 'higherSchoolCertificate', maxCount: 1 },
    { name: 'tenthCertificate', maxCount: 1 },
    { name: 'twelfthCertificate', maxCount: 1 },
    { name: 'resumeDocument', maxCount: 1 },
    { name: 'visaDocument', maxCount: 1 },
    { name: 'profilePhoto', maxCount: 1 },
    { name: 'graduationCertificate', maxCount: 1 },
    { name: 'postGraduationCertificate', maxCount: 1 },
    { name: 'relievingLetter1', maxCount: 1 },
    { name: 'relievingLetter2', maxCount: 1 },
    { name: 'pfPassbook', maxCount: 1 },
    { name: 'ssnDocument', maxCount: 1 },
    { name: 'previousPayslip1', maxCount: 1 },
    { name: 'previousPayslip2', maxCount: 1 },
    { name: 'previousPayslip3', maxCount: 1 }
  ]);

 uploadMiddleware(req, res, (err) => {
    if (err) {
     
      return res.status(400).json({ 
        success: false, 
        message: err.message,
        field: err.field  // This will tell you which field is the problem
      });
    }
    next();
  });
}, async (req, res) => {
  const driver = getDriver();
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
    emergencyRelationship,
    aadharNumber,
    ssnNumber,
    nationalId,
    panNumber,
    dateOfBirth,
    nationality,
    maritalStatus,
    employeeNumber,
    assignedCompany,
    selectedDemand,
    currentResidentialAddress,
    permanentResidentialAddress,
    city,
    state,
    jobTitle,
    employmentStartDate,
    employmentLocation,
    visaType,
    visaEndDate,
    supervisor,
    hr,
    skills,
    bankName,
    bankAccountNumber,
    ifscCode,
    bankBranch,
    pfNumber,
    previousUan,
    firstTimeEmployment,
    pfNomineeName,
    pfNomineeRelationship
  } = req.body;

  const files = req.files || {};
  const aadharDocumentFile = files?.aadharDocument?.[0];
  const panFile = files?.panDocument?.[0];
  const nationalIdDocFile = files?.nationalIdDocument?.[0];
  const higherSchoolCertFile = files?.higherSchoolCertificate?.[0];
  const ssnDocFile = files?.ssnDocument?.[0];
  const tenthCertFile = files?.tenthCertificate?.[0];
  const twelfthCertFile = files?.twelfthCertificate?.[0];
  const resumeFile = files?.resumeDocument?.[0];
  const visaDocFile = files?.visaDocument?.[0];
  const profilePhotoFile = files?.profilePhoto?.[0];
  const graduationCertFile = files?.graduationCertificate?.[0];
  const postGraduationCertFile = files?.postGraduationCertificate?.[0];
  const relievingLetter1File = files?.relievingLetter1?.[0];
  const relievingLetter2File = files?.relievingLetter2?.[0];
  const pfPassbookFile = files?.pfPassbook?.[0];
  const previousPayslip1File = files?.previousPayslip1?.[0];
  const previousPayslip2File = files?.previousPayslip2?.[0];
  const previousPayslip3File = files?.previousPayslip3?.[0];

  try {

    if (!userId || !nationality) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: userId or nationality"
      });
    }

    // Check if profile already exists
    const checkResult = await session.run(
      `MATCH (p:PersonalDetails {userId: $userId}) RETURN p`,
      { userId }
    );

    if (checkResult.records.length > 0) {
      return res.status(403).json({
        success: false,
        message: "Profile already submitted. You cannot submit again."
      });
    }

    // Check for duplicates
    let duplicateConditions = [];
    let duplicateParams = { userId: userId || "" };
    if (mobileNumber) { duplicateConditions.push(`p.mobileNumber = $mobileNumber`); duplicateParams.mobileNumber = mobileNumber; }
    if (personalEmailId) { duplicateConditions.push(`p.personalEmailId = $personalEmailId`); duplicateParams.personalEmailId = personalEmailId; }
    if (employeeNumber) { duplicateConditions.push(`p.employeeNumber = $employeeNumber`); duplicateParams.employeeNumber = employeeNumber; }
    if (emailId) { duplicateConditions.push(`p.emailId = $emailId`); duplicateParams.emailId = emailId; }

    if (duplicateConditions.length > 0) {
      const duplicateCheckResult = await session.run(
        `MATCH (p:PersonalDetails) WHERE p.userId <> $userId AND (${duplicateConditions.join(" OR ")})
         RETURN p.mobileNumber as mobile, p.personalEmailId as email, p.employeeNumber as empNo, p.emailId as workEmail`,
        duplicateParams
      );
      if (duplicateCheckResult.records.length > 0) {
        let errorMsg = [];
        for (const record of duplicateCheckResult.records) {
          if (mobileNumber && record.get("mobile") === mobileNumber) errorMsg.push("Mobile Number already exists.");
          if (personalEmailId && record.get("email") === personalEmailId) errorMsg.push("Personal Email already exists.");
          if (employeeNumber && record.get("empNo") === employeeNumber) errorMsg.push("Employee Number already exists.");
          if (emailId && record.get("workEmail") === emailId) errorMsg.push("Work Email already exists.");
        }
        return res.status(400).json({ success: false, message: [...new Set(errorMsg)].join(" ") });
      }
    }

    // Upload Aadhar document to Google Drive
    let aadharDocumentLink = null;
    if (aadharDocumentFile) {
      const uploadResult = await googleDrive.uploadAadharImage(
        aadharDocumentFile.buffer,
        aadharDocumentFile.originalname,
        aadharDocumentFile.mimetype,
        userId,
        'document'
      );
      if (uploadResult.success) {
        aadharDocumentLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({
          success: false,
          message: "Failed to upload Aadhar document",
          error: uploadResult.error
        });
      }
    }

    // Upload National ID document to Google Drive
    let nationalIdDocumentLink = null;
    if (nationalIdDocFile) {
      const uploadResult = await googleDrive.uploadNationalIdDocument(
        nationalIdDocFile.buffer,
        nationalIdDocFile.originalname,
        nationalIdDocFile.mimetype,
        userId
      );
      if (uploadResult.success) {
        nationalIdDocumentLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({
          success: false,
          message: "Failed to upload National ID document",
          error: uploadResult.error
        });
      }
    }

    // Upload Higher School Certificate to Google Drive
    let higherSchoolCertificateLink = null;
    if (higherSchoolCertFile) {
      const uploadResult = await googleDrive.uploadHigherSchoolCertificate(
        higherSchoolCertFile.buffer,
        higherSchoolCertFile.originalname,
        higherSchoolCertFile.mimetype,
        userId
      );
      if (uploadResult.success) {
        higherSchoolCertificateLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({
          success: false,
          message: "Failed to upload Higher School Certificate",
          error: uploadResult.error
        });
      }
    }

    // Upload SSN document to Google Drive
    let ssnDocumentLink = null;
    if (ssnDocFile) {
      const uploadResult = await googleDrive.uploadSsnDocument(
        ssnDocFile.buffer,
        ssnDocFile.originalname,
        ssnDocFile.mimetype,
        userId
      );
      if (uploadResult.success) {
        ssnDocumentLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({
          success: false,
          message: "Failed to upload SSN document",
          error: uploadResult.error
        });
      }
    }

    // Upload PAN document to Google Drive
    let panLink = null;
    if (panFile) {
      const uploadResult = await googleDrive.uploadPanImage(
        panFile.buffer,
        panFile.originalname,
        panFile.mimetype,
        userId
      );
      if (uploadResult.success) {
        panLink = uploadResult.viewLink;
      } else {
        if (aadharDocumentLink) {
          const fileId = extractDriveFileId(aadharDocumentLink);
          await googleDrive.deleteCandidateImage(fileId);
        }
        return res.status(500).json({
          success: false,
          message: "Failed to upload PAN document",
          error: uploadResult.error
        });
      }
    }

    // Upload 10th Certificate to Google Drive
    let tenthCertificateLink = null;
    if (tenthCertFile) {
      const uploadResult = await googleDrive.uploadTenthCertificate(
        tenthCertFile.buffer, tenthCertFile.originalname, tenthCertFile.mimetype, userId
      );
      if (uploadResult.success) {
        tenthCertificateLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({ success: false, message: "Failed to upload 10th Certificate", error: uploadResult.error });
      }
    }

    // Upload 12th Certificate to Google Drive
    let twelfthCertificateLink = null;
    if (twelfthCertFile) {
      const uploadResult = await googleDrive.uploadTwelfthCertificate(
        twelfthCertFile.buffer, twelfthCertFile.originalname, twelfthCertFile.mimetype, userId
      );
      if (uploadResult.success) {
        twelfthCertificateLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({ success: false, message: "Failed to upload 12th Certificate", error: uploadResult.error });
      }
    }

    // Upload Resume to Google Drive
    let resumeDocumentLink = null;
    if (resumeFile) {
      const uploadResult = await googleDrive.uploadResume(
        resumeFile.buffer, resumeFile.originalname, resumeFile.mimetype, userId
      );
      if (uploadResult.success) {
        resumeDocumentLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({ success: false, message: "Failed to upload Resume", error: uploadResult.error });
      }
    }

    // Upload Visa Document to Google Drive
    let visaDocumentLink = null;
    if (visaDocFile) {
      const uploadResult = await googleDrive.uploadVisaDocument(
        visaDocFile.buffer, visaDocFile.originalname, visaDocFile.mimetype, userId
      );
      if (uploadResult.success) {
        visaDocumentLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({ success: false, message: "Failed to upload Visa Document", error: uploadResult.error });
      }
    }

    // Upload Profile Photo to Google Drive
    let profilePhotoLink = null;
    if (profilePhotoFile) {
      const uploadResult = await googleDrive.uploadProfilePhoto(
        profilePhotoFile.buffer, profilePhotoFile.originalname, profilePhotoFile.mimetype, userId
      );
      if (uploadResult.success) {
        profilePhotoLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({ success: false, message: "Failed to upload Profile Photo", error: uploadResult.error });
      }
    }

    // Upload Graduation Certificate to Google Drive
    let graduationCertificateLink = null;
    if (graduationCertFile) {
      const uploadResult = await googleDrive.uploadGraduationCertificate(
        graduationCertFile.buffer, graduationCertFile.originalname, graduationCertFile.mimetype, userId
      );
      if (uploadResult.success) {
        graduationCertificateLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({ success: false, message: "Failed to upload Graduation Certificate", error: uploadResult.error });
      }
    }

    // Upload Post Graduation Certificate to Google Drive
    let postGraduationCertificateLink = null;
    if (postGraduationCertFile) {
      const uploadResult = await googleDrive.uploadPostGraduationCertificate(
        postGraduationCertFile.buffer, postGraduationCertFile.originalname, postGraduationCertFile.mimetype, userId
      );
      if (uploadResult.success) {
        postGraduationCertificateLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({ success: false, message: "Failed to upload Post Graduation Certificate", error: uploadResult.error });
      }
    }

    let relievingLetter1Link = null;
    if (relievingLetter1File) {
      const uploadResult = await googleDrive.uploadRelievingLetter1(
        relievingLetter1File.buffer, relievingLetter1File.originalname, relievingLetter1File.mimetype, userId
      );
      if (uploadResult.success) {
        relievingLetter1Link = uploadResult.viewLink;
      }
    }
    
    let relievingLetter2Link = null;
    if (relievingLetter2File) {
      const uploadResult = await googleDrive.uploadRelievingLetter2(
        relievingLetter2File.buffer, relievingLetter2File.originalname, relievingLetter2File.mimetype, userId
      );
      if (uploadResult.success) {
        relievingLetter2Link = uploadResult.viewLink;
      }
    }

    let pfPassbookLink = null;
    if (pfPassbookFile) {
      const uploadResult = await googleDrive.uploadPfPassbook(
        pfPassbookFile.buffer, pfPassbookFile.originalname, pfPassbookFile.mimetype, userId
      );
      if (uploadResult.success) {
        pfPassbookLink = uploadResult.viewLink;
      }
    }

    let previousPayslip1Link = null;
    if (previousPayslip1File) {
      const uploadResult = await googleDrive.uploadPreviousPayslip1(
        previousPayslip1File.buffer, previousPayslip1File.originalname, previousPayslip1File.mimetype, userId
      );
      if (uploadResult.success) {
        previousPayslip1Link = uploadResult.viewLink;
      }
    }

    let previousPayslip2Link = null;
    if (previousPayslip2File) {
      const uploadResult = await googleDrive.uploadPreviousPayslip2(
        previousPayslip2File.buffer, previousPayslip2File.originalname, previousPayslip2File.mimetype, userId
      );
      if (uploadResult.success) {
        previousPayslip2Link = uploadResult.viewLink;
      }
    }

    let previousPayslip3Link = null;
    if (previousPayslip3File) {
      const uploadResult = await googleDrive.uploadPreviousPayslip3(
        previousPayslip3File.buffer, previousPayslip3File.originalname, previousPayslip3File.mimetype, userId
      );
      if (uploadResult.success) {
        previousPayslip3Link = uploadResult.viewLink;
      }
    }

    // Generate full name
    const fullName = [firstName, middleName, lastName]
      .filter(n => n && n.trim())
      .join(" ");

    const currentTime = new Date().toISOString();

    // Generate sequential PID
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

    const sequentialNumber = String(count + 1).padStart(3, '0');
    const pidToUse = sequentialNumber;


    // Parse skills if it's a string
    let parsedSkills = skills;
    if (typeof skills === 'string') {
      try {
        parsedSkills = JSON.parse(skills);
      } catch (e) {
        parsedSkills = [];
      }
    }
    if (!parsedSkills) parsedSkills = [];

    // Create new PersonalDetails record
    const result = await session.run(
      `CREATE (p:PersonalDetails {
        userId: $userId,
        firstName: $firstName,
        middleName: $middleName,
        lastName: $lastName,
        fullName: $fullName,
        emailId: $emailId,
        personalEmailId: $personalEmailId,
        pid: $pid,
        gender: $gender,
        mobileNumber: $mobileNumber,
        emergencyNumber: $emergencyNumber,
        emergencyRelationship: $emergencyRelationship,
        aadharNumber: $aadharNumber,
        aadharDocumentLink: $aadharDocumentLink,
        ssnNumber: $ssnNumber,
        ssnDocumentLink: $ssnDocumentLink,
        nationalId: $nationalId,
        nationalIdDocumentLink: $nationalIdDocumentLink,
        higherSchoolCertificateLink: $higherSchoolCertificateLink,
        panNumber: $panNumber,
        panDocumentLink: $panDocumentLink,
        tenthCertificateLink: $tenthCertificateLink,
        twelfthCertificateLink: $twelfthCertificateLink,
        resumeDocumentLink: $resumeDocumentLink,
        visaDocumentLink: $visaDocumentLink,
        profilePhotoLink: $profilePhotoLink,
        graduationCertificateLink: $graduationCertificateLink,
        postGraduationCertificateLink: $postGraduationCertificateLink,
        skills: $skills,
        dateOfBirth: $dateOfBirth,
        nationality: $nationality,
        maritalStatus: $maritalStatus,
        currentResidentialAddress: $currentResidentialAddress,
        permanentResidentialAddress: $permanentResidentialAddress,
        city: $city,
        state: $state,
        jobTitle: $jobTitle,
        employeeNumber: $employeeNumber,
        assignedCompany: $assignedCompany,
        selectedDemand: $selectedDemand,
        employmentStartDate: $employmentStartDate,
        employmentLocation: $employmentLocation,
        visaType: $visaType,
        visaEndDate: $visaEndDate,
        supervisor: $supervisor,
        hr: $hr,
        bankName: $bankName,
        bankAccountNumber: $bankAccountNumber,
        ifscCode: $ifscCode,
        bankBranch: $bankBranch,
        relievingLetter1Link: $relievingLetter1Link,
        relievingLetter2Link: $relievingLetter2Link,
        pfPassbookLink: $pfPassbookLink,
        pfNumber: $pfNumber,
        previousUan: $previousUan,
        firstTimeEmployment: $firstTimeEmployment,
        pfNomineeName: $pfNomineeName,
        pfNomineeRelationship: $pfNomineeRelationship,
        previousPayslip1Link: $previousPayslip1Link,
        previousPayslip2Link: $previousPayslip2Link,
        previousPayslip3Link: $previousPayslip3Link,
        createdAt: $createdAt,
        updatedAt: $updatedAt,
        profileStatus: 'PENDING',
        profileSubmittedAt: $submittedAt
      })
      RETURN p { ${RETURN_FIELDS} } as personalDetails`,
      {
        userId,
        firstName,
        middleName: middleName || "",
        lastName,
        fullName,
        emailId: emailId || "",
        personalEmailId: personalEmailId || "",
        pid: pidToUse,
        gender,
        mobileNumber,
        emergencyNumber: emergencyNumber || "",
        emergencyRelationship: emergencyRelationship || "",
        aadharNumber: aadharNumber || "",
        aadharDocumentLink: aadharDocumentLink || null,
        ssnNumber: ssnNumber || "",
        ssnDocumentLink: ssnDocumentLink || null,
        nationalId: nationalId || "",
        nationalIdDocumentLink: nationalIdDocumentLink || null,
        higherSchoolCertificateLink: higherSchoolCertificateLink || null,
        panNumber: panNumber || "",
        panDocumentLink: panLink || null,
        tenthCertificateLink: tenthCertificateLink || null,
        twelfthCertificateLink: twelfthCertificateLink || null,
        resumeDocumentLink: resumeDocumentLink || null,
        visaDocumentLink: visaDocumentLink || null,
        profilePhotoLink: profilePhotoLink || null,
        graduationCertificateLink: graduationCertificateLink || null,
        postGraduationCertificateLink: postGraduationCertificateLink || null,
        skills: JSON.stringify(parsedSkills),
        dateOfBirth,
        nationality: nationality || "",
        maritalStatus: maritalStatus || "",
        currentResidentialAddress: currentResidentialAddress || "",
        permanentResidentialAddress: permanentResidentialAddress || "",
        city: city || "",
        state: state || "",
        jobTitle: jobTitle || "",
        employeeNumber: employeeNumber || "",
        assignedCompany: assignedCompany || "",
        selectedDemand: selectedDemand || "",
        employmentStartDate: employmentStartDate || "",
        employmentLocation: employmentLocation || "",
        visaType: visaType || "",
        visaEndDate: visaEndDate || "",
        supervisor: supervisor || "",
        hr: hr || "",
        bankName: bankName || "",
        bankAccountNumber: bankAccountNumber || "",
        ifscCode: ifscCode || "",
        bankBranch: bankBranch || "",
        relievingLetter1Link: relievingLetter1Link || null,
        relievingLetter2Link: relievingLetter2Link || null,
        pfPassbookLink: pfPassbookLink || null,
        pfNumber: pfNumber || "",
        previousUan: previousUan || "",
        firstTimeEmployment: firstTimeEmployment || "",
        pfNomineeName: pfNomineeName || "",
        pfNomineeRelationship: pfNomineeRelationship || "",
        previousPayslip1Link: previousPayslip1Link || null,
        previousPayslip2Link: previousPayslip2Link || null,
        previousPayslip3Link: previousPayslip3Link || null,
        createdAt: currentTime,
        updatedAt: currentTime,
        submittedAt: currentTime
      }
    );

    // Update User node with the generated PID
    await session.run(
      `MATCH (u:User {username: $userId})
       SET u.pid = $pid`,
      { userId, pid: pidToUse }
    );

    // Create notification for Admin
    const adminMessage = `New Personal Details submitted by ${firstName} ${lastName || ''} (${userId}).`;
    await session.run(
      `MATCH (admin:User {role: 'Admin'})
       CREATE (n:Notification {
         id: randomUUID(),
         userId: admin.username,
         type: "PERSONAL_DETAILS_SUBMISSION",
         message: $message,
         isRead: false,
         createdAt: $currentTime
       })`,
      { message: adminMessage, currentTime }
    );


    return res.status(201).json({
      success: true,
      message: "Personal details submitted successfully",
      data: result.records[0].get("personalDetails"),
      pid: pidToUse,
      aadharDocumentLink: aadharDocumentLink,
      nationalIdDocumentLink: nationalIdDocumentLink,
      panDocumentLink: panLink,
      tenthCertificateLink: tenthCertificateLink,
      twelfthCertificateLink: twelfthCertificateLink,
      resumeDocumentLink: resumeDocumentLink,
      visaDocumentLink: visaDocumentLink,
      profilePhotoLink: profilePhotoLink,
      graduationCertificateLink: graduationCertificateLink,
      postGraduationCertificateLink: postGraduationCertificateLink
    });

  } catch (err) {
    console.error("Error stack:", err.stack);
    res.status(500).json({ success: false, message: "Database error: " + err.message });
  } finally {
    await session.close();
  }
});

router.put("/resubmit/:userId", (req, res, next) => {
  const uploadMiddleware = upload.fields([
    { name: 'aadharDocument', maxCount: 1 },
    { name: 'panDocument', maxCount: 1 },
    { name: 'nationalIdDocument', maxCount: 1 },
    { name: 'higherSchoolCertificate', maxCount: 1 },
    { name: 'tenthCertificate', maxCount: 1 },
    { name: 'twelfthCertificate', maxCount: 1 },
    { name: 'resumeDocument', maxCount: 1 },
    { name: 'visaDocument', maxCount: 1 },
    { name: 'profilePhoto', maxCount: 1 },
    { name: 'graduationCertificate', maxCount: 1 },
    { name: 'postGraduationCertificate', maxCount: 1 },
    { name: 'relievingLetter1', maxCount: 1 },
    { name: 'relievingLetter2', maxCount: 1 },
    { name: 'pfPassbook', maxCount: 1 },
    { name: 'ssnDocument', maxCount: 1 },
    { name: 'previousPayslip1', maxCount: 1 },
    { name: 'previousPayslip2', maxCount: 1 },
    { name: 'previousPayslip3', maxCount: 1 }
  ]);

  uploadMiddleware(req, res, (err) => {
    if (err) {
      console.log("⚠️ Multer warning:", err.message);
    }
    next();
  });
}, async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { userId } = req.params;

  const {
    firstName, middleName, lastName, emailId, personalEmailId,
    gender, mobileNumber, emergencyNumber, emergencyRelationship, aadharNumber,
    ssnNumber, nationalId, passportNumber, drivingLicense, panNumber, dateOfBirth, nationality,
    maritalStatus, employeeNumber, assignedCompany, selectedDemand,
    currentResidentialAddress, permanentResidentialAddress,
    city, state, jobTitle, employmentStartDate, employmentLocation,
    visaType, visaEndDate, supervisor, hr, skills,
    bankName, bankAccountNumber, ifscCode, bankBranch,
    pfNumber, previousUan, firstTimeEmployment, pfNomineeName, pfNomineeRelationship
  } = req.body;

  const files = req.files || {};
  const aadharDocumentFile = files?.aadharDocument?.[0];
  const panFile = files?.panDocument?.[0];
  const nationalIdDocFile = files?.nationalIdDocument?.[0];
  const higherSchoolCertFile = files?.higherSchoolCertificate?.[0];
  const ssnDocFile = files?.ssnDocument?.[0];
  const tenthCertFile = files?.tenthCertificate?.[0];
  const twelfthCertFile = files?.twelfthCertificate?.[0];
  const resumeFile = files?.resumeDocument?.[0];
  const visaDocFile = files?.visaDocument?.[0];
  const profilePhotoFile = files?.profilePhoto?.[0];
  const graduationCertFile = files?.graduationCertificate?.[0];
  const postGraduationCertFile = files?.postGraduationCertificate?.[0];
  const relievingLetter1File = files?.relievingLetter1?.[0];
  const relievingLetter2File = files?.relievingLetter2?.[0];
  const pfPassbookFile = files?.pfPassbook?.[0];
  const previousPayslip1File = files?.previousPayslip1?.[0];
  const previousPayslip2File = files?.previousPayslip2?.[0];
  const previousPayslip3File = files?.previousPayslip3?.[0];

  try {
    if (!userId || !nationality) {
      return res.status(400).json({ success: false, message: "Missing required fields: userId or nationality" });
    }

    // Check that user's profile status is REJECTED
    const userCheck = await session.run(
      `MATCH (p:PersonalDetails {userId: $userId}) RETURN p`,
      { userId }
    );

    if (userCheck.records.length === 0) {
      return res.status(404).json({ success: false, message: "Profile not found" });
    }

    const pProps = userCheck.records[0].get("p").properties;
    const currentStatus = pProps.profileStatus;
    
    // Preserve old document links
    let oldAadharDocumentLink = pProps.aadharDocumentLink || null;
    let oldNationalIdDocumentLink = pProps.nationalIdDocumentLink || null;
    let oldHigherSchoolCertificateLink = pProps.higherSchoolCertificateLink || null;
    let oldSsnDocumentLink = pProps.ssnDocumentLink || null;
    let oldPanLink = pProps.panDocumentLink || null;
    let oldTenthCertLink = pProps.tenthCertificateLink || null;
    let oldTwelfthCertLink = pProps.twelfthCertificateLink || null;
    let oldResumeLink = pProps.resumeDocumentLink || null;
    let oldVisaDocLink = pProps.visaDocumentLink || null;
    let oldProfilePhotoLink = pProps.profilePhotoLink || null;
    let oldGraduationCertLink = pProps.graduationCertificateLink || null;
    let oldPostGraduationCertLink = pProps.postGraduationCertificateLink || null;
    let oldRelievingLetter1Link = pProps.relievingLetter1Link || null;
    let oldRelievingLetter2Link = pProps.relievingLetter2Link || null;
    let oldPfPassbookLink = pProps.pfPassbookLink || null;
    let oldPreviousPayslip1Link = pProps.previousPayslip1Link || null;
    let oldPreviousPayslip2Link = pProps.previousPayslip2Link || null;
    let oldPreviousPayslip3Link = pProps.previousPayslip3Link || null;

    // Preserve Admin-allocated fields that the employee form doesn't send
    const adminJobTitle = pProps.jobTitle || "";
    const adminEmployeeNumber = pProps.employeeNumber || "";
    const adminAssignedCompany = pProps.assignedCompany || "";
    const adminSelectedDemand = pProps.selectedDemand || "";
    const adminEmploymentStartDate = pProps.employmentStartDate || "";
    const adminEmploymentLocation = pProps.employmentLocation || "";
    const adminVisaType = pProps.visaType || "";
    const adminVisaEndDate = pProps.visaEndDate || "";
    const adminSupervisor = pProps.supervisor || "";
    const adminHr = pProps.hr || "";

    if (currentStatus && currentStatus !== 'REJECTED') {
      return res.status(403).json({
        success: false,
        message: "Resubmission is only allowed for rejected profiles."
      });
    }

    // Check for duplicates
    let duplicateConditions = [];
    let duplicateParams = { userId: userId || "" };
    if (mobileNumber) { duplicateConditions.push(`p.mobileNumber = $mobileNumber`); duplicateParams.mobileNumber = mobileNumber; }
    if (personalEmailId) { duplicateConditions.push(`p.personalEmailId = $personalEmailId`); duplicateParams.personalEmailId = personalEmailId; }
    if (employeeNumber) { duplicateConditions.push(`p.employeeNumber = $employeeNumber`); duplicateParams.employeeNumber = employeeNumber; }

    if (duplicateConditions.length > 0) {
      const duplicateCheckResult = await session.run(
        `MATCH (p:PersonalDetails) WHERE p.userId <> $userId AND (${duplicateConditions.join(" OR ")})
         RETURN p.mobileNumber as mobile, p.personalEmailId as email, p.employeeNumber as empNo`,
        duplicateParams
      );
      if (duplicateCheckResult.records.length > 0) {
        let errorMsg = [];
        for (const record of duplicateCheckResult.records) {
          if (mobileNumber && record.get("mobile") === mobileNumber) errorMsg.push("Mobile Number already exists.");
          if (personalEmailId && record.get("email") === personalEmailId) errorMsg.push("Personal Email already exists.");
          if (employeeNumber && record.get("empNo") === employeeNumber) errorMsg.push("Employee Number already exists.");
        }
        return res.status(400).json({ success: false, message: [...new Set(errorMsg)].join(" ") });
      }
    }

    // Upload new Aadhar Document if provided
    let aadharDocumentLink = oldAadharDocumentLink;
    if (aadharDocumentFile) {
      if (oldAadharDocumentLink) {
        const oldFileId = extractDriveFileId(oldAadharDocumentLink);
        await googleDrive.deleteCandidateImage(oldFileId);
      }

      const uploadResult = await googleDrive.uploadAadharImage(
        aadharDocumentFile.buffer,
        aadharDocumentFile.originalname,
        aadharDocumentFile.mimetype,
        userId,
        'document'
      );
      if (uploadResult.success) {
        aadharDocumentLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({
          success: false,
          message: "Failed to upload Aadhar document",
          error: uploadResult.error
        });
      }
    }

    // Upload new National ID Document if provided
    let nationalIdDocumentLink = oldNationalIdDocumentLink;
    if (nationalIdDocFile) {
      if (oldNationalIdDocumentLink) {
        const oldFileId = extractDriveFileId(oldNationalIdDocumentLink);
        await googleDrive.deleteFileFromDrive(oldFileId);
      }

      const uploadResult = await googleDrive.uploadNationalIdDocument(
        nationalIdDocFile.buffer,
        nationalIdDocFile.originalname,
        nationalIdDocFile.mimetype,
        userId
      );
      if (uploadResult.success) {
        nationalIdDocumentLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({
          success: false,
          message: "Failed to upload National ID document",
          error: uploadResult.error
        });
      }
    }

    // Upload new Higher School Certificate if provided
    let higherSchoolCertificateLink = oldHigherSchoolCertificateLink;
    if (higherSchoolCertFile) {
      if (oldHigherSchoolCertificateLink) {
        const oldFileId = extractDriveFileId(oldHigherSchoolCertificateLink);
        if (oldFileId) await googleDrive.deleteFileFromDrive(oldFileId);
      }

      const uploadResult = await googleDrive.uploadHigherSchoolCertificate(
        higherSchoolCertFile.buffer,
        higherSchoolCertFile.originalname,
        higherSchoolCertFile.mimetype,
        userId
      );
      if (uploadResult.success) {
        higherSchoolCertificateLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({
          success: false,
          message: "Failed to upload Higher School Certificate",
          error: uploadResult.error
        });
      }
    }

    // Upload new SSN Document if provided
    let ssnDocumentLink = oldSsnDocumentLink;
    if (ssnDocFile) {
      if (oldSsnDocumentLink) {
        const oldFileId = extractDriveFileId(oldSsnDocumentLink);
        await googleDrive.deleteFileFromDrive(oldFileId);
      }

      const uploadResult = await googleDrive.uploadSsnDocument(
        ssnDocFile.buffer,
        ssnDocFile.originalname,
        ssnDocFile.mimetype,
        userId
      );
      if (uploadResult.success) {
        ssnDocumentLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({
          success: false,
          message: "Failed to upload SSN document",
          error: uploadResult.error
        });
      }
    }

    // Upload new PAN document if provided
    let panLink = oldPanLink;
    if (panFile) {
      if (oldPanLink) {
        const oldFileId = extractDriveFileId(oldPanLink);
        await googleDrive.deleteCandidateImage(oldFileId);
      }

      const uploadResult = await googleDrive.uploadPanImage(
        panFile.buffer,
        panFile.originalname,
        panFile.mimetype,
        userId
      );
      if (uploadResult.success) {
        panLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({
          success: false,
          message: "Failed to upload PAN document",
          error: uploadResult.error
        });
      }
    }

    // Upload new 10th Certificate if provided
    let tenthCertificateLink = oldTenthCertLink;
    if (tenthCertFile) {
      if (oldTenthCertLink) {
        const oldFileId = extractDriveFileId(oldTenthCertLink);
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadTenthCertificate(
        tenthCertFile.buffer, tenthCertFile.originalname, tenthCertFile.mimetype, userId
      );
      if (uploadResult.success) { tenthCertificateLink = uploadResult.viewLink; }
      else { return res.status(500).json({ success: false, message: "Failed to upload 10th Certificate", error: uploadResult.error }); }
    }

    // Upload new 12th Certificate if provided
    let twelfthCertificateLink = oldTwelfthCertLink;
    if (twelfthCertFile) {
      if (oldTwelfthCertLink) {
        const oldFileId = extractDriveFileId(oldTwelfthCertLink);
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadTwelfthCertificate(
        twelfthCertFile.buffer, twelfthCertFile.originalname, twelfthCertFile.mimetype, userId
      );
      if (uploadResult.success) { twelfthCertificateLink = uploadResult.viewLink; }
      else { return res.status(500).json({ success: false, message: "Failed to upload 12th Certificate", error: uploadResult.error }); }
    }

    // Upload new Resume if provided
    let resumeDocumentLink = oldResumeLink;
    if (resumeFile) {
      if (oldResumeLink) {
        const oldFileId = extractDriveFileId(oldResumeLink);
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadResume(
        resumeFile.buffer, resumeFile.originalname, resumeFile.mimetype, userId
      );
      if (uploadResult.success) { resumeDocumentLink = uploadResult.viewLink; }
      else { return res.status(500).json({ success: false, message: "Failed to upload Resume", error: uploadResult.error }); }
    }

    // Upload new Visa Document if provided
    let visaDocumentLink = oldVisaDocLink;
    if (visaDocFile) {
      if (oldVisaDocLink) {
        const oldFileId = extractDriveFileId(oldVisaDocLink);
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadVisaDocument(
        visaDocFile.buffer, visaDocFile.originalname, visaDocFile.mimetype, userId
      );
      if (uploadResult.success) { visaDocumentLink = uploadResult.viewLink; }
      else { return res.status(500).json({ success: false, message: "Failed to upload Visa Document", error: uploadResult.error }); }
    }

    // Upload new Profile Photo if provided
    let profilePhotoLink = oldProfilePhotoLink;
    if (profilePhotoFile) {
      if (oldProfilePhotoLink) {
        const oldFileId = extractDriveFileId(oldProfilePhotoLink);
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadProfilePhoto(
        profilePhotoFile.buffer, profilePhotoFile.originalname, profilePhotoFile.mimetype, userId
      );
      if (uploadResult.success) { profilePhotoLink = uploadResult.viewLink; }
      else { return res.status(500).json({ success: false, message: "Failed to upload Profile Photo", error: uploadResult.error }); }
    }

    // Upload new Graduation Certificate if provided
    let graduationCertificateLink = oldGraduationCertLink;
    if (graduationCertFile) {
      if (oldGraduationCertLink) {
        const oldFileId = extractDriveFileId(oldGraduationCertLink);
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadGraduationCertificate(
        graduationCertFile.buffer, graduationCertFile.originalname, graduationCertFile.mimetype, userId
      );
      if (uploadResult.success) { graduationCertificateLink = uploadResult.viewLink; }
      else { return res.status(500).json({ success: false, message: "Failed to upload Graduation Certificate", error: uploadResult.error }); }
    }

    // Upload new Post Graduation Certificate if provided
    let postGraduationCertificateLink = oldPostGraduationCertLink;
    if (postGraduationCertFile) {
      if (oldPostGraduationCertLink) {
        const oldFileId = extractDriveFileId(oldPostGraduationCertLink);
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadPostGraduationCertificate(
        postGraduationCertFile.buffer, postGraduationCertFile.originalname, postGraduationCertFile.mimetype, userId
      );
      if (uploadResult.success) { postGraduationCertificateLink = uploadResult.viewLink; }
      else { return res.status(500).json({ success: false, message: "Failed to upload Post Graduation Certificate", error: uploadResult.error }); }
    }

    let relievingLetter1Link = oldRelievingLetter1Link;
    if (relievingLetter1File) {
      if (oldRelievingLetter1Link) {
        const oldFileId = extractDriveFileId(oldRelievingLetter1Link);
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadRelievingLetter1(
        relievingLetter1File.buffer, relievingLetter1File.originalname, relievingLetter1File.mimetype, userId
      );
      if (uploadResult.success) { relievingLetter1Link = uploadResult.viewLink; }
    }
    
    let relievingLetter2Link = oldRelievingLetter2Link;
    if (relievingLetter2File) {
      if (oldRelievingLetter2Link) {
        const oldFileId = extractDriveFileId(oldRelievingLetter2Link);
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadRelievingLetter2(
        relievingLetter2File.buffer, relievingLetter2File.originalname, relievingLetter2File.mimetype, userId
      );
      if (uploadResult.success) { relievingLetter2Link = uploadResult.viewLink; }
    }

    let pfPassbookLink = oldPfPassbookLink;
    if (pfPassbookFile) {
      if (oldPfPassbookLink) {
        const oldFileId = extractDriveFileId(oldPfPassbookLink);
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadPfPassbook(
        pfPassbookFile.buffer, pfPassbookFile.originalname, pfPassbookFile.mimetype, userId
      );
      if (uploadResult.success) { pfPassbookLink = uploadResult.viewLink; }
    }

    let previousPayslip1Link = oldPreviousPayslip1Link;
    if (previousPayslip1File) {
      if (oldPreviousPayslip1Link) {
        const oldFileId = extractDriveFileId(oldPreviousPayslip1Link);
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadPreviousPayslip1(
        previousPayslip1File.buffer, previousPayslip1File.originalname, previousPayslip1File.mimetype, userId
      );
      if (uploadResult.success) { previousPayslip1Link = uploadResult.viewLink; }
    }

    let previousPayslip2Link = oldPreviousPayslip2Link;
    if (previousPayslip2File) {
      if (oldPreviousPayslip2Link) {
        const oldFileId = extractDriveFileId(oldPreviousPayslip2Link);
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadPreviousPayslip2(
        previousPayslip2File.buffer, previousPayslip2File.originalname, previousPayslip2File.mimetype, userId
      );
      if (uploadResult.success) { previousPayslip2Link = uploadResult.viewLink; }
    }

    let previousPayslip3Link = oldPreviousPayslip3Link;
    if (previousPayslip3File) {
      if (oldPreviousPayslip3Link) {
        const oldFileId = extractDriveFileId(oldPreviousPayslip3Link);
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadPreviousPayslip3(
        previousPayslip3File.buffer, previousPayslip3File.originalname, previousPayslip3File.mimetype, userId
      );
      if (uploadResult.success) { previousPayslip3Link = uploadResult.viewLink; }
    }

    // Delete existing PersonalDetails node
    await session.run(
      `MATCH (p:PersonalDetails {userId: $userId}) DETACH DELETE p`,
      { userId }
    );

    const fullName = [firstName, middleName, lastName].filter(n => n && n.trim()).join(" ");
    const currentTime = new Date().toISOString();

    // Keep the same PID
    const userResult = await session.run(
      `MATCH (u:User {username: $userId}) RETURN u.pid as pid`,
      { userId }
    );
    const existingPid = userResult.records[0]?.get("pid");

    let pidToUse = existingPid;
    if (!pidToUse) {
      const countResult = await session.run(`MATCH (p:PersonalDetails) RETURN COUNT(p) as count`);
      let count = 0;
      if (countResult.records.length > 0) {
        const countValue = countResult.records[0].get("count");
        count = countValue && typeof countValue.toNumber === "function" ? countValue.toNumber() : Number(countValue);
      }
      pidToUse = String(count + 1).padStart(3, '0');
    }

    // Parse skills
    let parsedSkills = skills;
    if (typeof skills === 'string') {
      try {
        parsedSkills = JSON.parse(skills);
      } catch (e) {
        parsedSkills = [];
      }
    }

    // Create new PersonalDetails record
    const result = await session.run(
      `CREATE (p:PersonalDetails {
        userId: $userId,
        firstName: $firstName,
        middleName: $middleName,
        lastName: $lastName,
        fullName: $fullName,
        emailId: $emailId,
        personalEmailId: $personalEmailId,
        pid: $pid,
        gender: $gender,
        mobileNumber: $mobileNumber,
        emergencyNumber: $emergencyNumber,
        emergencyRelationship: $emergencyRelationship,
        aadharNumber: $aadharNumber,
        aadharDocumentLink: $aadharDocumentLink,
        ssnNumber: $ssnNumber,
        ssnDocumentLink: $ssnDocumentLink,
        nationalId: $nationalId,
        nationalIdDocumentLink: $nationalIdDocumentLink,
        higherSchoolCertificateLink: $higherSchoolCertificateLink,
        panNumber: $panNumber,
        panDocumentLink: $panDocumentLink,
        tenthCertificateLink: $tenthCertificateLink,
        twelfthCertificateLink: $twelfthCertificateLink,
        resumeDocumentLink: $resumeDocumentLink,
        visaDocumentLink: $visaDocumentLink,
        profilePhotoLink: $profilePhotoLink,
        graduationCertificateLink: $graduationCertificateLink,
        postGraduationCertificateLink: $postGraduationCertificateLink,
        skills: $skills,
        dateOfBirth: $dateOfBirth,
        nationality: $nationality,
        maritalStatus: $maritalStatus,
        currentResidentialAddress: $currentResidentialAddress,
        permanentResidentialAddress: $permanentResidentialAddress,
        city: $city,
        state: $state,
        jobTitle: $jobTitle,
        employeeNumber: $employeeNumber,
        assignedCompany: $assignedCompany,
        selectedDemand: $selectedDemand,
        employmentStartDate: $employmentStartDate,
        employmentLocation: $employmentLocation,
        visaType: $visaType,
        visaEndDate: $visaEndDate,
        supervisor: $supervisor,
        hr: $hr,
        bankName: $bankName,
        bankAccountNumber: $bankAccountNumber,
        ifscCode: $ifscCode,
        bankBranch: $bankBranch,
        relievingLetter1Link: $relievingLetter1Link,
        relievingLetter2Link: $relievingLetter2Link,
        pfPassbookLink: $pfPassbookLink,
        pfNumber: $pfNumber,
        previousUan: $previousUan,
        firstTimeEmployment: $firstTimeEmployment,
        pfNomineeName: $pfNomineeName,
        pfNomineeRelationship: $pfNomineeRelationship,
        previousPayslip1Link: $previousPayslip1Link,
        previousPayslip2Link: $previousPayslip2Link,
        previousPayslip3Link: $previousPayslip3Link,
        createdAt: $createdAt,
        updatedAt: $updatedAt,
        profileStatus: 'PENDING',
        profileSubmittedAt: $submittedAt
      })
      RETURN p { ${RETURN_FIELDS} } as personalDetails`,
      {
        userId,
        firstName,
        middleName: middleName || "",
        lastName,
        fullName,
        emailId: emailId || "",
        personalEmailId: personalEmailId || "",
        pid: pidToUse,
        gender,
        mobileNumber,
        emergencyNumber: emergencyNumber || "",
        emergencyRelationship: emergencyRelationship || "",
        aadharNumber: aadharNumber || "",
        aadharDocumentLink: aadharDocumentLink,
        ssnNumber: ssnNumber || "",
        ssnDocumentLink: ssnDocumentLink,
        nationalId: nationalId || "",
        nationalIdDocumentLink: nationalIdDocumentLink,
        higherSchoolCertificateLink: higherSchoolCertificateLink,
        panNumber: panNumber || "",
        panDocumentLink: panLink,
        tenthCertificateLink: tenthCertificateLink,
        twelfthCertificateLink: twelfthCertificateLink,
        resumeDocumentLink: resumeDocumentLink,
        visaDocumentLink: visaDocumentLink,
        profilePhotoLink: profilePhotoLink,
        graduationCertificateLink: graduationCertificateLink,
        postGraduationCertificateLink: postGraduationCertificateLink,
        skills: JSON.stringify(parsedSkills),
        dateOfBirth,
        nationality: nationality || "",
        maritalStatus: maritalStatus || "",
        currentResidentialAddress: currentResidentialAddress || "",
        permanentResidentialAddress: permanentResidentialAddress || "",
        city: city || "",
        state: state || "",
        jobTitle: adminJobTitle,
        employeeNumber: adminEmployeeNumber,
        assignedCompany: adminAssignedCompany,
        selectedDemand: adminSelectedDemand,
        employmentStartDate: adminEmploymentStartDate,
        employmentLocation: adminEmploymentLocation,
        visaType: adminVisaType,
        visaEndDate: adminVisaEndDate,
        supervisor: adminSupervisor,
        hr: adminHr,
        bankName: bankName || "",
        bankAccountNumber: bankAccountNumber || "",
        ifscCode: ifscCode || "",
        bankBranch: bankBranch || "",
        relievingLetter1Link: relievingLetter1Link || null,
        relievingLetter2Link: relievingLetter2Link || null,
        pfPassbookLink: pfPassbookLink || null,
        pfNumber: pfNumber || "",
        previousUan: previousUan || "",
        firstTimeEmployment: firstTimeEmployment || "",
        pfNomineeName: pfNomineeName || "",
        pfNomineeRelationship: pfNomineeRelationship || "",
        previousPayslip1Link: previousPayslip1Link || null,
        previousPayslip2Link: previousPayslip2Link || null,
        previousPayslip3Link: previousPayslip3Link || null,
        createdAt: currentTime,
        updatedAt: currentTime,
        submittedAt: currentTime
      }
    );

    await session.run(
      `MATCH (u:User {username: $userId})
       SET u.pid = $pid`,
      { userId, pid: pidToUse }
    );


    return res.status(201).json({
      success: true,
      message: "Profile resubmitted successfully. Waiting for admin approval.",
      data: result.records[0].get("personalDetails"),
      pid: pidToUse,
      aadharDocumentLink: aadharDocumentLink,
      nationalIdDocumentLink: nationalIdDocumentLink,
      higherSchoolCertificateLink: higherSchoolCertificateLink,
      panDocumentLink: panLink,
      tenthCertificateLink: tenthCertificateLink,
      twelfthCertificateLink: twelfthCertificateLink,
      resumeDocumentLink: resumeDocumentLink,
      visaDocumentLink: visaDocumentLink,
      profilePhotoLink: profilePhotoLink,
      graduationCertificateLink: graduationCertificateLink,
      postGraduationCertificateLink: postGraduationCertificateLink
    });

  } catch (err) {
    console.error("❌ Error resubmitting profile:", err);
    res.status(500).json({ success: false, message: "Database error: " + err.message });
  } finally {
    await session.close();
  }
});


router.put("/:userId", async (req, res) => {
  const driver = getDriver();

  if (!driver) {
    console.error("❌ Neo4j driver not available");
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { userId } = req.params;

  const { isAdmin, ...updateData } = req.body;

  if (!isAdmin) {
    return res.status(403).json({
      success: false,
      message: "Only admin users can edit personal details"
    });
  }

  try {
    const currentTime = new Date().toISOString();

    const setClauses = [];
    const params = { userId, updatedAt: currentTime };

    const excludeFields = ['isAdmin', 'createdAt', 'updatedAt', 'profileStatus', 'profileSubmittedAt', 'profileApprovedAt', 'profileRejectedAt', 'profileRejectionReason', 'submissionDate', 'personalDetails'];

    Object.keys(updateData).forEach((key) => {
      const val = updateData[key];
      if (val !== undefined && !excludeFields.includes(key)) {
        if (typeof val !== 'object' || Array.isArray(val) || val === null) {
          setClauses.push(`p.${key} = $${key}`);
          params[key] = val;
        }
      }
    });

    if (setClauses.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields to update"
      });
    }

    const result = await session.run(
      `MATCH (p:PersonalDetails {userId: $userId})
       SET ${setClauses.join(', ')}, p.updatedAt = $updatedAt
       RETURN p { ${RETURN_FIELDS} } as personalDetails`,
      params
    );

    if (result.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Personal details not found"
      });
    }

    const personalDetails = result.records[0].get("personalDetails");
    if (personalDetails.skills && typeof personalDetails.skills === 'string') {
      try {
        personalDetails.skills = JSON.parse(personalDetails.skills);
      } catch (e) {
        personalDetails.skills = [];
      }
    }

    res.json({
      success: true,
      message: "Personal details updated successfully by admin",
      data: personalDetails
    });

  } catch (err) {
    console.error("❌ Error updating personal details:", err);
    res.status(500).json({ success: false, message: "Database error: " + err.message });
  } finally {
    await session.close();
  }
});


router.delete("/:pid", async (req, res) => {
  const driver = getDriver();

  if (!driver) {
    console.error("❌ Neo4j driver not available");
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { pid } = req.params;

  try {

    const getResult = await session.run(
      `MATCH (p:PersonalDetails {pid: $pid}) 
       RETURN p.aadharDocumentLink as aadharDocumentLink, 
              p.panDocumentLink as panLink`,
      { pid }
    );

    if (getResult.records.length > 0) {
      const aadharDocumentLink = getResult.records[0].get("aadharDocumentLink");
      const panLink = getResult.records[0].get("panLink");

      if (aadharDocumentLink) {
        const fileId = extractDriveFileId(aadharDocumentLink);
        await googleDrive.deleteCandidateImage(fileId);
      }
      if (panLink) {
        const fileId = extractDriveFileId(panLink);
        await googleDrive.deleteCandidateImage(fileId);
      }
    }

    const result = await session.run(
      `MATCH (p:PersonalDetails {pid: $pid})
       DETACH DELETE p
       RETURN COUNT(p) as deleted`,
      { pid }
    );

    let deletedCount = 0;
    if (result.records.length > 0) {
      const deletedValue = result.records[0].get("deleted");
      deletedCount = deletedValue && typeof deletedValue.toNumber === "function"
        ? deletedValue.toNumber()
        : Number(deletedValue);
    }

    if (deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Personal details not found" });
    }


    res.json({ success: true, message: "Personal details deleted successfully" });

  } catch (err) {
    console.error("❌ Error deleting personal details:", err);
    res.status(500).json({ success: false, message: "Database error: " + err.message });
  } finally {
    await session.close();
  }
});

router.post("/upload-health-card/:employeeNumber", healthCardUpload.single('healthCard'), async (req, res) => {
  const driver = getDriver();
  if (!driver) {
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { employeeNumber } = req.params;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ success: false, message: "No file uploaded" });
  }

  try {
    // 1. Check if profile exists and get existing health card
    const checkResult = await session.run(
      `MATCH (p:PersonalDetails {employeeNumber: $employeeNumber})
       RETURN p.healthCardLink as link`,
      { employeeNumber }
    );

    if (checkResult.records.length === 0) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    const oldLink = checkResult.records[0].get("link");
    let oldFileId = null;
    if (oldLink && oldLink.includes('/d/')) {
      oldFileId = oldLink.split('/d/')[1].split('/')[0];
    }

    // 2. Delete old file from Drive if it exists
    if (oldFileId) {
      await googleDrive.deleteFileFromDrive(oldFileId);
    }

    // 3. Upload new file to Drive
    const uploadResult = await googleDrive.uploadHealthCard(
      file.buffer, file.originalname, file.mimetype, employeeNumber
    );

    if (!uploadResult.success) {
      return res.status(500).json({ success: false, message: "Failed to upload to Google Drive", error: uploadResult.error });
    }

    const newFileId = uploadResult.fileId;
    const viewLink = uploadResult.viewLink;
    const fileName = file.originalname;

    // 4. Update Neo4j
    const updateResult = await session.run(
      `MATCH (p:PersonalDetails {employeeNumber: $employeeNumber})
       SET p.healthCardLink = $link,
           p.healthCardUploadedAt = datetime()
       RETURN p { .healthCardLink, .healthCardUploadedAt } as updatedCard`,
      { employeeNumber, link: viewLink }
    );

    res.json({
      success: true,
      message: "Health Card uploaded successfully",
      data: updateResult.records[0].get("updatedCard")
    });

  } catch (err) {
    console.error("❌ Error in upload-health-card:", err);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  } finally {
    await session.close();
  }
});

router.get("/health-card/:employeeNumber", async (req, res) => {
  const driver = getDriver();
  if (!driver) {
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { employeeNumber } = req.params;

  try {
    const result = await session.run(
      `MATCH (p:PersonalDetails {employeeNumber: $employeeNumber})
       RETURN p.healthCardLink as link, p.healthCardUploadedAt as uploadedAt`,
      { employeeNumber }
    );

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    const link = result.records[0].get("link");
    const uploadedAt = result.records[0].get("uploadedAt");

    if (!link) {
      return res.json({ success: true, exists: false });
    }

    res.json({
      success: true,
      exists: true,
      healthCardLink: link,
      healthCardUploadedAt: uploadedAt
    });

  } catch (err) {
    console.error("❌ Error fetching health card:", err);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  } finally {
    await session.close();
  }
});

const relievingLetterUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 1 * 1024 * 1024, // 1MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPG, PNG, and PDF are allowed.'));
    }
  },
});

router.post("/employee-transfer/:employeeNumber", relievingLetterUpload.single('relievingLetter'), async (req, res) => {
  const driver = getDriver();
  if (!driver) {
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { employeeNumber } = req.params;
  const { experienceType, yearsOfExperience } = req.body;
  const file = req.file;

  try {
    if (experienceType === 'EXPERIENCED' && !file) {
      return res.status(400).json({ success: false, message: "Previous company relieving letter is mandatory for experienced employees." });
    }

    let link = null;
    let fileName = null;

    if (experienceType === 'EXPERIENCED' && file) {
      const uploadResult = await googleDrive.uploadRelievingLetter(
        file.buffer, file.originalname, file.mimetype, employeeNumber
      );

      if (!uploadResult.success) {
        return res.status(500).json({ success: false, message: "Failed to upload to Google Drive", error: uploadResult.error });
      }

      link = uploadResult.viewLink;
      fileName = file.originalname;
    }

    // Check if profile exists and get old link if any (to clean up if replaced)
    const checkResult = await session.run(
      `MATCH (p:PersonalDetails)
       WHERE p.employeeNumber = $employeeNumber OR p.userId = $employeeNumber
       RETURN p.relievingLetterLink as oldLink`,
      { employeeNumber }
    );

    if (checkResult.records.length === 0) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    if (file) {
      const oldLink = checkResult.records[0].get("oldLink");
      let oldFileId = null;
      if (oldLink && oldLink.includes('/d/')) {
        oldFileId = oldLink.split('/d/')[1].split('/')[0];
      }

      if (oldFileId) {
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
    }

    const setQuery = experienceType === 'EXPERIENCED' 
      ? `SET p.experienceType = $experienceType, p.yearsOfExperience = $yearsOfExperience, p.relievingLetterLink = $link, p.relievingLetterUploadedAt = datetime()`
      : `SET p.experienceType = $experienceType, p.yearsOfExperience = null, p.relievingLetterLink = null, p.relievingLetterUploadedAt = null`;

    const updateResult = await session.run(
      `MATCH (p:PersonalDetails)
       WHERE p.employeeNumber = $employeeNumber OR p.userId = $employeeNumber
       ${setQuery}
       RETURN p { .experienceType, .yearsOfExperience, .relievingLetterLink, .relievingLetterUploadedAt } as updatedData`,
      { employeeNumber, experienceType, yearsOfExperience, link }
    );

    res.json({
      success: true,
      message: "Transfer request submitted successfully",
      data: updateResult.records[0].get("updatedData")
    });

  } catch (err) {
    console.error("❌ Error in employee transfer submission:", err);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  } finally {
    await session.close();
  }
});

// Error handling middleware for Multer specifically
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, message: "File size exceeds 1MB limit" });
    }
    return res.status(400).json({ success: false, message: err.message });
  } else if (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
  next();
});

module.exports = router;
