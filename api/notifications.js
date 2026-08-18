const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");
const crypto = require("crypto");
const cron = require("node-cron");

// Get unread notifications for a user
router.get("/user/:userId", async (req, res) => {
  const driver = getDriver();
  if (!driver) return res.status(500).json({ success: false, message: "No DB connection" });
  
  const session = driver.session();
  const { userId } = req.params;
  
  try {
    const result = await session.run(`
      MATCH (n:Notification {userId: $userId})
      RETURN n {.*} as notification
      ORDER BY n.createdAt DESC
      LIMIT 50
    `, { userId });
    
    const notifications = result.records.map(record => record.get("notification"));
    
    // Also get unread count
    const countResult = await session.run(`
      MATCH (n:Notification {userId: $userId, isRead: false})
      RETURN count(n) as count
    `, { userId });
    
    const countRaw = countResult.records[0].get("count");
    const unreadCount = typeof countRaw.toNumber === 'function' ? countRaw.toNumber() : Number(countRaw);
    
    res.json({ success: true, data: notifications, unreadCount });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// Mark notification as read
router.put("/read/:id", async (req, res) => {
  const driver = getDriver();
  if (!driver) return res.status(500).json({ success: false, message: "No DB connection" });
  
  const session = driver.session();
  const { id } = req.params;
  
  try {
    await session.run(`
      MATCH (n:Notification {id: $id})
      SET n.isRead = true
    `, { id });
    
    res.json({ success: true, message: "Notification marked as read" });
  } catch (error) {
    console.error("Error marking notification as read:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// Mark all as read
router.put("/read-all/:userId", async (req, res) => {
  const driver = getDriver();
  if (!driver) return res.status(500).json({ success: false, message: "No DB connection" });
  
  const session = driver.session();
  const { userId } = req.params;
  
  try {
    await session.run(`
      MATCH (n:Notification {userId: $userId, isRead: false})
      SET n.isRead = true
    `, { userId });
    
    res.json({ success: true, message: "All notifications marked as read" });
  } catch (error) {
    console.error("Error marking all notifications as read:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// Schedule a job to run every day at midnight (0 0 * * *)
// to delete notifications older than 30 days.
cron.schedule('0 0 * * *', async () => {
  const driver = getDriver();
  if (!driver) {
    console.error("Cron Job: No DB connection for notification cleanup.");
    return;
  }
  
  const session = driver.session();
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoIso = thirtyDaysAgo.toISOString();
    
    const result = await session.run(`
      MATCH (n:Notification)
      WHERE n.createdAt < $thirtyDaysAgoIso
      DELETE n
      RETURN count(n) as deletedCount
    `, { thirtyDaysAgoIso });
    
    if (result.records.length > 0) {
      const countRaw = result.records[0].get("deletedCount");
      const deletedCount = typeof countRaw.toNumber === 'function' ? countRaw.toNumber() : Number(countRaw);
      
      if (deletedCount > 0) {
        console.log(`🧹 Notification Cleanup: Deleted ${deletedCount} notifications older than 30 days.`);
      }
    }
  } catch (error) {
    console.error("Error running notification cleanup cron job:", error);
  } finally {
    await session.close();
  }
});

module.exports = router;
