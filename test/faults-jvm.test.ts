import { describe, expect, it } from 'vitest';

import type { Marker } from '../src/core/marker';
import type { Tier } from '../src/core/types';
import { JVM_TOOLS } from '../src/faults/jvm';
import type { Fault, ToolId } from '../src/faults/types';

const marker: Marker = { id: 'abc123', snake: 'falsegreen_abc123', pascal: 'Falsegreenabc123' };

interface Call {
  argv?: string;
  cwd?: string;
  pathArgs?: string[];
  place?: string;
}

function faults(
  tool: ToolId,
  files: Record<string, string>,
  tier: Tier,
  call: Call = {},
): Fault | { skip: string } {
  const argv = call.argv ?? 'gradle check';
  const def = JVM_TOOLS.find((d) => d.id === tool)!;
  return def.faults(
    {
      root: '/unused',
      tracked: Object.keys(files),
      invocation: {
        tool,
        argv: argv.split(' '),
        cwd: call.cwd ?? '',
        pathArgs: call.pathArgs ?? [],
        via: [argv],
      },
      marker,
      ...(call.place === undefined ? {} : { place: call.place }),
      read: (p) => files[p] ?? '',
    },
    tier,
  );
}

function planted(result: Fault | { skip: string }): Fault & { path: string; content: string } {
  if ('skip' in result) throw new Error(`expected a fault, got skip: ${result.skip}`);
  expect(result.files).toHaveLength(1);
  return { ...result, ...result.files[0]! };
}

const CALC = 'package com.example.calc;\n\npublic final class Calc {}\n';
const JUNIT5_TEST = `package com.example.calc;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CalcTest {
  @Test
  void adds() {
    assertEquals(3, Calc.add(1, 2));
  }
}
`;
const JUNIT4_TEST = `package com.example.calc;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class CalcTest {
    @Test
    public void adds() {
        assertEquals(3, Calc.add(1, 2));
    }
}
`;
const KOTLIN_TEST = `package com.example.calc

import kotlin.test.Test
import kotlin.test.assertEquals

class CalcTest {
    @Test
    fun adds() {
        assertEquals(3, add(1, 2))
    }
}
`;

const javaProject = (test: string): Record<string, string> => ({
  'build.gradle': "plugins { id 'java' }\n",
  'src/main/java/com/example/calc/Calc.java': CALC,
  'src/test/java/com/example/calc/CalcTest.java': test,
});

describe('JVM_TOOLS', () => {
  it('defines every Gradle and Maven tool id', () => {
    expect(JVM_TOOLS.map((d) => [d.id, d.category, d.language])).toEqual([
      ['gradle-test', 'test', 'jvm'],
      ['gradle-lint', 'lint', 'jvm'],
      ['gradle-compile', 'compile', 'jvm'],
      ['maven-test', 'test', 'jvm'],
      ['maven-lint', 'lint', 'jvm'],
      ['maven-compile', 'compile', 'jvm'],
    ]);
  });
});

describe('test faults', () => {
  it('writes a JUnit 5 test in the neighbor package, directory and indentation', () => {
    const f = planted(faults('gradle-test', javaProject(JUNIT5_TEST), 'semantic'));
    expect(f.path).toBe('src/test/java/com/example/calc/Falsegreenabc123Test.java');
    expect(f.content).toBe(`package com.example.calc;

import static org.junit.jupiter.api.Assertions.fail;

import org.junit.jupiter.api.Test;

class Falsegreenabc123Test {
  @Test
  void plantedFailure() {
    fail("falsegreen_abc123: planted failing test");
  }
}
`);
    expect(f.description).toBe(`failing test: ${f.path}`);
  });

  it('writes a public JUnit 4 test when the neighbor imports org.junit', () => {
    const f = planted(faults('maven-test', javaProject(JUNIT4_TEST), 'semantic'));
    expect(f.content).toBe(`package com.example.calc;

import static org.junit.Assert.fail;

import org.junit.Test;

public class Falsegreenabc123Test {
    @Test
    public void plantedFailure() {
        fail("falsegreen_abc123: planted failing test");
    }
}
`);
  });

  it('writes Kotlin with the framework the Kotlin neighbor imports', () => {
    const files = {
      'src/main/kotlin/com/example/calc/Calc.kt': 'package com.example.calc\n',
      'src/test/kotlin/com/example/calc/CalcTest.kt': KOTLIN_TEST,
    };
    const f = planted(faults('gradle-test', files, 'semantic'));
    expect(f.path).toBe('src/test/kotlin/com/example/calc/Falsegreenabc123Test.kt');
    expect(f.content).toBe(`package com.example.calc

import kotlin.test.Test
import kotlin.test.fail

class Falsegreenabc123Test {
    @Test
    fun plantedFailure() {
        fail("falsegreen_abc123: planted failing test")
    }
}
`);

    const junit5 = KOTLIN_TEST.replace(
      'import kotlin.test.Test',
      'import org.junit.jupiter.api.Test',
    );
    const five = planted(
      faults('gradle-test', { 'src/test/kotlin/a/CalcTest.kt': junit5 }, 'semantic'),
    );
    expect(five.content).toContain(
      'import org.junit.jupiter.api.Test\nimport org.junit.jupiter.api.fail\n',
    );

    const junit4 = 'package a\n\nimport org.junit.Assert.assertEquals\nimport org.junit.Test\n';
    const four = planted(
      faults('gradle-test', { 'src/test/kotlin/a/CalcTest.kt': junit4 }, 'semantic'),
    );
    expect(four.content).toContain('import org.junit.Assert.fail\nimport org.junit.Test\n');
  });

  it('writes a test class that never closes for the reach tier', () => {
    const f = planted(faults('gradle-test', javaProject(JUNIT5_TEST), 'reach'));
    expect(f.content).toBe('package com.example.calc;\n\nclass Falsegreenabc123Test {\n');
    expect(f.description).toContain('does not compile');
  });

  it('copies tab indentation and the default package', () => {
    const tabbed =
      'import org.junit.jupiter.api.Test;\n\nclass CalcTest {\n\t@Test\n\tvoid adds() {}\n}\n';
    const f = planted(faults('gradle-test', { 'src/test/java/CalcTest.java': tabbed }, 'semantic'));
    expect(f.path).toBe('src/test/java/Falsegreenabc123Test.java');
    expect(f.content.startsWith('import static')).toBe(true);
    expect(f.content).toContain('\n\t@Test\n\tvoid plantedFailure() {\n\t\tfail(');
  });

  it('reads the framework from a sibling when the neighbor imports none', () => {
    const files = {
      'src/test/java/a/ATest.java': 'package a;\n\nclass ATest extends BaseTest {}\n',
      'src/test/java/a/BTest.java': JUNIT4_TEST,
    };
    expect(planted(faults('maven-test', files, 'semantic')).content).toContain(
      'org.junit.Assert.fail',
    );
  });

  it('skips the semantic tier for TestNG and for tests with no known framework', () => {
    const testng = {
      'src/test/java/a/ATest.java': 'package a;\n\nimport org.testng.annotations.Test;\n',
    };
    expect(faults('maven-test', testng, 'semantic')).toEqual({
      skip: 'src/test/java/a/ATest.java does not import JUnit 4, JUnit 5 or kotlin.test',
    });
    const none = { 'src/test/java/a/ATest.java': 'package a;\n\nclass ATest {}\n' };
    expect(faults('maven-test', none, 'semantic')).toHaveProperty('skip');
    // The reach tier needs no framework: the file never compiles.
    expect(planted(faults('maven-test', none, 'reach')).path).toBe(
      'src/test/java/a/Falsegreenabc123Test.java',
    );
  });

  it('names the class so Surefire runs it, and ignores integration tests and other source sets', () => {
    const files = {
      'src/test/java/a/CalcTestCase.java': JUNIT4_TEST,
      'src/test/java/b/OneIT.java': JUNIT4_TEST,
      'src/test/java/b/TwoIT.java': JUNIT4_TEST,
      'src/integrationTest/java/c/OneTest.java': JUNIT4_TEST,
      'src/integrationTest/java/c/TwoTest.java': JUNIT4_TEST,
      'src/main/java/d/MainTest.java': JUNIT4_TEST,
    };
    expect(planted(faults('maven-test', files, 'reach')).path).toBe(
      'src/test/java/a/Falsegreenabc123Test.java',
    );
    const onlyIt = { 'src/test/java/b/OneIT.java': JUNIT4_TEST };
    expect(faults('maven-test', onlyIt, 'semantic')).toEqual({
      skip: 'no test class found under src/test where maven-test runs',
    });
  });

  it('keeps a Test prefix and plants in the module the step names', () => {
    const files = {
      'app/src/test/java/a/TestCalc.java': JUNIT5_TEST,
      'lib/src/test/java/b/OneTest.java': JUNIT5_TEST,
      'lib/src/test/java/b/TwoTest.java': JUNIT5_TEST,
    };
    expect(planted(faults('gradle-test', files, 'reach')).path).toBe(
      'lib/src/test/java/b/Falsegreenabc123Test.java',
    );
    const app = faults('gradle-test', files, 'reach', {
      argv: 'gradle :app:test',
      pathArgs: ['app'],
    });
    expect(planted(app).path).toBe('app/src/test/java/a/TestFalsegreenabc123.java');
  });
});

describe('compile faults', () => {
  it('plants a main-source class that never closes, and has no semantic tier', () => {
    const f = planted(
      faults('maven-compile', javaProject(JUNIT4_TEST), 'reach', { argv: 'mvn compile' }),
    );
    expect(f.path).toBe('src/main/java/com/example/calc/Falsegreenabc123.java');
    expect(f.content).toBe('package com.example.calc;\n\nclass Falsegreenabc123 {\n');
    expect(faults('maven-compile', javaProject(JUNIT4_TEST), 'semantic')).toEqual({
      skip: 'maven-compile has no semantic fault: compiling is its only check',
    });
  });

  it('picks the language the task compiles', () => {
    const files = {
      'src/main/java/a/One.java': 'package a;\n',
      'src/main/kotlin/b/One.kt': 'package b\n',
      'src/main/kotlin/b/Two.kt': 'package b\n',
    };
    const java = faults('gradle-compile', files, 'reach', { argv: 'gradle compileJava' });
    expect(planted(java).path).toBe('src/main/java/a/Falsegreenabc123.java');
    const kotlin = planted(
      faults('gradle-compile', files, 'reach', { argv: 'gradle :compileKotlin' }),
    );
    expect(kotlin.path).toBe('src/main/kotlin/b/Falsegreenabc123.kt');
    expect(kotlin.content).toBe('package b\n\nclass Falsegreenabc123 {\n');
  });

  it('derives the package from the directory when a place: directory has no neighbor', () => {
    const f = planted(
      faults('gradle-compile', javaProject(JUNIT5_TEST), 'reach', {
        place: 'src/main/java/com/example/extra',
      }),
    );
    expect(f.path).toBe('src/main/java/com/example/extra/Falsegreenabc123.java');
    expect(f.content).toBe('package com.example.extra;\n\nclass Falsegreenabc123 {\n');
  });

  it('skips when there are no main sources or no tests', () => {
    const tests = { 'src/test/java/a/ATest.java': JUNIT5_TEST };
    expect(faults('gradle-compile', tests, 'reach')).toEqual({
      skip: 'no main sources found under src/main where gradle-compile runs',
    });
    expect(faults('gradle-lint', tests, 'semantic')).toHaveProperty('skip');
    expect(faults('gradle-test', { 'src/main/java/a/A.java': CALC }, 'reach')).toHaveProperty(
      'skip',
    );
  });
});

describe('lint faults', () => {
  it('plants badly formatted Java with tabs and an unused import', () => {
    const f = planted(faults('gradle-lint', javaProject(JUNIT5_TEST), 'semantic'));
    expect(f.path).toBe('src/main/java/com/example/calc/Falsegreenabc123.java');
    expect(f.content).toBe(
      'package com.example.calc;\n\nimport java.util.List;\n\npublic class Falsegreenabc123   {\n\tpublic   int   plantedLint( ) {  return 1 ;  }\n}\n',
    );
    expect(planted(faults('gradle-lint', javaProject(JUNIT5_TEST), 'reach')).content).toBe(
      'package com.example.calc;\n\nclass Falsegreenabc123 {\n',
    );
  });

  it('plants Kotlin next to Kotlin sources', () => {
    const files = { 'src/main/kotlin/a/Calc.kt': 'package a\n\nfun add() = 1\n' };
    const f = planted(faults('gradle-lint', files, 'semantic', { argv: 'gradle ktlintCheck' }));
    expect(f.path).toBe('src/main/kotlin/a/Falsegreenabc123.kt');
    expect(f.content).toContain('import java.io.File\n');
    expect(f.content).toContain('\n\tfun   plantedLint( )');
  });

  it('plants in test sources when the step lints only test sources', () => {
    const lint = (argv: string) =>
      planted(faults('gradle-lint', javaProject(JUNIT5_TEST), 'semantic', { argv })).path;
    expect(lint('gradle :app:checkstyleTest')).toBe(
      'src/test/java/com/example/calc/Falsegreenabc123Test.java',
    );
    expect(lint('gradle checkstyleTest checkstyleMain')).toBe(
      'src/main/java/com/example/calc/Falsegreenabc123.java',
    );
    expect(
      faults('gradle-lint', { 'src/main/java/a/A.java': CALC }, 'reach', {
        argv: 'gradle detektTest',
      }),
    ).toEqual({ skip: 'no test sources found under src/test where gradle-lint runs' });
  });

  it('warns that rule-driven linters may pass the file, unless a formatter also runs', () => {
    const survival = (files: Record<string, string>, argv: string) => {
      const f = planted(
        faults(argv.startsWith('mvn') ? 'maven-lint' : 'gradle-lint', files, 'semantic', { argv }),
      );
      return f.expectSurvival;
    };
    const checkstyle = {
      ...javaProject(JUNIT5_TEST),
      'build.gradle': "plugins { id 'checkstyle' }\n",
    };
    expect(survival(checkstyle, 'gradle check')).toMatch(/^Checkstyle report only the rules/);

    const both = {
      ...javaProject(JUNIT5_TEST),
      'build.gradle': "plugins { id 'checkstyle'\n id 'com.diffplug.spotless' version 'x' }\n",
    };
    expect(survival(both, 'gradle check')).toBeUndefined();
    expect(survival(both, 'gradle checkstyleMain')).toMatch(/^Checkstyle /);
    expect(survival(both, 'gradle spotlessCheck')).toBeUndefined();

    const pom = {
      'pom.xml':
        '<artifactId>maven-pmd-plugin</artifactId><artifactId>spotbugs-maven-plugin</artifactId>',
      'src/main/java/a/A.java': 'package a;\n',
    };
    expect(survival(pom, 'mvn verify')).toMatch(/^PMD, SpotBugs report only/);
    expect(survival({ 'src/main/java/a/A.java': 'package a;\n' }, 'gradle check')).toBeUndefined();
  });
});
