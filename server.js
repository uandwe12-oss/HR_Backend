require("dotenv").config();
const express = require("express");
const swaggerUi = require("swagger-ui-express");
const swaggerJsdoc = require("swagger-jsdoc");
const path = require('path');
const fs = require('fs');
const { initializeAllExports } = require('./services/autoExportMaster.js');
const EXPORT_CONFIGS = require('./services/exportConfigs.js');
const { startAutoCancelAssetReleaseScheduler } = require('./services/autoCancelAssetRelease.js');
const { verifyToken } = require('./middleware/auth');
const app = express();
const PORT = process.env.PORT || 5000;



async function initializeServices() {
  console.log('\n🔧 Initializing services...');
  await initAutoExport();
  startAutoExportScheduler();
  startDemandAutoExportScheduler();
  startAutoCancelAssetReleaseScheduler();
}

/* ================================
   CORS CONFIG
================================ */

const allowedOrigins = [
  "http://localhost:5173",
  "https://myuandwe.vercel.app",
  "https://uandwe.com",
  "https://www.uandwe.com"
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS,HEAD");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Company-Id");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  const company = req.headers['x-company-id'] || 'default';
  req.company = company;
  if (req.method !== 'OPTIONS') {

  }
  next();
});

/* ================================
   BODY PARSER
================================ */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.locals.company = req.company;
  next();
});



/* ================================
   SWAGGER CONFIG - COMPLETE FIX
================================ */

// Force localhost only - NO Azure URL
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "HR Backend API",
      version: "1.0.0",
      description: "Local Development API Documentation",
    },
    servers: [
      {
        url: `https://myuandwe-a3anhhcfewcvffhk.centralindia-01.azurewebsites.net`,
        description: "Local Development Server"
      }
    ],
  },
  apis: ["./api/*.js"]
};

let swaggerSpec;
try {
  swaggerSpec = swaggerJsdoc(swaggerOptions);
  console.log(`✅ Swagger initialized with ${Object.keys(swaggerSpec.paths || {}).length} endpoints`);
} catch (error) {
  console.error("❌ Swagger initialization error:", error);
  swaggerSpec = { openapi: "3.0.0", info: { title: "API", version: "1.0.0" }, paths: {} };
}







/* ================================
   ROUTES
================================ */
// ── Public routes (no token needed) ──────────────────────────────
app.use("/api/auth", require("./api/auth"));   // SSO Auth
app.use("/api/login", require("./api/login")); // Normal login

// ── Protected routes (valid JWT required) ────────────────────────
app.use("/api/demand", verifyToken, require("./api/demand"));
app.use("/api/candidates", verifyToken, require("./api/candidates"));
app.use("/api/skills", verifyToken, require("./api/skills"));
app.use("/api/skillsmatch", verifyToken, require("./api/skillsmatch"));
app.use("/api/shortcandidates", verifyToken, require("./api/shortcandidates"));
app.use("/api/users", verifyToken, require("./api/users"));
app.use("/api/selected-candidates", verifyToken, require("./api/selectedCandidates"));
app.use("/api/zone", verifyToken, require("./api/zone"));
app.use("/api/holiday", verifyToken, require("./api/holiday"));
app.use('/api/personal-details', verifyToken, require("./api/personalDetails"));
app.use("/api/visa", verifyToken, require("./api/visa"));
app.use("/api/policy", verifyToken, require("./api/policy"));
app.use('/api/profile-approval', verifyToken, require("./api/profileApproval"));
app.use('/api/salary-advance', verifyToken, require('./api/salaryAdvance'));
app.use("/api/insurance-policies", verifyToken, require('./api/Insurance'));
app.use("/api/employeeassets", verifyToken, require("./api/employeeassets"));
app.use("/api/birthday", verifyToken, require("./api/birthdayWishes"));
app.use("/api/reimbursements", verifyToken, require("./api/reimbursement"));
app.use("/api/leave", verifyToken, require("./api/leave"));
app.use("/api/payroll", verifyToken, require("./api/payroll"));
app.use("/api/teams", verifyToken, require("./api/teams"));
app.use("/api/notifications", verifyToken, require("./api/notifications"));
app.use("/api/allocations", verifyToken, require("./api/allocations"));
app.use("/api/timesheet", verifyToken, require("./api/timesheet"));
app.use("/api/news", verifyToken, require("./api/news"));
app.use("/api/field-config", verifyToken, require("./api/fieldConfig"));
app.use("/api/home-config", verifyToken, require("./api/homeConfig"));
app.use("/api/training", verifyToken, require("./api/training"));

/* ================================
   TEST ROUTE
================================ */

app.get("/api/test", (req, res) => {
  res.json({
    success: true,
    message: "Server is running",
    time: new Date(),
    port: PORT,
    environment: process.env.NODE_ENV || 'development'
  });
});

/* ================================
   ERROR HANDLER
================================ */

app.use((err, req, res, next) => {
  console.error("Server Error:", err);
  res.status(500).json({
    success: false,
    message: err.message || "Internal Server Error"
  });
});



/* ================================
START SERVER
================================ */

async function startServer() {
  try {
    await initializeServices();

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`✅ All services initialized successfully!\n`);
    });

  } catch (error) {
    console.error("❌ Failed to initialize services:", error);
    process.exit(1);
  }
}

startServer();

module.exports = app;



