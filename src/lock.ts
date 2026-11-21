import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { LockMethod } from "./config.ts";
import { attempt, closeQuietly, dirOpenFlags } from "./fsx.ts";

// The flock(2) of D (DR-0002 "D のロック"), with no native code: a shared
// lock for as long as the process holds D, an exclusive one for sweep to tell
// a D whose process has ended.

/**
 * O_SHLOCK and O_EXLOCK of Apple's systems, FreeBSD, NetBSD and OpenBSD (not
 * in fs.constants). Each system's sys/fcntl.h defines them with the same
 * values: O_SHLOCK 0x0010, O_EXLOCK 0x0020. Opening with one takes the
 * flock(2) lock of that kind, which other processes' flock(2) see.
 */
const oShlock = 0x10;
const oExlock = 0x20;

/** The outcome of taking a lock on D. */
export type Locked =
  | { readonly ok: true; readonly fd: number }
  /** Another process holds the other kind of lock (busy), or no lock can be taken here (unavailable). */
  | { readonly ok: false; readonly why: "busy" | "unavailable"; readonly code: string };

/**
 * Opens the directory at path (not through a symlink) and takes a lock of
 * the kind on it without waiting: the fd holds the lock until it is closed.
 *
 * - bsd: opened O_SHLOCK / O_EXLOCK | O_NONBLOCK (EAGAIN when it is held
 *   otherwise)
 * - flock-command: the fd is handed to flock(1) as its fd 3 (`flock -s -n 3`
 *   / `-x`). The lock is on the open file description, which the parent's fd
 *   keeps after flock(1) has exited (measured on Linux with Node and Bun,
 *   glibc and busybox)
 * - none: no lock can be taken
 *
 * An error opening path (ENOENT, ELOOP, ...) comes back as unavailable with
 * its code.
 */
export function openLocked(path: string, method: LockMethod, kind: "shared" | "exclusive"): Locked {
  switch (method.kind) {
    case "none":
      return { ok: false, why: "unavailable", code: "ENOLCK" };
    case "bsd": {
      const flags = dirOpenFlags | (kind === "shared" ? oShlock : oExlock) | fs.constants.O_NONBLOCK;
      const r = attempt(() => fs.openSync(path, flags));
      if (r.ok) {
        return { ok: true, fd: r.value };
      }
      return { ok: false, why: r.code === "EAGAIN" || r.code === "EWOULDBLOCK" ? "busy" : "unavailable", code: r.code };
    }
    case "flock-command": {
      const r = attempt(() => fs.openSync(path, dirOpenFlags));
      if (!r.ok) {
        return { ok: false, why: "unavailable", code: r.code };
      }
      const fd = r.value;
      const run = spawnSync(method.command, [kind === "shared" ? "-s" : "-x", "-n", "3"], {
        stdio: ["ignore", "ignore", "pipe", fd],
      });
      if (run.error === undefined && run.status === 0) {
        return { ok: true, fd };
      }
      closeQuietly(fd);
      if (run.error !== undefined) {
        return { ok: false, why: "unavailable", code: "ENOLCK" };
      }
      return { ok: false, why: run.status === 1 ? "busy" : "unavailable", code: "EAGAIN" };
    }
  }
}
