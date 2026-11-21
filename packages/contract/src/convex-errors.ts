import { ConvexError } from "convex/values";
import { ContractError, ERROR_CODES, type ErrorBody } from "./index.js";

// Kept out of the contract's index: the guest agent bundles the contract and has no use for Convex.

/**
 * A Convex function's refusal (`refuse`: a `ConvexError` carrying an error body without `retryable`) as the contract
 * error it is; anything else is not the caller's to see. A rate limit lifts by itself, so it is retryable.
 */
export function contractError(error: unknown): ContractError {
  if (error instanceof ContractError) return error;
  if (error instanceof ConvexError && (ERROR_CODES as readonly string[]).includes(error.data?.code)) { const { code, message, details } = error.data as Omit<ErrorBody, "retryable">; return new ContractError(code, message, details, code === "rate_limited"); }
  // Convex's own limits (TooManyWrites, OCC retries exhausted) are transient platform errors, not the caller's input.
  if (error instanceof ConvexError) return new ContractError("internal", typeof error.data?.message === "string" ? error.data.message : String(error.message), undefined, true);
  throw error;
}

/** Convex refused the caller's own credential (`unauthorized`: a removed machine, a revoked agent). */
export const callerRefused = (error: unknown): boolean => error instanceof ConvexError && error.data?.code === "unauthorized";
