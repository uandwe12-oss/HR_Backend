// services/autoExport.js
const cron = require('node-cron');
const axios = require('axios');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { uploadToDrive, authorize, deleteFileFromDrive, listFiles } = require('./googleDrive');

let isInitialized = false;
let isExporting = false;

// Get existing file from Google Drive
async function getExistingDriveFile() {
  try {
    const files = await listFiles();
    const matchingFile = files.find(file => 
      file.name && file.name === 'candidates_backup.xlsx'
    );
    return matchingFile;
  } catch (error) {
    console.error('Error getting drive file:', error.message);
    return null;
  }
}

// Delete old file and upload new one
async function uploadAndReplace(filePath) {
  try {
    
    // Check for existing file
    const existingFile = await getExistingDriveFile();
    if (existingFile && existingFile.id) {
      console.log(`🗑️ Deleting old file: ${existingFile.name}`);
      await deleteFileFromDrive(existingFile.id);
      console.log('✅ Old file deleted from Drive');
    } else {
      console.log('📁 No existing file found, will create new one');
    }
    
    // Upload new file with fixed name
    const fileName = 'candidates_backup.xlsx';
    const uploadResult = await uploadToDrive(filePath, fileName);
    
    if (uploadResult && uploadResult.success) {
      console.log('✅ New file uploaded successfully');
    }
    
    return uploadResult;
  } catch (error) {
    console.error('❌ Upload error:', error.message);
    return null;
  }
}

// Always return true for daily export
async function isExportNeeded() {
  const exportDir = path.join(__dirname, '../exports');
  const historyFile = path.join(exportDir, 'candidate_export_history.json');
  
  if (!fs.existsSync(historyFile)) {
    console.log('📝 No history - export needed');
    return true;
  }
  
  try {
    const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    if (history.length === 0) return true;
    
    const lastExport = new Date(history[0].timestamp);
    const now = new Date();
    
    // Check if last export was today
    const isToday = lastExport.toDateString() === now.toDateString();
    
    if (!isToday) {
      console.log(`📅 Last export: ${lastExport.toLocaleDateString()} - Need today's export`);
      return true;
    } else {
      console.log(`✅ Already exported today at ${lastExport.toLocaleTimeString()}`);
      return false;
    }
  } catch (error) {
    console.error('Error reading history:', error);
    return true;
  }
}

// Function to export and upload
async function autoExportAndUpload() {
  if (isExporting) {
    return { success: false, error: 'Export already in progress' };
  }
  
  isExporting = true;
  const startTime = Date.now();
  
  // console.log('\n' + '='.repeat(60));
  // console.log('📊 CANDIDATE AUTO-EXPORT (DAILY REPLACE)');
  // console.log(`⏰ Time: ${new Date().toLocaleString()}`);
  // console.log('='.repeat(60));
  
  try {
    const apiUrl = `http://localhost:${process.env.PORT || 5000}`;
    
    
    const response = await axios.get(`${apiUrl}/api/candidates/all`, {
      timeout: 60000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (!response.data || !response.data.success) {
      throw new Error('API returned unsuccessful response');
    }
    
    const candidates = response.data.data || [];
    
    if (candidates.length === 0) {
      return { success: false, error: 'No candidates to export' };
    }
    
    // Prepare Excel data
    const excelData = candidates.map(candidate => ({
      'Can_ID': candidate.canId || candidate.id || '',
      'Candidate Name': (candidate.name || '').trim(),
      'Email': candidate.email || '',
      'Mobile No': candidate.mobile || '',
      'Experience': candidate.experience || '',
      'Current Org': candidate.currentOrg || '',
      'Current CTC': candidate.currentCTC || '',
      'Expected CTC': candidate.expectedCTC || '',
      'Notice Period': candidate.noticePeriod || '',
      'Profile Sourced By': candidate.profileSourcedBy || '',
      'Client Name': candidate.clientName || '',
      'Profile Submission Date': candidate.profileSubmissionDate || '',
      'Visa Type': candidate.visaType || 'NA',
      'Visa Validity Date': candidate.visaValidityDate || '',
      'Key Skills': Array.isArray(candidate.keySkills) ? candidate.keySkills.join('; ') : 
                    (typeof candidate.keySkills === 'string' ? candidate.keySkills : ''),
      'Is In Progress': candidate.isInProgress ? 'true' : 'false',
      'Created At': candidate.createdAt ? new Date(candidate.createdAt).toLocaleDateString() : '',
      'Updated At': candidate.updatedAt ? new Date(candidate.updatedAt).toLocaleDateString() : '',
      'Last Updated': new Date().toLocaleString()
    }));
    
    // Create Excel file
    const worksheet = XLSX.utils.json_to_sheet(excelData);
    
    // Auto-size columns
    const maxWidths = {};
    excelData.forEach(row => {
      Object.keys(row).forEach(key => {
        const value = String(row[key] || '');
        maxWidths[key] = Math.max(maxWidths[key] || 0, Math.min(value.length, 50));
      });
    });
    
    worksheet['!cols'] = Object.keys(excelData[0] || {}).map(key => ({
      wch: Math.max(key.length, maxWidths[key] || 10) + 2
    }));
    
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'All Candidates');
    
    // Use FIXED filename (no timestamp)
    const fileName = 'candidates_backup.xlsx';
    
    // Save locally
    const exportDir = path.join(__dirname, '../exports');
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }
    
    const filePath = path.join(exportDir, fileName);
    XLSX.writeFile(workbook, filePath);
    const fileSize = fs.statSync(filePath).size;
    
    // Upload to Google Drive (replace)
    
    const driveResult = await uploadAndReplace(filePath);
    
    if (driveResult && driveResult.success) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      // console.log('\n' + '🎉'.repeat(20));
      // console.log('✅ CANDIDATE EXPORT COMPLETED!');
      // console.log('-'.repeat(40));
      // console.log(`📊 Candidates: ${candidates.length}`);
      // console.log(`📁 File: ${driveResult.fileName}`);
      // console.log(`🔗 Drive Link: ${driveResult.viewLink}`);
      // console.log(`⏱️ Time: ${duration}s`);
      // console.log('🎉'.repeat(20));
      
      // Save to history
      const historyFile = path.join(exportDir, 'candidate_export_history.json');
      let history = [];
      if (fs.existsSync(historyFile)) {
        history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      }
      history.unshift({
        timestamp: new Date().toISOString(),
        fileName: driveResult.fileName,
        fileId: driveResult.fileId,
        driveLink: driveResult.viewLink,
        candidateCount: candidates.length
      });
      history = history.slice(0, 30);
      fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
      
      // Delete local file
      try {
        fs.unlinkSync(filePath);
        console.log('🗑️ Local file deleted');
      } catch (unlinkErr) {
        console.log('⚠️ Could not delete local file');
      }
      
      return { success: true, ...driveResult };
    } else {
      console.log('⚠️ Drive upload failed, file saved locally');
      return { success: false, localPath: filePath, error: 'Drive upload failed' };
    }
  } catch (error) {
    console.error('❌ Export failed:', error.message);
    return { success: false, error: error.message };
  } finally {
    isExporting = false;
  }
}

// Run on startup
async function runExportIfNeeded() {
  // console.log('\n🔍 Checking if today\'s export is needed...');
  const needed = await isExportNeeded();
  
  if (needed) {
    console.log('🚀 Running export now...');
    await autoExportAndUpload();
  } else {
    console.log('✅ Already exported today');
  }
}

// Initialize
async function initAutoExport() {
  if (isInitialized) return;
  
  // console.log('\n🚀 Initializing Candidate Auto-Export (Daily Replace Mode)...');
  // console.log('='.repeat(40));
  
  try {
    const auth = await authorize();
    if (!auth) {
      console.log('⚠️ Google Drive not configured. Auto-export will save locally only.');
    } else {
      console.log('✅ Google Drive configured - Files will be replaced daily');
    }
    isInitialized = true;
  } catch (error) {
    console.error('❌ Init error:', error.message);
  }
}

// Start scheduler - Runs every day at 2 AM
function startAutoExportScheduler() {
  // Run on startup
  setTimeout(async () => {
    await runExportIfNeeded();
  }, 10000);
  
  // Schedule daily at 2 AM
  cron.schedule('0 2 * * *', async () => {
    console.log('\n🔔 Daily export scheduled at 2 AM');
    await autoExportAndUpload();
  });
  
  console.log('\n✅ Candidate Auto-Export Scheduler Started!');
  console.log('📅 Schedule: Every day at 2:00 AM');
  console.log('🔄 Mode: REPLACE - Old file deleted, new file uploaded');
}

// Manual trigger
async function manualExport() {
  console.log('\n🔧 Manual export triggered');
  return await autoExportAndUpload();
}

module.exports = {
  startAutoExportScheduler,
  autoExportAndUpload,
  manualExport,
  initAutoExport,
  runExportIfNeeded
};
