import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { identify } from '../src/resolve/tools';
import { stripWrappers } from '../src/resolve/wrappers';
import { makeRepo, type TempRepo } from './helpers/repo';

let repo: TempRepo;

beforeAll(() => {
  repo = makeRepo({
    'src/a.ts': 'export {};\n',
    'tests/test_a.py': '',
    'pkg/calc/calc.go': 'package calc\n',
    'web/package.json': '{}\n',
    'app/build.gradle': "plugins { id 'java' }\n",
    'lint/build.gradle.kts': 'plugins { id("com.diffplug.spotless") }\n',
    'crates/b/Cargo.toml': '[package]\nname = "b-core"\nversion = "0.1.0"\n',
    'pom.xml':
      '<project><build><plugins><plugin><artifactId>maven-checkstyle-plugin</artifactId></plugin></plugins></build></project>\n',
    'tsconfig.build.json': '{}\n',
  });
});

afterAll(() => repo.remove());

const tools = (cmd: string, cwd = '') =>
  identify(cmd.split(' '), cwd, repo.root).map((i) => i.tool);
const one = (cmd: string, cwd = '') => identify(cmd.split(' '), cwd, repo.root)[0];

describe('stripWrappers', () => {
  it.each([
    ['npx --yes vitest run', 'vitest run', 'npx'],
    ['npx -p typescript tsc --noEmit', 'tsc --noEmit', 'npx'],
    ['pnpm exec eslint .', 'eslint .', 'pnpm exec'],
    ['bunx biome ci', 'biome ci', 'bunx'],
    ['uv run --frozen --with pytest-cov pytest -q', 'pytest -q', 'uv run'],
    ['poetry run mypy src', 'mypy src', 'poetry run'],
    ['python3 -m pytest tests', 'pytest tests', 'python -m'],
    ['env CI=1 FOO=bar go test ./...', 'go test ./...', 'env'],
    ['xvfb-run -a npm test', 'npm test', 'xvfb-run'],
    ['./node_modules/.bin/eslint src', 'eslint src', undefined],
    ['.venv/bin/python -m unittest discover', 'unittest discover', 'python -m'],
    ['uv run python -m mypy .', 'mypy .', 'uv run'],
  ])('%s -> %s', (input, argv, wrapper) => {
    const r = stripWrappers(input.split(' '));
    expect(r.argv.join(' ')).toBe(argv);
    expect(r.wrapper).toBe(wrapper);
  });
});

describe('identify: JS and TS', () => {
  it.each([
    ['vitest run', ['vitest']],
    ['vitest', ['vitest']],
    ['vitest watch', []],
    ['jest --ci', ['jest']],
    ['jest --watch', []],
    ['mocha test/**/*.spec.js', ['mocha']],
    ['node --test', ['node-test']],
    ['node --experimental-strip-types --test test/', ['node-test']],
    ['node script.js', []],
    ['bun test', ['bun-test']],
    ['tsc --noEmit', ['tsc']],
    ['tsc -b', ['tsc']],
    ['tsc --init', []],
    ['vue-tsc --noEmit', ['vue-tsc']],
    ['eslint .', ['eslint']],
    ['eslint --fix .', []],
    ['biome lint src', ['biome-lint']],
    ['biome check .', ['biome-lint', 'biome-format']],
    ['biome ci', ['biome-lint', 'biome-format']],
    ['biome check --write .', []],
    ['biome format .', ['biome-format']],
    ['biome format --write .', []],
    ['oxlint', ['oxlint']],
    ['prettier --check .', ['prettier']],
    ['prettier -c src', ['prettier']],
    ['prettier --list-different .', ['prettier']],
    ['prettier --write .', []],
  ])('%s', (cmd, expected) => {
    expect(tools(cmd)).toEqual(expected);
  });

  it('keeps existing path arguments, repo-relative', () => {
    expect(one('npx vitest run src')!.pathArgs).toEqual(['src']);
    expect(one('eslint --config eslint.config.js .')!.pathArgs).toEqual(['.']);
    expect(one('jest --ci', 'web')!.cwd).toBe('web');
  });

  it('records the tsc project file', () => {
    expect(one('tsc -p tsconfig.build.json --noEmit')!.project).toBe('tsconfig.build.json');
    expect(one('tsc --project tsconfig.build.json')!.project).toBe('tsconfig.build.json');
  });
});

describe('identify: Python', () => {
  it.each([
    ['pytest -q tests', ['pytest']],
    ['py.test', ['pytest']],
    ['python -m unittest discover -s tests', ['unittest']],
    ['ruff check .', ['ruff-check']],
    ['ruff .', ['ruff-check']],
    ['ruff check --fix .', []],
    ['ruff format --check .', ['ruff-format']],
    ['ruff format .', []],
    ['flake8 src', ['flake8']],
    ['pylint pkg', ['pylint']],
    ['mypy src', ['mypy']],
    ['pyright', ['pyright']],
    ['basedpyright', ['basedpyright']],
    ['black --check .', ['black']],
    ['black .', []],
    ['isort --check-only .', ['isort']],
    ['isort -c .', ['isort']],
    ['isort .', []],
  ])('%s', (cmd, expected) => {
    expect(tools(cmd)).toEqual(expected);
  });

  it('keeps a test directory argument', () => {
    expect(one('pytest -q tests')!.pathArgs).toEqual(['tests']);
    expect(one('pytest -k slow tests')!.pathArgs).toEqual(['tests']);
  });

  it('reads the unittest start directory from -s or the first positional after discover', () => {
    expect(one('python -m unittest discover -s tests')!.pathArgs).toEqual(['tests']);
    expect(one('python -m unittest discover tests test*.py')!.pathArgs).toEqual(['tests']);
    expect(one('python -m unittest discover -p *_test.py tests')!.pathArgs).toEqual(['tests']);
    expect(one('python -m unittest tests.test_a')!.pathArgs).toEqual([]);
  });
});

describe('identify: Go', () => {
  it.each([
    ['go test ./...', ['go-test']],
    ['gotestsum -- ./...', ['go-test']],
    ['go vet ./...', ['go-vet']],
    ['go build ./...', []],
    ['golangci-lint run', ['golangci-lint']],
    ['staticcheck ./...', ['staticcheck']],
    ['gofmt -l .', ['gofmt']],
    ['gofmt -d pkg', ['gofmt']],
    ['gofmt -w .', []],
    ['goimports -l .', ['goimports']],
    ['gofumpt -l .', ['gofumpt']],
  ])('%s', (cmd, expected) => {
    expect(tools(cmd)).toEqual(expected);
  });

  it('turns package patterns into directories', () => {
    expect(one('go test ./pkg/...')!.pathArgs).toEqual(['pkg']);
    expect(one('go test ./...')!.pathArgs).toEqual(['.']);
  });
});

describe('identify: Rust', () => {
  it.each([
    ['cargo test', ['cargo-test']],
    ['cargo +nightly test --all-features', ['cargo-test']],
    ['cargo nextest run', ['cargo-nextest']],
    ['cargo clippy -- -D warnings', ['cargo-clippy']],
    ['cargo clippy --fix', []],
    ['cargo fmt --check', ['cargo-fmt']],
    ['cargo fmt --all -- --check', ['cargo-fmt']],
    ['cargo fmt', []],
    ['cargo check', ['cargo-check']],
    ['cargo build --release', ['cargo-check']],
  ])('%s', (cmd, expected) => {
    expect(tools(cmd)).toEqual(expected);
  });

  it('maps -p to the member directory', () => {
    expect(one('cargo test -p b-core')!.pathArgs).toEqual(['crates/b']);
    expect(one('cargo test --manifest-path crates/b/Cargo.toml')!.pathArgs).toEqual(['crates/b']);
  });
});

describe('identify: JVM', () => {
  it('maps Gradle tasks to categories, adding lint only when a lint plugin is configured', () => {
    expect(tools('./gradlew test', 'app')).toEqual(['gradle-test']);
    expect(tools('./gradlew check', 'app')).toEqual(['gradle-test']);
    expect(tools('gradle build', 'lint')).toEqual(['gradle-test', 'gradle-lint']);
    expect(tools('gradle spotlessCheck', 'lint')).toEqual(['gradle-lint']);
    expect(tools('./gradlew compileJava', 'app')).toEqual(['gradle-compile']);
    expect(tools('./gradlew --no-daemon :app:test')).toEqual(['gradle-test']);
    expect(one('./gradlew :app:test')!.pathArgs).toEqual(['app']);
  });

  it('maps Maven phases and goals', () => {
    expect(tools('mvn -q test')).toEqual(['maven-test']);
    expect(tools('./mvnw verify')).toEqual(['maven-test', 'maven-lint']);
    expect(tools('mvn checkstyle:check')).toEqual(['maven-lint']);
    expect(tools('mvn compile')).toEqual(['maven-compile']);
    expect(tools('mvn -B dependency:go-offline')).toEqual([]);
  });
});
