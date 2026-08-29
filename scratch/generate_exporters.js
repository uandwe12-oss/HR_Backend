const fs = require('fs');
const path = require('path');

const configs = [
  { name: 'Holiday', label: 'Holiday', time: '40 4', delay: 42000, displayName: 'Holiday' },
  { name: 'Allocation', label: 'Allocation', time: '50 4', delay: 45000, displayName: 'Allocation' },
  { name: 'Birthday', label: 'BirthdayWishLog', time: '0 5', delay: 48000, displayName: 'Birthday Wish' },
  { name: 'Skill', label: 'Skill', time: '10 5', delay: 51000, displayName: 'Skill' },
  { name: 'User', label: 'User', time: '20 5', delay: 54000, displayName: 'User' },
  { name: 'Zone', label: 'Zone', time: '30 5', delay: 57000, displayName: 'Zone' }
];

const template = (config) => `// services/autoExport${config.name}.js
const cron = require('node-cron');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { uploadBufferToDrive, authorize, deleteFileFromDrive, listFiles } = require('./googleDrive');
const getDriver = require('../lib/neo4j');

let isInitialized = false;
let isExporting = false;

// Get existing file from Google Drive
async function getExistingDriveFile() {
  try {
    const files = await listFiles();
    const matchingFile = files.find(file => 
      file.name && file.name === '${config.name.toLowerCase()}_backup.xlsx'
    );
    return matchingFile;
  } catch (error) {
    console.error('Error getting drive file:', error.message);
    return null;
  }
}

// Delete old file and upload new one from buffer
async function uploadAndReplace(buffer) {
  try {
    const existingFile = await getExistingDriveFile();
    if (existingFile && existingFile.id) {
      console.log(\`🗑️ Deleting old file: \${existingFile.name}\`);
      await deleteFileFromDrive(existingFile.id);
    }
    
    const fileName = '${config.name.toLowerCase()}_backup.xlsx';
    const uploadResult = await uploadBufferToDrive(buffer, fileName);
    
    if (uploadResult && uploadResult.success) {
      console.log('✅ New ${config.displayName.toLowerCase()} backup uploaded successfully');
    }
    
    return uploadResult;
  } catch (error) {
    console.error('❌ Upload error:', error.message);
    return null;
  }
}

async function isExportNeeded() {
  const exportDir = path.join(__dirname, '../exports');
  const historyFile = path.join(exportDir, '${config.name.toLowerCase()}_export_history.json');
  
  if (!fs.existsSync(historyFile)) return true;
  
  try {
    const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    if (history.length === 0) return true;
    
    const lastExport = new Date(history[0].timestamp);
    const now = new Date();
    
    return lastExport.toDateString() !== now.toDateString();
  } catch (error) {
    return true;
  }
}

async function autoExportAndUpload() {
  if (isExporting) return { success: false, error: 'Export already in progress' };
  
  isExporting = true;
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const result = await session.run(\`
      MATCH (p:${config.label})
      RETURN p
    \`);
    
    const records = result.records.map(r => {
      const p = r.get('p').properties;
      
      const formatValue = (val) => {
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') {
          try {
            return JSON.stringify(val);
          } catch(e) {
            return String(val);
          }
        }
        return String(val);
      };

      const record = {};
      const keys = Object.keys(p).sort(); // Sort keys alphabetically for consistent columns
      
      // Keep some important fields first
      const priorityKeys = ['id', 'userId', 'employeeNumber', 'name', 'title'];
      priorityKeys.forEach(k => {
        if (p.hasOwnProperty(k)) {
          record[k] = formatValue(p[k]);
        }
      });
      
      // Add the rest
      keys.forEach(key => {
        if (!priorityKeys.includes(key)) {
          if (typeof p[key] === 'string' && (p[key].startsWith('[') || p[key].startsWith('{'))) {
            try {
               let parsed = JSON.parse(p[key]);
               record[key] = Array.isArray(parsed) ? parsed.join(', ') : JSON.stringify(parsed);
            } catch(e) {
               record[key] = p[key];
            }
          } else if (key.toLowerCase().includes('date') || key.toLowerCase().includes('at')) {
             if (p[key] && !isNaN(Date.parse(p[key]))) {
                 record[key] = new Date(p[key]).toLocaleString();
             } else {
                 record[key] = p[key];
             }
          } else {
            record[key] = formatValue(p[key]);
          }
        }
      });

      return record;
    });
    
    if (records.length === 0) {
      return { success: false, error: 'No ${config.displayName.toLowerCase()} records to export' };
    }
    
    const worksheet = XLSX.utils.json_to_sheet(records);
    
    const maxWidths = {};
    records.forEach(row => {
      Object.keys(row).forEach(key => {
        const value = String(row[key] || '');
        maxWidths[key] = Math.max(maxWidths[key] || 0, Math.min(value.length, 50));
      });
    });
    
    worksheet['!cols'] = Object.keys(records[0] || {}).map(key => ({
      wch: Math.max(key.length, maxWidths[key] || 10) + 2
    }));
    
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '${config.label}s');
    
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    const fileName = '${config.name.toLowerCase()}_backup.xlsx';
    const exportDir = path.join(__dirname, '../exports');
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }
    
    const driveResult = await uploadAndReplace(buffer);
    
    if (driveResult && driveResult.success) {
      const historyFile = path.join(exportDir, '${config.name.toLowerCase()}_export_history.json');
      let history = [];
      if (fs.existsSync(historyFile)) {
        history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      }
      history.unshift({
        timestamp: new Date().toISOString(),
        fileName: driveResult.fileName,
        fileId: driveResult.fileId,
        recordCount: records.length
      });
      fs.writeFileSync(historyFile, JSON.stringify(history.slice(0, 30), null, 2));
      
      return { success: true, ...driveResult };
    } else {
      return { success: false, error: 'Drive upload failed' };
    }
  } catch (error) {
    console.error('❌ ${config.displayName} export failed:', error.message);
    return { success: false, error: error.message };
  } finally {
    isExporting = false;
    await session.close();
  }
}

async function runExportIfNeeded() {
  if (await isExportNeeded()) {
    console.log('🚀 Running ${config.displayName.toLowerCase()} export now...');
    await autoExportAndUpload();
  }
}

async function initAutoExport() {
  if (isInitialized) return;
  try {
    if (await authorize()) console.log('✅ Google Drive configured for ${config.displayName} Auto-Export');
    isInitialized = true;
  } catch (error) {
    console.error('❌ Init error:', error.message);
  }
}

function start${config.name}AutoExportScheduler() {
  setTimeout(async () => { await runExportIfNeeded(); }, ${config.delay});
  
  cron.schedule('${config.time} * * *', async () => {
    console.log('\\n🔔 Daily ${config.displayName.toLowerCase()} export scheduled at ${config.time.replace(' ', ':')} AM');
    await autoExportAndUpload();
  });
  
  console.log('\\n✅ ${config.displayName} Auto-Export Scheduler Started (${config.time.replace(' ', ':')} AM)');
}

module.exports = {
  start${config.name}AutoExportScheduler,
  autoExportAndUpload,
  initAutoExport,
  runExportIfNeeded
};
`;

configs.forEach(config => {
  const filePath = path.join(__dirname, '..', 'services', `autoExport${config.name}.js`);
  fs.writeFileSync(filePath, template(config));
  console.log(`Created ${filePath}`);
});
