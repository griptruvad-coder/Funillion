// Shared HTTP error type. server.js's central handler exposes e.message to the client only for
// this class (anything else becomes a generic "Something went wrong"), so every module that
// throws a client-facing error — not just server.js's own routes — must use this, not a plain Error.
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
module.exports = { HttpError };
