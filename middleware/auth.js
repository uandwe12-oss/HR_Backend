const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET is not set in environment variables. Server will not protect routes correctly.');
}

/**
 * verifyToken - Middleware that checks every request has a valid JWT.
 * Attaches decoded user info to req.user for downstream route handlers.
 */
const verifyToken = (req, res, next) => {
  // Extract token from Authorization header: "Bearer <token>"
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Access denied. No token provided. Please log in.'
    });
  }

  try {
    const secret = JWT_SECRET || 'supersecretjwtkey';
    const decoded = jwt.verify(token, secret);
    req.user = decoded; // attach user info to request
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please log in again.',
        expired: true
      });
    }
    return res.status(403).json({
      success: false,
      message: 'Invalid token. Please log in again.'
    });
  }
};

/**
 * requireAdmin - Must be used AFTER verifyToken.
 * Blocks access if the authenticated user is not an Admin.
 */
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'Admin') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Admin privileges required.'
    });
  }
  next();
};

/**
 * requireRole(...roles) - Must be used AFTER verifyToken.
 * Blocks access if the authenticated user's role is not in the allowed list.
 * Usage: requireRole('Admin', 'HR')
 */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Access denied. Required role: ${roles.join(' or ')}.`
    });
  }
  next();
};

module.exports = { verifyToken, requireAdmin, requireRole };
