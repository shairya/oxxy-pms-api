const router = require("express").Router();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const db = require("../config/mysql");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { HttpError, asyncHandler, toId, STATUSES, PRIORITIES } = require("../utils/http");
const { isAdmin, assertProjectAccess, assertTaskAccess, assertValidAssignee } = require("../services/access");
const { logActivity } = require("../services/activity");

router.use(requireAuth);

// ---------- Upload setup ----------
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXT = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".ppt", ".pptx", ".txt",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip",
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, crypto.randomBytes(16).toString("hex") + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB) || 10) * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_EXT.has(path.extname(file.originalname).toLowerCase())) return cb(null, true);
    cb(new HttpError(400, `File type not allowed: ${file.originalname}`));
  },
});

// ---------- Helpers ----------
const TASK_SELECT = `
  SELECT t.*, p.name AS project_name,
         a.full_name AS assignee_name, c.full_name AS created_by_name
  FROM tasks t
  JOIN projects p ON p.id = t.project_id
  LEFT JOIN users a ON a.id = t.assignee_id
  JOIN users c ON c.id = t.created_by`;

function parseTaskInput(body, { partial }) {
  const out = {};
  if (body.title !== undefined || !partial) {
    const title = String(body.title || "").trim();
    if (!title) throw new HttpError(400, "Title is required");
    if (title.length > 255) throw new HttpError(400, "Title is too long");
    out.title = title;
  }
  if (body.description !== undefined) out.description = body.description ? String(body.description) : null;
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) throw new HttpError(400, "Invalid status");
    out.status = body.status;
  }
  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) throw new HttpError(400, "Invalid priority");
    out.priority = body.priority;
  }
  if (body.assignee_id !== undefined) {
    out.assignee_id = body.assignee_id === null || body.assignee_id === "" ? null : toId(body.assignee_id);
  }
  if (body.due_date !== undefined) {
    if (body.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date)) throw new HttpError(400, "Invalid due date");
    out.due_date = body.due_date || null;
  }
  return out;
}

function buildFilters(query, alias = "t") {
  const where = [];
  const params = [];
  if (query.status === "open") {
    where.push(`${alias}.status <> 'done'`);
  } else if (query.status) {
    if (!STATUSES.includes(query.status)) throw new HttpError(400, "Invalid status filter");
    where.push(`${alias}.status = ?`);
    params.push(query.status);
  }
  if (query.priority) {
    if (!PRIORITIES.includes(query.priority)) throw new HttpError(400, "Invalid priority filter");
    where.push(`${alias}.priority = ?`);
    params.push(query.priority);
  }
  if (query.assignee === "unassigned") {
    where.push(`${alias}.assignee_id IS NULL`);
  } else if (query.assignee) {
    where.push(`${alias}.assignee_id = ?`);
    params.push(toId(query.assignee));
  }
  if (query.q) {
    where.push(`(${alias}.title LIKE ? OR ${alias}.description LIKE ?)`);
    const like = `%${String(query.q).slice(0, 100)}%`;
    params.push(like, like);
  }
  return { where, params };
}

const ORDER = `ORDER BY FIELD(t.status,'in_progress','pending','on_hold','done'),
                        FIELD(t.priority,'high','medium','low'),
                        t.due_date IS NULL, t.due_date, t.id DESC`;

// ---------- Task lists ----------
router.get(
  "/projects/:projectId/tasks",
  asyncHandler(async (req, res) => {
    const projectId = toId(req.params.projectId);
    await assertProjectAccess(req.user, projectId);
    const { where, params } = buildFilters(req.query);
    const [rows] = await db.execute(
      `${TASK_SELECT} WHERE t.project_id = ? ${where.length ? "AND " + where.join(" AND ") : ""} ${ORDER}`,
      [projectId, ...params],
    );
    res.json(rows);
  }),
);

// Tasks assigned to me, across every project I can still access
router.get(
  "/tasks/my",
  asyncHandler(async (req, res) => {
    const { where, params } = buildFilters({ ...req.query, assignee: undefined });
    const accessClause = isAdmin(req.user)
      ? ""
      : "AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = ?)";
    const accessParams = isAdmin(req.user) ? [] : [req.user.id];
    const [rows] = await db.execute(
      `${TASK_SELECT} WHERE t.assignee_id = ? ${accessClause}
       ${where.length ? "AND " + where.join(" AND ") : ""} ${ORDER}`,
      [req.user.id, ...accessParams, ...params],
    );
    res.json(rows);
  }),
);

// ---------- Create ----------
router.post(
  "/projects/:projectId/tasks",
  asyncHandler(async (req, res) => {
    const projectId = toId(req.params.projectId);
    await assertProjectAccess(req.user, projectId);
    const data = parseTaskInput(req.body, { partial: false });
    await assertValidAssignee(projectId, data.assignee_id);

    const [r] = await db.execute(
      `INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, due_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        data.title,
        data.description ?? null,
        data.status || "pending",
        data.priority || "medium",
        data.assignee_id ?? null,
        data.due_date ?? null,
        req.user.id,
      ],
    );
    await logActivity({ projectId, taskId: r.insertId, userId: req.user.id, action: "task_created", newValue: data.title });
    res.status(201).json({ id: r.insertId });
  }),
);

// ---------- Read one ----------
router.get(
  "/tasks/:id",
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    await assertTaskAccess(req.user, id);
    const [[task]] = await db.execute(`${TASK_SELECT} WHERE t.id = ?`, [id]);
    const [attachments] = await db.execute(
      `SELECT at.id, at.original_name, at.mime_type, at.size_bytes, at.created_at, at.uploaded_by,
              u.full_name AS uploaded_by_name
       FROM task_attachments at JOIN users u ON u.id = at.uploaded_by
       WHERE at.task_id = ? ORDER BY at.id`,
      [id],
    );
    const [comments] = await db.execute(
      `SELECT c.id, c.body, c.created_at, c.user_id, u.full_name AS user_name
       FROM task_comments c JOIN users u ON u.id = c.user_id
       WHERE c.task_id = ? ORDER BY c.id`,
      [id],
    );
    res.json({ ...task, attachments, comments });
  }),
);

// ---------- Update (any project member) ----------
router.patch(
  "/tasks/:id",
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const task = await assertTaskAccess(req.user, id);
    const data = parseTaskInput(req.body, { partial: true });
    // Validate only when the assignee actually changes (the current one may have lost access)
    if (data.assignee_id !== undefined && data.assignee_id !== task.assignee_id) {
      await assertValidAssignee(task.project_id, data.assignee_id);
    }

    // Only log fields that actually changed
    const changed = Object.keys(data).filter((k) => {
      const before = task[k] === undefined ? null : task[k];
      return String(before ?? "") !== String(data[k] ?? "");
    });
    if (changed.length === 0) return res.json({ message: "No changes" });

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `UPDATE tasks SET ${changed.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
        [...changed.map((c) => data[c]), id],
      );
      for (const field of changed) {
        await logActivity(
          {
            projectId: task.project_id,
            taskId: id,
            userId: req.user.id,
            action: field === "status" ? "status_changed" : field === "assignee_id" ? "reassigned" : "task_updated",
            field,
            // Long descriptions are not copied into the log
            oldValue: field === "description" ? null : task[field],
            newValue: field === "description" ? null : data[field],
          },
          conn,
        );
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    res.json({ message: "Task updated" });
  }),
);

// ---------- Delete (admin only) ----------
router.delete(
  "/tasks/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const task = await assertTaskAccess(req.user, id);
    const [files] = await db.execute("SELECT stored_name FROM task_attachments WHERE task_id = ?", [id]);
    await db.execute("DELETE FROM tasks WHERE id = ?", [id]);
    await logActivity({ projectId: task.project_id, taskId: id, userId: req.user.id, action: "task_deleted", oldValue: task.title });
    for (const f of files) fs.unlink(path.join(UPLOAD_DIR, f.stored_name), () => {});
    res.json({ message: "Task deleted" });
  }),
);

// ---------- Comments ----------
router.post(
  "/tasks/:id/comments",
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const task = await assertTaskAccess(req.user, id);
    const body = String(req.body.body || "").trim();
    if (!body) throw new HttpError(400, "Comment cannot be empty");
    const [r] = await db.execute("INSERT INTO task_comments (task_id, user_id, body) VALUES (?, ?, ?)", [
      id,
      req.user.id,
      body,
    ]);
    await logActivity({ projectId: task.project_id, taskId: id, userId: req.user.id, action: "comment_added" });
    res.status(201).json({ id: r.insertId });
  }),
);

// ---------- Attachments ----------
// Access is checked BEFORE multer writes anything to disk.
const loadTaskForUpload = asyncHandler(async (req, res, next) => {
  req.task = await assertTaskAccess(req.user, toId(req.params.id));
  next();
});

router.post(
  "/tasks/:id/attachments",
  loadTaskForUpload,
  upload.array("files", 10),
  asyncHandler(async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) throw new HttpError(400, "No files uploaded");
    for (const f of files) {
      await db.execute(
        `INSERT INTO task_attachments (task_id, original_name, stored_name, mime_type, size_bytes, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.task.id, f.originalname, f.filename, f.mimetype, f.size, req.user.id],
      );
      await logActivity({
        projectId: req.task.project_id,
        taskId: req.task.id,
        userId: req.user.id,
        action: "attachment_added",
        newValue: f.originalname,
      });
    }
    res.status(201).json({ uploaded: files.length });
  }),
);

async function loadAttachment(user, attachmentId) {
  const [rows] = await db.execute("SELECT * FROM task_attachments WHERE id = ?", [attachmentId]);
  const att = rows[0];
  if (!att) throw new HttpError(404, "Attachment not found");
  try {
    const task = await assertTaskAccess(user, att.task_id);
    return { att, task };
  } catch {
    throw new HttpError(404, "Attachment not found");
  }
}

router.get(
  "/attachments/:id/download",
  asyncHandler(async (req, res) => {
    const { att } = await loadAttachment(req.user, toId(req.params.id));
    const filePath = path.join(UPLOAD_DIR, att.stored_name);
    if (!fs.existsSync(filePath)) throw new HttpError(404, "File missing on server");
    res.download(filePath, att.original_name);
  }),
);

// Admin or the person who uploaded it
router.delete(
  "/attachments/:id",
  asyncHandler(async (req, res) => {
    const { att, task } = await loadAttachment(req.user, toId(req.params.id));
    if (!isAdmin(req.user) && att.uploaded_by !== req.user.id) {
      throw new HttpError(403, "Only the uploader or an admin can remove this file");
    }
    await db.execute("DELETE FROM task_attachments WHERE id = ?", [att.id]);
    fs.unlink(path.join(UPLOAD_DIR, att.stored_name), () => {});
    await logActivity({
      projectId: task.project_id,
      taskId: task.id,
      userId: req.user.id,
      action: "attachment_removed",
      oldValue: att.original_name,
    });
    res.json({ message: "Attachment removed" });
  }),
);

// ---------- Activity log ----------
router.get(
  "/tasks/:id/activity",
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    await assertTaskAccess(req.user, id);
    const [rows] = await db.execute(
      `SELECT l.*, u.full_name AS user_name
       FROM activity_log l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.task_id = ? ORDER BY l.id DESC`,
      [id],
    );
    // Turn assignee ids into names for display
    const ids = new Set();
    rows.forEach((r) => {
      if (r.field === "assignee_id") {
        if (r.old_value) ids.add(Number(r.old_value));
        if (r.new_value) ids.add(Number(r.new_value));
      }
    });
    const names = {};
    if (ids.size) {
      const list = [...ids];
      const [users] = await db.query("SELECT id, full_name FROM users WHERE id IN (?)", [list]);
      users.forEach((u) => (names[u.id] = u.full_name));
    }
    res.json(
      rows.map((r) =>
        r.field === "assignee_id"
          ? {
              ...r,
              old_value: r.old_value ? names[r.old_value] || `User #${r.old_value}` : "Unassigned",
              new_value: r.new_value ? names[r.new_value] || `User #${r.new_value}` : "Unassigned",
            }
          : r,
      ),
    );
  }),
);

module.exports = router;
