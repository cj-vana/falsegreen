/**
 * What falsegreen must never run on the user's behalf: commands that publish, deploy or push, or
 * that rewrite the repository, and steps in jobs that exist to release. Local replay and remote
 * mode both decide with these functions.
 */
import type { JobModel, StepModel, WorkflowModel } from '../workflow/model';
import { stripWrappers } from './wrappers';

/**
 * The words after the command that are not options, skipping the value of each option in
 * `valueFlags`: `git -C . push` gives ['push'], `pnpm -r publish` gives ['publish'].
 */
function positionals(args: string[], valueFlags: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (valueFlags.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Git subcommands that move HEAD, rewrite the tree or the index, or push. */
const GIT_WRITES = new Set([
  'push',
  'commit',
  'merge',
  'rebase',
  'pull',
  'am',
  'cherry-pick',
  'revert',
  'reset',
  'checkout',
  'switch',
  'restore',
  'clean',
]);

const KUBECTL_WRITES = new Set([
  'apply',
  'create',
  'delete',
  'replace',
  'patch',
  'rollout',
  'scale',
  'set',
  'edit',
  'label',
  'annotate',
  'drain',
  'cordon',
]);

/** Subcommands that publish, deploy or push, for tools where the subcommand decides. */
const WRITES: Record<string, string[]> = {
  npm: ['publish', 'unpublish', 'deprecate', 'dist-tag'],
  pnpm: ['publish'],
  yarn: ['publish'],
  bun: ['publish'],
  cargo: ['publish', 'release', 'yank', 'owner'],
  poetry: ['publish'],
  uv: ['publish'],
  flit: ['publish'],
  hatch: ['publish'],
  pdm: ['publish'],
  twine: ['upload'],
  gem: ['push'],
  nuget: ['push'],
  changeset: ['publish', 'tag'],
  lerna: ['publish', 'version'],
  jsr: ['publish'],
  deno: ['publish'],
  vsce: ['publish'],
  ovsx: ['publish'],
  terraform: ['apply', 'destroy', 'import'],
  tofu: ['apply', 'destroy', 'import'],
  helm: ['install', 'upgrade', 'uninstall', 'rollback', 'push'],
  pulumi: ['up', 'destroy', 'import'],
  cdk: ['deploy', 'destroy'],
  serverless: ['deploy', 'remove'],
  sls: ['deploy', 'remove'],
  netlify: ['deploy'],
  firebase: ['deploy'],
  wrangler: ['deploy', 'publish', 'pages'],
  fly: ['deploy'],
  flyctl: ['deploy'],
  railway: ['up'],
};

/** Tools whose only job is to publish or release, whatever the arguments. */
const RELEASERS = new Set(['semantic-release', 'release-it', 'np', 'surge']);

const GH_WRITE_VERBS = new Set([
  'create',
  'merge',
  'close',
  'reopen',
  'edit',
  'comment',
  'review',
  'ready',
  'delete',
  'lock',
]);

/**
 * Why running this command could reach outside the machine or destroy the user's work: the
 * command it is (`npm publish`, `git push`, `git reset`), or undefined when it is neither.
 */
export function unsafeCommand(raw: string[]): string | undefined {
  const argv = stripWrappers(raw).argv;
  const [exe, ...args] = argv;
  if (exe === undefined) return undefined;
  if (RELEASERS.has(exe)) return exe;

  if (exe === 'git') {
    const [sub, ...rest] = positionals(args, ['-C', '-c', '--git-dir', '--work-tree']);
    if (sub === undefined) return undefined;
    if (GIT_WRITES.has(sub)) return `git ${sub}`;
    if (sub === 'stash' && !['list', 'show'].includes(rest[0] ?? '')) return 'git stash';
    if (sub === 'tag' && rest.length > 0 && !args.some((a) => ['-l', '--list'].includes(a))) {
      return 'git tag';
    }
    return undefined;
  }
  if (exe === 'docker' || exe === 'podman') {
    const words = positionals(args, ['--context', '-H', '--host', '--config', '-l', '--log-level']);
    if (words.includes('push') || args.some((a) => a === '--push' || a.startsWith('--push='))) {
      return `${exe} push`;
    }
    return undefined;
  }
  if (exe === 'gh') {
    const [sub, verb] = positionals(args, ['-R', '--repo', '-H', '--header']);
    if (['release', 'secret', 'variable', 'workflow'].includes(sub ?? '')) return `gh ${sub}`;
    if ((sub === 'pr' || sub === 'issue') && GH_WRITE_VERBS.has(verb ?? '')) {
      return `gh ${sub} ${verb}`;
    }
    if (sub === 'api') {
      const flag = args.findIndex((a) => a === '-X' || a === '--method');
      const method = flag >= 0 ? args[flag + 1] : undefined;
      const writes = args.some((a) =>
        ['-f', '-F', '--field', '--raw-field', '--input'].includes(a),
      );
      if (writes || (method !== undefined && method.toUpperCase() !== 'GET')) return 'gh api';
    }
    return undefined;
  }
  if (exe === 'dotnet') {
    return positionals(args)[0] === 'nuget' && positionals(args)[1] === 'push'
      ? 'dotnet nuget push'
      : undefined;
  }
  if (exe === 'goreleaser') {
    const sub = positionals(args)[0];
    return sub === undefined || sub === 'release' ? 'goreleaser release' : undefined;
  }
  if (exe === 'vercel') {
    const sub = positionals(args)[0];
    // A bare `vercel` deploys a preview.
    return sub === undefined || sub === 'deploy' || args.includes('--prod')
      ? 'vercel deploy'
      : undefined;
  }
  if (exe === 'kubectl') {
    const sub = positionals(args, ['-n', '--namespace', '--context', '--kubeconfig'])[0];
    return sub !== undefined && KUBECTL_WRITES.has(sub) ? `kubectl ${sub}` : undefined;
  }
  if (exe === 'aws') {
    const words = positionals(args, ['--region', '--profile', '--output']);
    if (words.includes('deploy')) return 'aws deploy';
    if (words[0] === 's3' && ['sync', 'cp', 'mv', 'rm', 'rb', 'mb'].includes(words[1] ?? '')) {
      return `aws s3 ${words[1]}`;
    }
    return undefined;
  }
  if (exe === 'gcloud' || exe === 'az') {
    return positionals(args).includes('deploy') ? `${exe} deploy` : undefined;
  }
  if (exe === 'mvn' || exe === 'mvnw') {
    if (args.includes('deploy')) return 'mvn deploy';
    if (args.some((a) => a.startsWith('release:'))) return 'mvn release';
    return undefined;
  }
  if (exe === 'gradle' || exe === 'gradlew') {
    if (args.some((t) => /(^|:)(publish\w*|release)$/.test(t))) return 'gradle publish';
    return undefined;
  }

  const writes = WRITES[exe];
  if (writes) {
    // Anywhere among the words: `yarn npm publish`, `pnpm --filter web publish`.
    const hit = positionals(args, ['--filter', '-F', '-C', '--dir', '--cwd', '-w']).find((w) =>
      writes.includes(w),
    );
    if (hit !== undefined) return `${exe} ${hit}`;
  }
  return undefined;
}

const RELEASE_JOB = /publish|deploy|release/i;
// Not "release" for steps: CI steps build release binaries all the time.
const RELEASE_STEP = /publish|deploy/i;

/** True when every trigger of the workflow is a tag push or a release or deployment event. */
function releaseOnly(wf: WorkflowModel): boolean {
  const t = wf.triggers;
  const push = t.push;
  const tagOnlyPush =
    push !== undefined &&
    (push.tags !== undefined || push.tagsIgnore !== undefined) &&
    push.branches === undefined &&
    push.branchesIgnore === undefined;
  const releaseEvents = t.other.filter((e) =>
    ['release', 'registry_package', 'deployment', 'deployment_status'].includes(e),
  );
  const others =
    (push !== undefined && !tagOnlyPush ? 1 : 0) +
    (t.pullRequest !== undefined ? 1 : 0) +
    (t.pullRequestTarget !== undefined ? 1 : 0) +
    (t.workflowDispatch !== undefined ? 1 : 0) +
    (t.workflowCall !== undefined ? 1 : 0) +
    (t.schedule ? 1 : 0) +
    (t.other.length - releaseEvents.length);
  return (tagOnlyPush || releaseEvents.length > 0) && others === 0;
}

/**
 * Why a step belongs to a release or deploy job, whose steps falsegreen does not replay: the job
 * deploys to an environment, a name says publish, deploy or release, or the workflow runs only for
 * tags and releases. Undefined when none of these hold.
 */
export function releaseContext(
  wf: WorkflowModel,
  job: JobModel,
  step?: StepModel,
): string | undefined {
  if (job.environment !== undefined) {
    return `job ${job.id} deploys to the ${job.environment} environment`;
  }
  for (const name of [job.id, job.name]) {
    if (name !== undefined && RELEASE_JOB.test(name)) {
      return `job ${job.id} is named like a release or deploy job`;
    }
  }
  if (step?.name !== undefined && RELEASE_STEP.test(step.name)) {
    return `step "${step.name}" is named like a release or deploy step`;
  }
  if (releaseOnly(wf)) return `${wf.file} runs only for tags and releases`;
  return undefined;
}
