import { linkDirSpelling, type Linked, linkFileSpelling, newBindCall } from "./bind.ts";
import { asError, systemError, Trace, Unusable, withDiagnostics } from "./errors.ts";
import { type FileId, realFile, sameId, socketAt } from "./fsx.ts";
import { absTarget, classify, cwdId, type RouteName } from "./route.ts";
import { Cleaner, RecordedSocketFile } from "./socketfile.ts";
import type { ForBind, ForConnect, Options, SocketFile, Spelling } from "./types.ts";
import type { World } from "./world.ts";

// The resolves (SPEC "resolve"): a spelling to hand to the standard yourself.

/**
 * ForBind's socketFile: follows the spelling now to the socket file bound
 * (its last component followed while a symlink, as bind(2) follows it on
 * some systems) and records it. An abstract name has no file.
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

/** resolveForBind on w. */
export function resolveForBindIn(w: World, path: string, opts: Options): ForBind {
  const trace = new Trace();
  try {
    const kind = classify(w, path, opts);
    if (kind !== "long") {
      const relative = kind === "short" && !path.startsWith("/");
      const spelling: Spelling = relative ? { kind: "CwdRelative" } : { kind: "Original" };
      return forBind(path, path, spelling, "standard", null, trace, new Cleaner(null, path), relative ? cwdId() : null, kind === "abstract");
    }
    const c = newBindCall(w, path, opts, { syscall: "resolve", path });
    trace.skip("standard", "path too long");
    let route: RouteName = "link-dir";
    let ln: Linked | Unusable = linkDirSpelling(c);
    if (ln instanceof Unusable && w.cfg.bindFollows === "yes") {
      trace.skip(route, ln.reason);
      route = "link-file";
      const target = absTarget(path);
      ln = target instanceof Unusable ? target : linkFileSpelling(c, target, false);
    }
    if (ln instanceof Unusable) {
      trace.skip(route, ln.reason);
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

/** resolveForConnect on w: link-file only, through the process's D (usableCrossUid is not looked at). */
export function resolveForConnectIn(w: World, path: string, opts: Options): ForConnect {
  const trace = new Trace();
  const given: Options = opts.base === undefined ? {} : { base: opts.base };
  try {
    if (classify(w, path, given) !== "long") {
      return forConnect(path, "standard", trace, new Cleaner(null, path));
    }
    const c = newBindCall(w, path, given, { syscall: "resolve", path });
    trace.skip("standard", "path too long");
    const target = absTarget(path);
    const ln = target instanceof Unusable ? target : linkFileSpelling(c, target, w.cfg.os === "linux");
    if (ln instanceof Unusable) {
      trace.skip("link-file", ln.reason);
      throw systemError("ENAMETOOLONG", "resolve", path);
    }
    return forConnect(ln.spelling, "link-file", trace, new Cleaner(ln.link, path));
  } catch (e) {
    throw withDiagnostics(asError(e), trace);
  }
}

function forConnect(spelt: string, route: RouteName, trace: Trace, cleaner: Cleaner): ForConnect {
  return { path: spelt, route, skipped: [...trace.skipped], cleanup: () => cleaner.cleanup() };
}
