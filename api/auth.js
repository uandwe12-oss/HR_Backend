const express = require("express");
const router = express.Router();
const msal = require("@azure/msal-node");
const jwt = require("jsonwebtoken");
const getDriver = require("../lib/neo4j");
const fs = require("fs");
const path = require("path");

// ==========================================
// Microsoft MSAL Configuration
// ==========================================

const msalConfig = {
  auth: {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    authority: "https://login.microsoftonline.com/common",
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
  },
};

const pca = new msal.ConfidentialClientApplication(msalConfig);

// ==========================================
// 1. Initiate Microsoft Login
// ==========================================

router.get("/microsoft", async (req, res) => {
  const authCodeUrlParameters = {
    scopes: ["User.Read"],
    redirectUri: process.env.MICROSOFT_REDIRECT_URI,
  };

  try {
    const response = await pca.getAuthCodeUrl(authCodeUrlParameters);

    console.log("Microsoft login URL generated successfully");

    res.redirect(response);
  } catch (error) {
    console.error("Error generating MSAL auth URL:", error);

    res.status(500).send("Error initiating Microsoft login");
  }
});

// ==========================================
// 2. Microsoft Login Callback
// ==========================================

router.get("/microsoft/callback", async (req, res) => {
  const code = req.query.code;

  // Check whether Microsoft returned an authorization code
  if (!code) {
    console.error("Microsoft callback did not contain an authorization code");

return res.redirect(
  "https://uandwe.com/myuandwe/login?error=MissingAuthorizationCode"
);
  }

  const tokenRequest = {
    code: code,
    scopes: ["User.Read"],
    redirectUri: process.env.MICROSOFT_REDIRECT_URI,
  };

  try {
    // ==========================================
    // Exchange Microsoft authorization code
    // for Microsoft access token
    // ==========================================

    const response = await pca.acquireTokenByCode(tokenRequest);

    if (!response || !response.account) {
      console.error("Microsoft account information was not returned");

      return res.redirect(
"https://uandwe.com/myuandwe/login?error=MicrosoftAccountMissing"      );
    }

    const account = response.account;

    // ==========================================
    // Get Microsoft user's details
    // ==========================================

    const email = account.username;
    const displayName = account.name || (email ? email.split('@')[0] : "New User");

    if (!email) {
      console.error("Microsoft email was not returned");

      return res.redirect(
"https://uandwe.com/myuandwe/login?error=EmailMissing"      );
    }

    const normalizedEmail = email.toLowerCase().trim();

    console.log("Microsoft login email:", normalizedEmail);

    // ==========================================
    // 3. Allowed Organization Check
    // ==========================================

    let allowedDomains = [];
    try {
      const configPath = path.join(__dirname, '../config/allowedDomains.json');
      const configData = fs.readFileSync(configPath, 'utf8');
      allowedDomains = JSON.parse(configData).allowedDomains;
    } catch (err) {
      console.error("Error reading allowed domains config:", err);
      // Fallback
      allowedDomains = [
        "@kyotralis.com",
        "@uandwelabs.com",
      ];
    }

    const isAllowedDomain = allowedDomains.some((domain) =>
      normalizedEmail.endsWith(domain)
    );

    if (!isAllowedDomain) {
      console.log(
        "Unauthorized Microsoft domain:",
        normalizedEmail
      );

      return res.redirect(
"https://uandwe.com/myuandwe/login?error=UnauthorizedDomain"      );
    }

    console.log(
      "Microsoft domain is allowed:",
      normalizedEmail
    );

    // ==========================================
    // 4. Check User in Neo4j
    // ==========================================

    const driver = getDriver();
    const session = driver.session();

    try {
      const result = await session.run(
        `
        MATCH (u:User)
        WHERE toLower(u.username) = $email
        RETURN
          u.username AS username,
          u.role AS role,
          u.name AS name,
          u.assignedClient AS assignedClient
        `,
        {
          email: normalizedEmail,
        }
      );

      // ==========================================
      // User does not exist in Neo4j (Auto-Register)
      // ==========================================

      if (result.records.length === 0) {
        console.log(
          "Microsoft user not found in Neo4j. Auto-registering:",
          normalizedEmail
        );

        const createdAt = new Date().toISOString();

        await session.run(
          `
          CREATE (u:User {
            username: $email,
            role: "Pending",
            name: $name,
            createdAt: $createdAt
          })
          `,
          {
            email: normalizedEmail,
            name: displayName,
            createdAt: createdAt
          }
        );

        // Set the userObj for the new user
        var username = normalizedEmail;
        var role = "Pending";
        var name = displayName;
        var assignedClient = null;

      } else {
        // ==========================================
        // User found
        // ==========================================

        const record = result.records[0];

        var username = record.get("username");
        var role = record.get("role");
        var name = record.get("name") || normalizedEmail;
        var assignedClient = record.get("assignedClient");

        console.log(
          "Neo4j user found:",
          username
        );
      }

      // ==========================================
      // 5. Create Application User Object
      // ==========================================

      const userObj = {
        username: username,
        name: name,
        role: role,
        clientName: assignedClient,
      };

      // ==========================================
      // 6. Generate Application JWT
      // ==========================================

      const jwtSecret =
        process.env.JWT_SECRET || "supersecretjwtkey";

      const token = jwt.sign(
        userObj,
        jwtSecret,
        {
          expiresIn: "1h",
        }
      );

      console.log(
        "JWT generated successfully for:",
        normalizedEmail
      );

      // ==========================================
      // 7. Redirect to React SSO Callback
      // ==========================================

  res.redirect(
  `https://uandwe.com/myuandwe/sso-callback?token=${encodeURIComponent(
    token
  )}`
);
    } finally {
      await session.close();
    }
  } catch (error) {
    // ==========================================
    // Microsoft Token Error
    // ==========================================

    console.error(
      "=========================================="
    );
    console.error(
      "Error acquiring token from Microsoft"
    );
    console.error(
      "=========================================="
    );

    console.error("Error code:", error.errorCode);
    console.error("Error message:", error.errorMessage);
    console.error("Sub error:", error.subError);
    console.error("Correlation ID:", error.correlationId);
    console.error("Full error:", error);

    return res.redirect(
"https://uandwe.com/myuandwe/login?error=SSOFailed"    );
  }
});

// ==========================================
// Export Router
// ==========================================

module.exports = router;
