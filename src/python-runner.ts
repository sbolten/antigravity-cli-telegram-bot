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

try:
    from google.antigravity import Client
except ImportError:
    print(json.dumps({"error": "google.antigravity not installed"}))
    sys.exit(1)

prompt = sys.argv[1]
model = sys.argv[2]
conversation_id = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None

try:
    client = Client()
    start_time = time.time()

    # We could stream, but for simplicity here we just run and return final json block
    # In a full implementation we'd emit stream-json events

    response = client.agents.run(
        prompt=prompt,
        model=model or "antigravity-default"
    )

    duration = time.time() - start_time

    usage = response.usage_metadata

    output = {
        "text": getattr(response, "output_text", ""),
        "model": model,
        "conversationId": getattr(response, "session_id", conversation_id),
        "usage": {
            "prompt_tokens": getattr(usage, "prompt_token_count", 0),
            "output_tokens": getattr(usage, "candidates_token_count", 0),
            "total_tokens": getattr(usage, "total_token_count", 0)
        },
        "duration_seconds": duration,
        "status": "SUCCESS"
    }
    print(json.dumps(output))

except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

export function runAgyPython(
  config: AgyConfig,
  prompt: string,
  conversationId: string | null,
  options: RunnerOptions = {}
): Promise<AgyResult> {
  return new Promise((resolve, reject) => {
    const { signal, onEvent, ...overrides } = options;
    const effectiveModel = overrides.model || config.model || "";

    // Simulate streaming by just running synchronously here, but we will emit a single event and then resolve.
    // In actual production we would write a python script that streams NDJSON.

    const child = spawn("python3", ["-c", PYTHON_RUN_SCRIPT, prompt, effectiveModel, conversationId || ""], {
      cwd: config.workspace,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
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
      finish(() => reject(new Error(`Python API prompt timed out after ${config.timeoutMs}ms`)));
    }, config.timeoutMs + 2000);

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
          reject(new Error(`Python API exited with ${code ?? sig}${detail ? ": " + detail : ""}`));
          return;
        }

        try {
          const parsed = JSON.parse(stdout.trim());
          if (parsed.error) {
             reject(new Error(parsed.error));
             return;
          }

          const result: AgyResult = {
             text: parsed.text || "",
             parsed: parsed,
             events: [],
             conversationId: parsed.conversationId || conversationId,
             model: parsed.model || effectiveModel,
             usage: {
               input_tokens: parsed.usage?.prompt_tokens,
               output_tokens: parsed.usage?.output_tokens,
               total_tokens: parsed.usage?.total_tokens
             },
             durationMs: (parsed.duration_seconds || 0) * 1000,
             numTurns: null,
             toolCalls: 0,
             status: parsed.status
          };

          if (onEvent) {
             onEvent({
                event: "result",
                result: parsed
             });
          }

          resolve(result);
        } catch (e) {
          reject(new Error("Failed to parse Python API output: " + stdout.trim() + " error: " + (e as Error).message));
        }
      })
    );
  });
}
