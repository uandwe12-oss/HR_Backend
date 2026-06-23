// Run this script once to set up Google Drive authentication
const { firstTimeAuth } = require('../services/googleDrive');
const fs = require('fs');
const path = require('path');

async function setup() {
  console.log('\n🔧 Google Drive Setup Utility');
  console.log('='.repeat(40));
  
  const credPath = path.join(__dirname, '../config/credentials.json');
  
  if (!fs.existsSync(credPath)) {
    console.error('\n❌ credentials.json not found!');
    console.log('\n📝 Steps:');
    console.log('1. Go to https://console.cloud.google.com/');
    console.log('2. Create project or select existing');
    console.log('3. Enable Google Drive API');
    console.log('4. Create OAuth 2.0 credentials (Desktop app)');
    console.log('5. Download JSON and save as: config/credentials.json');
    console.log('6. Run this script again\n');
    process.exit(1);
  }
  
  console.log('\n✅ credentials.json found!');
  console.log('🔐 Starting authentication...');
  
  const success = await firstTimeAuth();
  
  if (success) {
    console.log('\n🎉 Setup completed successfully!');
    console.log('📁 Auto-export will now upload to your Google Drive folder');
    console.log('🔄 Restart the server to start auto-export\n');
  } else {
    console.log('\n❌ Setup failed. Please try again.\n');
  }
}

setup();
