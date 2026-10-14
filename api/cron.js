const express = require('express');
const router = express.Router();
const { initializeAllExports } = require('../services/autoExportMaster.js');
const EXPORT_CONFIGS = require('../services/exportConfigs.js');
const { executeAutoCancelAssetRelease } = require('../services/autoCancelAssetRelease.js');
const { checkAndSendDocumentExpiryNotifications, sendSampleDocumentExpiryEmail } = require('../services/documentExpiryNotifier.js');

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

    // 3. Run Document Expiry Notifications (2-month alert)
    console.log('[CRON] Checking document 2-month expiry notifications...');
    const expiryReport = await checkAndSendDocumentExpiryNotifications();
    console.log(`[CRON] Document expiry check finished. Sent ${expiryReport?.emailsSent || 0} notification(s).`);

    console.log('[CRON] Daily cron jobs completed successfully.\n');
    return res.status(200).json({ success: true, message: 'Cron jobs executed successfully.', expiryReport });
  } catch (error) {
    console.error('[CRON] Error executing daily cron jobs:', error);
    return res.status(500).json({ success: false, message: 'Error executing cron jobs', error: error.message });
  }
});

/**
 * GET /api/cron/test-document-expiry
 * Quick test endpoint: checks all documents in Neo4j and triggers notifications if any are within 60 days
 */
router.get('/test-document-expiry', async (req, res) => {
  try {
    const force = req.query.force !== 'false'; // Default to true for testing so it always checks
    const report = await checkAndSendDocumentExpiryNotifications({ force });
    res.json({
      success: true,
      message: 'Document expiry check completed',
      report
    });
  } catch (error) {
    console.error('[CRON] Error during test document expiry check:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/cron/test-sample-email
 * Quick test endpoint: immediately sends a test 2-month expiry alert email to bharill@kyotralis.com and swathi@uandwe.com
 */
router.get('/test-sample-email', async (req, res) => {
  try {
    const report = await sendSampleDocumentExpiryEmail();
    res.json({
      success: true,
      message: 'Sample test email dispatched to recipients',
      report
    });
  } catch (error) {
    console.error('[CRON] Error sending test sample email:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
