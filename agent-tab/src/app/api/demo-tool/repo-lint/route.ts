import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Slice 12a.1 demo tool. Safety contract:
//   - execFile (no shell). Fixed args. No string concatenation.
//   - Caller input is ignored entirely (req.body is never read).
//   - cwd is captured at module load — never derived from a request.
//   - Subprocess env is allow-listed (PATH, NODE_ENV, HOME).
//   - Output is bounded (timeout, maxBuffer) and the response snippet is
//     truncated. Full file paths beyond cwd-relative are not surfaced.
//   - Double-guarded: 403 if NODE_ENV=production OR DEMO_MODE!=="true".

const CWD = process.cwd();
const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 1024 * 1024;
const SNIPPET_BYTES = 1024;

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function parseEslintCounts(stdout: string): { errorCount: number; warningCount: number } {
  // ESLint summary line: "✖ 7 problems (3 errors, 4 warnings)"
  const match = stdout.match(/(\d+)\s+errors?,\s+(\d+)\s+warnings?/);
  if (!match) return { errorCount: 0, warningCount: 0 };
  return { errorCount: Number(match[1]), warningCount: Number(match[2]) };
}

async function runLint(): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("npm", ["run", "lint"], {
      cwd: CWD,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: process.env.NODE_ENV ?? "",
        HOME: process.env.HOME ?? "",
      },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (e) {
    // execFile rejects on non-zero exit; we still want the captured streams.
    const err = e as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}

export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "demo tools disabled in production" },
      { status: 403 },
    );
  }
  if (process.env.DEMO_MODE !== "true") {
    return NextResponse.json(
      { error: "demo tools require DEMO_MODE=true" },
      { status: 403 },
    );
  }

  const startedAt = Date.now();
  const { stdout, stderr, exitCode } = await runLint();
  const durationMs = Date.now() - startedAt;

  const combined = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
  const { errorCount, warningCount } = parseEslintCounts(combined);
  const snippet = combined.slice(-SNIPPET_BYTES);

  return NextResponse.json({
    exitCode,
    errorCount,
    warningCount,
    durationMs,
    snippet,
    timestamp: new Date().toISOString(),
  });
}
