const db = require("../config/mysql");

// conn can be a pool or a transaction connection
async function logActivity(
  { projectId = null, taskId = null, userId = null, action, field = null, oldValue = null, newValue = null, note = null },
  conn = db,
) {
  await conn.execute(
    `INSERT INTO activity_log (project_id, task_id, user_id, action, field, old_value, new_value, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId,
      taskId,
      userId,
      action,
      field,
      oldValue === null ? null : String(oldValue),
      newValue === null ? null : String(newValue),
      note,
    ],
  );
}

module.exports = { logActivity };
