export class ApiError extends Error {
  constructor(
    public code:
      | "VALIDATION_ERROR"
      | "NOT_FOUND"
      | "CONFLICT"
      | "INVALID_PROBABILITY"
      | "PRICING_INVALID_INPUT"
      | "SNAPSHOT_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ErrorBody {
  error: { code: string; message: string };
}

export function statusFor(code: ApiError["code"]): number {
  switch (code) {
    case "VALIDATION_ERROR":
    case "PRICING_INVALID_INPUT":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "SNAPSHOT_MISMATCH":
      return 409;
    case "INVALID_PROBABILITY":
      return 422;
  }
}
