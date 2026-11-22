import { type CallSite, invalidArgument, systemError, errnoCode, Unusable } from "./errors.ts";
import { attempt, type FileId, realDir, sameId, statId } from "./fsx.ts";
import { byteLength, foldLexically, isAbs, joinUnder, splitPath } from "./paths.ts";
import type { Options, Spelling } from "./types.ts";
import { givenShapeOk, type World } from "./world.ts";
import fs from "node:fs";

// What every bind, connect and resolve does before the routes, and what the
// routes hand to the standard and get back.

/** The routes' names (SPEC "経路の名前"). */
export type RouteName =
  | "standard"
  | "link-dir"
  | "link-file"
  | "thread-cwd"
  | "at"
  | "proc-direct"
  | "relative"
  | "widened"
  | "at-direct"
  | "thread-cwd-direct";

/** The reason of a route sockat-ts never makes (DR-0002). */
export const noNative = "no native code in sockat-ts";

/**
 * What the standard did with a spelling a route handed to it: bound /
 * connected (close discards the listener or socket), or failed.
 */
export type Outcome = { readonly ok: true; readonly close: () => void } | { readonly ok: false; readonly error: Error };

/**
 * How a standard is handed a path it takes: the path itself, or the same
 * file spelt so that the standard reads it as a path (SPEC "短いパス").
 */
export type StandardSpelling = (path: string) => string;

/** For a standard that reads every string as a path (Bun.listen / Bun.connect's `unix`). */
export const asItIs: StandardSpelling = (path) => path;

/**
 * For node:net, which reads a string that Number() makes 0 or more ("123",
 * "1e3", " ") as a TCP port: such a spelling without a '/' gets "./" in
 * front, which names the same file relative to the cwd. Only a relative
 * path handed on as it is meets it: a connect's, a bind's or a resolve's
 * that no absolute candidate nor route could take, and a connect's relative
 * route.
 */
export const forNodeNet: StandardSpelling = (path) => (!path.includes("/") && Number(path) >= 0 ? `./${path}` : path);

/**
 * The checks every call makes first (SPEC "短いパス", "エラー"): an
 * Options.base of the wrong form, an empty path, and a NUL other than the
 * leading one of a Linux abstract name, are argument errors whatever the
 * length. Whether path is an abstract name (handed to the standard as it is).
 */
function checkForm(w: World, path: string, opts: Options): boolean {
  if (opts.base !== undefined && !givenShapeOk(opts.base)) {
    throw invalidArgument("options.base", opts.base, "must be an absolute path ending with a name");
  }
  if (path === "") {
    throw invalidArgument("path", path, "must not be empty");
  }
  if (w.cfg.os === "linux" && path.startsWith("\0")) {
    return true;
  }
  if (path.includes("\0")) {
    throw invalidArgument(
      "path",
      path,
      w.cfg.os === "linux"
        ? "must not contain a NUL byte other than the leading one of an abstract socket name"
        : "must not contain a NUL byte",
    );
  }
  return false;
}

/** The kind of path for a connect, and the spelling to hand the standard when it takes it. */
export type Kind = { readonly kind: "abstract" | "short"; readonly spelt: string } | { readonly kind: "long" };

/**
 * The kind of path for a connect, after checkForm: an abstract name, and a
 * path whose spelling for the standard (spell) is at most the standard
 * length, go to the standard; a longer one takes the routes. A relative
 * path stays relative (SPEC "相対パスを絶対パスにする": the connects).
 */
export function classify(w: World, path: string, opts: Options, spell: StandardSpelling): Kind {
  if (checkForm(w, path, opts)) {
    return { kind: "abstract", spelt: path };
  }
  const spelt = spell(path);
  return byteLength(spelt) <= w.cfg.standardLength ? { kind: "short", spelt } : { kind: "long" };
}

/** The socket's directory of a path, looked up before anything is made. */
export interface SocketDir {
  /** The directory as the caller spelt it. */
  readonly dir: string;
  readonly name: string;
  /** Its real path. */
  readonly real: string;
  readonly id: FileId;
}

/** Whether a failure to get or use a real path is for its length (realpath(3) gives ERANGE for that on macOS). */
function forLength(code: string): boolean {
  return code === "ENAMETOOLONG" || code === "ERANGE";
}

/**
 * Looks up the socket's directory of path (SPEC "長いパスの経路と試す順番"): a
 * path not ending with a name is an argument error; a missing directory
 * ENOENT, one that is not a directory ENOTDIR, and a failure to resolve its
 * real path for another reason its own errno, before anything is decided or
 * made. A real path that cannot be had for its length (a cwd deeper than
 * PATH_MAX: realpath(3) fails, or on Linux gives a path too long to look up)
 * gives the errno it failed with as tooLong.
 */
function findDir(path: string, site: CallSite): SocketDir | { readonly tooLong: string } {
  const parts = splitPath(path);
  if (parts === null) {
    throw invalidArgument("path", path, "must end with a file name");
  }
  const st = attempt(() => fs.statSync(parts.dir, { bigint: true }));
  if (!st.ok) {
    throw systemError(st.code, site.syscall, site.path);
  }
  if (!st.value.isDirectory()) {
    throw systemError("ENOTDIR", site.syscall, site.path);
  }
  const real = realDir(parts.dir);
  if (!real.ok) {
    if (forLength(real.code)) {
      return { tooLong: real.code };
    }
    throw systemError(real.code, site.syscall, site.path);
  }
  // The real path must name the directory stat looked up: another one there
  // now (renamed or replaced in between) would put E elsewhere.
  const seen = attempt(() => fs.statSync(real.value, { bigint: true }));
  if (!seen.ok && forLength(seen.code)) {
    return { tooLong: seen.code };
  }
  if (!seen.ok || !sameId({ dev: seen.value.dev, ino: seen.value.ino }, { dev: st.value.dev, ino: st.value.ino })) {
    throw new Error(`${site.syscall} ${site.path}: the socket's directory changed while it was looked up`);
  }
  return { dir: parts.dir, name: parts.name, real: real.value, id: { dev: st.value.dev, ino: st.value.ino } };
}

/**
 * Looks up the socket's directory of a connect's long path first (findDir;
 * a real path too long to have is its errno), then checks Options.base
 * (making nothing) with cross as the call has it.
 */
export function lookUpDir(w: World, path: string, opts: Options, cross: boolean, site: CallSite): SocketDir {
  const dir = findDir(path, site);
  if ("tooLong" in dir) {
    throw systemError(dir.tooLong, site.syscall, site.path);
  }
  if (opts.base !== undefined) {
    w.checkGiven(opts.base, cross, site);
  }
  return dir;
}

/**
 * How a bind or a resolve goes on with path (SPEC "相対パスを絶対パスにする"):
 * - abstract: an abstract name, to the standard as it is
 * - standard: spelt to the standard, as its spelling says, shown as the
 *   listener's address
 * - routes: the routes, through dir; shown as the listener's address when
 *   one binds; asItIs, when no route can be used, the relative path to the
 *   standard as it is (CwdRelative; null when over the standard length,
 *   or absolute: ENAMETOOLONG)
 */
export type Entry =
  | { readonly kind: "abstract" }
  | { readonly kind: "standard"; readonly spelt: string; readonly spelling: Spelling; readonly shown: string }
  | { readonly kind: "routes"; readonly dir: SocketDir; readonly shown: string; readonly asItIs: string | null };

const original: Spelling = { kind: "Original" };
const cwdRelative: Spelling = { kind: "CwdRelative" };

/**
 * Where a bind or a resolve of path goes, after checkForm (SPEC "相対パスを絶対
 * パスにする", SPEC-routes "絶対パスの候補の作り方"):
 *
 * | path                                    | goes                                         |
 * |-----------------------------------------|----------------------------------------------|
 * | absolute, at most the standard length   | the standard, as it is                       |
 * | absolute, longer                        | the standard by its real candidate if that fits, else the routes |
 * | relative, not ending with a name        | the standard as it is (short), else an argument error |
 * | relative, real path too long to have    | the standard as it is (short), else ENAMETOOLONG |
 * | relative                                | the standard by its real candidate, else by its $PWD candidate, if one fits; else the routes |
 *
 * The socket's directory is looked up first (its errors thrown); Options.base
 * is checked only when the routes are taken (newBindCall). shown is the
 * absolute path given, or the absolute form of a relative one: the
 * candidate handed to the standard, or the real candidate when the routes
 * are taken. A relative path is spelt for the standard by spell (asItIs).
 */
export function entryOf(w: World, path: string, opts: Options, spell: StandardSpelling, site: CallSite): Entry {
  if (checkForm(w, path, opts)) {
    return { kind: "abstract" };
  }
  const fits = (p: string): boolean => byteLength(p) <= w.cfg.standardLength;
  if (isAbs(path)) {
    if (fits(path)) {
      return { kind: "standard", spelt: path, spelling: original, shown: path };
    }
    const dir = findDir(path, site);
    if ("tooLong" in dir) {
      throw systemError("ENAMETOOLONG", site.syscall, site.path);
    }
    const real = joinUnder(dir.real, dir.name);
    return fits(real) ? { kind: "standard", spelt: real, spelling: original, shown: path } : { kind: "routes", dir, shown: path, asItIs: null };
  }
  const spelt = spell(path);
  const relSpelt = fits(spelt) ? spelt : null;
  if (splitPath(path) === null && relSpelt !== null) {
    // No file name, so no candidate: the standard's own error.
    return { kind: "standard", spelt: relSpelt, spelling: cwdRelative, shown: path };
  }
  const dir = findDir(path, site);
  if ("tooLong" in dir) {
    // No candidate, and no route (they go through the real path): step 5,
    // with nothing tried.
    if (relSpelt === null) {
      throw systemError("ENAMETOOLONG", site.syscall, site.path);
    }
    return { kind: "standard", spelt: relSpelt, spelling: cwdRelative, shown: path };
  }
  const real = joinUnder(dir.real, dir.name);
  if (fits(real)) {
    return { kind: "standard", spelt: real, spelling: original, shown: real };
  }
  const pwd = pwdCandidate(w, path, dir.id);
  if (pwd !== null && fits(pwd)) {
    return { kind: "standard", spelt: pwd, spelling: original, shown: pwd };
  }
  return { kind: "routes", dir, shown: real, asItIs: relSpelt };
}

/**
 * The $PWD candidate of the relative path (SPEC-routes "絶対パスの候補の作り方"):
 * $PWD, when it is absolute and names the cwd, joined with path and folded
 * as a string, when the folded directory is the socket's directory (dirId)
 * the path names; null otherwise. $PWD is read through the world (the
 * environment the process started with: neither runtime updates it on
 * process.chdir, hence the check against the cwd).
 */
function pwdCandidate(w: World, path: string, dirId: FileId): string | null {
  const pwd = w.cfg.getenv("PWD");
  if (pwd === undefined || !isAbs(pwd)) {
    return null;
  }
  const here = cwdId();
  const there = statId(pwd);
  if (here === null || there === null || !sameId(here, there)) {
    return null;
  }
  const folded = foldLexically(`${pwd}/${path}`);
  const parts = splitPath(folded);
  if (parts === null) {
    return null;
  }
  // "a/sym/.." folded names a, while the kernel goes to the parent of
  // sym's target: only the same directory is a candidate.
  const id = statId(parts.dir);
  return id !== null && sameId(id, dirId) ? folded : null;
}

/**
 * The error of a long path whose route bound / connected and failed: the
 * standard's errno, with the caller's path in place of the spelling (which
 * never shows in an error).
 */
export function routeFailure(error: Error, site: CallSite, spelling: string): Error {
  const code = errnoCode(error);
  if (code === undefined) {
    // Not the system's answer (a misuse the standard refused, such as Bun's
    // TypeError for missing socket handlers): passed on as it is, unless it
    // would show the spelling.
    return error.message.includes(spelling)
      ? new Error(`${site.syscall} failed for ${site.path}: the standard gave an error without an errno`)
      : error;
  }
  return systemError(code, site.syscall, site.path);
}

/**
 * The caller's spelling made absolute against the cwd, for a symlink to
 * hold: the kernel then resolves the link as it resolves the caller's path.
 * Unusable when the cwd cannot be read.
 */
export function absTarget(path: string): string | Unusable {
  if (isAbs(path)) {
    return path;
  }
  const cwd = attempt(() => process.cwd());
  return cwd.ok ? `${cwd.value}/${path}` : new Unusable("cwd unreadable");
}

/** The (st_dev, st_ino) of the cwd, null when it cannot be looked up. */
export function cwdId(): FileId | null {
  return statId(".");
}
