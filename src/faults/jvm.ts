/**
 * JVM faults, for Gradle and Maven builds.
 *
 * Recorded behavior (Gradle 9.8.0, Maven 3.9.16, Temurin 26.0.2 on macOS arm64, 2026-09-27;
 * Spotless 8.10.3 with google-java-format 1.36.1 and ktlint 1.8.0, Gradle's default Checkstyle
 * 10.24.0, maven-checkstyle-plugin 3.6.0 with Checkstyle 9.3, Surefire 3.5.4, Kotlin 2.4.20,
 * JUnit 5.14.4 and 4.13.2). Paths below are shortened; the tools print them in full.
 *
 * Gradle, Java, JUnit 5 (fixture jvm-gradle):
 * - test reach, an unterminated class in src/test/java: `gradle check` exits 1, ":compileTestJava
 *   FAILED" and javac's ".../Falsegreen<id>Test.java:3: error: reached end of file while parsing".
 *   `gradle build -x test` exits 1 the same way: checkstyleTest still compiles the test classes.
 * - test semantic, a JUnit 5 `fail()`: `gradle check` exits 1, "Falsegreen<id>Test >
 *   plantedFailure() FAILED". `gradle build -x test` exits 0.
 * - lint reach, an unterminated class in src/main/java: `gradle spotlessCheck` exits 1,
 *   "src/main/java/.../Falsegreen<id>.java:L3 google-java-format(google-java-format) error: reached
 *   end of file while parsing". `gradle checkstyleMain` and `gradle check` exit 1 at :compileJava
 *   (Checkstyle's classpath needs the compiled classes), with javac naming the file.
 * - lint semantic, tab indentation plus an unused import plus irregular spacing: `gradle
 *   spotlessCheck` exits 1, "The following files had format violations:
 *   src/main/java/.../Falsegreen<id>.java". `gradle checkstyleMain` exits 1, ".../Falsegreen<id>.java:3:8:
 *   Unused import - java.util.List. [UnusedImports]" and ":6:1: File contains tab characters (this
 *   is the first instance). [FileTabCharacter]". `gradle check` fails both tasks.
 * - compile reach: `gradle compileJava` exits 1, javac naming the file.
 *
 * Gradle, Kotlin DSL, kotlin.test (fixture jvm-kotlin):
 * - test reach: `gradle test` exits 1, "e: file:///.../Falsegreen<id>Test.kt:3:29 Syntax error:
 *   Missing '}.". `gradle build -x test` exits 0: with no lint plugin nothing compiles the tests.
 * - test semantic, kotlin.test `fail()`: exits 1, "Falsegreen<id>Test > plantedFailure() FAILED".
 * - compile reach: `gradle assemble` exits 1, "e: file:///.../Falsegreen<id>.kt:3:25 Syntax error:
 *   Missing '}.".
 *
 * Probed by hand, no fixture: Kotlin with JUnit 5 (`org.junit.jupiter.api.fail`) exits 1,
 * "Falsegreen<id>Test > plantedFailure() FAILED"; Kotlin with JUnit 4 (`org.junit.Assert.fail`)
 * exits 1, "Falsegreen<id>Test > plantedFailure FAILED". Spotless with ktlint: lint reach exits 1,
 * "src/main/kotlin/.../Falsegreen<id>.kt:L3 ktlint(ktlint) Missing '}"; lint semantic exits 1, "The
 * following files had format violations: src/main/kotlin/.../Falsegreen<id>.kt". A gate that lints
 * only test sources (`gradle checkstyleTest`) gets the lint file under src/test/java: exits 1,
 * UnusedImports and FileTabCharacter on ".../Falsegreen<id>Test.java". Not run at all:
 * the ktlint Gradle plugin, detekt, PMD, SpotBugs, and TestNG (a TestNG neighbor is skipped).
 *
 * Maven, Java, JUnit 4, checkstyle:check bound to validate (fixture jvm-maven):
 * - test reach: `mvn -B verify` exits 1, "[ERROR] .../Falsegreen<id>Test.java:[3,29] reached end of
 *   file while parsing".
 * - test semantic, a JUnit 4 `fail()`: exits 1, "[ERROR] com.example.calc.Falsegreen<id>Test.
 *   plantedFailure -- Time elapsed: ... <<< FAILURE!" and "java.lang.AssertionError: falsegreen_<id>:
 *   planted failing test". With `-Dmaven.test.failure.ignore=true` it prints the same and exits 0.
 * - lint reach: exits 1 in validate, "Failed during checkstyle configuration: Exception was thrown
 *   while processing .../Falsegreen<id>.java". `mvn -B compile` fails the same way, before javac.
 * - lint semantic: exits 1, "[ERROR] src/main/java/.../Falsegreen<id>.java:[3,8] (imports)
 *   UnusedImports: Unused import - java.util.List." and "[6,1] (whitespace) FileTabCharacter".
 *
 * After a revert, the next Gradle compile and the next maven-compiler-plugin run ("Recompiling the
 * module because of added or removed source files") delete the planted class's .class file, so a
 * planted test never runs again from a stale build directory.
 */
import { posix } from 'node:path';

import type { Marker } from '../core/marker';
import type { Tier } from '../core/types';
import { candidateDir, markerName } from './placement';
import type { Fault, FaultContext, ToolDef, ToolId } from './types';

type Lang = 'java' | 'kotlin';
type TestApi = 'junit4' | 'junit5' | 'kotlin-test';

/** Class names Surefire runs by default (`*IT` is Failsafe's); Gradle runs any class with tests. */
const TEST_CLASS = /(^|\/)(Test\w*|\w+(Test|Tests|TestCase))\.(java|kt)$/;
const TEST_SOURCE = /(^|\/)src\/test\/(java|kotlin)\//;
const MAIN_SOURCE = /(^|\/)src\/main\/(java|kotlin)\//;

/** Tasks and goals that read only one language's sources. */
const JAVA_ONLY =
  /^(compile\w*Java|checkstyle\w*|pmd\w*|spotbugs\w*|spotlessJava\w*)$|^(checkstyle|pmd|spotbugs):/;
const KOTLIN_ONLY = /^(compile\w*Kotlin|ktlint\w*|detekt\w*|spotlessKotlin\w*)$/;

/** Lint tasks and goals, and the plugins behind them. */
const LINT_TASK =
  /^(spotless\w*|ktlint\w*|detekt\w*|checkstyle\w*|pmd\w*|spotbugs\w*|lint)$|^(spotless|checkstyle|pmd|spotbugs):/;
const FORMATTER = /spotless|ktlint/i;
const RULE_TOOLS: [RegExp, string][] = [
  [/checkstyle/i, 'Checkstyle'],
  [/\bpmd/i, 'PMD'],
  [/spotbugs/i, 'SpotBugs'],
  [/detekt/i, 'detekt'],
  [/^lint$/m, 'Android Lint'],
];
const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'pom.xml'];

const langOf = (path: string): Lang => (path.endsWith('.kt') ? 'kotlin' : 'java');

const className = (path: string): string => posix.basename(path).replace(/\.(java|kt)$/, '');

/** The words that name tasks or goals: `:app:test` and `test` both give `test`, plus the raw word. */
function taskWords(argv: string[]): string[] {
  return argv
    .slice(1)
    .filter((a) => !a.startsWith('-'))
    .flatMap((a) => [a, a.split(':').filter(Boolean).at(-1) ?? a]);
}

function exts(ctx: FaultContext): string[] {
  const words = taskWords(ctx.invocation.argv);
  const java = words.some((w) => JAVA_ONLY.test(w));
  const kotlin = words.some((w) => KOTLIN_ONLY.test(w));
  if (java && !kotlin) return ['.java'];
  if (kotlin && !java) return ['.kt'];
  return ['.java', '.kt'];
}

/** `package a.b;` for Java, `package a.b` for Kotlin: the neighbor's, or else from the directory. */
function packageLine(ctx: FaultContext, dir: string, neighbor: string | undefined, lang: Lang) {
  const name =
    neighbor === undefined
      ? /src\/(test|main)\/(java|kotlin)\/(.+)$/.exec(dir)?.[3]?.replace(/\//g, '.')
      : /^\s*package\s+([\w.]+)/m.exec(ctx.read(neighbor))?.[1];
  if (name === undefined) return '';
  return lang === 'java' ? `package ${name};\n\n` : `package ${name}\n\n`;
}

/** The neighbor's indent unit, from its first indented line that is not inside a comment. */
function indentOf(ctx: FaultContext, neighbor: string, lang: Lang): string {
  const unit = /^([ \t]+)[^\s*]/m.exec(ctx.read(neighbor))?.[1];
  if (unit !== undefined) return unit.startsWith('\t') ? '\t' : unit;
  return lang === 'java' ? '  ' : '    ';
}

function apiIn(text: string): TestApi | 'testng' | undefined {
  if (/^import\s+kotlin\.test\.Test\b/m.test(text)) return 'kotlin-test';
  if (/^import\s+(static\s+)?org\.junit\.jupiter\./m.test(text)) return 'junit5';
  if (/^import\s+(static\s+)?org\.junit\.[A-Z*]/m.test(text)) return 'junit4';
  if (/^import\s+kotlin\.test\./m.test(text)) return 'kotlin-test';
  if (/^import\s+(static\s+)?org\.testng\./m.test(text)) return 'testng';
  return undefined;
}

/** The test framework the neighbor imports, or else the first test class beside it that imports one. */
function testApi(ctx: FaultContext, neighbor: string): TestApi | 'testng' | undefined {
  const dir = posix.dirname(neighbor);
  const siblings = ctx.tracked
    .filter((p) => p !== neighbor && posix.dirname(p) === dir && TEST_CLASS.test(p))
    .sort();
  for (const path of [neighbor, ...siblings]) {
    const api = apiIn(ctx.read(path));
    if (api !== undefined) return api;
  }
  return undefined;
}

/** A class declaration that never closes: no compiler, formatter or linter accepts the file. */
function unparseable(pkg: string, cls: string): string {
  return `${pkg}class ${cls} {\n`;
}

/** A test that fails with the marker, shaped so formatters and import rules pass it. */
function failingTest(api: TestApi, lang: Lang, pkg: string, cls: string, i: string, m: Marker) {
  const message = `"${m.snake}: planted failing test"`;
  if (lang === 'kotlin') {
    const imports = {
      'kotlin-test': ['kotlin.test.Test', 'kotlin.test.fail'],
      junit5: ['org.junit.jupiter.api.Test', 'org.junit.jupiter.api.fail'],
      junit4: ['org.junit.Assert.fail', 'org.junit.Test'],
    }[api];
    return (
      `${pkg}${imports.map((name) => `import ${name}\n`).join('')}\n` +
      `class ${cls} {\n${i}@Test\n${i}fun plantedFailure() {\n${i}${i}fail(${message})\n${i}}\n}\n`
    );
  }
  const [assertions, annotation, visibility] =
    api === 'junit4'
      ? ['org.junit.Assert', 'org.junit.Test', 'public ']
      : ['org.junit.jupiter.api.Assertions', 'org.junit.jupiter.api.Test', ''];
  return (
    `${pkg}import static ${assertions}.fail;\n\nimport ${annotation};\n\n` +
    `${visibility}class ${cls} {\n${i}@Test\n${i}${visibility}void plantedFailure() {\n` +
    `${i}${i}fail(${message});\n${i}}\n}\n`
  );
}

/** Valid code no formatter leaves alone, which common rule sets reject: tabs and an unused import. */
function lintViolations(lang: Lang, pkg: string, cls: string): string {
  return lang === 'java'
    ? `${pkg}import java.util.List;\n\npublic class ${cls}   {\n\tpublic   int   plantedLint( ) {  return 1 ;  }\n}\n`
    : `${pkg}import java.io.File\n\nclass ${cls}   {\n\tfun   plantedLint( ) : Int {  return 1  }\n}\n`;
}

/**
 * Why the lint semantic fault may survive a gate whose only linters run project-chosen rules:
 * the lint tasks the step names, or else the plugins its build files mention.
 */
function ruleOnlyLinters(ctx: FaultContext): string | undefined {
  const named = taskWords(ctx.invocation.argv).filter((w) => LINT_TASK.test(w));
  const dirs = [ctx.invocation.cwd, ...ctx.invocation.pathArgs, ''];
  const text =
    named.length > 0
      ? named.join('\n')
      : ctx.tracked
          .filter((p) => BUILD_FILES.includes(posix.basename(p)))
          .filter((p) => dirs.includes(posix.dirname(p) === '.' ? '' : posix.dirname(p)))
          .map((p) => ctx.read(p))
          .join('\n');
  if (FORMATTER.test(text)) return undefined;
  const tools = RULE_TOOLS.filter(([re]) => re.test(text)).map(([, name]) => name);
  if (tools.length === 0) return undefined;
  return `${tools.join(', ')} report only the rules this project enables; the planted file has tab indentation and an unused import, which survive when no enabled rule covers them`;
}

function fault(
  ctx: FaultContext,
  tool: ToolId,
  tier: Tier,
  file: { path: string; content: string },
  description: string,
): Fault {
  return {
    tool,
    tier,
    marker: ctx.marker,
    files: [file],
    appends: [],
    description: `${description}: ${file.path}`,
  };
}

/** A test class next to an existing one: one that does not compile, or one whose test fails. */
function testFault(tool: ToolId, ctx: FaultContext, tier: Tier): Fault | { skip: string } {
  const where = candidateDir(ctx, {
    kind: 'test',
    exts: exts(ctx),
    testPattern: TEST_CLASS,
    accept: (p) => TEST_SOURCE.test(p),
  });
  if (!where?.neighbor) return { skip: `no test class found under src/test where ${tool} runs` };
  const lang = langOf(where.neighbor);
  let path = markerName(where.neighbor, ctx.marker, 'jvm');
  // `FooTestCase` has no affix markerName keeps, and a plain class name is not run by Surefire.
  if (!TEST_CLASS.test(path)) path = path.replace(/\.(java|kt)$/, 'Test.$1');
  const pkg = packageLine(ctx, where.dir, where.neighbor, lang);
  const cls = className(path);
  if (tier === 'reach') {
    const content = unparseable(pkg, cls);
    return fault(ctx, tool, tier, { path, content }, 'test class that does not compile');
  }
  const api = testApi(ctx, where.neighbor);
  if (api === undefined || api === 'testng') {
    return { skip: `${where.neighbor} does not import JUnit 4, JUnit 5 or kotlin.test` };
  }
  const indent = indentOf(ctx, where.neighbor, lang);
  const content = failingTest(api, lang, pkg, cls, indent, ctx.marker);
  return fault(ctx, tool, tier, { path, content }, 'failing test');
}

/** A source file next to existing ones in the main (or test) source set, named after the marker. */
function sourceFile(ctx: FaultContext, set: 'main' | 'test') {
  const types = exts(ctx);
  const root = set === 'main' ? MAIN_SOURCE : TEST_SOURCE;
  const where = candidateDir(ctx, { kind: 'source', exts: types, accept: (p) => root.test(p) });
  if (!where) return undefined;
  const path = where.neighbor
    ? markerName(where.neighbor, ctx.marker, 'jvm')
    : posix.join(where.dir, `${ctx.marker.pascal}${types[0]}`);
  return { path, pkg: packageLine(ctx, where.dir, where.neighbor, langOf(path)) };
}

/** True when every lint task the step names reads only test sources (`checkstyleTest`). */
function lintsOnlyTests(ctx: FaultContext): boolean {
  const named = taskWords(ctx.invocation.argv).filter((w) => LINT_TASK.test(w));
  return named.length > 0 && named.every((w) => /Test(SourceSetCheck)?$/.test(w));
}

function compileFault(tool: ToolId, ctx: FaultContext, tier: Tier): Fault | { skip: string } {
  if (tier === 'semantic') {
    return { skip: `${tool} has no semantic fault: compiling is its only check` };
  }
  const src = sourceFile(ctx, 'main');
  if (!src) return { skip: `no main sources found under src/main where ${tool} runs` };
  const content = unparseable(src.pkg, className(src.path));
  return fault(ctx, tool, tier, { path: src.path, content }, 'source file that does not compile');
}

function lintFault(tool: ToolId, ctx: FaultContext, tier: Tier): Fault | { skip: string } {
  const set = lintsOnlyTests(ctx) ? 'test' : 'main';
  const src = sourceFile(ctx, set);
  if (!src) return { skip: `no ${set} sources found under src/${set} where ${tool} runs` };
  const cls = className(src.path);
  if (tier === 'reach') {
    const content = unparseable(src.pkg, cls);
    return fault(ctx, tool, tier, { path: src.path, content }, 'source file that does not parse');
  }
  const content = lintViolations(langOf(src.path), src.pkg, cls);
  const planted = fault(
    ctx,
    tool,
    tier,
    { path: src.path, content },
    'badly formatted source with an unused import',
  );
  const survival = ruleOnlyLinters(ctx);
  return survival === undefined ? planted : { ...planted, expectSurvival: survival };
}

type Build = (tool: ToolId, ctx: FaultContext, tier: Tier) => Fault | { skip: string };

const def = (id: ToolId, category: 'test' | 'lint' | 'compile', build: Build): ToolDef => ({
  id,
  language: 'jvm',
  category,
  faults: (ctx, tier) => build(id, ctx, tier),
});

export const JVM_TOOLS: ToolDef[] = [
  def('gradle-test', 'test', testFault),
  def('gradle-lint', 'lint', lintFault),
  def('gradle-compile', 'compile', compileFault),
  def('maven-test', 'test', testFault),
  def('maven-lint', 'lint', lintFault),
  def('maven-compile', 'compile', compileFault),
];
