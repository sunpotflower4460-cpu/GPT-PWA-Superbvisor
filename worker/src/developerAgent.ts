import {
  GitHubEnv,
  GitHubWorkspace,
  compareWorkspace,
  createPullRequest,
  createWorkspace,
  deleteFile,
  getBranchWorkflowRuns,
  listTree,
  readFile,
  writeFile,
} from './githubExecutor';
import { PushEnv, sendSupervisorPush } from './push';

interface AgentEnv extends GitHubEnv, PushEnv {
  OPENAI_API_KEY: string;
  OPENAI_MODEL?: string;
  SUPERVISOR_STATE: KVNamespace;
}

export interface CreateDeveloperJobBody {
  projectId?: string;
  projectName?: string;
  repository: string;
  goal: string;
  prompt: string;
  model?: string;
  maxToolTurns?: number;
}

export type DeveloperJobStatus = 'starting' | 'running' | 'completed' | 'failed';

export interface DeveloperJob {
  id: string;
  projectId?: string;
  projectName?: string;
  repository: string;
  goal: string;
  prompt: string;
  model: string;
  workspace: GitHubWorkspace;
  status: DeveloperJobStatus;
  currentResponseId?: string;
  toolTurns: number;
  maxToolTurns: number;
  createdAt: string;
  updatedAt: string;
  outputText?: string;
  error?: string;
  changedFiles?: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
  pullRequest?: { number: number; url: string; draft: true };
  managedByGoalRunId?: string;
}

interface ResponseRecord {
  id: string;
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: ResponseOutputItem[];
}

type ResponseOutputItem =
  | { type: 'function_call'; call_id: string; name: string; arguments: string; status?: string }
  | { type: 'message'; content?: Array<{ type?: string; text?: string }> }
  | { type: string; [key: string]: unknown };

interface FunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

const JOB_TTL = 60 * 60 * 24 * 14;
const MAX_TOOL_TURNS = 16;
const TOOL_OUTPUT_LIMIT = 120_000;

const tools = [
  {
    type: 'function',
    name: 'github_list_tree',
    description: 'List text/blob paths in the current protected feature-branch workspace. Use this before guessing file locations.',
    strict: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false, required: [] },
  },
  {
    type: 'function',
    name: 'github_read_file',
    description: 'Read one UTF-8 text file from the current protected feature branch.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: { path: { type: 'string', minLength: 1, maxLength: 500 } },
    },
  },
  {
    type: 'function',
    name: 'github_write_file',
    description: 'Create or replace one UTF-8 text file on the protected feature branch. Never write secrets. Keep each file under 250 KB.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false, required: ['path', 'content', 'message'],
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 500 },
        content: { type: 'string', maxLength: 250000 },
        message: { type: 'string', minLength: 1, maxLength: 180 },
      },
    },
  },
  {
    type: 'function',
    name: 'github_delete_file',
    description: 'Delete one file from the protected feature branch. Use only when clearly needed by the task.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false, required: ['path', 'message'],
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 500 },
        message: { type: 'string', minLength: 1, maxLength: 180 },
      },
    },
  },
  {
    type: 'function',
    name: 'github_compare',
    description: 'Compare the protected feature branch with the repository default branch and return changed-file statistics.',
    strict: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false, required: [] },
  },
  {
    type: 'function',
    name: 'github_ci_status',
    description: 'Read recent GitHub Actions workflow runs for the protected feature branch. Do not repeatedly poll in a tight loop.',
    strict: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false, required: [] },
  },
] as const;

export async function createDeveloperJob(env: AgentEnv, body: CreateDeveloperJobBody): Promise<DeveloperJob> {
  return createDeveloperJobInternal(env, body);
}

export async function createManagedDeveloperJob(
  env: AgentEnv,
  body: CreateDeveloperJobBody,
  goalRunId: string,
  workspace?: GitHubWorkspace,
): Promise<DeveloperJob> {
  return createDeveloperJobInternal(env, body, workspace, goalRunId);
}

export async function continueDeveloperJob(
  env: AgentEnv,
  previous: DeveloperJob,
  prompt: string,
  goalRunId?: string,
): Promise<DeveloperJob> {
  return createDeveloperJobInternal(env, {
    projectId: previous.projectId,
    projectName: previous.projectName,
    repository: previous.repository,
    goal: previous.goal,
    prompt,
    model: previous.model,
    maxToolTurns: previous.maxToolTurns,
  }, previous.workspace, goalRunId ?? previous.managedByGoalRunId);
}

async function createDeveloperJobInternal(
  env: AgentEnv,
  body: CreateDeveloperJobBody,
  existingWorkspace?: GitHubWorkspace,
  managedByGoalRunId?: string,
): Promise<DeveloperJob> {
  if (!body.repository?.trim() || !body.goal?.trim() || !body.prompt?.trim()) throw new Error('repository, goal and prompt are required');
  const id = crypto.randomUUID();
  const model = body.model?.trim() || env.OPENAI_MODEL?.trim() || 'gpt-5.6-luna';
  const maxToolTurns = clamp(body.maxToolTurns ?? 10, 1, MAX_TOOL_TURNS);
  const workspace = existingWorkspace ?? await createWorkspace(env, body.repository, body.projectName || body.goal.slice(0, 32));
  const now = new Date().toISOString();
  let job: DeveloperJob = {
    id,
    projectId: body.projectId,
    projectName: body.projectName,
    repository: workspace.repository,
    goal: body.goal,
    prompt: body.prompt,
    model,
    workspace,
    status: 'starting',
    toolTurns: 0,
    maxToolTurns,
    createdAt: now,
    updatedAt: now,
    managedByGoalRunId,
  };
  await saveJob(env, job);

  const launched = await createResponse(env, job, { input: buildInitialInput(job) });
  if (!launched.ok || !launched.response?.id) {
    job = { ...job, status: 'failed', error: launched.error || 'OpenAI developer response failed to start', updatedAt: new Date().toISOString() };
    await saveJob(env, job);
    return job;
  }
  job = { ...job, status: 'running', currentResponseId: launched.response.id, updatedAt: new Date().toISOString() };
  await mapResponse(env, launched.response.id, job.id);
  await saveJob(env, job);
  return job;
}

export async function getDeveloperJob(env: AgentEnv, id: string): Promise<DeveloperJob | null> {
  return readJob(env, id);
}

export async function getLatestDeveloperJob(env: AgentEnv, projectId: string): Promise<DeveloperJob | null> {
  const id = await env.SUPERVISOR_STATE.get(`developer-project:${projectId}:latest`);
  return id ? readJob(env, id) : null;
}

export async function refreshDeveloperJob(env: AgentEnv, id: string): Promise<DeveloperJob | null> {
  const job = await readJob(env, id);
  if (!job || job.status !== 'running' || !job.currentResponseId) return job;
  await handleDeveloperResponse(env, job.currentResponseId);
  return readJob(env, id);
}

export async function handleDeveloperResponse(env: AgentEnv, responseId: string): Promise<boolean> {
  const jobId = await env.SUPERVISOR_STATE.get(`developer-response:${responseId}`);
  if (!jobId) return false;
  let job = await readJob(env, jobId);
  if (!job || job.status === 'completed' || job.status === 'failed') return true;

  const response = await retrieveResponse(env, responseId);
  if (!response.ok || !response.response) {
    job = await failJob(env, job, response.error || 'Could not retrieve developer response');
    await notifyFinal(env, job);
    return true;
  }
  const record = response.response;
  if (record.status === 'failed' || record.status === 'incomplete' || record.error) {
    job = await failJob(env, job, record.error?.message || record.incomplete_details?.reason || `Response ${record.status}`);
    await notifyFinal(env, job);
    return true;
  }
  if (record.status && record.status !== 'completed') return true;

  const calls = (record.output ?? []).filter((item): item is Extract<ResponseOutputItem, { type: 'function_call' }> => item.type === 'function_call');
  if (calls.length) {
    if (job.toolTurns >= job.maxToolTurns) {
      job = await failJob(env, job, `Tool-turn limit reached (${job.maxToolTurns})`);
      await notifyFinal(env, job);
      return true;
    }
    const outputs: FunctionCallOutput[] = [];
    for (const call of calls) {
      outputs.push({ type: 'function_call_output', call_id: call.call_id, output: await executeTool(env, job, call) });
    }
    job = { ...job, toolTurns: job.toolTurns + 1, updatedAt: new Date().toISOString() };
    await saveJob(env, job);
    const continued = await createResponse(env, job, { previousResponseId: responseId, input: outputs });
    if (!continued.ok || !continued.response?.id) {
      job = await failJob(env, job, continued.error || 'Failed to continue after tool output');
      await notifyFinal(env, job);
      return true;
    }
    job = { ...job, currentResponseId: continued.response.id, updatedAt: new Date().toISOString() };
    await mapResponse(env, continued.response.id, job.id);
    await saveJob(env, job);
    return true;
  }

  const outputText = extractText(record);
  const comparison = await compareWorkspace(env, job.workspace);
  let pullRequest = job.pullRequest;
  if (comparison.ahead_by > 0 && !pullRequest) {
    try {
      const pr = await createPullRequest(
        env,
        job.workspace,
        `${job.projectName || 'AI DEV DECK'}: ${shortTitle(job.goal)}`,
        buildPullRequestBody(job, outputText, comparison),
      );
      pullRequest = { number: pr.number, url: pr.url, draft: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'PR creation failed';
      job = { ...job, error: `Changes were made, but ${detail}` };
    }
  }

  job = {
    ...job,
    status: 'completed',
    outputText: outputText || 'Developer agent completed without a text summary.',
    changedFiles: comparison.files ?? [],
    pullRequest,
    updatedAt: new Date().toISOString(),
  };
  await saveJob(env, job);
  await notifyFinal(env, job);
  return true;
}

async function executeTool(env: AgentEnv, job: DeveloperJob, call: Extract<ResponseOutputItem, { type: 'function_call' }>) {
  try {
    const args = parseArguments(call.arguments);
    let result: unknown;
    if (call.name === 'github_list_tree') result = await listTree(env, job.repository, job.workspace.branch);
    else if (call.name === 'github_read_file') result = await readFile(env, job.repository, job.workspace.branch, requiredString(args, 'path'));
    else if (call.name === 'github_write_file') result = await writeFile(env, job.repository, job.workspace.branch, requiredString(args, 'path'), requiredString(args, 'content'), requiredString(args, 'message'));
    else if (call.name === 'github_delete_file') result = await deleteFile(env, job.repository, job.workspace.branch, requiredString(args, 'path'), requiredString(args, 'message'));
    else if (call.name === 'github_compare') result = await compareWorkspace(env, job.workspace);
    else if (call.name === 'github_ci_status') result = await getBranchWorkflowRuns(env, job.repository, job.workspace.branch);
    else throw new Error(`Unknown tool: ${call.name}`);
    return truncate(JSON.stringify({ ok: true, result }));
  } catch (error) {
    return truncate(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Tool execution failed' }));
  }
}

async function createResponse(
  env: AgentEnv,
  job: DeveloperJob,
  options: { input: string | FunctionCallOutput[]; previousResponseId?: string },
): Promise<{ ok: boolean; response?: ResponseRecord; error?: string }> {
  return openAI<ResponseRecord>(env, '/responses', {
    method: 'POST',
    body: {
      model: job.model,
      background: true,
      instructions: buildInstructions(job),
      input: options.input,
      previous_response_id: options.previousResponseId,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      metadata: {
        devdeck_developer_job: job.id.slice(0, 64),
        devdeck_repo: job.repository.slice(0, 64),
      },
    },
  });
}

async function retrieveResponse(env: AgentEnv, id: string) {
  return openAI<ResponseRecord>(env, `/responses/${encodeURIComponent(id)}`, { method: 'GET' });
}

function buildInitialInput(job: DeveloperJob) {
  return `Repository: ${job.repository}\nProtected branch: ${job.workspace.branch}\nDefault branch: ${job.workspace.defaultBranch}\n\nGOAL:\n${job.goal}\n\nTASK:\n${job.prompt}\n\nInspect the repository before editing. Implement as much of the requested task as you safely can using only the provided GitHub tools. Do not merely describe code changes if you can make them.`;
}

function buildInstructions(job: DeveloperJob) {
  return `You are AI DEV DECK's bounded GitHub developer agent.\n\nSecurity boundary:\n- You can only operate on ${job.repository}.\n- All writes are forced to ${job.workspace.branch}; never ask to write main/default directly.\n- Never add secrets, credentials, private keys, tokens, or .env values.\n- Never merge a PR, change repository permissions, release, deploy production, or trigger paid external services.\n- Inspect existing code before changing it. Preserve unrelated behavior.\n- Keep commits small and relevant.\n- Use github_compare after meaningful edits.\n- Do not tight-loop github_ci_status; CI may be asynchronous.\n- If a task requires unavailable credentials, irreversible product choices, billing, identity verification, or production actions, leave those as explicit human-required items instead of guessing.\n- When finished, provide a concise summary with changes, validation evidence you could actually observe, remaining risks, and human-required steps.\n\nYou have at most ${job.maxToolTurns} tool rounds.`;
}

function buildPullRequestBody(job: DeveloperJob, outputText: string, comparison: Awaited<ReturnType<typeof compareWorkspace>>) {
  const files = (comparison.files ?? []).slice(0, 50).map((file) => `- \`${file.filename}\` (${file.status}, +${file.additions}/-${file.deletions})`).join('\n') || '- No file list returned';
  return `## AI DEV DECK developer job\n\n**Goal:** ${job.goal}\n\n**Protected branch:** \`${job.workspace.branch}\`\n\n## Agent summary\n${outputText.slice(0, 8000) || 'No final summary returned.'}\n\n## Changed files\n${files}\n\n## Safety\n- Draft PR only\n- No automatic merge\n- No direct default-branch writes\n- Review CI and diff before merging\n`;
}

async function failJob(env: AgentEnv, job: DeveloperJob, error: string) {
  const failed = { ...job, status: 'failed' as const, error: error.slice(0, 2000), updatedAt: new Date().toISOString() };
  await saveJob(env, failed);
  return failed;
}

async function notifyFinal(env: AgentEnv, job: DeveloperJob) {
  if (job.managedByGoalRunId) return;
  const name = job.projectName || job.repository;
  if (job.status === 'completed') {
    await sendSupervisorPush(env, {
      title: `${name}: GitHub作業完了`,
      body: job.pullRequest ? `Draft PR #${job.pullRequest.number} を作成しました。レビューできます。` : 'GitHub developer jobが完了しました。',
      tag: `developer-${job.id}`,
      projectId: job.projectId,
      kind: 'complete',
      url: job.pullRequest?.url || './',
    });
  } else {
    await sendSupervisorPush(env, {
      title: `${name}: GitHub作業停止`,
      body: job.error || 'Developer agent stopped.',
      tag: `developer-${job.id}`,
      projectId: job.projectId,
      kind: 'error',
      url: './',
    });
  }
}

async function saveJob(env: AgentEnv, job: DeveloperJob) {
  await env.SUPERVISOR_STATE.put(`developer-job:${job.id}`, JSON.stringify(job), { expirationTtl: JOB_TTL });
  if (job.projectId) await env.SUPERVISOR_STATE.put(`developer-project:${job.projectId}:latest`, job.id, { expirationTtl: JOB_TTL });
}

async function readJob(env: AgentEnv, id: string): Promise<DeveloperJob | null> {
  const raw = await env.SUPERVISOR_STATE.get(`developer-job:${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as DeveloperJob; } catch { return null; }
}

async function mapResponse(env: AgentEnv, responseId: string, jobId: string) {
  await env.SUPERVISOR_STATE.put(`developer-response:${responseId}`, jobId, { expirationTtl: JOB_TTL });
}

async function openAI<T>(env: AgentEnv, path: string, options: { method: 'GET' | 'POST'; body?: unknown }) {
  try {
    const response = await fetch(`https://api.openai.com/v1${path}`, {
      method: options.method,
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    if (!response.ok) {
      const message = parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? JSON.stringify((parsed as { error?: unknown }).error).slice(0, 2000)
        : text.slice(0, 2000) || `OpenAI request failed (${response.status})`;
      return { ok: false, status: response.status, error: message } as const;
    }
    return { ok: true, status: response.status, response: parsed as T } as const;
  } catch (error) {
    return { ok: false, status: 502, error: error instanceof Error ? error.message : 'OpenAI network error' } as const;
  }
}

function extractText(response: ResponseRecord) {
  const chunks: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const typed = part as { type?: unknown; text?: unknown };
      if (typed.type === 'output_text' && typeof typed.text === 'string') chunks.push(typed.text);
    }
  }
  return chunks.join('\n').trim();
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* handled below */ }
  throw new Error('Invalid function arguments JSON');
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

function truncate(value: string) {
  return value.length <= TOOL_OUTPUT_LIMIT ? value : `${value.slice(0, TOOL_OUTPUT_LIMIT)}\n...TRUNCATED`;
}

function clamp(value: number, min: number, max: number) {
  const integer = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.max(min, Math.min(max, integer));
}

function shortTitle(goal: string) {
  return goal.replace(/[\r\n]+/g, ' ').trim().slice(0, 90) || 'implementation update';
}
