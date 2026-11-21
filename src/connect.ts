import fs from "node:fs";
import { type CallSite, cwdChangedError, systemError, type Trace, Unusable } from "./errors.ts";
import { attempt, closeQuietly, entry, type FileId, fstatId, oPath, procAt, realDir, sameId, statId } from "./fsx.ts";
import { createAt, randomLength } from "./names.ts";
import { below, byteLength, isAbs, joinUnder, relativeTo, splitPath } from "./paths.ts";
import { absTarget, classify, cwdId, lookUpDir, noNative, type Outcome, type RouteName, routeFailure, type SocketDir, type StandardSpelling } from "./route.ts";
import type { Options } from "./types.ts";
import { type Base, stillHeld, type World } from "./world.ts";

// The connect order of a long path (SPEC "connect の順", DR-0002): the routes
// that need no writing and no thread first, then link-file, which writes an
// E in B. The routes that need native code are skipped:
//
//   | system                 | order                                                       |
//   |------------------------|-------------------------------------------------------------|
//   | Linux with /proc       | proc-direct, thread-cwd-direct (not made), link-file        |
//   | Linux without /proc    | relative, thread-cwd-direct (not made), link-file           |
//   | Apple's                | relative, widened (not made), thread-cwd-direct (not made), link-file |
//   | FreeBSD                | at-direct (not made), link-file                             |
//   | NetBSD, OpenBSD, other | relative, link-file                                         |
//
// A connect leaves no spelling with the peer, so no route of a connect makes
// D or keeps an E: link-file's E, in B itself, is unlinked right after the
// connect.

/** What a connect produced besides the socket. */
export interface ConnectResult {
  readonly route: RouteName;
}

/** One connect of a long path. */
interface ConnectCall {
  readonly w: World;
  readonly path: string;
  readonly dir: SocketDir;
  readonly opts: Options;
  readonly site: CallSite;
  /** The socket's directory opened O_PATH (Linux), for proc-direct; null when not opened. */
  readonly sdir: number | null;
}

/**
 * Whether the connect takes the row with proc-direct (SPEC "用語": `/proc`
 * を使える, for choosing the connect row): / opened for the check, and
 * <proc>/self/fd/<fd> has its (st_dev, st_ino). Where the PID namespace and
 * the /proc mounted disagree, or /proc is not there, it does not.
 */
function procRow(w: World): boolean {
  if (w.cfg.os !== "linux" || w.cfg.proc === "") {
    return false;
  }
  const r = attempt(() => fs.openSync("/", oPath | fs.constants.O_DIRECTORY));
  if (!r.ok) {
    return false;
  }
  try {
    const id = fstatId(r.value);
    return id !== null && procAt(w.cfg.proc, r.value, id) !== null;
  } finally {
    closeQuietly(r.value);
  }
}

/** The connect order after standard on this system (the row decided once, by whether /proc can be used). */
function connectOrder(w: World, proc: boolean): RouteName[] {
  switch (w.cfg.os) {
    case "linux":
      return proc ? ["proc-direct", "thread-cwd-direct", "link-file"] : ["relative", "thread-cwd-direct", "link-file"];
    case "darwin":
      return ["relative", "widened", "thread-cwd-direct", "link-file"];
    case "freebsd":
      return ["at-direct", "link-file"];
    default:
      return ["relative", "link-file"];
  }
}

/** A relative spelling of an absolute socket path, checked to name the same directory. */
export interface Relative {
  readonly spelling: string;
  /** The cwd when the spelling was made. */
  readonly cwd: FileId;
}

/**
 * The spellings of the cwd that the path may start with: what getcwd(3)
 * reports, and $PWD only when it names the cwd (stat($PWD) and stat(".")
 * agree on (st_dev, st_ino)).
 */
function cwdSpellings(cwd: string, id: FileId): string[] {
  const out = [cwd];
  const pwd = process.env["PWD"];
  if (pwd !== undefined && isAbs(pwd) && pwd !== cwd) {
    const pid = statId(pwd);
    if (pid !== null && sameId(pid, id)) {
      out.push(pwd);
    }
  }
  return out;
}

/**
 * path (whose directory part is dir) spelt relative to the cwd (SPEC-routes
 * "相対パスの作り方"): below a spelling of the cwd when path starts with one,
 * otherwise (only when that gives nothing short enough) through real paths,
 * climbing out of the cwd with "..". The shorter is kept, and used only when
 * its directory is the absolute one and the cwd did not change meanwhile.
 * Lengths are those of the spelling as the standard is handed it (spell).
 * null when there is no such spelling of at most max bytes.
 */
export function newRelative(path: string, dir: string, max: number, spell: StandardSpelling): Relative | null {
  const parts = splitPath(path);
  if (!isAbs(path) || parts === null) {
    return null;
  }
  const before = cwdId();
  const cwd = attempt(() => process.cwd());
  if (before === null || !cwd.ok) {
    return null;
  }
  let best: string | null = null;
  const keep = (rel: string): void => {
    if (best === null || byteLength(spell(rel)) < byteLength(spell(best))) {
      best = rel;
    }
  };
  for (const prefix of cwdSpellings(cwd.value, before)) {
    const rel = below(path, prefix);
    if (rel !== null) {
      keep(rel);
    }
  }
  const fitsNow = (): boolean => best !== null && byteLength(spell(best)) <= max;
  if (!fitsNow()) {
    const real = realDir(dir);
    if (real.ok) {
      const rel = relativeTo(joinUnder(real.value, parts.name), cwd.value);
      if (rel !== null) {
        keep(rel);
      }
    }
  }
  const chosen: string | null = best;
  if (chosen === null || byteLength(spell(chosen)) > max) {
    return null;
  }
  const relParts = splitPath(chosen);
  if (relParts === null) {
    return null;
  }
  const relId = statId(relParts.dir);
  const dirId = statId(dir);
  if (relId === null || dirId === null || !sameId(relId, dirId)) {
    return null;
  }
  const now = cwdId();
  if (now === null || !sameId(now, before)) {
    return null;
  }
  return { spelling: spell(chosen), cwd: before };
}

/** What a route does after its connect when it has nothing to do. */
function nothingAfter(): void {}

/** The length of the default connect's link-file spelling <B's real path>/<E>. */
function linkConnectLen(breal: string): number {
  return byteLength(breal) + 1 + randomLength;
}

/**
 * The B of link-file's connect: Options.base's when given (made here when
 * not there yet; an error making it is the call's), otherwise the process's
 * B of the places 1 to 3 (made here when the process has none yet, and
 * kept). The socket's directory, whose real-path spelling is longer than the
 * path, is no place for it.
 */
function connectBase(c: ConnectCall): Base | Unusable {
  const fits = (_kind: string, breal: string): boolean => linkConnectLen(breal) <= c.w.cfg.spellingLength;
  if (c.opts.base !== undefined) {
    return c.w.givenBase(c.opts.base, fits, c.site);
  }
  return c.w.autoBase(false, fits);
}

/**
 * The connect of path, as the steps the standard takes (see bindSteps): a
 * path the standard takes and an abstract name go to it as they are; a
 * longer one takes the connect order. relative discards a socket connected
 * while the cwd changed (a general error); link-file unlinks its E right
 * after, whatever the outcome.
 */
export function* connectSteps(
  w: World,
  path: string,
  opts: Options,
  trace: Trace,
  syscall: string,
  spell: StandardSpelling,
): Generator<string, ConnectResult, Outcome> {
  const site: CallSite = { syscall, path };
  const kind = classify(w, path, opts, spell);
  if (kind.kind !== "long") {
    const o = yield kind.spelt;
    trace.route = "standard";
    if (!o.ok) {
      throw o.error;
    }
    return { route: "standard" };
  }
  const dir = lookUpDir(w, path, opts, false, site);
  trace.skip("standard", "path too long");
  let sdir: number | null = null;
  if (w.cfg.os === "linux") {
    const r = attempt(() => fs.openSync(dir.dir, oPath | fs.constants.O_DIRECTORY));
    sdir = r.ok ? r.value : null;
  }
  try {
    const c: ConnectCall = { w, path, dir, opts, site, sdir };
    for (const route of connectOrder(w, procRow(w))) {
      let spelling: string;
      let after: (o: Outcome) => void = nothingAfter;
      switch (route) {
        case "proc-direct": {
          if (c.sdir === null) {
            trace.skip(route, "socket directory not opened");
            continue;
          }
          // The fd used is checked itself, apart from the row's check
          // (SPEC-routes "proc-direct").
          const sid = fstatId(c.sdir);
          const at = sid === null ? null : procAt(w.cfg.proc, c.sdir, sid);
          if (at === null) {
            trace.skip(route, "/proc does not name the socket's directory");
            continue;
          }
          spelling = `${at}/${dir.name}`;
          if (byteLength(spelling) > w.cfg.spellingLength) {
            trace.skip(route, "spelling too long");
            continue;
          }
          break;
        }
        case "relative": {
          if (!isAbs(path)) {
            trace.skip(route, "path not absolute");
            continue;
          }
          const rel = newRelative(path, dir.dir, w.cfg.spellingLength, spell);
          if (rel === null) {
            trace.skip(route, "no relative spelling");
            continue;
          }
          spelling = rel.spelling;
          after = (o) => {
            const now = cwdId();
            if (now === null || !sameId(now, rel.cwd)) {
              if (o.ok) {
                o.close();
              }
              trace.route = route;
              throw cwdChangedError();
            }
          };
          break;
        }
        case "link-file": {
          const target = absTarget(path);
          if (target instanceof Unusable) {
            trace.skip(route, target.reason);
            continue;
          }
          const b = connectBase(c);
          if (b instanceof Unusable) {
            trace.skip(route, b.reason);
            continue;
          }
          if (linkConnectLen(b.real) > w.cfg.spellingLength) {
            trace.skip(route, "spelling too long");
            continue;
          }
          const made = attempt(() => createAt(w.cfg.random, (n) => fs.symlinkSync(target, entry(b, n))));
          if (!made.ok) {
            trace.skip(route, "E not made");
            continue;
          }
          const name = made.value;
          spelling = joinUnder(b.real, name);
          // A failure to remove E is not reported: a connect that went
          // through is not made a failure by it. Named by B's real path, E
          // is unlinked only while that name is still the B held (the
          // connect waited, and a B removed meanwhile may be someone else's
          // name now).
          after = () => {
            if (stillHeld(b, null)) {
              attempt(() => fs.unlinkSync(entry(b, name)));
            }
          };
          break;
        }
        default:
          trace.skip(route, noNative);
          continue;
      }
      const o = yield spelling;
      after(o);
      trace.route = route;
      if (!o.ok) {
        throw routeFailure(o.error, site, spelling);
      }
      return { route };
    }
    throw systemError("ENAMETOOLONG", syscall, path);
  } finally {
    if (sdir !== null) {
      closeQuietly(sdir);
    }
  }
}
