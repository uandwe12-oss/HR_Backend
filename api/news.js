const express = require('express');
const router = express.Router();
const getDriver = require('../lib/neo4j');
const crypto = require('crypto');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const googleDriveService = require('../services/googleDrive');

// Get news items (optionally filtered by nationality)
router.get('/latest', async (req, res) => {
  const { nationality } = req.query;
  const driver = getDriver();
  const session = driver.session();
  try {
    let query = `
      MATCH (n:News)
      RETURN n
      ORDER BY n.createdAt ASC
    `;
    let params = {};

    if (nationality && nationality.toUpperCase() !== 'ALL') {
      query = `
        MATCH (n:News)
        WHERE n.nationality = $nationality OR n.nationality = 'ALL' OR n.nationality IS NULL OR n.nationality = ''
        RETURN n
        ORDER BY n.createdAt ASC
      `;
      params.nationality = nationality.toUpperCase();
    }

    const result = await session.run(query, params);

    const newsItems = result.records.map(record => record.get('n').properties);
    res.json({ success: true, data: newsItems });
  } catch (error) {
    console.error('Error fetching latest news:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch latest news' });
  } finally {
    await session.close();
  }
});

// Create or update news item
router.post('/', upload.array('media', 10), async (req, res) => {
  const { id, title, linkUrl, content, nationality, layoutOrder, mediaLayout } = req.body;
  
  let imageUrls = req.body.imageUrls ? JSON.parse(req.body.imageUrls) : [];
  let attachmentUrls = req.body.attachmentUrls ? JSON.parse(req.body.attachmentUrls) : [];
  let videoUrls = req.body.videoUrls ? JSON.parse(req.body.videoUrls) : [];

  if (req.files && req.files.length > 0) {
    for (const file of req.files) {
      try {
        if (file.mimetype.startsWith('image/')) {
          const uploadRes = await googleDriveService.uploadNewsImage(file.buffer, file.originalname, file.mimetype);
          if (uploadRes.success) imageUrls.push(uploadRes.directLink);
        } else if (file.mimetype.startsWith('video/')) {
          const uploadRes = await googleDriveService.uploadNewsAttachment(file.buffer, file.originalname, file.mimetype);
          if (uploadRes.success) videoUrls.push(uploadRes.directLink);
        } else {
          // Treat others as attachments/documents
          const uploadRes = await googleDriveService.uploadNewsAttachment(file.buffer, file.originalname, file.mimetype);
          if (uploadRes.success) attachmentUrls.push(uploadRes.directLink);
        }
      } catch (e) {
        console.error("Failed to upload media to drive:", e);
      }
    }
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    let result;
    if (id) {
      // Update existing
      result = await session.run(`
        MATCH (n:News {id: $id})
        SET n.title = $title,
            n.imageUrls = $imageUrls,
            n.attachmentUrls = $attachmentUrls,
            n.videoUrls = $videoUrls,
            n.linkUrl = $linkUrl,
            n.content = $content,
            n.nationality = $nationality,
            n.layoutOrder = $layoutOrder,
            n.mediaLayout = $mediaLayout
        RETURN n
      `, {
        id: id,
        title: title || '',
        imageUrls: imageUrls,
        attachmentUrls: attachmentUrls,
        videoUrls: videoUrls,
        linkUrl: linkUrl || '',
        content: content || '',
        nationality: (nationality || 'ALL').toUpperCase(),
        layoutOrder: layoutOrder || 'IMAGE_FIRST',
        mediaLayout: mediaLayout || 'STACKED'
      });
    } else {
      // Create new
      const countResult = await session.run('MATCH (n:News) RETURN count(n) as c');
      const countValue = countResult.records[0].get('c');
      const currentCount = typeof countValue.toNumber === 'function' ? countValue.toNumber() : Number(countValue);
      const newsId = `news_${currentCount + 1}`;
      result = await session.run(`
        CREATE (n:News {
          id: $id,
          title: $title,
          imageUrls: $imageUrls,
          attachmentUrls: $attachmentUrls,
          videoUrls: $videoUrls,
          linkUrl: $linkUrl,
          content: $content,
          nationality: $nationality,
          layoutOrder: $layoutOrder,
          mediaLayout: $mediaLayout,
          createdAt: $createdAt
        })
        RETURN n
      `, {
        id: newsId,
        title: title || '',
        imageUrls: imageUrls,
        attachmentUrls: attachmentUrls,
        videoUrls: videoUrls,
        linkUrl: linkUrl || '',
        content: content || '',
        nationality: (nationality || 'ALL').toUpperCase(),
        layoutOrder: layoutOrder || 'IMAGE_FIRST',
        mediaLayout: mediaLayout || 'STACKED',
        createdAt: new Date().toISOString()
      });

      // Send notifications to all applicable users
      const msgTitle = title ? title : "A new announcement has been posted";
      const message = `📰 Company News: ${msgTitle}`;
      const notifNationality = (nationality || 'ALL').toUpperCase();

      // Send Emails
      try {
        const usersResult = await session.run(`
          MATCH (u:User)
          OPTIONAL MATCH (p:PersonalDetails {userId: u.username})
          WITH DISTINCT u, coalesce(p.nationality, 'ALL') AS userNat, coalesce(p.profileStatus, 'PENDING') AS pStatus
          WHERE ($nat = 'ALL' OR userNat = $nat OR userNat = '' OR userNat IS NULL)
            AND (u.role IN ['Admin', 'HR', 'Finance', 'Management'] OR pStatus = 'APPROVED')
          RETURN u.email AS email
        `, { nat: notifNationality });

        const { sendEmail } = require('../services/emailService');
        const emailPromises = usersResult.records.map(async (record) => {
          const recipientEmail = record.get("email");
          if (recipientEmail) {
            try {
              await sendEmail({
                to: recipientEmail,
                subject: msgTitle,
                html: `
                  <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <h2>Hello,</h2>
                    <p>A new announcement has been posted in the <b>Company News Feed</b>.</p>
                    <p><strong>${msgTitle}</strong></p>
                    <p>Please log in to the portal to view the details.</p>
                    <br/>
                    <p>Best Regards,</p>
                    <p>Your HR Team</p>
                  </div>
                `
              });
            } catch (e) {
              console.error("Failed to send email to", recipientEmail, e);
            }
          }
        });
        await Promise.all(emailPromises);
      } catch (err) {
        console.error("Failed to process email notifications:", err);
      }

      await session.run(`
        MATCH (u:User)
        OPTIONAL MATCH (p:PersonalDetails {userId: u.username})
        WITH DISTINCT u, coalesce(p.nationality, 'ALL') AS userNat, coalesce(p.profileStatus, 'PENDING') AS pStatus
        WHERE ($nat = 'ALL' OR userNat = $nat OR userNat = '' OR userNat IS NULL)
          AND (u.role IN ['Admin', 'HR', 'Finance', 'Management'] OR pStatus = 'APPROVED')
        CREATE (n:Notification {
          id: randomUUID(),
          userId: u.username,
          message: $message,
          type: 'News',
          isRead: false,
          createdAt: $createdAt
        })
      `, {
        message,
        nat: notifNationality,
        createdAt: new Date().toISOString()
      });
    }

    res.json({ success: true, message: 'News item published successfully', data: result.records[0].get('n').properties });
  } catch (error) {
    console.error('Error publishing news:', error);
    res.status(500).json({ success: false, message: 'Failed to publish news' });
  } finally {
    await session.close();
  }
});

// Delete a specific news item
router.delete('/:id', async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const fetchResult = await session.run(`
      MATCH (n:News {id: $id})
      RETURN n.imageUrls AS imageUrls, n.attachmentUrls AS attachmentUrls, n.videoUrls AS videoUrls
    `, { id: req.params.id });

    if (fetchResult.records.length > 0) {
      const record = fetchResult.records[0];
      const imageUrls = record.get('imageUrls') || [];
      const attachmentUrls = record.get('attachmentUrls') || [];
      const videoUrls = record.get('videoUrls') || [];

      const extractDriveId = (url) => {
        if (!url) return null;
        const patterns = [
          /\/file\/d\/([a-zA-Z0-9_-]{10,})/,
          /\/d\/([a-zA-Z0-9_-]{10,})\//,
          /[?&]id=([a-zA-Z0-9_-]{10,})/,
          /open\?id=([a-zA-Z0-9_-]{10,})/,
          /uc\?id=([a-zA-Z0-9_-]{10,})/
        ];
        for (const p of patterns) {
          const m = url.match(p);
          if (m) return m[1];
        }
        return null;
      };

      const allUrls = [...imageUrls, ...attachmentUrls, ...videoUrls];
      const filesToDelete = allUrls
        .map(extractDriveId)
        .filter(id => id); // Remove nulls

      for (const fileId of filesToDelete) {
        try {
          await googleDriveService.deleteFileFromDrive(fileId);
        } catch (err) {
          console.error(`Failed to delete file from drive: ${fileId}`, err);
        }
      }
    }

    await session.run(`
      MATCH (n:News {id: $id})
      DELETE n
    `, { id: req.params.id });
    res.json({ success: true, message: 'News deleted successfully' });
  } catch (error) {
    console.error('Error deleting news:', error);
    res.status(500).json({ success: false, message: 'Failed to delete news' });
  } finally {
    await session.close();
  }
});

module.exports = router;
