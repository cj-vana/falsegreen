/**
 * The command line GitHub uses for each `shell:` value, from
 * https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
 * The default is `bash -e {0}`, which has no pipefail; `shell: bash` adds `-o pipefail`.
 */
import { spawnSync } from 'node:child_process';

let bashPresent: boolean | undefined;

function hasBash(): boolean {
  bashPresent ??= spawnSync('bash', ['-c', 'true'], { stdio: 'ignore' }).status === 0;
  return bashPresent;
}

export function shellCommand(
  shell: string | undefined,
  scriptPath: string,
): { cmd: string; args: string[] } | { unsupported: string } {
  if (shell === undefined) {
    return hasBash()
      ? { cmd: 'bash', args: ['-e', scriptPath] }
      : { cmd: 'sh', args: ['-e', scriptPath] };
  }
  switch (shell) {
    case 'bash':
      return { cmd: 'bash', args: ['--noprofile', '--norc', '-eo', 'pipefail', scriptPath] };
    case 'sh':
      return { cmd: 'sh', args: ['-e', scriptPath] };
    case 'python':
      return { cmd: 'python', args: [scriptPath] };
    case 'pwsh':
      return { cmd: 'pwsh', args: ['-command', `. '${scriptPath}'`] };
    case 'powershell':
    case 'cmd':
      return { unsupported: shell };
  }
  if (shell.includes('{0}')) {
    const [cmd, ...args] = shell.split(/\s+/).map((part) => part.replace('{0}', scriptPath));
    return { cmd: cmd!, args };
  }
  return { unsupported: shell };
}
