// When a user loses access (removed from a project, or deactivated), their
// open tasks (anything not "done") are handed to the active admin who
// currently has the fewest open tasks. Every move is written to the activity log.
const { logActivity } = require("./activity");

async function pickAdmin(conn, excludeUserId) {
  const [rows] = await conn.execute(
    `SELECT u.id, u.full_name,
            (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.status <> 'done') AS open_count
     FROM users u
     WHERE u.role = 'admin' AND u.is_active = TRUE AND u.id <> ?
     ORDER BY open_count ASC, u.id ASC
     LIMIT 1`,
    [excludeUserId],
  );
  return rows[0] || null;
}

/**
 * @param conn       transaction connection
 * @param userId     user losing access
 * @param projectId  limit to one project, or null for all projects
 * @param actorId    admin performing the action
 * @param reason     text stored in the log
 * @returns number of tasks reassigned
 */
async function reassignOpenTasks(conn, { userId, projectId = null, actorId, reason }) {
  const params = [userId];
  let sql = "SELECT id, project_id FROM tasks WHERE assignee_id = ? AND status <> 'done'";
  if (projectId) {
    sql += " AND project_id = ?";
    params.push(projectId);
  }
  const [tasks] = await conn.execute(sql, params);
  if (tasks.length === 0) return 0;

  for (const task of tasks) {
    // Re-pick per task so the load spreads across admins
    const admin = await pickAdmin(conn, userId);
    const newAssignee = admin ? admin.id : null;
    await conn.execute("UPDATE tasks SET assignee_id = ? WHERE id = ?", [newAssignee, task.id]);
    await logActivity(
      {
        projectId: task.project_id,
        taskId: task.id,
        userId: actorId,
        action: "auto_reassigned",
        field: "assignee_id",
        oldValue: userId,
        newValue: newAssignee,
        note: admin ? reason : `${reason} (no active admin available - left unassigned)`,
      },
      conn,
    );
  }
  return tasks.length;
}

module.exports = { reassignOpenTasks };
