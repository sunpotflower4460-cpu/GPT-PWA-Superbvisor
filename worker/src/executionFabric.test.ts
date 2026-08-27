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
});

describe('createCiExecutionFabric', () => {
  it('builds a fabric from possibly-undefined job checks', async () => {
    const fabric = createCiExecutionFabric(undefined, false);
    expect(fabric.kind).toBe('CI');
    expect((await fabric.runTest()).status).toBe('unknown');
  });
});
