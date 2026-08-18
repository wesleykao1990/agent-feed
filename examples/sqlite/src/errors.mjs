export class SqlitePersistenceError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "SqlitePersistenceError";
    this.code = code;
    this.details = details;
  }
}

export function persistenceError(code, message = code, details = {}) {
  return new SqlitePersistenceError(code, message, details);
}
