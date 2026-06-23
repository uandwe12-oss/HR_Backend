// services/googleDrive.js
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// Paths
const TOKEN_PATH = path.join(__dirname, '../config/token.json');
const CREDENTIALS_PATH = path.join(__dirname, '../config/credentials.json');

// Google Drive Folder IDs - SEPARATE FOLDERS
const CANDIDATE_PROFILE_FOLDER_ID = '1wIQXwyPPYyfXWJ35TsmDByeg4FTxyNle';
const DRIVE_FOLDER_ID = '1Nehh6KSypnEo77JZqf2gVtkIwYIi8rgp'; // For Excel files and resumes
const AADHAR_FOLDER_ID = '1N5ogPcz6aDWG9TDFW0XfHuVArbf81Rjm'; // For Aadhar card images (Front & Back)
const PAN_FOLDER_ID = '1HBMospeK_kI4NBL-yWyJYxeOIdo6KUnu'; // For PAN card images
const TENTH_CERT_FOLDER_ID = '1DEHvvggqRbSEl-hIDwLkgS1IoC9s2gf1'; // For 10th Certificate
const TWELFTH_CERT_FOLDER_ID = '1ZOIag9ZPX3WkvhEMa_ESg8waSWtj3Nq4'; // For 12th / PUC Certificate 
const PROFILE_PHOTO_FOLDER_ID = '17NNXT49zzVQe3ceRIdiDeAR-szWPxIkT'; // For Profile Photos
const RESUME_FOLDER_ID = '10R6KWZVzKQH0h5wcmuJwqRcGxAapz6LW'; // For Resume Documents
const VISA_FOLDER_ID = '1twXnKdxYkC0xUuibbKkUPGR7H3uNEwl3'; // For Visa Documents
const GRADUATION_FOLDER_ID = '1HfA8fNZ46gqD3k1pPCVFUTlmSE9N0IKo'; // For Graduation Certificates
const POST_GRADUATION_FOLDER_ID = '1NnT42fkh8eavmLfM6Cgv7N9H18Lu61hy'; // For Post Graduation Certificates
const HEALTH_CARD_FOLDER_ID = '1vRQBgV6pMuXdVcVKzqCRJgMQ5L60GzYm'; // For Health Cards
const EMPLOYEE_TRANSFER_FOLDER_ID = '1RQU_k8ie5yRsYFOIPX997ItIBbwAPpJ2'; // For Relieving Letters
const REIMBURSEMENT_FOLDER_ID = '1RQU_k8ie5yRsYFOIPX997ItIBbwAPpJ2'; // For Reimbursement Documents
const PAYSLIP_FOLDER_ID = '10Gp5wXt-x_wGKGiJ_8KbIRuFN9CwNfgh'; // For Employee Payslips


const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

// Authorize using Service Account (JWT)
async function authorize() {
  try {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      console.error('❌ credentials.json not found at:', CREDENTIALS_PATH);
      return null;
    }

    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));

    if (credentials.private_key) {

      const auth = new google.auth.JWT(
        credentials.client_email,
        null,
        credentials.private_key,
        SCOPES
      );

      return auth;
    }
    else if (credentials.installed || credentials.web) {
      console.log('👤 Using OAuth2 authentication');

      const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
      const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

      if (fs.existsSync(TOKEN_PATH)) {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
        oAuth2Client.setCredentials(token);
        return oAuth2Client;
      }
    }

    // console.log('⚠️ No valid credentials found');
    return null;
  } catch (error) {
    console.error('❌ Authorization error:', error.message);
    return null;
  }
}

// Get Drive Service
async function getDriveService() {
  const auth = await authorize();
  if (!auth) {
    throw new Error('Not authenticated with Google Drive');
  }

  return google.drive({
    version: 'v3',
    auth
  });
}

// ============ UPLOAD FUNCTIONS ============

/**
 * Upload Aadhar card image (Front or Back) to Aadhar-specific folder
 */
async function uploadAadharImage(fileBuffer, originalName, mimeType, userId, side) {
  try {
    // console.log(`📸 Uploading Aadhar ${side} for ${userId}...`);

    const drive = await getDriveService();

    // Generate unique filename with user ID and side
    const timestamp = Date.now();
    const extension = path.extname(originalName);
    const uniqueFileName = `aadhar_${side}_${userId}_${timestamp}${extension}`;

    const fileMetadata = {
      name: uniqueFileName,
      parents: [AADHAR_FOLDER_ID], // Use Aadhar-specific folder
      properties: {
        userId: userId,
        documentType: 'aadhar',
        side: side,
        originalName: originalName,
        uploadedAt: new Date().toISOString()
      }
    };

    const media = {
      mimeType: mimeType,
      body: require('stream').Readable.from(fileBuffer)
    };

    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id,name,webViewLink,webContentLink',
      supportsAllDrives: true
    });

    // Make the file publicly accessible
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      },
      supportsAllDrives: true
    });

    // console.log(`✅ Aadhar ${side} uploaded: ${uniqueFileName}`);

    return {
      success: true,
      fileId: response.data.id,
      fileName: response.data.name,
      viewLink: response.data.webViewLink,
      directLink: `https://drive.google.com/uc?id=${response.data.id}`
    };
  } catch (error) {
    console.error(`❌ Aadhar ${side} upload error:`, error.message);
    return { success: false, error: error.message };
  }
}


/**
 * Upload resume for Candidate Profile (goes to Candidate_Profile folder)
 */
async function uploadCandidateProfileResume(filePath, fileName) {
  try {
    const drive = await getDriveService();

    const fileMetadata = {
      name: fileName,
      parents: [CANDIDATE_PROFILE_FOLDER_ID]  // Use the Candidate Profile folder
    };

    const media = {
      mimeType: 'application/pdf',
      body: fs.createReadStream(filePath)
    };

    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id,name,webViewLink,webContentLink',
      supportsAllDrives: true
    });

    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true
    });

    return {
      success: true,
      fileId: response.data.id,
      viewLink: response.data.webViewLink,
      downloadLink: `https://drive.google.com/uc?export=download&id=${response.data.id}`
    };
  } catch (error) {
    console.error('❌ Candidate Profile resume upload error:', error.message);
    return { success: false, error: error.message };
  }
}
/**
 * Upload PAN card image to PAN-specific folder
 */
async function uploadPanImage(fileBuffer, originalName, mimeType, userId) {
  try {
    // console.log(`📸 Uploading PAN card for ${userId}...`);

    const drive = await getDriveService();

    // Generate unique filename with user ID
    const timestamp = Date.now();
    const extension = path.extname(originalName);
    const uniqueFileName = `pan_${userId}_${timestamp}${extension}`;

    const fileMetadata = {
      name: uniqueFileName,
      parents: [PAN_FOLDER_ID], // Use PAN-specific folder
      properties: {
        userId: userId,
        documentType: 'pan',
        originalName: originalName,
        uploadedAt: new Date().toISOString()
      }
    };

    const media = {
      mimeType: mimeType,
      body: require('stream').Readable.from(fileBuffer)
    };

    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id,name,webViewLink,webContentLink',
      supportsAllDrives: true
    });

    // Make the file publicly accessible
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      },
      supportsAllDrives: true
    });

    // console.log(`✅ PAN card uploaded: ${uniqueFileName}`);

    return {
      success: true,
      fileId: response.data.id,
      fileName: response.data.name,
      viewLink: response.data.webViewLink,
      directLink: `https://drive.google.com/uc?id=${response.data.id}`
    };
  } catch (error) {
    console.error('❌ PAN card upload error:', error.message);
    return { success: false, error: error.message };
  }
}

async function uploadResumeToDrive(filePath, fileName) {
  try {
    const drive = await getDriveService();
    const stats = fs.statSync(filePath);

    const fileMetadata = {
      name: fileName,
      parents: [RESUME_FOLDER_ID]
    };

    const media = {
      mimeType: 'application/pdf', // ✅ Correct for resumes
      body: fs.createReadStream(filePath)
    };

    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id,name,webViewLink,webContentLink',
      supportsAllDrives: true
    });

    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true
    });

    return {
      success: true,
      fileId: response.data.id,
      viewLink: response.data.webViewLink,
      downloadLink: `https://drive.google.com/uc?export=download&id=${response.data.id}`
    };
  } catch (error) {
    console.error('❌ Resume upload error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Generic function to upload any candidate image (backward compatibility)
 */
async function uploadCandidateImage(fileBuffer, originalName, mimeType, userId) {
  // Determine which folder to use based on the userId parameter
  if (userId.includes('_aadhar_front')) {
    return await uploadAadharImage(fileBuffer, originalName, mimeType, userId.replace('_aadhar_front', ''), 'front');
  } else if (userId.includes('_aadhar_back')) {
    return await uploadAadharImage(fileBuffer, originalName, mimeType, userId.replace('_aadhar_back', ''), 'back');
  } else if (userId.includes('_pan')) {
    return await uploadPanImage(fileBuffer, originalName, mimeType, userId.replace('_pan', ''));
  } else {
    // Default to PAN folder for backward compatibility
    return await uploadPanImage(fileBuffer, originalName, mimeType, userId);
  }
}

/**
 * Delete a file from Google Drive
 */
async function deleteFileFromDrive(fileId) {
  try {
    const drive = await getDriveService();
    await drive.files.delete({
      fileId: fileId,
      supportsAllDrives: true
    });
    console.log(`✅ Deleted file: ${fileId}`);
    return { success: true };
  } catch (error) {
    console.error('❌ Delete file error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Delete candidate image (backward compatibility)
 */
async function deleteCandidateImage(fileId) {
  return await deleteFileFromDrive(fileId);
}

// ============ GENERIC DOCUMENT UPLOAD ============

/**
 * Generic function to upload a document to a specific Google Drive folder
 */
async function uploadDocumentToFolder(fileBuffer, originalName, mimeType, userId, docType, folderId) {
  try {

    const drive = await getDriveService();

    const timestamp = Date.now();
    const extension = path.extname(originalName);
    const uniqueFileName = `${docType}_${userId}_${timestamp}${extension}`;

    const fileMetadata = {
      name: uniqueFileName,
      parents: [folderId],
      properties: {
        userId: userId,
        documentType: docType,
        originalName: originalName,
        uploadedAt: new Date().toISOString()
      }
    };

    const media = {
      mimeType: mimeType,
      body: require('stream').Readable.from(fileBuffer)
    };

    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id,name,webViewLink,webContentLink',
      supportsAllDrives: true
    });

    // Make the file publicly accessible
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      },
      supportsAllDrives: true
    });


    return {
      success: true,
      fileId: response.data.id,
      fileName: response.data.name,
      viewLink: response.data.webViewLink,
      directLink: `https://drive.google.com/uc?id=${response.data.id}`
    };
  } catch (error) {
    console.error(`❌ ${docType} upload error:`, error.message);
    return { success: false, error: error.message };
  }
}

// Convenience wrappers for each new document type
async function uploadTenthCertificate(fileBuffer, originalName, mimeType, userId) {
  return uploadDocumentToFolder(fileBuffer, originalName, mimeType, userId, 'tenth_certificate', TENTH_CERT_FOLDER_ID);
}

async function uploadTwelfthCertificate(fileBuffer, originalName, mimeType, userId) {
  return uploadDocumentToFolder(fileBuffer, originalName, mimeType, userId, 'twelfth_certificate', TWELFTH_CERT_FOLDER_ID);
}

async function uploadResume(fileBuffer, originalName, mimeType, userId) {
  return uploadDocumentToFolder(fileBuffer, originalName, mimeType, userId, 'resume', RESUME_FOLDER_ID);
}

async function uploadVisaDocument(fileBuffer, originalName, mimeType, userId) {
  return uploadDocumentToFolder(fileBuffer, originalName, mimeType, userId, 'visa_document', VISA_FOLDER_ID);
}

async function uploadProfilePhoto(fileBuffer, originalName, mimeType, userId) {
  return uploadDocumentToFolder(fileBuffer, originalName, mimeType, userId, 'profile_photo', PROFILE_PHOTO_FOLDER_ID);
}

async function uploadGraduationCertificate(fileBuffer, originalName, mimeType, userId) {
  return uploadDocumentToFolder(fileBuffer, originalName, mimeType, userId, 'graduation_certificate', GRADUATION_FOLDER_ID);
}

async function uploadPostGraduationCertificate(fileBuffer, originalName, mimeType, userId) {
  return uploadDocumentToFolder(fileBuffer, originalName, mimeType, userId, 'post_graduation_certificate', POST_GRADUATION_FOLDER_ID);
}

async function uploadHealthCard(fileBuffer, originalName, mimeType, userId) {
  return uploadDocumentToFolder(fileBuffer, originalName, mimeType, userId, 'health_card', HEALTH_CARD_FOLDER_ID);
}

async function uploadRelievingLetter(fileBuffer, originalName, mimeType, userId) {
  return uploadDocumentToFolder(fileBuffer, originalName, mimeType, userId, 'relieving_letter', EMPLOYEE_TRANSFER_FOLDER_ID);
}

async function uploadReimbursementDocument(fileBuffer, originalName, mimeType, userId) {
  return uploadDocumentToFolder(fileBuffer, originalName, mimeType, userId, 'reimbursement_document', REIMBURSEMENT_FOLDER_ID);
}

async function uploadPayslip(fileBuffer, originalName, mimeType, userId) {
  return uploadDocumentToFolder(fileBuffer, originalName, mimeType, userId, 'payslip', PAYSLIP_FOLDER_ID);
}

// ============ EXISTING FUNCTIONS (Preserved) ============

async function uploadToDrive(filePath, fileName) {
  try {
    // console.log(`📤 Starting upload to Google Drive...`);
    // console.log(`   File: ${fileName}`);

    const stats = fs.statSync(filePath);
    const fileSizeMB = stats.size / (1024 * 1024);
    // console.log(`   Size: ${fileSizeMB.toFixed(2)} MB`);

    const drive = await getDriveService();

    const fileMetadata = {
      name: fileName,
      parents: [DRIVE_FOLDER_ID]
    };

    const media = {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: fs.createReadStream(filePath)
    };

    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id,name,webViewLink',
      supportsAllDrives: true
    }, {
      timeout: 120000,
      retryConfig: {
        retry: 3,
        retryDelay: 1000,
        httpMethodsToRetry: ['POST', 'PUT']
      }
    });

    // console.log('✅ File uploaded to Google Drive');
    // console.log(`📄 File ID: ${response.data.id}`);
    // console.log(`🔗 View Link: ${response.data.webViewLink}`);

    return {
      success: true,
      fileId: response.data.id,
      fileName: response.data.name,
      viewLink: response.data.webViewLink
    };
  } catch (error) {
    console.error('❌ Upload Error:', error.message);
    return { success: false, error: error.message, code: error.code };
  }
}

async function listFiles() {
  try {
    const drive = await getDriveService();

    const response = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and trashed=false`,
      fields: 'files(id,name,webViewLink,createdTime)',
      orderBy: 'createdTime desc',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });

    return response.data.files || [];
  } catch (error) {
    console.error('❌ List Files Error:', error.message);
    return [];
  }
}

async function cleanupOldFiles() {
  try {
    const files = await listFiles();

    if (files.length > 1) {
      const drive = await getDriveService();
      const filesToDelete = files.slice(1);

      // console.log(`🗑️ Keeping most recent file: ${files[0].name}`);
      // console.log(`🗑️ Deleting ${filesToDelete.length} old file(s)...`);

      for (const file of filesToDelete) {
        await drive.files.delete({
          fileId: file.id,
          supportsAllDrives: true
        });
        // console.log(`   ✅ Deleted: ${file.name}`);
      }

      // console.log(`✅ Cleanup complete. Only 1 file remains in Drive.`);
    } else {
      console.log(`📁 Currently ${files.length} file(s) in Drive (keeping only 1)`);
    }
  } catch (error) {
    console.error('❌ Cleanup Error:', error.message);
  }
}

async function cleanupOldFilesDemand() {
  try {
    const files = await listFiles();

    const demandFiles = files.filter(file => file.name && file.name.startsWith('demands_backup_'));

    if (demandFiles.length > 1) {
      const drive = await getDriveService();
      const filesToDelete = demandFiles.slice(1);

      // console.log(`🗑️ Keeping most recent demand file: ${demandFiles[0].name}`);
      // console.log(`🗑️ Deleting ${filesToDelete.length} old demand file(s)...`);

      for (const file of filesToDelete) {
        await drive.files.delete({
          fileId: file.id,
          supportsAllDrives: true
        });
        // console.log(`   ✅ Deleted: ${file.name}`);
      }

      console.log(`✅ Demand cleanup complete. Only 1 demand file remains.`);
    } else {
      console.log(`📁 Currently ${demandFiles.length} demand file(s) in Drive`);
    }
  } catch (error) {
    console.error('❌ Cleanup Error for demand files:', error.message);
  }
}

async function testConnection() {
  try {
    const auth = await authorize();
    if (auth) {
      const drive = await getDriveService();
      const about = await drive.about.get({ fields: 'user' });
      // console.log('✅ Connected to Google Drive as:', about.data.user.displayName);
      return true;
    }
    return false;
  } catch (error) {
    console.error('❌ Connection test failed:', error.message);
    return false;
  }
}

async function firstTimeAuth() {
  // console.log('ℹ️ For service accounts, credentials.json is already configured.');
  // console.log('✅ No additional setup needed!');
  return true;
}

// Export all functions
module.exports = {
  // Existing exports
  uploadToDrive,
  uploadResumeToDrive,
  uploadCandidateProfileResume,
  listFiles,
  cleanupOldFiles,
  cleanupOldFilesDemand,
  firstTimeAuth,
  authorize,
  testConnection,
  DRIVE_FOLDER_ID,

  // Specific upload functions
  uploadAadharImage,
  uploadPanImage,
  uploadCandidateImage,  // Backward compatibility
  deleteCandidateImage,
  deleteFileFromDrive,

  // New document upload functions
  uploadDocumentToFolder,
  uploadTenthCertificate,
  uploadTwelfthCertificate,
  uploadResume,
  uploadVisaDocument,
  uploadProfilePhoto,
  uploadGraduationCertificate,
  uploadPostGraduationCertificate,
  uploadHealthCard,
  uploadRelievingLetter,
  uploadReimbursementDocument,
  uploadPayslip
};
