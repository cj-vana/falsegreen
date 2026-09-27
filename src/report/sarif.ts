/** SARIF 2.1.0, for GitHub code scanning. Findings point at workflow lines. */
import type { RuleId, Severity } from '../core/types';
import type { Report } from './model';
import { RULE_DESCRIPTIONS, RULES_URL } from './rules';

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = {
  high: 'error',
  medium: 'warning',
  low: 'note',
  info: 'note',
};

export interface Sarif {
  $schema: string;
  version: '2.1.0';
  runs: {
    tool: {
      driver: {
        name: string;
        version: string;
        informationUri: string;
        rules: {
          id: RuleId;
          shortDescription: { text: string };
          helpUri: string;
          defaultConfiguration: { level: string };
        }[];
      };
    };
    results: {
      ruleId: RuleId;
      level: string;
      message: { text: string };
      locations: {
        physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } };
      }[];
    }[];
  }[];
}

export function toSarif(report: Report): Sarif {
  const rules = [...new Set(report.findings.map((f) => f.rule))];
  const fallback = report.gates[0]?.workflow;
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'falsegreen',
            version: report.version,
            informationUri: 'https://github.com/cj-vana/falsegreen',
            rules: rules.map((id) => ({
              id,
              shortDescription: { text: RULE_DESCRIPTIONS[id] },
              helpUri: `${RULES_URL}#${id}`,
              defaultConfiguration: {
                level: LEVEL[report.findings.find((f) => f.rule === id)!.severity],
              },
            })),
          },
        },
        results: report.findings.map((f) => {
          const file = f.location?.file ?? fallback;
          return {
            ruleId: f.rule,
            level: LEVEL[f.severity],
            message: { text: f.hint === undefined ? f.message : `${f.message} ${f.hint}` },
            locations:
              file === undefined
                ? []
                : [
                    {
                      physicalLocation: {
                        artifactLocation: { uri: file },
                        region: { startLine: f.location?.line ?? 1 },
                      },
                    },
                  ],
          };
        }),
      },
    ],
  };
}
