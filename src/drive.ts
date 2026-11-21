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

/**
 * The standard's answer as an outcome, a throw included (a standard may
 * throw at once rather than fail later: Bun.connect without socket
 * handlers), so the steps always go on and clean up what they made (E, the
 * socket's directory's fd).
 */
function thrownAsFailure<S>(e: unknown): Attempted<S> {
  return { ok: false, error: asError(e) };
}

/** Runs steps, handing each spelling to the async standard at. */
export async function driveAsync<R, S>(
  steps: Generator<string, R, Outcome>,
  at: (spelling: string) => Promise<Attempted<S>>,
): Promise<{ result: R; socket: S }> {
  let held: { socket: S } | null = null;
  let step = steps.next();
  while (step.done !== true) {
    let a: Attempted<S>;
    try {
      a = await at(step.value);
    } catch (e) {
      a = thrownAsFailure(e);
    }
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
    let a: Attempted<S>;
    try {
      a = at(step.value);
    } catch (e) {
      a = thrownAsFailure(e);
    }
    held = a.ok ? { socket: a.socket } : null;
    step = steps.next(toOutcome(a));
  }
  if (held === null) {
    throw new Error("sockat: internal error: the steps ended without a socket");
  }
  return { result: step.value, socket: held.socket };
}

/**
 * What bindEx looks at before the bind: whether there is a file to record
 * (not for an abstract name), and the cwd for a relative path (SPEC
 * "remove": the cwd is compared before the bind and after the file is
 * recorded). The file itself is looked up after the bind (boundOf), as SPEC
 * "remove" records it: looked up before, a symlink on the way changed in
 * between would have it record a file other than the one bound.
 */
export interface BeforeBind {
  readonly file: boolean;
  readonly cwd: ReturnType<typeof cwdId>;
  readonly relative: boolean;
}

export function beforeBind(path: string): BeforeBind {
  // A NUL is an abstract name (no file to record) or an argument error,
  // which the bind's own checks throw.
  if (path.includes("\0")) {
    return { file: false, cwd: null, relative: false };
  }
  const relative = !path.startsWith("/");
  return { relative, cwd: relative ? cwdId() : null, file: true };
}

/**
 * The Bound of bindEx, the socket file recorded the moment the bind is done
 * (SPEC "remove"): followed to the socket it leads to, the cwd unchanged for
 * a relative path. When it cannot be recorded, a general error is thrown (a
 * remove that could not tell the file must not look like a success), after
 * the E is cleaned up and then the listener discarded: the standard unlinks
 * the spelling on close, which with E gone names nothing, so whatever has
 * replaced the socket file stays. A spelling with no E (a path the standard
 * took as it is) is unlinked by the close all the same.
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
  if (before.file) {
    const file = realFile(path);
    let ok = file.ok;
    if (file.ok) {
      const sock = socketAt(file.value);
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
      let eGone = result.link === null;
      try {
        cleaner.cleanup();
        eGone = true;
      } catch {
        // The error of the call is that the file could not be recorded.
      }
      discard();
      const left =
        result.link === null
          ? "the listener was closed, which unlinks the path"
          : eGone
            ? "the listener was closed and what is at the path left"
            : "the listener was closed, which unlinks the spelling (its symlink could not be removed first)";
      throw withDiagnostics(new Error(`listen ${path}: the socket file bound could not be recorded for its removal; ${left}`), trace);
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

