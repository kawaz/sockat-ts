import { type CallSite, invalidArgument, systemError, errnoCode, Unusable } from "./errors.ts";
import { attempt, type FileId, realDir, sameId, statId } from "./fsx.ts";
import { byteLength, isAbs, splitPath } from "./paths.ts";
import type { Options } from "./types.ts";
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
 * front, which names the same file relative to the cwd.
 */
export const forNodeNet: StandardSpelling = (path) => (!path.includes("/") && Number(path) >= 0 ? `./${path}` : path);

/** The kind of path, and the spelling to hand the standard when it takes it. */
export type Kind = { readonly kind: "abstract" | "short"; readonly spelt: string } | { readonly kind: "long" };

/**
 * The kind of path, after the checks every call makes first (SPEC "短いパス",
 * "エラー"): an Options.base of the wrong form, an empty path, and a NUL
 * other than the leading one of a Linux abstract name, are argument errors
 * whatever the length; an abstract name, and a path whose spelling for the
 * standard (spell) is at most the standard length, go to the standard; a
 * longer one takes the routes.
 */
export function classify(w: World, path: string, opts: Options, spell: StandardSpelling): Kind {
  if (opts.base !== undefined && !givenShapeOk(opts.base)) {
    throw invalidArgument("options.base", opts.base, "must be an absolute path ending with a name");
  }
  if (path === "") {
    throw invalidArgument("path", path, "must not be empty");
  }
  if (w.cfg.os === "linux" && path.startsWith("\0")) {
    return { kind: "abstract", spelt: path };
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
  const spelt = spell(path);
  return byteLength(spelt) <= w.cfg.standardLength ? { kind: "short", spelt } : { kind: "long" };
}

/** The socket's directory of a long path, looked up before anything else. */
export interface SocketDir {
  /** The directory as the caller spelt it. */
  readonly dir: string;
  readonly name: string;
  /** Its real path. */
  readonly real: string;
  readonly id: FileId;
}

/**
 * Looks up the socket's directory of a long path first (SPEC "長いパスの経路と
 * 試す順番"): a path not ending with a name is an argument error; a missing
 * directory ENOENT, one that is not a directory ENOTDIR, and a failure to
 * resolve its real path its own errno, before anything is decided or made.
 * Then Options.base is checked (making nothing) with cross as the call has it.
 */
export function lookUpDir(w: World, path: string, opts: Options, cross: boolean, site: CallSite): SocketDir {
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
    throw systemError(real.code, site.syscall, site.path);
  }
  // The real path must name the directory stat looked up: another one there
  // now (renamed or replaced in between) would put E elsewhere.
  const seen = statId(real.value);
  if (seen === null || !sameId(seen, { dev: st.value.dev, ino: st.value.ino })) {
    throw new Error(`${site.syscall} ${site.path}: the socket's directory changed while it was looked up`);
  }
  if (opts.base !== undefined) {
    w.checkGiven(opts.base, cross, site);
  }
  return { dir: parts.dir, name: parts.name, real: real.value, id: { dev: st.value.dev, ino: st.value.ino } };
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
