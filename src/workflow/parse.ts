/**
 * Reads workflow files into a model that remembers where every job and step came from, so each
 * finding can point at a line. Values come from the fully resolved document (anchors, aliases and
 * merge keys applied); lines come from walking the same document's nodes.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  LineCounter,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parse as parseYaml,
  parseDocument,
  type Document,
  type Pair,
} from 'yaml';

import { emptyContext, substitute } from './expressions';
import type {
  Defaults,
  Filter,
  Inputs,
  JobModel,
  MatrixSpec,
  StepModel,
  Triggers,
  WorkflowModel,
} from './model';

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const rec = (v: unknown): Rec => (isRecord(v) ? v : {});

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function strings(v: unknown): string[] | undefined {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.map((x) => str(x)).filter((x): x is string => x !== undefined);
  return undefined;
}

function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(rec(v))) {
    const s = str(value);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

function defaultsOf(v: unknown): Defaults {
  const run = rec(rec(v).run);
  const out: Defaults = {};
  const shell = str(run.shell);
  const dir = str(run['working-directory']);
  if (shell !== undefined) out.shell = shell;
  if (dir !== undefined) out.workingDirectory = dir;
  return out;
}

function filterOf(v: unknown): Filter {
  const f = rec(v);
  const out: Filter = {};
  const set = (key: keyof Filter, yamlKey: string): void => {
    const list = strings(f[yamlKey]);
    if (list !== undefined) out[key] = list;
  };
  set('branches', 'branches');
  set('branchesIgnore', 'branches-ignore');
  set('tags', 'tags');
  set('tagsIgnore', 'tags-ignore');
  set('paths', 'paths');
  set('pathsIgnore', 'paths-ignore');
  return out;
}

function inputsOf(v: unknown): Inputs {
  const inputs: Inputs['inputs'] = {};
  for (const [name, spec] of Object.entries(rec(rec(v).inputs))) {
    const d = str(rec(spec).default);
    inputs[name] = d === undefined ? {} : { default: d };
  }
  return { inputs };
}

function triggersOf(on: unknown): Triggers {
  const t: Triggers = { schedule: false, other: [] };
  const entries: [string, unknown][] =
    typeof on === 'string'
      ? [[on, null]]
      : Array.isArray(on)
        ? on.map((e) => [String(e), null])
        : Object.entries(rec(on));
  for (const [event, cfg] of entries) {
    if (event === 'push') t.push = filterOf(cfg);
    else if (event === 'pull_request') t.pullRequest = filterOf(cfg);
    else if (event === 'pull_request_target') t.pullRequestTarget = filterOf(cfg);
    else if (event === 'workflow_dispatch') t.workflowDispatch = inputsOf(cfg);
    else if (event === 'workflow_call') t.workflowCall = inputsOf(cfg);
    else if (event === 'schedule') t.schedule = true;
    else t.other.push(event);
  }
  return t;
}

function matrixOf(strategy: unknown): MatrixSpec | undefined {
  const m = rec(strategy).matrix;
  if (m === undefined) return undefined;
  if (typeof m === 'string') return { axes: {}, include: [], exclude: [], expression: m };
  const spec: MatrixSpec = { axes: {}, include: [], exclude: [] };
  for (const [key, value] of Object.entries(rec(m))) {
    if (key === 'include' || key === 'exclude') {
      if (typeof value === 'string') spec.expression = value;
      else spec[key] = (Array.isArray(value) ? value : []).map(rec);
    } else if (Array.isArray(value)) {
      spec.axes[key] = value;
    } else if (typeof value === 'string') {
      spec.expression = value;
    }
  }
  return spec;
}

function continueOnErrorOf(v: unknown): boolean | string | undefined {
  return typeof v === 'boolean' || typeof v === 'string' ? v : undefined;
}

/** Walks the parsed document's nodes to find source lines. */
class Locator {
  constructor(
    private readonly doc: Document,
    private readonly lines: LineCounter,
  ) {}

  resolve(node: unknown): unknown {
    return isAlias(node) ? node.resolve(this.doc) : node;
  }

  pair(map: unknown, key: string): Pair | undefined {
    const m = this.resolve(map);
    if (!isMap(m)) return undefined;
    return m.items.find((p) => isScalar(p.key) && p.key.value === key) as Pair | undefined;
  }

  value(map: unknown, key: string): unknown {
    return this.resolve(this.pair(map, key)?.value);
  }

  line(node: unknown): number | undefined {
    const range = (node as { range?: [number, number, number] } | undefined)?.range;
    return range ? this.lines.linePos(range[0]).line : undefined;
  }

  /** First line of a scalar's text: the line after the indicator for block scalars. */
  contentLine(node: unknown): number | undefined {
    const line = this.line(node);
    if (line === undefined || !isScalar(node)) return line;
    return node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED' ? line + 1 : line;
  }
}

interface RawStep {
  data: Rec;
  line: number;
  runLine?: number;
  fromAction?: string;
}

const MAX_ACTION_DEPTH = 5;

/** Replaces a local composite action step by its steps; undefined when it is not one. */
function inlineComposite(
  root: string,
  uses: string,
  withArgs: Record<string, string>,
  line: number,
  depth: number,
): RawStep[] | undefined {
  if (depth > MAX_ACTION_DEPTH) return undefined;
  const dir = join(root, uses);
  const file = ['action.yml', 'action.yaml'].map((f) => join(dir, f)).find(existsSync);
  if (!file) return undefined;
  let action: Rec;
  try {
    action = rec(parseYaml(readFileSync(file, 'utf8'), { merge: true }));
  } catch {
    return undefined;
  }
  const runs = rec(action.runs);
  if (runs.using !== 'composite') return undefined;

  const inputs: Record<string, string> = {};
  for (const [name, spec] of Object.entries(rec(action.inputs))) {
    const d = str(rec(spec).default);
    if (d !== undefined) inputs[name] = d;
  }
  Object.assign(inputs, withArgs);
  // On a runner action_path is absolute; the path as written works from the workspace root.
  const ctx = { ...emptyContext(), inputs, github: { action_path: uses } };
  const fill = (v: unknown): unknown => (typeof v === 'string' ? substitute(v, ctx).text : v);

  const out: RawStep[] = [];
  for (const raw of Array.isArray(runs.steps) ? runs.steps : []) {
    const step = rec(raw);
    const data: Rec = { ...step };
    for (const key of ['run', 'shell', 'working-directory', 'uses', 'name']) {
      if (key in data) data[key] = fill(data[key]);
    }
    if (isRecord(step.env))
      data.env = Object.fromEntries(Object.entries(step.env).map(([k, v]) => [k, fill(v)]));
    if (isRecord(step.with))
      data.with = Object.fromEntries(Object.entries(step.with).map(([k, v]) => [k, fill(v)]));
    const nested =
      typeof data.uses === 'string' && data.uses.startsWith('./')
        ? inlineComposite(root, data.uses, stringMap(data.with), line, depth + 1)
        : undefined;
    if (nested) out.push(...nested);
    else out.push({ data, line, fromAction: uses });
  }
  return out;
}

function stepModel(raw: RawStep, index: number, file: string): StepModel {
  const s = raw.data;
  const step: StepModel = {
    index,
    with: stringMap(s.with),
    env: stringMap(s.env),
    loc: { file, line: raw.line },
  };
  const set = <K extends keyof StepModel>(key: K, value: StepModel[K] | undefined): void => {
    if (value !== undefined) step[key] = value;
  };
  set('id', str(s.id));
  set('name', str(s.name));
  set('run', str(s.run));
  set('uses', str(s.uses));
  set('shell', str(s.shell));
  set('workingDirectory', str(s['working-directory']));
  set('continueOnError', continueOnErrorOf(s['continue-on-error']));
  set('if', str(s.if));
  set(
    'timeoutMinutes',
    typeof s['timeout-minutes'] === 'number' ? s['timeout-minutes'] : undefined,
  );
  set('runLine', raw.runLine);
  set('fromAction', raw.fromAction);
  return step;
}

export function parseWorkflow(file: string, text: string, root: string): WorkflowModel {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, merge: true, uniqueKeys: false });
  const base: WorkflowModel = {
    file,
    triggers: { schedule: false, other: [] },
    env: {},
    defaults: {},
    jobs: [],
    loc: { file, line: 1 },
    errors: [],
  };
  if (doc.errors.length > 0) {
    return { ...base, errors: doc.errors.map((e) => `${file}: ${e.message.split('\n')[0]}`) };
  }

  const js = rec(doc.toJS({ maxAliasCount: -1 }));
  const at = new Locator(doc, lines);
  const wf: WorkflowModel = {
    ...base,
    triggers: triggersOf(js.on),
    env: stringMap(js.env),
    defaults: defaultsOf(js.defaults),
  };
  const name = str(js.name);
  if (name !== undefined) wf.name = name;

  const jobsNode = at.value(doc.contents, 'jobs');
  for (const [id, rawJob] of Object.entries(rec(js.jobs))) {
    const j = rec(rawJob);
    const pair = at.pair(jobsNode, id);
    const jobLine = at.line(pair?.key) ?? 1;
    const jobNode = at.resolve(pair?.value);
    const stepsNode = at.value(jobNode, 'steps');

    const rawSteps: RawStep[] = [];
    (Array.isArray(j.steps) ? j.steps : []).forEach((s: unknown, i: number) => {
      const data = rec(s);
      const node = isSeq(stepsNode) ? at.resolve(stepsNode.items[i]) : undefined;
      const line = at.line(node) ?? jobLine;
      if (typeof data.uses === 'string' && data.uses.startsWith('./')) {
        const inlined = inlineComposite(root, data.uses, stringMap(data.with), line, 1);
        if (inlined) {
          rawSteps.push(...inlined);
          return;
        }
      }
      const runLine = at.contentLine(at.value(node, 'run'));
      rawSteps.push({ data, line, ...(runLine !== undefined ? { runLine } : {}) });
    });

    const job: JobModel = {
      id,
      needs: strings(j.needs) ?? [],
      env: stringMap(j.env),
      defaults: defaultsOf(j.defaults),
      steps: rawSteps.map((raw, index) => stepModel(raw, index, file)),
      loc: { file, line: jobLine },
    };
    const jobName = str(j.name);
    if (jobName !== undefined) job.name = jobName;
    const cond = str(j.if);
    if (cond !== undefined) job.if = cond;
    const coe = continueOnErrorOf(j['continue-on-error']);
    if (coe !== undefined) job.continueOnError = coe;
    const matrix = matrixOf(j.strategy);
    if (matrix) job.matrix = matrix;
    const environment = str(j.environment) ?? str(rec(j.environment).name);
    if (environment !== undefined) job.environment = environment;
    const usesWorkflow = str(j.uses);
    if (usesWorkflow !== undefined) job.usesWorkflow = usesWorkflow;
    if (typeof j['timeout-minutes'] === 'number') job.timeoutMinutes = j['timeout-minutes'];
    wf.jobs.push(job);
  }
  return wf;
}

/** Every `.github/workflows/*.yml|yaml`, sorted; `only` filters by file name or path. */
export function loadWorkflows(root: string, only?: string[]): WorkflowModel[] {
  const dir = join(root, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
  const wanted = only && only.length > 0 ? new Set(only.map((o) => basename(o))) : undefined;
  return files
    .filter((f) => !wanted || wanted.has(f))
    .map((f) => parseWorkflow(`.github/workflows/${f}`, readFileSync(join(dir, f), 'utf8'), root));
}
