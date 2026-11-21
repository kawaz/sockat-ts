import fs from "node:fs";
import { invalidArgument, systemError } from "./errors.ts";
import { attempt, closeQuietly, entry, fstat, type HeldDir, isOurDir, lstat, modeBits, procAt, realDir, sameId } from "./fsx.ts";
import { openLocked } from "./lock.ts";
import { isRandomName } from "./names.ts";
import { joinUnder, splitPath } from "./paths.ts";
import { bName, checkAncestors, givenShapeOk, type World } from "./world.ts";

// sweep and sweepBase (SPEC "sweep"): remove the D of processes that have
// ended, told by an exclusive lock taken at once.

/** Throws the errors collected: one as it is, several as an AggregateError. */
function throwAll(errors: Error[], message: string): void {
  if (errors.length === 1 && errors[0] !== undefined) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, message);
  }
}

/**
 * sweep on w: the B of a default name in each of w's places 1 to 3 whose
 * ancestors pass their check. A place or B that fails a check is passed
 * over; nothing is made.
 */
export function sweepIn(w: World): void {
  const errors: Error[] = [];
  for (const p of w.autoPlaces()) {
    const real = realDir(p.path);
    if (!real.ok || checkAncestors(real.value, false) !== null) {
      continue;
    }
    const b = joinUnder(real.value, bName(p.kind));
    errors.push(...sweepB(w, b, b, false));
  }
  throwAll(errors, "sweep: some directories could not be removed");
}

/**
 * sweepBase on w: sweep for the B at base (as given to Options.base).
 * Nothing when base, or its parent, does not exist; an argument error for a
 * base of the wrong form; EPERM / ENOTDIR for a B or an ancestor that fails
 * the check.
 */
export function sweepBaseIn(w: World, base: string): void {
  if (!givenShapeOk(base)) {
    throw invalidArgument("base", base, "must be an absolute path ending with a name");
  }
  const parts = splitPath(base);
  if (parts === null) {
    return;
  }
  const real = realDir(parts.dir);
  if (!real.ok) {
    if (real.code === "ENOENT") {
      return;
    }
    throw systemError(real.code, "sweep", base);
  }
  const st = attempt(() => fs.statSync(real.value));
  if (!st.ok) {
    throw systemError(st.code, "sweep", base);
  }
  if (!st.value.isDirectory()) {
    throw systemError("ENOTDIR", "sweep", base);
  }
  if (checkAncestors(real.value, false) !== null) {
    throw systemError("EPERM", "sweep", base);
  }
  throwAll(sweepB(w, joinUnder(real.value, parts.name), base, true), "sweep: some directories could not be removed");
}

/**
 * Removes the dead D in the B at real (named path in the errors): a
 * directory of ours others cannot write to, opened without following a
 * symlink. Nothing when it is not there. given makes a B that fails the
 * check an error; otherwise it is passed over.
 */
function sweepB(w: World, real: string, path: string, given: boolean): Error[] {
  const failed = (code: string): Error[] => (given ? [systemError(code, "sweep", path)] : []);
  const st = lstat(real);
  if (!st.ok) {
    return st.code === "ENOENT" ? [] : failed(st.code);
  }
  if (st.value.isSymbolicLink()) {
    return failed("EPERM");
  }
  if (!st.value.isDirectory()) {
    return failed("ENOTDIR");
  }
  const opened = attempt(() => fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW));
  if (!opened.ok) {
    return failed(opened.code);
  }
  const bfd = opened.value;
  try {
    const held = fstat(bfd);
    if (!held.ok) {
      return [systemError(held.code, "sweep", path)];
    }
    if (!isOurDir(held.value) || (modeBits(held.value) & 0o022) !== 0 || !sameId(held.value, st.value)) {
      return failed("EPERM");
    }
    const b: HeldDir = { real, at: w.cfg.os === "linux" ? procAt(w.cfg.proc, bfd, held.value) : null };
    const names = attempt(() => fs.readdirSync(entry(b, "."), { encoding: "utf8" }));
    if (!names.ok) {
      return [systemError(names.code, "sweep", path)];
    }
    const errors: Error[] = [];
    for (const n of names.value) {
      const code = sweepD(w, b, n);
      if (code !== null) {
        errors.push(systemError(code, "sweep", joinUnder(real, n)));
      }
    }
    return errors;
  } finally {
    closeQuietly(bfd);
  }
}

/**
 * Removes the entry name of B when it is a D whose process has ended
 * (SPEC-routes "D と E"): named as a D is, a directory of ours, on which an
 * exclusive lock can be taken at once (a live process holds a shared one),
 * still named name once locked, and holding nothing but symlinks. The
 * symlinks go, then D. Anything else is left alone. The errno of a dead D
 * that could not be removed; null otherwise.
 */
function sweepD(w: World, b: HeldDir, name: string): string | null {
  if (!isRandomName(name)) {
    return null;
  }
  const at = entry(b, name);
  const st = lstat(at);
  if (!st.ok || !isOurDir(st.value)) {
    return null;
  }
  const locked = openLocked(at, w.cfg.lock, "exclusive");
  if (!locked.ok) {
    return null;
  }
  const dfd = locked.fd;
  try {
    const held = fstat(dfd);
    const now = lstat(at);
    if (!held.ok || !isOurDir(held.value) || !now.ok || !sameId(now.value, held.value)) {
      return null;
    }
    const d: HeldDir = { real: joinUnder(b.real, name), at: w.cfg.os === "linux" ? procAt(w.cfg.proc, dfd, held.value) : null };
    const entries = attempt(() => fs.readdirSync(entry(d, "."), { encoding: "utf8" }));
    if (!entries.ok) {
      return entries.code;
    }
    for (const e of entries.value) {
      const est = lstat(entry(d, e));
      if (!est.ok || !est.value.isSymbolicLink()) {
        return null;
      }
    }
    for (const e of entries.value) {
      const r = attempt(() => fs.unlinkSync(entry(d, e)));
      if (!r.ok && r.code !== "ENOENT") {
        return r.code;
      }
    }
    const r = attempt(() => fs.rmdirSync(at));
    if (!r.ok && r.code !== "ENOENT" && r.code !== "ENOTEMPTY" && r.code !== "EEXIST") {
      return r.code;
    }
    return null;
  } finally {
    closeQuietly(dfd);
  }
}
