// services/autoExportDemand.js
const cron = require('node-cron');
const axios = require('axios');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { uploadToDrive, authorize, deleteFileFromDrive, listFiles } = require('./googleDrive');

let isExporting = false;

// Get existing demand file from Google Drive
async function getExistingDemandDriveFile() {
  try {
    const files = await listFiles();
    const matchingFile = files.find(file => 
      file.name && file.name === 'demands_backup.xlsx'
    );
    return matchingFile;
  } catch (error) {
    console.error('Error getting drive file:', error.message);
    return null;
  }
}

// Delete old file and upload new one
async function uploadAndReplaceDemand(filePath) {
  try {
    
    // Check for existing file
    const existingFile = await getExistingDemandDriveFile();
    if (existingFile && existingFile.id) {
      console.log(`🗑️ Deleting old demand file: ${existingFile.name}`);
      await deleteFileFromDrive(existingFile.id);
      console.log('✅ Old demand file deleted from Drive');
    } else {
      console.log('📁 No existing demand file found');
    }
    
    // Upload new file with fixed name
    const fileName = 'demands_backup.xlsx';
    const uploadResult = await uploadToDrive(filePath, fileName);
    
    if (uploadResult && uploadResult.success) {
      console.log('✅ New demand file uploaded successfully');
    }
    
    return uploadResult;
  } catch (error) {
    console.error('❌ Upload error:', error.message);
    return null;
  }
}

// Always return true for daily export
async function isDemandExportNeeded() {
  const exportDir = path.join(__dirname, '../exports');
  const historyFile = path.join(exportDir, 'demand_export_history.json');
  
  if (!fs.existsSync(historyFile)) {
    console.log('📝 No demand history - export needed');
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
      console.log(`📅 Last demand export: ${lastExport.toLocaleDateString()} - Need today's export`);
      return true;
    } else {
      console.log(`✅ Demands already exported today at ${lastExport.toLocaleTimeString()}`);
      return false;
    }
  } catch (error) {
    console.error('Error reading history:', error);
    return true;
  }
}

async function autoExportAndUploadDemand() {
  if (isExporting) {
    console.log('⚠️ Demand export already in progress');
    return { success: false, error: 'Export already in progress' };
  }
  
  isExporting = true;
  const startTime = Date.now();
  
  // console.log('\n' + '='.repeat(60));
  // console.log('📊 DEMAND AUTO-EXPORT (DAILY REPLACE)');
  // console.log(`⏰ Time: ${new Date().toLocaleString()}`);
  // console.log('='.repeat(60));
  
  try {
    const apiUrl = `http://localhost:${process.env.PORT || 5000}`;
    
    // console.log(`🌐 Fetching demands from: ${apiUrl}/api/demand`);
    const response = await axios.get(`${apiUrl}/api/demand`, {
      timeout: 30000,
      headers: { 'X-Company-Id': 'default' }
    });
    
    const demands = response.data;
    console.log(`✅ Fetched ${demands.length} demands`);
    
    if (demands.length === 0) {
      // console.log('⚠️ No demands found, skipping export');
      return { success: false, error: 'No demands to export' };
    }
    
    // Prepare Excel data
    const excelData = demands.map((d, index) => {
      const calculateAgeing = (createdDate) => {
        if (!createdDate) return 0;
        const created = new Date(createdDate);
        const today = new Date();
        const diffDays = Math.floor((today - created) / (1000 * 60 * 60 * 24));
        return Math.max(0, Math.floor(diffDays / 7));
      };
      
      const ageingWeeks = calculateAgeing(d.createdDate);
      
      return {
        'S.No': index + 1,
        'RR No': d.rrNumber || `RR${String(d.id).padStart(3, "0")}`,
        'Client': d.clientName || '',
        'Experience': `${d.expFrom || 0}-${d.expTo || 0} yrs`,
        'Country': d.country || '',
        'Location': d.location || '',
        'Creation Date': d.createdDate || '',
        'Ageing in Weeks': ageingWeeks,
        'Priority': d.jobPriority || '',
        'Status': d.status || '',
        'Interviewer 1': d.interviewer1 || '',
        'Interviewer 2': d.interviewer2 || '',
        'Recruiter': d.recruiterPOC || '',
        'Primary Skills': (d.primarySkill || []).join(', '),
        'Secondary Skills': (d.secondarySkill || []).join(', '),
        'Job Description': d.jobDescription || '',
        'Last Updated': new Date().toLocaleString()
      };
    });
    
    // Create Excel file
    const worksheet = XLSX.utils.json_to_sheet(excelData);
    
    worksheet['!cols'] = [
      { wch: 5 }, { wch: 10 }, { wch: 20 }, { wch: 15 }, { wch: 15 },
      { wch: 15 }, { wch: 12 }, { wch: 15 }, { wch: 10 }, { wch: 10 },
      { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 30 }, { wch: 30 }, 
      { wch: 50 }, { wch: 20 }
    ];
    
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Demands');
    
    // Use FIXED filename (no timestamp)
    const fileName = 'demands_backup.xlsx';
    
    const exportDir = path.join(__dirname, '../exports');
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }
    
    const filePath = path.join(exportDir, fileName);
    XLSX.writeFile(workbook, filePath);
    // console.log(`✅ Excel file created: ${fileName} (${(fs.statSync(filePath).size / 1024).toFixed(2)} KB)`);
    
    // console.log('📤 Uploading to Google Drive (replacing old file)...');
    const driveResult = await uploadAndReplaceDemand(filePath);
    
    if (driveResult && driveResult.success) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      // console.log('\n' + '🎉'.repeat(20));
      // console.log('✅ DEMAND EXPORT COMPLETED!');
      // console.log('-'.repeat(40));
      // console.log(`📊 Demands: ${demands.length}`);
      // console.log(`📁 File: ${driveResult.fileName}`);
      // console.log(`🔗 Drive Link: ${driveResult.viewLink}`);
      // console.log(`⏱️ Time: ${duration}s`);
      // console.log('🎉'.repeat(20));
      
      // Save to history
      const historyFile = path.join(exportDir, 'demand_export_history.json');
      let history = [];
      if (fs.existsSync(historyFile)) {
        history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      }
      history.unshift({
        timestamp: new Date().toISOString(),
        fileName: driveResult.fileName,
        fileId: driveResult.fileId,
        driveLink: driveResult.viewLink,
        demandCount: demands.length
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
    console.error('❌ Demand export failed:', error.message);
    return { success: false, error: error.message };
  } finally {
    isExporting = false;
  }
}

async function runDemandExportIfNeeded() {
  // console.log('\n🔍 Checking if today\'s demand export is needed...');
  const needed = await isDemandExportNeeded();
  
  if (needed) {
    console.log('🚀 Running demand export now...');
    await autoExportAndUploadDemand();
  } else {
    console.log('✅ Demands already exported today');
  }
}

function startDemandAutoExportScheduler() {
  setTimeout(async () => {
    await runDemandExportIfNeeded();
  }, 15000);
  
  // Daily check at 2:05 AM
  cron.schedule('5 2 * * *', async () => {
    console.log('\n🔔 Daily demand export scheduled at 2:05 AM');
    await autoExportAndUploadDemand();
  });
  
  // console.log('\n✅ Demand Auto-Export Scheduler Started!');
  // console.log('📅 Schedule: Every day at 2:05 AM');
  // console.log('🔄 Mode: REPLACE - Old file deleted, new file uploaded');
}

async function manualDemandExport() {
  // console.log('\n🔧 Manual demand export triggered');
  return await autoExportAndUploadDemand();
}

module.exports = {
  startDemandAutoExportScheduler,
  autoExportAndUploadDemand,
  manualDemandExport,
  runDemandExportIfNeeded
};
