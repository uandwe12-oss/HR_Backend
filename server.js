require("dotenv").config();
const express = require("express");
const swaggerUi = require("swagger-ui-express");
const swaggerJsdoc = require("swagger-jsdoc");

const app = express();

/* ================================
   CORS CONFIG (VERCEL SAFE)
================================ */

const allowedOrigins = [
  "http://localhost:5173",
  "https://myuandwe.vercel.app",
  "https://uandwe.com"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  next();
});

/* ================================
   BODY PARSER
================================ */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
   SWAGGER CONFIG
================================ */

const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "HR Backend API",
      version: "1.0.0",
      description: "API documentation"
    },
    servers: [
      {
        url: process.env.BASE_URL || "http://localhost:5000"
      }
    ]
  },
  apis: ["./api/*.js"]
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

/* ================================
   TEST ROUTE
================================ */

app.get("/api/test", (req, res) => {
  res.json({
    success: true,
    message: "Server is running",
    time: new Date()
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

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Personal details API available at: http://localhost:${PORT}/api/personal-details`);
});

module.exports = app;