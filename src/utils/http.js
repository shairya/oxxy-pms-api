class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Wrap async route handlers so thrown errors reach the error middleware
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const toId = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Invalid id");
  return n;
};

const STATUSES = ["pending", "in_progress", "on_hold", "done"];
const PRIORITIES = ["low", "medium", "high"];

module.exports = { HttpError, asyncHandler, toId, STATUSES, PRIORITIES };
