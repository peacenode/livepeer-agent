import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

export interface CliIO {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stdout(value: string): void;
  stderr(value: string): void;
  readStdin(): Promise<string>;
  confirm(message: string): Promise<boolean>;
  prompt(message: string, signal?: AbortSignal): Promise<string>;
  promptSecret(message: string, signal?: AbortSignal): Promise<string>;
}

export function createProcessIO(): CliIO {
  return {
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin as AsyncIterable<Uint8Array | string>) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    },
    confirm: async (message) => {
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return /^(?:y|yes)$/iu.test((await prompt.question(`${message} [y/N] `)).trim());
      } finally {
        prompt.close();
      }
    },
    prompt: async (message, signal) => {
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return signal
          ? await prompt.question(`${message} `, { signal })
          : await prompt.question(`${message} `);
      } finally {
        prompt.close();
      }
    },
    promptSecret: (message, signal) => readSecret(message, signal),
  };
}

function readSecret(message: string, signal?: AbortSignal): Promise<string> {
  if (!process.stdin.isTTY) return Promise.reject(new CliInputError("Secret input requires a TTY or --stdin."));
  const input = process.stdin;
  const wasRaw = input.isRaw;
  process.stderr.write(`${message} `);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      signal?.removeEventListener("abort", onAbort);
      input.setRawMode(Boolean(wasRaw));
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : new DOMException("Cancelled by user.", "AbortError"));
    const onData = (chunk: string | Buffer) => {
      for (const character of chunk.toString()) {
        if (character === "\u0003") return finish(new DOMException("Cancelled by user.", "AbortError"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    input.on("data", onData);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class CliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliInputError";
  }
}

export async function readJsonInput(path: string, io: CliIO): Promise<Record<string, unknown>> {
  let source: string;
  try {
    source = path === "-" ? await io.readStdin() : await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" ? "file not found" : code === "EACCES" ? "permission denied" : "could not be read";
    throw new CliInputError(`Unable to read JSON input ${path === "-" ? "stdin" : JSON.stringify(path)}: ${reason}.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new CliInputError(`Invalid JSON input: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliInputError("Tool input must be a JSON object.");
  }
  return value as Record<string, unknown>;
}
