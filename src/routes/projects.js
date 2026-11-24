const router = require("express").Router();
const db = require("../config/mysql");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { HttpError, asyncHandler, toId } = require("../utils/http");
const { isAdmin, assertProjectAccess } = require("../services/access");
const { logActivity } = require("../services/activity");
const { reassignOpenTasks } = require("../services/reassign");

router.use(requireAuth);

const COUNTS = `
  (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
  (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status <> 'done') AS open_count`;

// Admin: all projects. Member: only projects they were granted.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    let rows;
    if (isAdmin(req.user)) {
      [rows] = await db.execute(`SELECT p.*, ${COUNTS} FROM projects p ORDER BY p.is_archived, p.name`);
    } else {
      [rows] = await db.execute(
        `SELECT p.*, ${COUNTS} FROM projects p
         JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
         WHERE p.is_archived = FALSE
         ORDER BY p.name`,
        [req.user.id],
      );
    }
    res.json(rows.map((p) => ({ ...p, is_archived: !!p.is_archived })));
  }),
);

router.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const name = String(req.body.name || "").trim();
    if (!name) throw new HttpError(400, "Project name is required");
    const [r] = await db.execute(
      "INSERT INTO projects (name, description, created_by) VALUES (?, ?, ?)",
      [name, req.body.description || null, req.user.id],
    );
    await logActivity({ projectId: r.insertId, userId: req.user.id, action: "project_created", newValue: name });
    res.status(201).json({ id: r.insertId });
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const project = await assertProjectAccess(req.user, toId(req.params.id));
    res.json({ ...project, is_archived: !!project.is_archived });
  }),
);

router.patch(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const project = await assertProjectAccess(req.user, id);
    const name = req.body.name !== undefined ? String(req.body.name).trim() : project.name;
    if (!name) throw new HttpError(400, "Project name is required");
    const description = req.body.description !== undefined ? req.body.description : project.description;
    const archived = req.body.is_archived !== undefined ? !!req.body.is_archived : !!project.is_archived;
    await db.execute("UPDATE projects SET name = ?, description = ?, is_archived = ? WHERE id = ?", [
      name,
      description,
      archived,
      id,
    ]);
    await logActivity({ projectId: id, userId: req.user.id, action: "project_updated" });
    res.json({ message: "Project updated" });
  }),
);

// Members of the project (used for the assignee dropdown). Admins are always included.
router.get(
  "/:id/members",
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    await assertProjectAccess(req.user, id);
    const [rows] = await db.execute(
      `SELECT u.id, u.full_name, u.email, u.role
       FROM users u
       LEFT JOIN project_members pm ON pm.user_id = u.id AND pm.project_id = ?
       WHERE u.is_active = TRUE AND (u.role = 'admin' OR pm.user_id IS NOT NULL)
       ORDER BY u.role = 'admin', u.full_name`,
      [id],
    );
    res.json(rows);
  }),
);

router.post(
  "/:id/members",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const userId = toId(req.body.user_id);
    await assertProjectAccess(req.user, id);
    const [u] = await db.execute("SELECT role FROM users WHERE id = ? AND is_active = TRUE", [userId]);
    if (!u[0]) throw new HttpError(404, "User not found");
    if (u[0].role === "admin") throw new HttpError(400, "Admins already have access to every project");
    try {
      await db.execute("INSERT INTO project_members (project_id, user_id, added_by) VALUES (?, ?, ?)", [
        id,
        userId,
        req.user.id,
      ]);
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY") throw new HttpError(409, "User is already a member");
      throw e;
    }
    await logActivity({ projectId: id, userId: req.user.id, action: "member_added", newValue: userId });
    res.status(201).json({ message: "Member added" });
  }),
);

router.delete(
  "/:id/members/:userId",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const userId = toId(req.params.userId);
    const [u] = await db.execute("SELECT full_name FROM users WHERE id = ?", [userId]);
    if (!u[0]) throw new HttpError(404, "User not found");

    const conn = await db.getConnection();
    let reassigned = 0;
    try {
      await conn.beginTransaction();
      const [r] = await conn.execute("DELETE FROM project_members WHERE project_id = ? AND user_id = ?", [
        id,
        userId,
      ]);
      if (r.affectedRows === 0) throw new HttpError(404, "User is not a member of this project");
      await logActivity({ projectId: id, userId: req.user.id, action: "member_removed", oldValue: userId }, conn);
      reassigned = await reassignOpenTasks(conn, {
        userId,
        projectId: id,
        actorId: req.user.id,
        reason: `${u[0].full_name} was removed from the project`,
      });
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    res.json({ message: "Member removed", reassigned_tasks: reassigned });
  }),
);

module.exports = router;
