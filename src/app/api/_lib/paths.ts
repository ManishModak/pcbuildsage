import path from "node:path";

export class SandboxedPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxedPathError";
  }
}

export function resolveSandboxedPath(input: string, options: { base?: string } = {}): string {
  const baseDir = path.resolve(options.base ?? path.join(process.cwd(), "data"));
  if (!input.trim()) throw new SandboxedPathError("Path must not be empty.");

  const resolved = path.isAbsolute(input) ? path.resolve(input) : resolveRelativeInput(input, baseDir);
  if (!isWithinBase(resolved, baseDir)) {
    throw new SandboxedPathError(`Path must stay within ${baseDir}.`);
  }
  return resolved;
}

function resolveRelativeInput(input: string, baseDir: string): string {
  const fromCwd = path.resolve(process.cwd(), input);
  if (isWithinBase(fromCwd, baseDir)) return fromCwd;
  return path.resolve(baseDir, input);
}

function isWithinBase(candidate: string, baseDir: string): boolean {
  const relative = path.relative(baseDir, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
