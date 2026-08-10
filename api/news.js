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
router.post('/', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'attachment', maxCount: 1 }]), async (req, res) => {
  const { id, title, linkUrl, content, nationality, layoutOrder } = req.body;
  let imageUrl = req.body.imageUrl || '';
  let attachmentUrl = req.body.attachmentUrl || '';

  if (req.files && req.files['image'] && req.files['image'][0]) {
    try {
      const uploadRes = await googleDriveService.uploadNewsImage(
        req.files['image'][0].buffer,
        req.files['image'][0].originalname,
        req.files['image'][0].mimetype
      );
      if (uploadRes.success) {
        imageUrl = uploadRes.directLink;
      }
    } catch (e) {
      console.error("Failed to upload news image to drive:", e);
    }
  }

  if (req.files && req.files['attachment'] && req.files['attachment'][0]) {
    try {
      const uploadRes = await googleDriveService.uploadNewsAttachment(
        req.files['attachment'][0].buffer,
        req.files['attachment'][0].originalname,
        req.files['attachment'][0].mimetype
      );
      if (uploadRes.success) {
        attachmentUrl = uploadRes.directLink;
      }
    } catch (e) {
      console.error("Failed to upload news attachment to drive:", e);
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
            n.imageUrl = CASE WHEN $imageUrl <> '' THEN $imageUrl ELSE n.imageUrl END,
            n.attachmentUrl = CASE WHEN $attachmentUrl <> '' THEN $attachmentUrl ELSE n.attachmentUrl END,
            n.linkUrl = $linkUrl,
            n.content = $content,
            n.nationality = $nationality,
            n.layoutOrder = $layoutOrder
        RETURN n
      `, {
        id: id,
        title: title || '',
        imageUrl: imageUrl || '',
        attachmentUrl: attachmentUrl || '',
        linkUrl: linkUrl || '',
        content: content || '',
        nationality: (nationality || 'ALL').toUpperCase(),
        layoutOrder: layoutOrder || 'IMAGE_FIRST'
      });
    } else {
      // Create new
      const newsId = crypto.randomUUID();
      result = await session.run(`
        CREATE (n:News {
          id: $id,
          title: $title,
          imageUrl: $imageUrl,
          attachmentUrl: $attachmentUrl,
          linkUrl: $linkUrl,
          content: $content,
          nationality: $nationality,
          layoutOrder: $layoutOrder,
          createdAt: $createdAt
        })
        RETURN n
      `, {
        id: newsId,
        title: title || '',
        imageUrl: imageUrl || '',
        attachmentUrl: attachmentUrl || '',
        linkUrl: linkUrl || '',
        content: content || '',
        nationality: (nationality || 'ALL').toUpperCase(),
        layoutOrder: layoutOrder || 'IMAGE_FIRST',
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
