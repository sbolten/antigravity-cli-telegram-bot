import { spawn } from "node:child_process";
import type { AgyConfig, RunnerOptions, AgyResult, StreamEvent, Usage } from "./types.js";
import path from "node:path";

export interface PythonRunnerOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  conversationId?: string;
}

const PYTHON_INFO_SCRIPT = `
import sys
import json
import os

try:
    from google.antigravity import Client
except ImportError:
    print(json.dumps({"error": "google.antigravity is not installed or not available."}))
    sys.exit(1)

cmd = sys.argv[1]
conversation_id = sys.argv[2] if len(sys.argv) > 2 else None

try:
    client = Client()
    if cmd == "/usage":
        # Usage metadata is per response, but we might want overall quota or we can just say not available
        print("Usage statistics via Python API must be retrieved per-prompt.")

    elif cmd == "/credits":
        account_info = client.account.get_quota()
        credits = getattr(account_info, 'remaining_credits', 'Unknown')
        print(f"💳 <b>AGY Credits</b>\\n• Credits Remaining: <b>{credits}</b>")

    elif cmd == "/context":
        if not conversation_id:
            print("No active conversation.")
        else:
            session = client.sessions.get(conversation_id)
            history_len = len(session.history) if hasattr(session, 'history') else 'Unknown'
            utilization = getattr(session, 'context_utilization', 'Unknown')

            print(f"🧠 <b>Active Context</b>\\n• Conversation ID: {conversation_id}\\n• History length: {history_len}\\n• Context utilization: {utilization}")

    else:
        print(f"Unknown command: {cmd}")
except Exception as e:
    print(f"Error: {str(e)}")
`;

export function runPythonInfoCommand(
  config: AgyConfig,
  command: "/usage" | "/credits" | "/context",
  options: PythonRunnerOptions = {}
): Promise<string> {
  const { timeoutMs = 25_000, signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error("Python API command cancelled"));
    }

    const child = spawn("python3", ["-c", PYTHON_INFO_SCRIPT, command, options.conversationId || ""], {
      cwd: config.workspace,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const killProcessGroup = (): void => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch {
        try { child.kill("SIGKILL"); } catch { /* dead */ }
      }
    };

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };

    const abort = (): void => {
      killProcessGroup();
      finish(() => reject(new Error("Python API command cancelled")));
    };

    const timer = setTimeout(() => {
      killProcessGroup();
      finish(() => reject(new Error(`Python API command ${command} timed out after ${timeoutMs}ms`)));
    }, timeoutMs + 2000);

    signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      killProcessGroup();
      finish(() => reject(error));
    });

    child.on("close", (code, sig) =>
      finish(() => {
        if (code !== 0 && !stdout.trim()) {
          const detail = stderr.trim().slice(0, 500);
          reject(new Error(`Python API ${command} exited with ${code ?? sig}${detail ? ": " + detail : ""}`));
          return;
        }
        resolve(stdout.trim() || stderr.trim() || "AGY returned no output.");
      })
    );
  });
}

const PYTHON_RUN_SCRIPT = `
import sys
import json
import time
import asyncio

try:
    from google.antigravity import Agent, LocalAgentConfig
    from google.antigravity.types import ContentPart
    from google.antigravity.sessions import Conversation
except ImportError:
    print(json.dumps({"error": "google.antigravity not installed"}))
    sys.exit(1)

prompt = sys.argv[1]
model = sys.argv[2]
conversation_id = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
image_path = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
document_path = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else None

async def run_prompt():
    try:
        config = LocalAgentConfig()
        start_time = time.time()

        # Init event
        print(json.dumps({
            "event": "init",
            "model": model or "antigravity-default"
        }))
        sys.stdout.flush()

        files = []
        if image_path:
            files.append(ContentPart.from_file(image_path))
        if document_path:
            files.append(ContentPart.from_file(document_path))

        async with Agent(config) as agent:
            if conversation_id:
                conversation = Conversation(agent=agent, session_id=conversation_id)
            else:
                conversation = Conversation(agent=agent)

            kwargs = {"prompt": prompt}
            if files:
                kwargs["files"] = files

            response = await conversation.chat(**kwargs)

            # Start streaming text
            async for token in response:
                print(json.dumps({
                    "event": "step_update",
                    "step_update": {
                        "text_delta": token
                    }
                }))
                sys.stdout.flush()

            # Streaming thoughts if available
            if hasattr(response, "thoughts"):
                async for thought in response.thoughts:
                    print(json.dumps({
                        "event": "step_update",
                        "step_update": {
                            "step_type": "thinking",
                            "thought": thought
                        }
                    }))
                    sys.stdout.flush()

            # End of response
            end_time = time.time()
            duration = end_time - start_time

            usage = getattr(response, "usage_metadata", None)

            result_payload = {
                "model": model or "antigravity-default",
                "duration_seconds": duration,
                "status": "SUCCESS",
                "conversation_id": getattr(conversation, "session_id", conversation_id),
                "num_turns": getattr(conversation, "history", []),
                "usage": {
                    "prompt_tokens": getattr(usage, "prompt_token_count", 0) if usage else 0,
                    "output_tokens": getattr(usage, "candidates_token_count", 0) if usage else 0,
                    "total_tokens": getattr(usage, "total_token_count", 0) if usage else 0
                }
            }
            if isinstance(result_payload["num_turns"], list):
                result_payload["num_turns"] = len(result_payload["num_turns"])

            print(json.dumps({
                "event": "result",
                "conversation_id": result_payload["conversation_id"],
                "result": result_payload
            }))
            sys.stdout.flush()

    except Exception as e:
        print(json.dumps({
            "event": "result",
            "result": {
                "status": "ERROR",
                "error": str(e)
            }
        }))
        sys.stdout.flush()

if __name__ == "__main__":
    asyncio.run(run_prompt())
`;

import { parseStreamOutput } from "./agy-runner.js";

export function runAgyPython(
  config: AgyConfig,
  prompt: string,
  conversationId: string | null,
  options: RunnerOptions = {}
): Promise<AgyResult> {
  return new Promise((resolve, reject) => {
    const { signal, onEvent, ...overrides } = options;
    const effectiveModel = overrides.model || config.model || "";

    const args = ["-c", PYTHON_RUN_SCRIPT, prompt, effectiveModel, conversationId || "", overrides.imagePath || "", overrides.documentPath || ""];

    const child = spawn("python3", args, {
      cwd: config.workspace,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    let settled = false;

    const killProcessGroup = (): void => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch {
        try { child.kill("SIGKILL"); } catch { /* dead */ }
      }
    };

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };

    const abort = (): void => {
      killProcessGroup();
      finish(() => reject(new Error("Python API command cancelled")));
    };

    const timer = setTimeout(() => {
      killProcessGroup();
      finish(() => reject(new Error(`Python API prompt timed out after ${config.timeoutMs}ms`)));
    }, config.timeoutMs + 2000);

    signal?.addEventListener("abort", abort, { once: true });

    const emit = (line: string): void => {
      if (!line.trim()) return;
      try {
        if (onEvent) {
          onEvent(JSON.parse(line) as StreamEvent);
        }
      } catch (error) {
        // ignore parse error on partials
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      pendingLine += text;
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() || "";
      lines.forEach(emit);
    });

    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("error", (error) => {
      killProcessGroup();
      finish(() => reject(error));
    });

    child.on("close", (code, sig) =>
      finish(() => {
        emit(pendingLine);

        if (code !== 0 && !stdout.trim()) {
          const detail = stderr.trim().slice(0, 500);
          reject(new Error(`Python API exited with ${code ?? sig}${detail ? ": " + detail : ""}`));
          return;
        }

        try {
          const result = parseStreamOutput(stdout);
          resolve(result);
        } catch (e) {
          reject(new Error("Failed to parse Python API output: error: " + (e as Error).message));
        }
      })
    );
  });
}
