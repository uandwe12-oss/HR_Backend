require("dotenv").config();
const express = require("express");
const swaggerUi = require("swagger-ui-express");
const swaggerJsdoc = require("swagger-jsdoc");
const path = require('path');
const fs = require('fs');
const { startAutoExportScheduler, initAutoExport } = require('./services/autoExport');
const { startDemandAutoExportScheduler } = require('./services/autoExportDemand');

const app = express();
const PORT = process.env.PORT || 5000;

async function initializeServices() {
  console.log('\n🔧 Initializing services...');
  await initAutoExport();
  startAutoExportScheduler();
  startDemandAutoExportScheduler();
}

/* ================================
   CORS CONFIG
================================ */

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5173/myuandwe",
  "http://localhost:3000",
  "https://myuandwe.vercel.app"
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
        url:'https://myuandwe-a3anhhcfewcvffhk.centralindia-01.azurewebsites.net'
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





// Debug endpoint


/* ================================
   ROUTES
================================ */

app.use("/api/login", require("./api/login"));
app.use("/api/demand", require("./api/demand"));
app.use("/api/candidates", require("./api/candidates"));
app.use("/api/skills", require("./api/skills"));
app.use("/api/skillsmatch", require("./api/skillsmatch"));
app.use("/api/shortcandidates", require("./api/shortcandidates"));
app.use("/api/users", require("./api/users"));
app.use("/api/selected-candidates", require("./api/selectedCandidates"));
app.use("/api/zone", require("./api/zone"));
app.use("/api/holiday", require("./api/holiday"));
app.use('/api/personal-details', require("./api/personalDetails"));
app.use("/api/visa", require("./api/visa"));


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



module.exports = app;
