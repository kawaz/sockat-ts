import { linkDirSpelling, type Linked, linkFileSpelling, newBindCall, standardSkipped } from "./bind.ts";
import { asError, systemError, Trace, Unusable, withDiagnostics } from "./errors.ts";
import { type FileId, realFile, sameId, socketAt } from "./fsx.ts";
import { isAbs } from "./paths.ts";
import { absTarget, cwdId, entryOf, forNodeNet, type RouteName, type StandardSpelling } from "./route.ts";
import { Cleaner, RecordedSocketFile } from "./socketfile.ts";
import type { ForBind, ForConnect, Options, SocketFile, Spelling } from "./types.ts";
import type { World } from "./world.ts";

// The resolves (SPEC "resolve"): a spelling to hand to the standard yourself.
// A relative path is made absolute first, as a bind's is (SPEC "相対パスを絶対
// パスにする"): the spelling may be used after the cwd changed.

/**
 * ForBind's socketFile: follows the spelling now to the socket file bound
 * (its last component followed while a symlink, as bind(2) follows it on
 * some systems) and records it. An abstract name has no file. A spelling
 * relative to the cwd (CwdRelative) is only followed in the cwd it was
 * resolved in.
 */
function socketFileOf(path: string, spelt: string, spelling: Spelling, cwd: FileId | null, cleaner: Cleaner, abstract: boolean): SocketFile {
  if (abstract) {
    return new RecordedSocketFile(null, cleaner);
  }
  if (spelling.kind === "CwdRelative") {
    const now = cwdId();
    if (now === null || cwd === null || !sameId(now, cwd)) {
      throw new Error(
        `socketfile ${path}: the current directory changed since the path was resolved; the socket file it names may be another`,
      );
    }
  }
  const file = realFile(spelt);
  if (!file.ok) {
    throw systemError(file.code, "socketfile", path);
  }
  const sock = socketAt(file.value);
  if (!sock.ok) {
    throw systemError(sock.code, "socketfile", path);
  }
  return new RecordedSocketFile(sock.value, cleaner);
}

/** resolveForBind on w, for the standard spell spells for (node:net's, which also suits Bun's). */
export function resolveForBindIn(w: World, path: string, opts: Options, spell: StandardSpelling = forNodeNet): ForBind {
  const trace = new Trace();
  // The cwd before anything is looked up, for a CwdRelative spelling's socketFile.
  const cwd = isAbs(path) ? null : cwdId();
  try {
    const site = { syscall: "resolve", path };
    const e = entryOf(w, path, opts, spell, site);
    if (e.kind === "abstract") {
      return forBind(path, path, { kind: "Original" }, "standard", null, trace, new Cleaner(null, path), null, true);
    }
    if (e.kind === "standard") {
      return forBind(path, e.spelt, e.spelling, "standard", null, trace, new Cleaner(null, path), cwd, false);
    }
    const c = newBindCall(w, path, e.dir, opts, site);
    trace.skip("standard", standardSkipped(path));
    let route: RouteName = "link-dir";
    let ln: Linked | Unusable = linkDirSpelling(c, false);
    if (ln instanceof Unusable && w.cfg.bindFollows === "yes") {
      trace.skip(route, ln.reason);
      route = "link-file";
      const target = absTarget(path);
      ln = target instanceof Unusable ? target : linkFileSpelling(c, target, false);
    }
    if (ln instanceof Unusable) {
      trace.skip(route, ln.reason);
      if (e.asItIs !== null) {
        trace.unskip("standard");
        return forBind(path, e.asItIs, { kind: "CwdRelative" }, "standard", null, trace, new Cleaner(null, path), cwd, false);
      }
      throw systemError("ENAMETOOLONG", "resolve", path);
    }
    return forBind(path, ln.spelling, ln.sp, route, ln.base, trace, new Cleaner(ln.link, path), null, false);
  } catch (e) {
    throw withDiagnostics(asError(e), trace);
  }
}

function forBind(
  path: string,
  spelt: string,
  spelling: Spelling,
  route: RouteName,
  base: string | null,
  trace: Trace,
  cleaner: Cleaner,
  cwd: FileId | null,
  abstract: boolean,
): ForBind {
  return {
    path: spelt,
    spelling,
    route,
    base,
    skipped: [...trace.skipped],
    cleanup: () => cleaner.cleanup(),
    socketFile: () => socketFileOf(path, spelt, spelling, cwd, cleaner, abstract),
  };
}

/**
 * resolveForConnect on w: an absolute candidate when one fits, otherwise
 * link-file through the process's D (procB on Linux; usableCrossUid is not
 * looked at), otherwise a relative path as it is.
 */
export function resolveForConnectIn(w: World, path: string, opts: Options, spell: StandardSpelling = forNodeNet): ForConnect {
  const trace = new Trace();
  const given: Options = opts.base === undefined ? {} : { base: opts.base };
  try {
    const site = { syscall: "resolve", path };
    const e = entryOf(w, path, given, spell, site);
    if (e.kind === "abstract") {
      return forConnect(path, { kind: "Original" }, "standard", trace, new Cleaner(null, path));
    }
    if (e.kind === "standard") {
      return forConnect(e.spelt, e.spelling, "standard", trace, new Cleaner(null, path));
    }
    const c = newBindCall(w, path, e.dir, given, site);
    trace.skip("standard", standardSkipped(path));
    const target = absTarget(path);
    const ln = target instanceof Unusable ? target : linkFileSpelling(c, target, w.cfg.os === "linux");
    if (ln instanceof Unusable) {
      trace.skip("link-file", ln.reason);
      if (e.asItIs !== null) {
        trace.unskip("standard");
        return forConnect(e.asItIs, { kind: "CwdRelative" }, "standard", trace, new Cleaner(null, path));
      }
      throw systemError("ENAMETOOLONG", "resolve", path);
    }
    return forConnect(ln.spelling, ln.sp, "link-file", trace, new Cleaner(ln.link, path));
  } catch (e) {
    throw withDiagnostics(asError(e), trace);
  }
}

function forConnect(spelt: string, spelling: Spelling, route: RouteName, trace: Trace, cleaner: Cleaner): ForConnect {
  return { path: spelt, spelling, route, skipped: [...trace.skipped], cleanup: () => cleaner.cleanup() };
}
