import { z } from 'zod';

import { RULE_IDS, SEVERITY_ORDER, type Severity } from '../core/types';
import { TOOL_IDS } from '../faults/types';

const severity = z.enum(SEVERITY_ORDER as unknown as [Severity, ...Severity[]]);
const tool = z.enum(TOOL_IDS);

export const ConfigSchema = z.strictObject({
  failOn: severity.default('high'),
  ignore: z
    .array(
      z
        .strictObject({
          job: z.string().optional(),
          step: z.string().optional(),
          rule: z.enum(RULE_IDS).optional(),
        })
        .refine((e) => e.job !== undefined || e.step !== undefined || e.rule !== undefined, {
          message: 'an ignore entry needs at least one of job, step or rule',
        }),
    )
    .default([]),
  gates: z
    .array(
      z.strictObject({
        job: z.string(),
        step: z.string(),
        tool,
        cwd: z.string().optional(),
      }),
    )
    .default([]),
  place: z.array(z.strictObject({ tool, dir: z.string() })).default([]),
  matrix: z.strictObject({ max: z.number().int().positive().default(4) }).default({ max: 4 }),
  remote: z
    .strictObject({
      allow: z.array(z.string()).default([]),
      timeoutMinutes: z.number().positive().default(30),
    })
    .default({ allow: [], timeoutMinutes: 30 }),
});

export type Config = z.infer<typeof ConfigSchema>;
