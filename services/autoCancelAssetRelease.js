const cron = require('node-cron');
const getDriver = require('../lib/neo4j');

function startAutoCancelAssetReleaseScheduler() {
  // Run daily at midnight
  cron.schedule('0 0 * * *', async () => {
    console.log("🕒 Running auto-cancel asset release job...");
    const driver = getDriver();
    const session = driver.session();
    
    try {
      const result = await session.run(`
        MATCH (a:EmployeeAsset)
        RETURN a
      `);
      
      let updatedCount = 0;
      
      for (const record of result.records) {
        const node = record.get("a").properties;
        let assetsArray = typeof node.assets === 'string' ? JSON.parse(node.assets) : (node.assets || []);
        let modified = false;
        
        for (let i = 0; i < assetsArray.length; i++) {
          const asset = assetsArray[i];
          if (asset.release_requested && asset.release_request_date) {
            const requestDate = new Date(asset.release_request_date);
            const now = new Date();
            const diffTime = Math.abs(now - requestDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            if (diffDays > 3) {
              // Cancel the request
              asset.release_requested = false;
              asset.release_request_date = null;
              modified = true;
              updatedCount++;
            }
          }
        }
        
        if (modified) {
          await session.run(`
            MATCH (a:EmployeeAsset {id: $id})
            SET a.assets = $assetsStr
          `, { id: node.id, assetsStr: JSON.stringify(assetsArray) });
        }
      }
      
      console.log(`✅ Auto-cancel asset release job completed. Cancelled ${updatedCount} requests.`);
    } catch (err) {
      console.error("❌ Error in auto-cancel asset release job:", err);
    } finally {
      await session.close();
    }
  });
}

module.exports = { startAutoCancelAssetReleaseScheduler };
