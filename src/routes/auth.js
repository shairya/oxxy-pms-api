const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../config/mysql");
const { requireAuth } = require("../middleware/auth");
const { HttpError, asyncHandler } = require("../utils/http");

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const email = String(req.body.email || "").toLowerCase().trim();
    const password = String(req.body.password || "");
    if (!email || !password) throw new HttpError(400, "Email and password are required");

    const [rows] = await db.execute("SELECT * FROM users WHERE email = ?", [email]);
    const user = rows[0];
    // Same message for every failure so emails can't be enumerated
    if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
      throw new HttpError(401, "Invalid email or password");
    }

    const token = jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || "8h",
    });
    res.json({
      token,
      user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role },
    });
  }),
);

router.get("/me", requireAuth, (req, res) => {
  const { id, full_name, email, role } = req.user;
  res.json({ id, full_name, email, role });
});

router.post(
  "/change-password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || String(newPassword).length < 8) {
      throw new HttpError(400, "New password must be at least 8 characters");
    }
    const [rows] = await db.execute("SELECT password_hash FROM users WHERE id = ?", [req.user.id]);
    if (!(await bcrypt.compare(String(currentPassword || ""), rows[0].password_hash))) {
      throw new HttpError(400, "Current password is incorrect");
    }
    const hash = await bcrypt.hash(String(newPassword), 12);
    await db.execute("UPDATE users SET password_hash = ? WHERE id = ?", [hash, req.user.id]);
    res.json({ message: "Password changed" });
  }),
);

module.exports = router;
