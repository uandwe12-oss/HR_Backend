// services/autoExportMaster.js
const cron = require('node-cron');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { uploadBufferToDrive, deleteFileFromDrive, listFiles } = require('./googleDrive');
const getDriver = require('../lib/neo4j');

class AutoExportService {
  constructor(config) {
    this.moduleName = config.moduleName;
    this.query = config.query;
    this.fileName = config.fileName;
    this.historyFileName = config.historyFile;
    this.nodeKey = config.nodeKey || 'p';
    this.priorityKeys = config.priorityKeys || [];
    this.cronSchedule = config.cronSchedule || '0 0 * * *';
    
    this.isExporting = false;
  }

  async getExistingDriveFiles() {
    try {
      const files = await listFiles();
      const baseName = this.fileName.replace('.xlsx', '');
      // Match files starting with baseName (e.g., candidates_backup)
      const moduleFiles = files.filter(file => file.name && file.name.startsWith(baseName) && file.name.endsWith('.xlsx'));
      return moduleFiles;
    } catch (error) {
      console.error(`[${this.moduleName}] Error getting drive files:`, error.message);
      return [];
    }
  }

  getISTDateString(date = new Date()) {
    const options = { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' };
    return new Intl.DateTimeFormat('en-CA', options).format(date);
  }

  async uploadAndEnforceRetention(buffer) {
    try {
      const baseName = this.fileName.replace('.xlsx', '');
      const todayDateStr = this.getISTDateString();
      const newFileName = `${baseName}_${todayDateStr}.xlsx`;
      
      // Upload new file FIRST
      const uploadResult = await uploadBufferToDrive(buffer, newFileName);
      if (uploadResult && uploadResult.success) {
        console.log(`[${this.moduleName}] ✅ New backup uploaded successfully: ${newFileName}`);
        
        // Only enforce retention if upload was successful
        const existingFiles = await this.getExistingDriveFiles();
        // Sort descending by createdTime
        existingFiles.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
        
        if (existingFiles.length > 5) {
          const filesToDelete = existingFiles.slice(5);
          for (const file of filesToDelete) {
            console.log(`[${this.moduleName}] 🗑️ Deleting old backup: ${file.name}`);
            await deleteFileFromDrive(file.id);
          }
        }
      } else {
        console.log(`[${this.moduleName}] ⚠️ Upload failed, skipping retention cleanup.`);
      }
      return uploadResult;
    } catch (error) {
      console.error(`[${this.moduleName}] ❌ Upload/Retention error:`, error.message);
      return null;
    }
  }

  async isExportNeeded() {
    try {
      const existingFiles = await this.getExistingDriveFiles();
      if (!existingFiles || existingFiles.length === 0) return true; // No files exist, export needed
      
      // Get the newest file
      existingFiles.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
      const newestFile = existingFiles[0];
      
      const lastExportIST = this.getISTDateString(new Date(newestFile.createdTime));
      const todayIST = this.getISTDateString();
      
      return lastExportIST !== todayIST;
    } catch (error) {
      console.error(`[${this.moduleName}] Error checking if export needed:`, error);
      return true;
    }
  }

  async autoExportAndUpload() {
    if (this.isExporting) return { success: false, error: 'Export already in progress' };
    
    this.isExporting = true;
    const driver = getDriver();
    const session = driver.session();
    
    try {
      const result = await session.run(this.query);
      
      const records = result.records.map(r => {
        const allProps = {};

        // Extract all properties dynamically from the returned Neo4j record
        r.keys.forEach(key => {
          const val = r.get(key);
          if (val && val.properties) {
            Object.assign(allProps, val.properties);
          } else {
            allProps[key] = val;
          }
        });
        
        const formatValue = (val) => {
          if (val === null || val === undefined) return '';
          
          // Handle Neo4j Integers
          if (val.low !== undefined && val.high !== undefined) {
            return val.toNumber ? val.toNumber() : Number(val);
          }
          
          // Handle Arrays (like URLs in News)
          if (Array.isArray(val)) {
            return val.join(', ');
          }

          if (typeof val === 'object') {
            try { return JSON.stringify(val); } catch(e) { return String(val); }
          }
          return String(val);
        };

        const record = {};
        
        // Add priority keys first
        this.priorityKeys.forEach(key => {
          record[key] = formatValue(allProps[key] !== undefined ? allProps[key] : '');
        });
        
        // Add remaining keys
        Object.keys(allProps).sort().forEach(key => {
          if (!this.priorityKeys.includes(key) && allProps[key] !== undefined) {
            record[key] = formatValue(allProps[key]);
          }
        });
        
        return record;
      });
      
      if (records.length === 0) {
        console.log(`[${this.moduleName}] No data found for export`);
        return { success: true, message: 'No data to export' };
      }

      const ws = XLSX.utils.json_to_sheet(records);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, this.moduleName);
      
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

      const uploadResult = await this.uploadAndEnforceRetention(buffer);

      return { success: true, recordCount: records.length, uploadSuccess: uploadResult?.success };
    } catch (error) {
      console.error(`[${this.moduleName}] Export error:`, error);
      return { success: false, error: error.message };
    } finally {
      this.isExporting = false;
      await session.close();
    }
  }

  startScheduler() {
    console.log(`[${this.moduleName}] Scheduler registered: ${this.cronSchedule}`);
    cron.schedule(this.cronSchedule, async () => {
      console.log(`[${this.moduleName}] Running scheduled export...`);
      try {
        const needed = await this.isExportNeeded();
        if (needed) {
          await this.autoExportAndUpload();
        } else {
          console.log(`[${this.moduleName}] Export already run today, skipping.`);
        }
      } catch (error) {
        console.error(`[${this.moduleName}] Scheduled export failed:`, error);
      }
    });
  }

  async init() {
    console.log(`[${this.moduleName}] Checking initial export status...`);
    const needed = await this.isExportNeeded();
    if (needed) {
      console.log(`[${this.moduleName}] Initial export needed, starting...`);
      await this.autoExportAndUpload();
    } else {
      console.log(`[${this.moduleName}] Initial export not needed.`);
    }
  }
}

function initializeAllExports(configs) {
  const instances = configs.map(config => new AutoExportService(config));
  
  return {
    initAll: async () => {
      for (const instance of instances) {
        await instance.init();
      }
    },
    startAllSchedulers: () => {
      for (const instance of instances) {
        instance.startScheduler();
      }
    }
  };
}

module.exports = {
  AutoExportService,
  initializeAllExports
};
