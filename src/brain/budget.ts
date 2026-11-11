/** Keep admission checks and the panel on the same budget accounting rule.
 * Explicit client-side rejection releases the estimate; it is not reported as measured usage.
 * Timeouts, gateway errors and successful calls without usage keep their conservative reserve.
 */
export const REJECTED_ATTEMPT_SQL = `(ok = 0 AND status IN (400,401,402,403,404,422,429)
  AND error_kind IN ('configuration','auth','quota','rate_limit'))`;
export const ATTEMPT_TOKENS_SQL = `CASE
  WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN input_tokens + output_tokens
  WHEN ${REJECTED_ATTEMPT_SQL} THEN 0
  ELSE reserved_tokens END`;
export const ESTIMATED_ATTEMPT_SQL = `((input_tokens IS NULL OR output_tokens IS NULL) AND NOT COALESCE(${REJECTED_ATTEMPT_SQL},0))`;
