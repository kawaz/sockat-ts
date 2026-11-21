import { type CallSite, invalidArgument, systemError, errnoCode, Unusable } from "./errors.ts";
import { attempt, type FileId, statId, realDir } from "./fsx.ts";
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
 * The kind of path, after the checks every call makes first (SPEC "短いパス",
 * "エラー"): an Options.base of the wrong form, and a NUL other than the
 * leading one of a Linux abstract name, are argument errors whatever the
 * length; an abstract name and a path of at most the standard length go to
 * the standard as they are; a longer one takes the routes.
 */
export function classify(w: World, path: string, opts: Options): "abstract" | "short" | "long" {
  if (opts.base !== undefined && !givenShapeOk(opts.base)) {
    throw invalidArgument("options.base", opts.base, "must be an absolute path ending with a name");
  }
  if (w.cfg.os === "linux" && path.startsWith("\0")) {
    return "abstract";
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
  return byteLength(path) <= w.cfg.standardLength ? "short" : "long";
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
export function routeFailure(error: Error, site: CallSite): Error {
  const code = errnoCode(error);
  if (code === undefined) {
    return new Error(`${site.syscall} failed for ${site.path}: the standard gave an error without an errno`);
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
