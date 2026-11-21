import { asError, type Trace, withDiagnostics } from "./errors.ts";
import type { BindResult } from "./bind.ts";
import { realFile, sameId, socketAt } from "./fsx.ts";
import type { Outcome } from "./route.ts";
import { cwdId } from "./route.ts";
import { Cleaner, RecordedSocketFile } from "./socketfile.ts";
import type { Bound } from "./types.ts";

// Running the steps of a bind or connect (bindSteps, connectSteps) against a
// standard: node:net and Bun.connect answer later (async), Bun.listen at once
// (sync). The steps are the same generator for both.

/** What the standard did with a spelling: a socket, with how to discard it, or the error. */
export type Attempted<S> = { readonly ok: true; readonly socket: S; readonly close: () => void } | { readonly ok: false; readonly error: Error };

function toOutcome<S>(a: Attempted<S>): Outcome {
  return a.ok ? { ok: true, close: a.close } : { ok: false, error: a.error };
}

/** Runs steps, handing each spelling to the async standard at. */
export async function driveAsync<R, S>(
  steps: Generator<string, R, Outcome>,
  at: (spelling: string) => Promise<Attempted<S>>,
): Promise<{ result: R; socket: S }> {
  let held: { socket: S } | null = null;
  let step = steps.next();
  while (step.done !== true) {
    const a = await at(step.value);
    held = a.ok ? { socket: a.socket } : null;
    step = steps.next(toOutcome(a));
  }
  if (held === null) {
    throw new Error("sockat: internal error: the steps ended without a socket");
  }
  return { result: step.value, socket: held.socket };
}

/** Runs steps, handing each spelling to the sync standard at. */
export function driveSync<R, S>(steps: Generator<string, R, Outcome>, at: (spelling: string) => Attempted<S>): { result: R; socket: S } {
  let held: { socket: S } | null = null;
  let step = steps.next();
  while (step.done !== true) {
    const a = at(step.value);
    held = a.ok ? { socket: a.socket } : null;
    step = steps.next(toOutcome(a));
  }
  if (held === null) {
    throw new Error("sockat: internal error: the steps ended without a socket");
  }
  return { result: step.value, socket: held.socket };
}

/**
 * What bindEx records before the bind: the socket file at path with its
 * directory resolved to a real path, and the cwd for a relative path (SPEC
 * "remove": the cwd is compared before and after).
 */
export interface BeforeBind {
  readonly file: ReturnType<typeof realFile> | null;
  readonly cwd: ReturnType<typeof cwdId>;
  readonly relative: boolean;
}

export function beforeBind(path: string): BeforeBind {
  // A NUL is an abstract name (no file to record) or an argument error,
  // which the bind's own checks throw.
  if (path.includes("\0")) {
    return { file: null, cwd: null, relative: false };
  }
  const relative = !path.startsWith("/");
  return { relative, cwd: relative ? cwdId() : null, file: realFile(path) };
}

/**
 * The Bound of bindEx, the socket file recorded the moment the bind is done
 * (SPEC "remove"): followed to the socket it leads to, the cwd unchanged for
 * a relative path. When it cannot be recorded, the listener is discarded,
 * the E cleaned up, and a general error thrown (a remove that could not tell
 * the file must not look like a success).
 */
export function boundOf<S>(
  path: string,
  before: BeforeBind,
  result: BindResult,
  socket: S,
  discard: () => void,
  trace: Trace,
): Bound<S> {
  const cleaner = new Cleaner(result.link, path);
  let recorded: { file: string; id: { dev: bigint; ino: bigint } } | null = null;
  if (before.file !== null) {
    let ok = before.file.ok;
    if (before.file.ok) {
      const sock = socketAt(before.file.value);
      ok = sock.ok;
      if (sock.ok) {
        recorded = sock.value;
      }
    }
    if (ok && before.relative) {
      const now = cwdId();
      ok = now !== null && before.cwd !== null && sameId(now, before.cwd);
    }
    if (!ok) {
      discard();
      try {
        cleaner.cleanup();
      } catch {
        // The error of the call is that the file could not be recorded.
      }
      throw withDiagnostics(
        new Error(`listen ${path}: the socket file bound could not be recorded for its removal; the listener was closed and the file left`),
        trace,
      );
    }
  }
  return {
    socket,
    file: new RecordedSocketFile(recorded, cleaner),
    spelling: result.spelling,
    route: result.route,
    base: result.base,
    skipped: [...trace.skipped],
  };
}

/** Attaches trace's diagnostics to a thrown value. */
export function diagnosed(e: unknown, trace: Trace): Error {
  return withDiagnostics(asError(e), trace);
}

