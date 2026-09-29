export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_PROBABILITY"
  | "UNSUPPORTED_FEATURE"
  | "INVALID_PAGINATION";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details ?? null;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
