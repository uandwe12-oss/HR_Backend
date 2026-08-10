// config/multer.js
const multer = require('multer');

// Use memory storage - files will be stored in memory as buffers
// This is ideal for uploading directly to Google Drive
const storage = multer.memoryStorage();

// File filter for all document types
const fileFilter = (req, file, cb) => {
    console.log(`📄 Processing file: ${file.fieldname} - ${file.originalname} - ${file.mimetype}`);
    
    // Profile photo must be image only
    if (file.fieldname === 'profilePhoto') {
        const imageTypes = ['image/jpeg', 'image/jpg', 'image/png'];
        if (imageTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Profile photo must be an image (JPG or PNG only).'), false);
        }
    } 
    // Aadhar and PAN documents - PDF only
    else if (file.fieldname === 'aadharDocument' || file.fieldname === 'panDocument') {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error(`${file.fieldname} must be a PDF document.`), false);
        }
    } 
    // Other documents - PDF or images allowed
    else {
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPG, PNG, and PDF are allowed.'), false);
        }
    }
};

// Configure multer with memory storage
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit for all documents
    },
    fileFilter: fileFilter,
});

// Export configured multer and field names for easy use
module.exports = {
    upload,
    // Define all document fields for reuse
    documentFields: [
        { name: 'aadharDocument', maxCount: 1 },
        { name: 'panDocument', maxCount: 1 },
        { name: 'tenthCertificate', maxCount: 1 },
        { name: 'twelfthCertificate', maxCount: 1 },
        { name: 'resumeDocument', maxCount: 1 },
        { name: 'visaDocument', maxCount: 1 },
        { name: 'profilePhoto', maxCount: 1 },
        { name: 'graduationCertificate', maxCount: 1 },
        { name: 'postGraduationCertificate', maxCount: 1 }
    ]
};
