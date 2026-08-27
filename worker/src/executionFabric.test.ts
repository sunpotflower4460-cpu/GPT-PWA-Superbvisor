import { describe, expect, it } from 'vitest';
import { CiExecutionFabric, createCiExecutionFabric } from './executionFabric';
import { CiCheckLike } from './orchestratorPolicy';

const passingCheck: CiCheckLike = {
  id: 1,
  name: 'guard',
  status: 'completed',
  conclusion: 'success',
  url: 'https://github.com/example/repo/actions/runs/1',
  headSha: 'abc123',
};

const failingCheck: CiCheckLike = {
  ...passingCheck,
  id: 2,
  name: 'test',
  conclusion: 'failure',
};

describe('CiExecutionFabric', () => {
  it('reports unknown when no checks have been observed yet', async () => {
    const fabric = new CiExecutionFabric([], false);
    const result = await fabric.runTest();
    expect(result.status).toBe('unknown');
  });

  it('reports pending while any check is still running', async () => {
    const fabric = new CiExecutionFabric([{ ...passingCheck, status: 'in_progress', conclusion: null }], true);
    expect((await fabric.runTest()).status).toBe('pending');
  });

  it('reports passed only when every check succeeded', async () => {
    const fabric = new CiExecutionFabric([passingCheck], true);
    const result = await fabric.runBuild();
    expect(result.status).toBe('passed');
    expect(result.exitCode).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it('treats neutral and skipped conclusions as passing, not failing', async () => {
    const fabric = new CiExecutionFabric([
      { ...passingCheck, conclusion: 'neutral' },
      { ...passingCheck, id: 3, conclusion: 'skipped' },
    ], true);
    const result = await fabric.runBuild();
    expect(result.status).toBe('passed');
    expect(result.failures).toEqual([]);
    const logs = await fabric.inspectLogs();
    expect(logs.every((log) => log.status === 'passed' && log.failures.length === 0)).toBe(true);
  });

  it('reports failed with structured failures, not a raw log dump', async () => {
    const fabric = new CiExecutionFabric([passingCheck, failingCheck], true);
    const result = await fabric.runTypecheck();
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].message).toContain('test');
  });

  it('never fakes running an arbitrary command', async () => {
    const fabric = new CiExecutionFabric([passingCheck], true);
    const result = await fabric.runCommand('rm -rf /');
    expect(result.status).toBe('unknown');
    expect(result.command).toBe('rm -rf /');
  });

  it('maps each check to a structured log entry via inspectLogs', async () => {
    const fabric = new CiExecutionFabric([passingCheck, failingCheck], true);
    const logs = await fabric.inspectLogs();
    expect(logs).toHaveLength(2);
    expect(logs[1].status).toBe('failed');
    expect(logs[1].artifact).toBe(failingCheck.url);
  });

  it('reports health based on whether CI has been observed for the current head', async () => {
    expect((await new CiExecutionFabric([], false).health()).available).toBe(false);
    expect((await new CiExecutionFabric([], true).health()).available).toBe(true);
  });

  it('isolates a phase by check name instead of reporting the aggregate when names allow it', async () => {
    const unitTests: CiCheckLike = { ...passingCheck, id: 3, name: 'unit-tests', conclusion: 'failure' };
    const buildJob: CiCheckLike = { ...passingCheck, id: 4, name: 'build', conclusion: 'success' };
    const typecheckJob: CiCheckLike = { ...passingCheck, id: 5, name: 'typecheck', conclusion: 'success' };
    const fabric = new CiExecutionFabric([unitTests, buildJob, typecheckJob], true);

    // The failing test check must not drag down build/typecheck once the
    // fabric can isolate them by name — that's the whole point of this
    // routing over the old always-aggregate behavior.
    expect((await fabric.runTest()).status).toBe('failed');
    expect((await fabric.runBuild()).status).toBe('passed');
    expect((await fabric.runTypecheck()).status).toBe('passed');
  });

  it('labels the command with which checks it matched by name', async () => {
    const unitTests: CiCheckLike = { ...passingCheck, id: 3, name: 'unit-tests', conclusion: 'success' };
    const fabric = new CiExecutionFabric([unitTests], true);
    const result = await fabric.runTest();
    expect(result.command).toContain('unit-tests');
    expect(result.command).not.toContain('aggregate');
  });

  it('falls back to the full aggregate, and says so, when no check name matches the phase', async () => {
    const combinedJob: CiCheckLike = { ...passingCheck, id: 3, name: 'worker-check', conclusion: 'success' };
    const fabric = new CiExecutionFabric([combinedJob], true);
    const result = await fabric.runTest();
    expect(result.status).toBe('passed');
    expect(result.command).toContain('aggregate');
    expect(result.command).toContain('no check name matched');
  });

  it('surfaces a target repo\'s own browser/visual CI job by name, without launching a browser itself', async () => {
    const playwrightJob: CiCheckLike = { ...passingCheck, id: 3, name: 'playwright-e2e', conclusion: 'failure' };
    const otherJob: CiCheckLike = { ...passingCheck, id: 4, name: 'lint', conclusion: 'success' };
    const fabric = new CiExecutionFabric([playwrightJob, otherJob], true);

    const result = await fabric.runBrowser();
    expect(fabric.kind).toBe('CI');
    expect(result.status).toBe('failed');
    expect(result.command).toContain('playwright-e2e');
    expect(result.command).not.toContain('lint');
  });

  it('reports unknown, not a borrowed aggregate, for runBrowser when no check name looks like a browser job', async () => {
    const fabric = new CiExecutionFabric([passingCheck], true);
    const result = await fabric.runBrowser();
    expect(result.status).toBe('unknown');
    expect(result.command).toContain('no browser CI evidence available');
    expect(result.command).not.toContain('aggregate');
  });

  it('matches phase keywords on word boundaries, not as an arbitrary substring', async () => {
    const inspectionJob: CiCheckLike = { ...passingCheck, id: 3, name: 'deployment-inspection', conclusion: 'success' };
    const genericCiJob: CiCheckLike = { ...passingCheck, id: 4, name: 'ci', conclusion: 'failure' };
    const fabric = new CiExecutionFabric([inspectionJob, genericCiJob], true);

    // "inspection" contains "spec" as a substring but is not the word
    // "spec" — must not be picked up by the test keyword, so this falls
    // back to the (failing) aggregate instead of reporting a false pass.
    const result = await fabric.runTest();
    expect(result.command).toContain('aggregate');
    expect(result.status).toBe('failed');
  });

  it('still matches a hyphenated keyword against a check literally named that phase', async () => {
    const typeCheckJob: CiCheckLike = { ...passingCheck, id: 3, name: 'worker-type-check-ci', conclusion: 'failure' };
    const fabric = new CiExecutionFabric([typeCheckJob], true);
    const result = await fabric.runTypecheck();
    expect(result.command).toContain('worker-type-check-ci');
    expect(result.status).toBe('failed');
  });

  it('still matches a plural/suffixed job name like "tests" or "integration-tests", not just the bare word', async () => {
    const testsJob: CiCheckLike = { ...passingCheck, id: 3, name: 'integration-tests', conclusion: 'failure' };
    const otherJob: CiCheckLike = { ...passingCheck, id: 4, name: 'lint', conclusion: 'success' };
    const fabric = new CiExecutionFabric([testsJob, otherJob], true);

    const result = await fabric.runTest();
    expect(result.command).toContain('integration-tests');
    expect(result.command).not.toContain('lint');
    expect(result.status).toBe('failed');
  });

  it('never matches "test" against an unrelated word that merely contains it, like "ubuntu-latest"', async () => {
    const latestJob: CiCheckLike = { ...passingCheck, id: 3, name: 'build-ubuntu-latest', conclusion: 'success' };
    const genericCiJob: CiCheckLike = { ...passingCheck, id: 4, name: 'ci', conclusion: 'failure' };
    const fabric = new CiExecutionFabric([latestJob, genericCiJob], true);

    const result = await fabric.runTest();
    expect(result.command).toContain('aggregate');
    expect(result.status).toBe('failed');
  });

  it('never matches "spec" as a prefix of an unrelated word like "specification"', async () => {
    const specificationJob: CiCheckLike = { ...passingCheck, id: 3, name: 'specification-lint', conclusion: 'success' };
    const genericCiJob: CiCheckLike = { ...passingCheck, id: 4, name: 'ci', conclusion: 'failure' };
    const fabric = new CiExecutionFabric([specificationJob, genericCiJob], true);

    // Only "spec" as a whole word/plural/gerund should match — "specification"
    // is a different word entirely, so this must fall back to the (failing)
    // aggregate rather than reporting the test phase as a false pass.
    const result = await fabric.runTest();
    expect(result.command).toContain('aggregate');
    expect(result.status).toBe('failed');
  });

  it('still matches a gerund like "testing"', async () => {
    const testingJob: CiCheckLike = { ...passingCheck, id: 3, name: 'testing-suite', conclusion: 'failure' };
    const fabric = new CiExecutionFabric([testingJob], true);
    const result = await fabric.runTest();
    expect(result.command).toContain('testing-suite');
    expect(result.status).toBe('failed');
  });
});

describe('createCiExecutionFabric', () => {
  it('builds a fabric from possibly-undefined job checks', async () => {
    const fabric = createCiExecutionFabric(undefined, false);
    expect(fabric.kind).toBe('CI');
    expect((await fabric.runTest()).status).toBe('unknown');
  });
});
