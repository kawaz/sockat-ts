import { getSystemErrorMap } from "node:util";

// The errors sockat throws, in Node's shape (DR-0001): an OS error is an
// Error with code (the errno's name), errno (negative, as Node's are),
// syscall and path (the caller's path; a spelling never shows); an argument
// error is a TypeError with code ERR_INVALID_ARG_VALUE; a general error has
// no code.

/** A route found unusable, and why (diagnostics only; not a promise). */
export interface Skip {
  readonly name: string;
  readonly reason: string;
}

/**
 * A route that cannot be used here, and why (SPEC "使えない"): the order
 * moves on to the next route and records it in `skipped`. Never thrown out
 * of the package.
 */
export class Unusable {
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

/**
 * No B of the places 1 to 3 is there or can be made: the order may still
 * try the socket's directory. The reason names a place whose B of the
 * default name is taken (SPEC "診断": 占拠), if any was.
 */
export class NoBase extends Unusable {}

/** The call an error belongs to: the system call named in it and the caller's path. */
export interface CallSite {
  readonly syscall: string;
  readonly path: string;
}

/** An OS error as sockat throws it. */
export interface SystemError extends Error {
  code: string;
  errno: number;
  syscall: string;
  path: string;
  address: string;
}

/** The diagnostics the `*Ex` functions and the resolves attach to their errors. */
export interface RouteDiagnostics {
  /** The route that bound / connected and failed; null when none did. */
  route: string | null;
  /** The routes found unusable before it, in the order tried. */
  skipped: Skip[];
}

/** What the routes record of one call: the routes skipped and the route that failed. */
export class Trace {
  readonly skipped: Skip[] = [];
  route: string | null = null;

  skip(name: string, reason: string): void {
    this.skipped.push({ name, reason });
  }

  /**
   * Takes name back out of the skipped: the route that is taken after all
   * (standard, with a relative path as it is, once no route could be used;
   * SPEC "相対パスを絶対パスにする").
   */
  unskip(name: string): void {
    const i = this.skipped.findIndex((s) => s.name === name);
    if (i >= 0) {
      this.skipped.splice(i, 1);
    }
  }
}

/** The name and message of each errno, by name, from the runtime's table. */
const errnoByName: ReadonlyMap<string, { errno: number; message: string }> = (() => {
  const m = new Map<string, { errno: number; message: string }>();
  for (const [errno, [name, message]] of getSystemErrorMap()) {
    if (!m.has(name)) {
      m.set(name, { errno, message });
    }
  }
  return m;
})();

/**
 * An OS error of code (an errno's name) from syscall at path, in the shape
 * Node gives the errors of node:net (`listen EACCES: permission denied /p`).
 * `path` and `address` are both the caller's path.
 */
export function systemError(code: string, syscall: string, path: string, note?: string): SystemError {
  const known = errnoByName.get(code);
  const head = known === undefined ? `${syscall} ${code} ${path}` : `${syscall} ${code}: ${known.message} ${path}`;
  const message = note === undefined ? head : `${head} (${note})`;
  return Object.assign(new Error(message), {
    code,
    errno: known === undefined ? 0 : known.errno,
    syscall,
    path,
    address: path,
  });
}

/** An argument error (SPEC "エラー": 引数の誤り). */
export function invalidArgument(name: string, value: string, reason: string): TypeError & { code: string } {
  return Object.assign(new TypeError(`The argument '${name}' ${reason}. Received ${JSON.stringify(value)}`), {
    code: "ERR_INVALID_ARG_VALUE",
  });
}

/** The general error of a relative connect whose cwd changed meanwhile. */
export function cwdChangedError(): Error {
  return new Error(
    "The current directory changed while connecting through a path relative to it; the result was discarded",
  );
}

/** err with the diagnostics of trace attached. */
export function withDiagnostics<E extends Error>(err: E, trace: Trace): E & RouteDiagnostics {
  return Object.assign(err, { route: trace.route, skipped: [...trace.skipped] });
}

/**
 * The errno name of a thrown value or an error event (Node's and Bun's
 * errors carry it as `code`), undefined when it has none. The one place
 * where sockat reads an error it did not make.
 */
export function errnoCode(e: unknown): string | undefined {
  if (e instanceof Error && "code" in e && typeof e.code === "string" && /^E[A-Z0-9]+$/.test(e.code)) {
    return e.code;
  }
  return undefined;
}

/** A thrown value as an Error (the runtimes throw Errors; anything else is wrapped). */
export function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
