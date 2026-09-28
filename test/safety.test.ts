import { describe, expect, it } from 'vitest';

import { releaseContext, unsafeCommand } from '../src/resolve/safety';
import { parseWorkflow } from '../src/workflow/parse';

const unsafe = (cmd: string) => unsafeCommand(cmd.split(' '));

describe('unsafeCommand', () => {
  // The review's probe: each of these reached a local replay before.
  it.each([
    ['npm publish', 'npm publish'],
    ['pnpm -r publish --no-git-checks', 'pnpm publish'],
    ['pnpm --filter web publish', 'pnpm publish'],
    ['yarn npm publish', 'yarn publish'],
    ['npx changeset publish', 'changeset publish'],
    ['npx semantic-release', 'semantic-release'],
    ['lerna publish from-package', 'lerna publish'],
    ['git -C . push origin HEAD', 'git push'],
    ['docker buildx build --push .', 'docker push'],
    ['goreleaser release --clean', 'goreleaser release'],
    ['goreleaser', 'goreleaser release'],
    ['gh release create v1.0.0', 'gh release'],
    ['gh pr merge 12 --squash', 'gh pr merge'],
    ['gh api -X POST repos/o/r/dispatches', 'gh api'],
    ['dotnet nuget push out.nupkg', 'dotnet nuget push'],
    ['cargo release patch', 'cargo release'],
    ['vsce publish', 'vsce publish'],
    ['deno publish', 'deno publish'],
    ['vercel --prod', 'vercel deploy'],
    ['vercel', 'vercel deploy'],
    ['kubectl -n prod apply -f k8s/', 'kubectl apply'],
    ['aws s3 sync dist s3://bucket', 'aws s3 sync'],
    ['uv publish', 'uv publish'],
    ['python -m twine upload dist/*', 'twine upload'],
    ['./gradlew :lib:publishToMavenCentral', 'gradle publish'],
    ['mvn -B release:perform', 'mvn release'],
  ])('%s is %s', (cmd, label) => {
    expect(unsafe(cmd)).toBe(label);
  });

  // A replay must not rewrite the user's repository either.
  it.each([
    ['git clean -fdx', 'git clean'],
    ['git reset --hard', 'git reset'],
    ['git checkout -- .', 'git checkout'],
    ['git stash', 'git stash'],
    ['git commit -am fix', 'git commit'],
    ['git tag v1', 'git tag'],
  ])('%s is %s', (cmd, label) => {
    expect(unsafe(cmd)).toBe(label);
  });

  it.each([
    'npm test',
    'npm run build -- --publish',
    'pnpm -r test',
    'git diff --exit-code',
    'git status --porcelain',
    'git stash list',
    'git tag --list',
    'docker build .',
    'gh api repos/o/r',
    'goreleaser check',
    'vercel build',
    'kubectl get pods',
    'aws s3 ls',
    'cargo test',
  ])('%s is safe', (cmd) => {
    expect(unsafe(cmd)).toBeUndefined();
  });
});

describe('releaseContext', () => {
  const wf = (text: string) => parseWorkflow('.github/workflows/w.yml', text, '/');
  const job = (w: ReturnType<typeof wf>, id: string) => w.jobs.find((j) => j.id === id)!;

  it('names jobs that deploy, jobs named like releases, and tag-only workflows', () => {
    const ci = wf(
      [
        'on: [push, pull_request]',
        'jobs:',
        '  test:',
        '    steps: [{ run: npm test }]',
        '  ship:',
        '    environment: production',
        '    steps: [{ run: npm test }]',
        '  publish-docs:',
        '    steps: [{ run: npm test }, { name: Deploy preview, run: npm test }]',
      ].join('\n'),
    );
    expect(releaseContext(ci, job(ci, 'test'))).toBeUndefined();
    const steps = job(ci, 'publish-docs').steps;
    expect(releaseContext(ci, job(ci, 'test'), { ...steps[1]!, name: 'Deploy preview' })).toBe(
      'step "Deploy preview" is named like a release or deploy step',
    );
    // CI builds release binaries all the time; only publish and deploy count for steps.
    expect(
      releaseContext(ci, job(ci, 'test'), { ...steps[1]!, name: 'Build release binaries' }),
    ).toBeUndefined();
    expect(releaseContext(ci, job(ci, 'ship'))).toBe(
      'job ship deploys to the production environment',
    );
    expect(releaseContext(ci, job(ci, 'publish-docs'))).toBe(
      'job publish-docs is named like a release or deploy job',
    );
    const tagged = wf(
      "on:\n  push:\n    tags: ['v*']\njobs:\n  build:\n    steps: [{ run: make }]",
    );
    expect(releaseContext(tagged, job(tagged, 'build'))).toBe(
      '.github/workflows/w.yml runs only for tags and releases',
    );
    const both = wf(
      "on:\n  push:\n    branches: [main]\n    tags: ['v*']\njobs:\n  build:\n    steps: [{ run: make }]",
    );
    expect(releaseContext(both, job(both, 'build'))).toBeUndefined();
  });
});
