const express = require('express');
const router = express.Router();
const { initializeAllExports } = require('../services/autoExportMaster.js');
const EXPORT_CONFIGS = require('../services/exportConfigs.js');
const { executeAutoCancelAssetRelease } = require('../services/autoCancelAssetRelease.js');

// Create the exporter instance just for this cron invocation
const exporter = initializeAllExports(EXPORT_CONFIGS);

/**
 * @swagger
 * /api/cron/daily:
 *   get:
 *     summary: Execute all daily background cron jobs (used by Vercel Cron)
 *     tags: [Cron]
 *     responses:
 *       200:
 *         description: Successfully executed cron jobs
 */
router.get('/daily', async (req, res) => {
  try {
    // Optional: Protect route with a basic secret if CRON_SECRET is set in environment
    // Vercel cron jobs will send a Bearer token matching CRON_SECRET if configured.
    const authHeader = req.headers.authorization;
    if (process.env.CRON_SECRET) {
      if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }
    }

    console.log('\n[CRON] Starting daily cron jobs via API endpoint...');

    // 1. Run Asset Release auto canceler
    console.log('[CRON] Running auto-cancel asset release...');
    const cancelledCount = await executeAutoCancelAssetRelease();
    console.log(`[CRON] Auto-cancel finished. Cancelled ${cancelledCount || 0} requests.`);

    // 2. Run all exports
    console.log('[CRON] Running Google Drive auto-exports...');
    // initAll already loops through all configurations, checks if needed, and uploads if necessary
    await exporter.initAll();
    console.log('[CRON] Google Drive auto-exports finished.');

    console.log('[CRON] Daily cron jobs completed successfully.\n');
    return res.status(200).json({ success: true, message: 'Cron jobs executed successfully.' });
  } catch (error) {
    console.error('[CRON] Error executing daily cron jobs:', error);
    return res.status(500).json({ success: false, message: 'Error executing cron jobs', error: error.message });
  }
});

module.exports = router;
