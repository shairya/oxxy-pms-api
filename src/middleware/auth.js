const jwt = require("jsonwebtoken");
const db = require("../config/mysql");
const { HttpError, asyncHandler } = require("../utils/http");

// Verifies the JWT, then re-loads the user from the DB on every request
// so a deactivated user is locked out immediately (not when the token expires).
const requireAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new HttpError(401, "Not logged in");

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    throw new HttpError(401, "Session expired, please log in again");
  }

  const [rows] = await db.execute(
    "SELECT id, full_name, email, role, is_active FROM users WHERE id = ?",
    [payload.sub],
  );
  const user = rows[0];
  if (!user || !user.is_active) throw new HttpError(401, "Account is inactive");

  req.user = user;
  next();
});

const requireAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") return next(new HttpError(403, "Admin only"));
  next();
};

module.exports = { requireAuth, requireAdmin };
