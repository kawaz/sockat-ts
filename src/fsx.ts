import fs from "node:fs";
import nodePath from "node:path";
import { errnoCode } from "./errors.ts";
import { isAbs, joinUnder, splitPath } from "./paths.ts";

// The file system as the routes look at it: (st_dev, st_ino), real paths,
// the effective uid, and the stand-ins for the *at system calls that node:fs
// does not have (DR-0002 "*at 系の代わり").

/** (st_dev, st_ino). */
export interface FileId {
  readonly dev: bigint;
  readonly ino: bigint;
}

export function sameId(a: FileId, b: FileId): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function idOf(st: fs.BigIntStats): FileId {
  return { dev: st.dev, ino: st.ino };
}

/** The outcome of a file system call: its value, or the errno's name it failed with. */
export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };

/**
 * Runs a file system call, turning an error with an errno into a value.
 * An error without one (a bug, not the file system's answer) is thrown.
 */
export function attempt<T>(f: () => T): Result<T> {
  try {
    return { ok: true, value: f() };
  } catch (e) {
    const code = errnoCode(e);
    if (code === undefined) {
      throw e;
    }
    return { ok: false, code };
  }
}

export function lstat(path: string): Result<fs.BigIntStats> {
  return attempt(() => fs.lstatSync(path, { bigint: true }));
}

export function fstat(fd: number): Result<fs.BigIntStats> {
  return attempt(() => fs.fstatSync(fd, { bigint: true }));
}

/** The (st_dev, st_ino) of what path names (following symlinks), null when it cannot be looked up. */
export function statId(path: string): FileId | null {
  const r = attempt(() => fs.statSync(path, { bigint: true }));
  return r.ok ? idOf(r.value) : null;
}

export function lstatId(path: string): FileId | null {
  const r = lstat(path);
  return r.ok ? idOf(r.value) : null;
}

export function fstatId(fd: number): FileId | null {
  const r = fstat(fd);
  return r.ok ? idOf(r.value) : null;
}

/** The effective uid (B's name and the checks of B, D and their ancestors). */
export function euid(): number {
  if (process.geteuid === undefined) {
    throw new Error("sockat needs a POSIX system (process.geteuid)");
  }
  return process.geteuid();
}

/** Whether st is a directory owned by the effective uid. */
export function isOurDir(st: fs.BigIntStats): boolean {
  return st.isDirectory() && st.uid === BigInt(euid());
}

/** The permission bits of st (mode & 07777). */
export function modeBits(st: fs.BigIntStats): number {
  return Number(st.mode & 0o7777n);
}

/**
 * dir as a real path (symlinks resolved, absolute), made absolute against
 * the cwd first so every component is looked up.
 */
export function realDir(dir: string): Result<string> {
  return attempt(() => fs.realpathSync(nodePath.resolve(dir)));
}

/**
 * The socket file at path with its directory resolved to a real path, so a
 * later change of the cwd or of a symlink on the way does not retarget it.
 */
export function realFile(path: string): Result<string> {
  const parts = splitPath(path);
  if (parts === null) {
    return { ok: false, code: "EINVAL" };
  }
  const real = realDir(parts.dir);
  return real.ok ? { ok: true, value: joinUnder(real.value, parts.name) } : real;
}

/**
 * How many symlinks socketAt follows before it gives up with ELOOP: at least
 * what the kernels follow in a path (40 on Linux, 32 on macOS).
 */
const maxFollow = 40;

/**
 * The socket file at file (whose directory is a real path): when its last
 * component is a symlink, followed as bind(2) follows it on the systems
 * where it does (SPEC "remove", "ForBind の SocketFile"), each target taken
 * relative to the directory of its symlink and its directory resolved to a
 * real path. The real path of the socket reached and its (st_dev, st_ino),
 * or the errno: the lstat's (ENOENT, ...), ENOTSOCK when what is reached is
 * not a socket, ELOOP after maxFollow symlinks.
 */
export function socketAt(file: string): Result<{ file: string; id: FileId }> {
  let current = file;
  for (let i = 0; i <= maxFollow; i++) {
    const st = lstat(current);
    if (!st.ok) {
      return st;
    }
    if (st.value.isSocket()) {
      return { ok: true, value: { file: current, id: idOf(st.value) } };
    }
    if (!st.value.isSymbolicLink()) {
      return { ok: false, code: "ENOTSOCK" };
    }
    const link = current;
    const target = attempt(() => fs.readlinkSync(link));
    if (!target.ok) {
      return target;
    }
    const next = realFile(isAbs(target.value) ? target.value : `${nodePath.dirname(current)}/${target.value}`);
    if (!next.ok) {
      return next;
    }
    current = next.value;
  }
  return { ok: false, code: "ELOOP" };
}

/** How B and D are opened: for reading (D takes its lock, sweep lists B), never through a symlink. */
export const dirOpenFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;

/**
 * Linux's O_PATH (not in fs.constants): opens a directory with search
 * permission alone (the socket's directory for proc-direct, the parent of B).
 */
export const oPath = 0o10000000;

/**
 * A directory held by its fd, through which its entries are named: by
 * /proc/self/fd/<fd>/<name> where /proc can be used for it (Linux), so the
 * name is looked up in the directory held, as *at system calls would;
 * otherwise by its real path, every directory on the way to which was
 * checked so that nobody else can replace it (DR-0002).
 */
export interface HeldDir {
  /** The directory's real path. */
  readonly real: string;
  /** /proc/self/fd/<fd>, when /proc names the directory held by fd; null otherwise. */
  readonly at: string | null;
}

/** The path through which the entry name of dir is reached. */
export function entry(dir: HeldDir, name: string): string {
  return dir.at !== null ? `${dir.at}/${name}` : joinUnder(dir.real, name);
}

/**
 * <proc>/self/fd/<fd>, when proc is set and it names the directory held by
 * fd (the same (st_dev, st_ino) as fd's); null otherwise.
 */
export function procAt(proc: string, fd: number, id: FileId): string | null {
  if (proc === "") {
    return null;
  }
  const at = `${proc}/self/fd/${fd}`;
  const seen = statId(at);
  return seen !== null && sameId(seen, id) ? at : null;
}

/** Closes fd, ignoring an error (an fd of ours closed once). */
export function closeQuietly(fd: number): void {
  attempt(() => fs.closeSync(fd));
}
