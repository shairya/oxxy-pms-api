// Admin-only user management
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const db = require("../config/mysql");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { HttpError, asyncHandler, toId } = require("../utils/http");
const { reassignOpenTasks } = require("../services/reassign");
const { logActivity } = require("../services/activity");

router.use(requireAuth, requireAdmin);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const [users] = await db.execute(
      `SELECT u.id, u.full_name, u.email, u.role, u.is_active, u.created_at,
              GROUP_CONCAT(pm.project_id) AS project_ids
       FROM users u
       LEFT JOIN project_members pm ON pm.user_id = u.id
       GROUP BY u.id
       ORDER BY u.is_active DESC, u.full_name ASC`,
    );
    res.json(
      users.map((u) => ({
        ...u,
        is_active: !!u.is_active,
        project_ids: u.project_ids ? u.project_ids.split(",").map(Number) : [],
      })),
    );
  }),
);

// Create a member account (admins are created only via the CLI script)
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const fullName = String(req.body.full_name || "").trim();
    const email = String(req.body.email || "").toLowerCase().trim();
    const password = String(req.body.password || "");
    const projectIds = Array.isArray(req.body.project_ids) ? req.body.project_ids.map(toId) : [];

    if (!fullName || !EMAIL_RE.test(email)) throw new HttpError(400, "Valid name and email are required");
    if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const hash = await bcrypt.hash(password, 12);
      const [r] = await conn.execute(
        "INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, 'member')",
        [fullName, email, hash],
      );
      for (const pid of projectIds) {
        await conn.execute(
          "INSERT INTO project_members (project_id, user_id, added_by) VALUES (?, ?, ?)",
          [pid, r.insertId, req.user.id],
        );
        await logActivity({ projectId: pid, userId: req.user.id, action: "member_added", newValue: r.insertId }, conn);
      }
      await conn.commit();
      res.status(201).json({ id: r.insertId });
    } catch (e) {
      await conn.rollback();
      if (e.code === "ER_DUP_ENTRY") throw new HttpError(409, "Email already registered");
      if (e.code === "ER_NO_REFERENCED_ROW_2") throw new HttpError(400, "Unknown project");
      throw e;
    } finally {
      conn.release();
    }
  }),
);

// Update name / email / active flag. Deactivating hands open tasks to an admin.
router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const [rows] = await db.execute("SELECT * FROM users WHERE id = ?", [id]);
    const target = rows[0];
    if (!target) throw new HttpError(404, "User not found");

    const updates = {};
    if (req.body.full_name !== undefined) {
      const v = String(req.body.full_name).trim();
      if (!v) throw new HttpError(400, "Name cannot be empty");
      updates.full_name = v;
    }
    if (req.body.email !== undefined) {
      const v = String(req.body.email).toLowerCase().trim();
      if (!EMAIL_RE.test(v)) throw new HttpError(400, "Invalid email");
      updates.email = v;
    }
    if (req.body.is_active !== undefined) {
      updates.is_active = !!req.body.is_active;
      if (!updates.is_active && id === req.user.id) {
        throw new HttpError(400, "You cannot deactivate your own account");
      }
    }
    if (Object.keys(updates).length === 0) return res.json({ message: "Nothing to update" });

    const conn = await db.getConnection();
    let reassigned = 0;
    try {
      await conn.beginTransaction();
      const cols = Object.keys(updates);
      await conn.execute(
        `UPDATE users SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
        [...cols.map((c) => updates[c]), id],
      );
      if (updates.is_active === false && target.is_active) {
        reassigned = await reassignOpenTasks(conn, {
          userId: id,
          actorId: req.user.id,
          reason: `${target.full_name} was deactivated`,
        });
        await logActivity({ userId: req.user.id, action: "user_deactivated", newValue: id }, conn);
      } else if (updates.is_active === true && !target.is_active) {
        await logActivity({ userId: req.user.id, action: "user_reactivated", newValue: id }, conn);
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      if (e.code === "ER_DUP_ENTRY") throw new HttpError(409, "Email already registered");
      throw e;
    } finally {
      conn.release();
    }
    res.json({ message: "User updated", reassigned_tasks: reassigned });
  }),
);

router.post(
  "/:id/reset-password",
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const password = String(req.body.password || "");
    if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
    const hash = await bcrypt.hash(password, 12);
    const [r] = await db.execute("UPDATE users SET password_hash = ? WHERE id = ?", [hash, id]);
    if (r.affectedRows === 0) throw new HttpError(404, "User not found");
    res.json({ message: "Password reset" });
  }),
);

// Replace the full list of projects a member can access.
// Projects removed from the list trigger reassignment of that user's open tasks there.
router.put(
  "/:id/projects",
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const wanted = new Set((req.body.project_ids || []).map(toId));

    const [urows] = await db.execute("SELECT * FROM users WHERE id = ?", [id]);
    const target = urows[0];
    if (!target) throw new HttpError(404, "User not found");
    if (target.role === "admin") throw new HttpError(400, "Admins already have access to every project");

    const conn = await db.getConnection();
    let reassigned = 0;
    try {
      await conn.beginTransaction();
      const [current] = await conn.execute("SELECT project_id FROM project_members WHERE user_id = ?", [id]);
      const have = new Set(current.map((r) => r.project_id));

      for (const pid of wanted) {
        if (have.has(pid)) continue;
        await conn.execute(
          "INSERT INTO project_members (project_id, user_id, added_by) VALUES (?, ?, ?)",
          [pid, id, req.user.id],
        );
        await logActivity({ projectId: pid, userId: req.user.id, action: "member_added", newValue: id }, conn);
      }
      for (const pid of have) {
        if (wanted.has(pid)) continue;
        await conn.execute("DELETE FROM project_members WHERE project_id = ? AND user_id = ?", [pid, id]);
        await logActivity({ projectId: pid, userId: req.user.id, action: "member_removed", oldValue: id }, conn);
        reassigned += await reassignOpenTasks(conn, {
          userId: id,
          projectId: pid,
          actorId: req.user.id,
          reason: `${target.full_name} was removed from the project`,
        });
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      if (e.code === "ER_NO_REFERENCED_ROW_2") throw new HttpError(400, "Unknown project");
      throw e;
    } finally {
      conn.release();
    }
    res.json({ message: "Project access updated", reassigned_tasks: reassigned });
  }),
);

module.exports = router;
