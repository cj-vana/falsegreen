/** Process exit codes: 0 nothing at or above the fail-on severity, 1 findings, 2 falsegreen
 *  itself failed (bad input, interruption, or a cleanup it could not finish). */
export const EXIT = { OK: 0, FINDINGS: 1, ERROR: 2 } as const;
