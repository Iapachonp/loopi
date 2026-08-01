/**
 * loopi - Multi-agent coder/reviewer loop extension for Pi.
 *
 * This file is intentionally heavily commented. The goal is not just to ship a
 * working tool, but to make every abstraction readable so you (and future agents)
 * can collaborate on it, review it, and extend it safely.
 *
 * ---------------------------------------------------------------------------
 * Table of contents of this file
 * ---------------------------------------------------------------------------
 * 1.  Imports and why each one is used
 * 2.  Constants
 * 3.  Types - the data shapes we move around
 * 4.  Agent discovery - how loopi finds its agent definitions
 * 5.  Subprocess plumbing - how we run a single agent in a fresh pi process
 * 6.  Round orchestration - coder round, reviewer round, verdict parsing
 * 7.  Tool registration - the public `loopi` tool the model can call
 * 8.  Export - the default extension factory
 *
 * ---------------------------------------------------------------------------
 * Big picture architecture
 * ---------------------------------------------------------------------------
 *
 *  Pi main session
 *       |
 *       v
 *  LLM calls `loopi` tool
 *       |
 *       v
 *  loopi.ts::execute()
 *       |
 *       |---- spawns N coder agents in parallel
 *       |        (each is `pi --mode json -p` with isolated context)
 *       |
 *       |---- collects coder outputs
 *       |
 *       |---- spawns M reviewer agents in parallel
 *       |        (each reviews the combined coder output / git diff)
 *       |
 *       |---- parses verdicts
 *       |
 *       |---- if any reviewer says CHANGES_REQUESTED:
 *       |         build feedback summary, loop back to coders
 *       |     else:
 *       |         return success to main session
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Pi AI types. A "Message" is the common currency of Pi conversations: it can
// be a user message, an assistant message, or a tool result. We read the
// assistant messages produced by the child `pi` processes to extract the final
// text output of each agent.
import type { Message } from "@earendil-works/pi-ai";

// `StringEnum` is a helper from pi-ai that builds a JSON schema string enum in
// a way that works across all providers (Google's API in particular does not
// accept Type.Union([Type.Literal(...)])). Always use this for string enums.
import { StringEnum } from "@earendil-works/pi-ai";

// Pi coding-agent exports. The ones we need:
//   ExtensionAPI      - the object passed to every extension factory; lets us
//                       register tools, commands, event handlers, etc.
//   CONFIG_DIR_NAME   - the name of Pi's config directory. Usually ".pi" but
//                       could be rebranded; use this constant instead of hardcoding.
//   getAgentDir       - returns the global Pi agent directory (usually ~/.pi/agent).
//   withFileMutationQueue - serializes file mutations so parallel tools do not
//                           clobber the same file.
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

// `Type` from typebox is how we declare JSON schemas for tool parameters.
// Pi sends these schemas to the model so it knows what arguments the tool
// accepts. The model will only be able to call the tool with valid args.
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// 2. Constants
// ---------------------------------------------------------------------------

// Default number of coder/reviewer rounds. The loop stops earlier if all
// reviewers approve.
const DEFAULT_MAX_ROUNDS = 2;

// Default agents used when the user does not override them. These names map to
// markdown agent definition files discovered from Pi's agent directories.
const DEFAULT_CODER_AGENT = "loopi-coder";
const DEFAULT_REVIEWER_AGENT = "loopi-reviewer";

// ---------------------------------------------------------------------------
// 3. Types - the data shapes we move around
// ---------------------------------------------------------------------------

/**
 * AgentConfig is the in-memory representation of one agent definition.
 * Agent definitions live as markdown files with YAML frontmatter, e.g.:
 *
 *   ---
 *   name: loopi-coder
 *   description: Coding agent...
 *   tools: read, bash, edit, write
 *   model: claude-sonnet-4-5
 *   ---
 *
 * The body of the markdown file is the system prompt we pass to the child pi
 * process via `--append-system-prompt`.
 */
interface AgentConfig {
  // Unique name used by the loopi tool to select an agent.
  name: string;

  // Human-readable description (used for diagnostics / logging).
  description: string;

  // Optional list of tool names the child pi process should expose. This maps
  // to pi's `--tools` CLI flag. If omitted, the child gets Pi's default tools.
  tools?: string[];

  // Optional model override, e.g. "claude-sonnet-4-5". Maps to pi's `--model`
  // CLI flag. If omitted, the child uses whatever model is currently active.
  model?: string;

  // Absolute path to the markdown file that defines this agent. We read the
  // body from this file and pass it as the child system prompt.
  filePath: string;
}

/**
 * AgentResult captures everything we care about after running one agent.
 */
interface AgentResult {
  // The final assistant text produced by the agent.
  output: string;

  // The raw message stream from the child pi process. Useful for debugging or
  // for extracting usage/cost in the future.
  messages: Message[];

  // Unix exit code of the child pi process. 0 means normal exit.
  exitCode: number;

  // Anything the child wrote to stderr. Non-empty usually means trouble.
  error?: string;
}

/**
 * RoundResult captures the outcome of one full round: all coder agents plus
 * all reviewer agents plus the parsed verdict.
 */
interface RoundResult {
  round: number;
  coderResults: AgentResult[];
  reviewerResults: AgentResult[];
  verdict: "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN";
  feedback: string;
}

// ---------------------------------------------------------------------------
// 4. Agent discovery - how loopi finds its agent definitions
// ---------------------------------------------------------------------------

/**
 * Discover available agents from two places:
 *
 *  1. The global Pi agent directory: `~/.pi/agent/agents/*.md`
 *  2. The project-local agent directory: `<cwd>/.pi/agents/*.md`
 *
 * Why both? Global agents are personal/team defaults. Project-local agents let a
 * repository ship custom agent prompts that are specific to the repo's stack or
 * conventions. Project-local agents override global agents with the same name.
 *
 * This mirrors how Pi's official `subagent` extension discovers agents.
 */
function discoverAgents(cwd: string): AgentConfig[] {
  const configs: AgentConfig[] = [];
  const seen = new Set<string>();

  // Order matters: project-local last so it wins on name collisions.
  const searchDirs = [
    path.join(getAgentDir(), "agents"),
    path.join(cwd, CONFIG_DIR_NAME, "agents"),
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.endsWith(".md")) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;

      const filePath = path.join(dir, entry.name);
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      // Parse YAML frontmatter and the markdown body.
      const parsed = parseAgentFrontmatter(content);
      if (!parsed.name || !parsed.description) continue;

      // Project-local wins on collisions.
      if (seen.has(parsed.name)) {
        const existingIndex = configs.findIndex((c) => c.name === parsed.name);
        if (existingIndex >= 0) configs.splice(existingIndex, 1);
      }

      seen.add(parsed.name);
      configs.push({
        name: parsed.name,
        description: parsed.description,
        model: parsed.model,
        tools: parsed.tools?.split(",").map((t) => t.trim()).filter(Boolean),
        filePath,
      });
    }
  }

  return configs;
}

/**
 * Minimal YAML frontmatter parser.
 *
 * We intentionally do not pull in a YAML dependency for this first iteration;
 * agent frontmatter is simple key:value lines. If we later need nested YAML,
 * we can swap this for a real parser without changing the agent file format.
 */
function parseAgentFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return {};

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    frontmatter[key] = value;
  }

  return frontmatter;
}

/**
 * Extract the system prompt body from an agent markdown file.
 * We strip the frontmatter and return the rest; that body becomes the child
 * process system prompt.
 */
function getAgentSystemPromptBody(filePath: string): string {
  const content = fs.readFileSync(filePath, "utf-8");
  return content.replace(/^---\n[\s\S]*?\n---\n/, "");
}

// ---------------------------------------------------------------------------
// 5. Subprocess plumbing - how we run a single agent in a fresh pi process
// ---------------------------------------------------------------------------

/**
 * Write a temporary file containing the agent's system prompt body.
 *
 * Why a temp file instead of passing the prompt inline? Pi's
 * `--append-system-prompt` flag accepts a file path. This keeps child process
 * argv small and avoids escaping issues with large prompts.
 *
 * `withFileMutationQueue` is used here as a good practice, even though the temp
 * file path is unique per call. It ensures that if we ever decide to reuse a
 * prompt file, concurrent writes are serialized safely.
 */
async function writeTempSystemPrompt(agent: AgentConfig): Promise<string> {
  const body = getAgentSystemPromptBody(agent.filePath);
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "loopi-prompt-"),
  );
  const tmpFile = path.join(tmpDir, `${agent.name}.md`);

  await withFileMutationQueue(tmpFile, async () => {
    await fs.promises.writeFile(tmpFile, body, {
      encoding: "utf-8",
      mode: 0o600, // readable only by owner
    });
  });

  return tmpFile;
}

/**
 * Determine how to invoke the child `pi` process.
 *
 * When Pi is running under Bun, `process.execPath` is `bun` and the current
 * script is loaded from a virtual filesystem. In that case we fall back to the
 * `pi` command in PATH. Otherwise we prefer `pi` directly so we do not depend on
 * the exact runtime Pi was launched with.
 */
function getPiInvocation(): { command: string; argsPrefix: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");

  if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
    // We are running from a real file on disk; use the same runtime + script.
    return { command: process.execPath, argsPrefix: [currentScript] };
  }

  return { command: "pi", argsPrefix: [] };
}

/**
 * Run a single agent in a separate Pi subprocess and return its result.
 *
 * Child invocation looks like:
 *   pi --mode json -p --no-session \
 *      --model claude-sonnet-4-5 \
 *      --tools read,bash,edit,write \
 *      --append-system-prompt /tmp/loopi-prompt-xxx/loopi-coder.md \
 *      "Task: add input validation to src/api.ts"
 *
 * `--mode json -p --no-session` makes pi print a JSONL stream of events to
 * stdout, with no session persistence. We parse the stream to reconstruct the
 * assistant's final message.
 */
async function runAgent(
  cwd: string,
  agent: AgentConfig,
  task: string,
  signal?: AbortSignal,
): Promise<AgentResult> {
  const tmpPromptPath = await writeTempSystemPrompt(agent);
  const tmpDir = path.dirname(tmpPromptPath);

  try {
    const args: string[] = ["--mode", "json", "-p", "--no-session"];
    if (agent.model) args.push("--model", agent.model);
    if (agent.tools && agent.tools.length > 0) {
      args.push("--tools", agent.tools.join(","));
    }
    args.push("--append-system-prompt", tmpPromptPath);
    args.push(task);

    const { command, argsPrefix } = getPiInvocation();
    const fullArgs = [...argsPrefix, ...args];

    return await new Promise<AgentResult>((resolve) => {
      const proc = spawn(command, fullArgs, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdoutBuffer = "";
      let stderrText = "";
      const messages: Message[] = [];

      /**
       * The child pi process emits one JSON object per line.
       * We care about `message_end` events because they contain complete
       * assistant/tool-result messages.
       */
      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line) as unknown;
          if (
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "message_end" &&
            "message" in event &&
            event.message
          ) {
            messages.push(event.message as Message);
          }
        } catch {
          // Ignore malformed lines. In production we may want to log these.
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString("utf-8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderrText += data.toString("utf-8");
      });

      proc.on("close", (code) => {
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);

        const output = extractLastAssistantText(messages);
        resolve({
          output,
          messages,
          exitCode: code ?? 0,
          error: stderrText || undefined,
        });
      });

      proc.on("error", () => {
        resolve({
          output: "",
          messages,
          exitCode: 1,
          error: stderrText || `Failed to spawn ${command}`,
        });
      });

      // Wire the parent AbortSignal to the child process so that when the user
      // hits Escape/Ctrl+C in the main Pi session, the child agents die too.
      if (signal) {
        const killProc = () => {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });
  } finally {
    // Clean up the temp prompt file and its directory.
    try {
      fs.unlinkSync(tmpPromptPath);
      fs.rmdirSync(tmpDir);
    } catch {
      // Ignore cleanup errors; temp files are harmless.
    }
  }
}

/**
 * Walk backwards through the child process messages and return the last
 * assistant text block. This is the agent's final answer.
 */
function extractLastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// 6. Round orchestration - coder round, reviewer round, verdict parsing
// ---------------------------------------------------------------------------

/**
 * Build the task prompt for a coder agent.
 *
 * On round 1 the prompt is just the user's original task.
 * On later rounds we prepend the accumulated reviewer feedback so the coder
 * knows what to fix.
 */
function buildCoderTask(originalTask: string, feedback: string): string {
  if (!feedback.trim()) return originalTask;
  return [
    "Original task:",
    originalTask,
    "",
    "Reviewer feedback from the previous round - address every item:",
    feedback,
  ].join("\n");
}

/**
 * Build the task prompt for a reviewer agent.
 *
 * The reviewer sees the original task and the coder output so it can judge
 * whether the changes are correct and complete.
 */
function buildReviewerTask(
  originalTask: string,
  coderOutputs: string[],
): string {
  return [
    "Review whether the coder's changes satisfy the original task.",
    "",
    "Original task:",
    originalTask,
    "",
    "Coder output(s):",
    coderOutputs.join("\n\n---\n\n"),
  ].join("\n");
}

/**
 * Parse a reviewer's text output to decide if the work is approved.
 *
 * We look for the exact keywords `APPROVED` or `CHANGES_REQUESTED`. This is a
 * deliberate, simple contract: agent prompts instruct reviewers to end with
 * one of these keywords. More sophisticated parsing (e.g., JSON schemas) can
 * be layered on later.
 */
function parseVerdict(reviewerOutputs: string[]): {
  verdict: "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN";
  feedback: string;
} {
  // If any reviewer requests changes, the whole round is changes-requested.
  const anyRequested = reviewerOutputs.some((out) =>
    out.includes("CHANGES_REQUESTED"),
  );
  const allApproved = reviewerOutputs.every((out) => out.includes("APPROVED"));

  if (anyRequested) {
    const feedback = reviewerOutputs
      .map((out, i) => `### Reviewer ${i + 1}\n${out}`)
      .join("\n\n");
    return { verdict: "CHANGES_REQUESTED", feedback };
  }

  if (allApproved) {
    return { verdict: "APPROVED", feedback: reviewerOutputs.join("\n\n") };
  }

  // No clear signal; treat as changes requested to be safe.
  return {
    verdict: "CHANGES_REQUESTED",
    feedback:
      "No clear approval was found. Reviewer output:\n\n" +
      reviewerOutputs.join("\n\n"),
  };
}

/**
 * Run one coder agent.
 *
 * This function exists so that in the future we can easily run multiple coders
 * in parallel by mapping over an array of AgentConfig objects.
 */
async function runCoderRound(
  cwd: string,
  coder: AgentConfig,
  task: string,
  signal?: AbortSignal,
): Promise<AgentResult> {
  return runAgent(cwd, coder, task, signal);
}

/**
 * Run one reviewer agent.
 *
 * Same idea as runCoderRound: the boundary is intentionally thin so we can
 * parallelize or specialize reviewers later.
 */
async function runReviewerRound(
  cwd: string,
  reviewer: AgentConfig,
  task: string,
  signal?: AbortSignal,
): Promise<AgentResult> {
  return runAgent(cwd, reviewer, task, signal);
}

// ---------------------------------------------------------------------------
// 7. Tool registration - the public `loopi` tool the model can call
// ---------------------------------------------------------------------------

/**
 * JSON schema for the `loopi` tool parameters.
 *
 * The model uses this schema to construct the arguments when it calls `loopi`.
 *
 * Fields:
 *   task         - what the coders should do (required).
 *   maxRounds    - safety limit on iterations (default 2).
 *   coderAgent   - name of the coder agent to use (default loopi-coder).
 *   reviewerAgent- name of the reviewer agent to use (default loopi-reviewer).
 *
 * Future additions (not in v0.1):
 *   - coderAgents: string[]   // multiple coders, possibly in parallel
 *   - reviewerAgents: string[] // multiple reviewers, voting
 *   - strategy: "sequential" | "parallel"
 *   - stopOnFirstApproval: boolean
 */
const LoopiParams = Type.Object({
  task: Type.String({
    description: "The coding task to delegate to the loopi agents",
  }),

  maxRounds: Type.Optional(
    Type.Integer({
      description: `Maximum number of coder/reviewer rounds (default: ${DEFAULT_MAX_ROUNDS})`,
      default: DEFAULT_MAX_ROUNDS,
      minimum: 1,
      maximum: 5,
    }),
  ),

  coderAgent: Type.Optional(
    Type.String({
      description: "Name of the coder agent definition to use",
      default: DEFAULT_CODER_AGENT,
    }),
  ),

  reviewerAgent: Type.Optional(
    Type.String({
      description: "Name of the reviewer agent definition to use",
      default: DEFAULT_REVIEWER_AGENT,
    }),
  ),
});

/**
 * The default extension factory.
 *
 * Pi calls this function once when it loads the extension. We receive an
 * `ExtensionAPI` instance and use it to register our custom tool.
 */
export default function (pi: ExtensionAPI) {
  /**
   * Register the `loopi` tool.
   *
   * The `description` and `promptSnippet` are what the model sees in its system
   * prompt, so they directly influence *when* the model decides to call the
   * tool. Keep them concrete and truthful.
   */
  pi.registerTool({
    name: "loopi",
    label: "Loopi",

    description:
      "Run a multi-agent coder/reviewer loop. Delegate a coding task to a " +
      "coder agent, then ask a reviewer agent to verify the changes. Loop " +
      "until the reviewer approves or the maximum number of rounds is reached.",

    promptSnippet:
      "Run a coder/reviewer agent loop for tasks that may need iteration",

    promptGuidelines: [
      "Use loopi when a coding task benefits from a separate reviewer pass before finalizing.",
      "Provide a clear task description; the loop stops when the reviewer approves or maxRounds is reached.",
    ],

    parameters: LoopiParams,

    /**
     * This is the function Pi invokes when the model calls `loopi`.
     *
     * Arguments:
     *   _toolCallId - unique id for this tool call; rarely needed inside execute.
     *   params     - the validated arguments matching LoopiParams.
     *   signal     - AbortSignal tied to the user's cancel action in Pi.
     *   onUpdate   - callback to stream progress back to the Pi TUI/RPC.
     *   ctx        - ExtensionContext with cwd, ui, sessionManager, etc.
     */
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Current working directory of the main Pi session. All child agents run
      // in the same cwd so they operate on the same files.
      const cwd = ctx.cwd;

      // Discover which agents are available on this machine/in this project.
      const agents = discoverAgents(cwd);

      // Resolve the requested coder and reviewer agents.
      const coderName = params.coderAgent ?? DEFAULT_CODER_AGENT;
      const reviewerName = params.reviewerAgent ?? DEFAULT_REVIEWER_AGENT;

      const coder = agents.find((a) => a.name === coderName);
      const reviewer = agents.find((a) => a.name === reviewerName);

      // Fail fast with a helpful message if an agent definition is missing.
      if (!coder) {
        return {
          content: [{
            type: "text",
            text: `Coder agent "${coderName}" not found. Available agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
          }],
          isError: true,
        };
      }
      if (!reviewer) {
        return {
          content: [{
            type: "text",
            text: `Reviewer agent "${reviewerName}" not found. Available agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
          }],
          isError: true,
        };
      }

      const maxRounds = params.maxRounds ?? DEFAULT_MAX_ROUNDS;
      let accumulatedFeedback = "";
      const history: RoundResult[] = [];

      for (let round = 1; round <= maxRounds; round++) {
        // Stream progress to the user. `onUpdate` is optional; it is present
        // in TUI and RPC modes but not in print/JSON modes.
        onUpdate?.({
          content: [{
            type: "text",
            text: `Round ${round}/${maxRounds}: running coder...`,
          }],
        });

        // 1. Coder round.
        const coderTask = buildCoderTask(params.task, accumulatedFeedback);
        const coderResult = await runCoderRound(cwd, coder, coderTask, signal);

        if (coderResult.exitCode !== 0) {
          return {
            content: [{
              type: "text",
              text: `Coder failed in round ${round}:\n${coderResult.error || coderResult.output}`,
            }],
            details: { history },
            isError: true,
          };
        }

        onUpdate?.({
          content: [{
            type: "text",
            text: `Round ${round}/${maxRounds}: coder done, running reviewer...`,
          }],
        });

        // 2. Reviewer round.
        const reviewerTask = buildReviewerTask(
          params.task,
          [coderResult.output],
        );
        const reviewerResult = await runReviewerRound(
          cwd,
          reviewer,
          reviewerTask,
          signal,
        );

        if (reviewerResult.exitCode !== 0) {
          return {
            content: [{
              type: "text",
              text: `Reviewer failed in round ${round}:\n${reviewerResult.error || reviewerResult.output}`,
            }],
            details: { history },
            isError: true,
          };
        }

        // 3. Parse the verdict.
        const { verdict, feedback } = parseVerdict([reviewerResult.output]);

        history.push({
          round,
          coderResults: [coderResult],
          reviewerResults: [reviewerResult],
          verdict,
          feedback,
        });

        // 4. If approved, we are done.
        if (verdict === "APPROVED") {
          return {
            content: [{
              type: "text",
              text: [
                `✓ Approved after ${round} round(s).`,
                "",
                "## Final reviewer assessment",
                reviewerResult.output,
                "",
                "## Coder summary",
                coderResult.output,
              ].join("\n"),
            }],
            details: { history },
          };
        }

        // 5. Not approved: prepare feedback for the next coder round.
        accumulatedFeedback = feedback;

        onUpdate?.({
          content: [{
            type: "text",
            text: `Round ${round}/${maxRounds}: reviewer requested changes. ${round < maxRounds ? "Looping..." : "Max rounds reached."}`,
          }],
        });
      }

      // 6. We exhausted maxRounds without approval.
      const lastRound = history[history.length - 1];
      return {
        content: [{
          type: "text",
          text: [
            `✗ Reached max rounds (${maxRounds}) without approval.`,
            "",
            "## Last reviewer feedback",
            lastRound?.feedback ?? "(none)",
            "",
            "To continue, ask loopi again with a higher maxRounds or a more specific task.",
          ].join("\n"),
        }],
        details: { history },
      };
    },
  });
}
