// Central place for "can this user see this?" checks.
// Every route that touches a project or task goes through these functions.
// We answer 404 (not 403) when access is denied, so users can't probe
// which project/task IDs exist.
const db = require("../config/mysql");
const { HttpError } = require("../utils/http");

const isAdmin = (user) => user.role === "admin";

async function assertProjectAccess(user, projectId) {
  const [rows] = await db.execute("SELECT * FROM projects WHERE id = ?", [projectId]);
  const project = rows[0];
  if (!project) throw new HttpError(404, "Project not found");
  if (isAdmin(user)) return project;

  const [m] = await db.execute(
    "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?",
    [projectId, user.id],
  );
  if (m.length === 0) throw new HttpError(404, "Project not found");
  return project;
}

async function assertTaskAccess(user, taskId) {
  const [rows] = await db.execute("SELECT * FROM tasks WHERE id = ?", [taskId]);
  const task = rows[0];
  if (!task) throw new HttpError(404, "Task not found");
  try {
    await assertProjectAccess(user, task.project_id);
  } catch {
    throw new HttpError(404, "Task not found");
  }
  return task;
}

// A task can only be assigned to an active project member or an active admin.
async function assertValidAssignee(projectId, assigneeId) {
  if (assigneeId === null || assigneeId === undefined) return;
  const [rows] = await db.execute(
    `SELECT u.id FROM users u
     LEFT JOIN project_members pm ON pm.user_id = u.id AND pm.project_id = ?
     WHERE u.id = ? AND u.is_active = TRUE AND (u.role = 'admin' OR pm.user_id IS NOT NULL)`,
    [projectId, assigneeId],
  );
  if (rows.length === 0) {
    throw new HttpError(400, "Assignee must be an active member of this project");
  }
}

module.exports = { isAdmin, assertProjectAccess, assertTaskAccess, assertValidAssignee };
