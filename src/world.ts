import fs from "node:fs";
import type { Config } from "./config.ts";
import { envConfig } from "./config.ts";
import { type CallSite, systemError, Unusable } from "./errors.ts";
import {
  attempt,
  closeQuietly,
  dirOpenFlags,
  entry,
  euid,
  type FileId,
  fstat,
  fstatId,
  type HeldDir,
  isOurDir,
  lstat,
  lstatId,
  modeBits,
  oPath,
  procAt,
  realDir,
  type Result,
  sameId,
} from "./fsx.ts";
import { openLocked } from "./lock.ts";
import { createAt, nameAttempts } from "./names.ts";
import { isAbs, joinUnder, sameComponents, splitPath, below } from "./paths.ts";

// B, the directory in a place that a user's processes share, and D and E in
// it (SPEC-routes "B の作り方", "実体の置き場", "別の uid と PrivateTmp",
// "D と E"), and the world: what a process keeps of them across calls.

/** The kinds of B, which are also the diagnostics' base values for a real-path spelling. */
export type BaseKind = "tmp" | "runtime" | "tmpdir" | "sockdir" | "given";

/** A D: held open with a shared lock for the life of the process (never closed). */
export interface ProcD extends HeldDir {
  readonly fd: number;
  readonly name: string;
  readonly id: FileId;
}

/** A B the world holds, by its fd (never closed). */
export interface Base extends HeldDir {
  readonly fd: number;
  readonly id: FileId;
  readonly kind: BaseKind;
  /** Every directory on the way to B lets others search it (mode & 0o001), as seen when B was first held. */
  readonly ancestorsX: boolean;
  /**
   * B itself lets others search it. Remembered when true; when false it is
   * looked at again (crossOf), since a process making B at the same time may
   * have opened it between its mkdir (0700) and its chmod (0711).
   */
  selfX: boolean;
  /** The place before its real path was resolved, or B's real path, goes through a private /tmp's directory. */
  readonly tmpPath: boolean;
  /** This process's D in B, made at most once (ownD). */
  d: ProcD | null;
  /** The name of the next resolve E (base 36). */
  nextE: number;
}

/** An E this process made in its D of a B. */
export interface Link {
  readonly base: Base;
  readonly d: ProcD;
  readonly name: string;
}

/** Somewhere B may be made: its kind and its path as configured. */
interface Place {
  readonly kind: BaseKind;
  readonly path: string;
}

/**
 * Whether a spelling through a B of the kind, whose real path is real,
 * can fit: the estimate before B is made (no B is made where it cannot).
 */
export type Fits = (kind: BaseKind, real: string) => boolean;

/** A directory of ours made or opened, or why not (notOurs: the check of B failed). */
type Made = Result<number> | { readonly ok: false; readonly code: "notOurs" };

const spellingTooLong = new Unusable("spelling too long");
const noBase = new Unusable("no base");

/** The fd-free key of a (st_dev, st_ino). */
function key(id: FileId): string {
  return `${id.dev}:${id.ino}`;
}

/** D as a directory held, through which its E are named. */
export function dHeld(b: Base, d: ProcD): HeldDir {
  return { real: joinUnder(b.real, d.name), at: d.at };
}

/** E's real path, for nothing but its removal's error. */
export function linkEntry(e: Link): string {
  return entry(dHeld(e.base, e.d), e.name);
}

/** Unlinks E; a missing E is no error (removed already). */
export function removeLink(e: Link): Result<void> {
  const r = attempt(() => fs.unlinkSync(linkEntry(e)));
  return r.ok || r.code === "ENOENT" ? { ok: true, value: undefined } : r;
}

/**
 * Whether the directory fd, of (st_dev, st_ino) id, was removed: st_nlink 0,
 * or its name (looked up by lookup, not following a symlink) gone or naming
 * something else. The name is looked up even when st_nlink is not 0: a
 * removed directory keeps st_nlink 2 on macOS (APFS).
 */
function dirGone(fd: number, id: FileId, lookup: () => FileId | null): boolean {
  const st = fstat(fd);
  if (!st.ok || st.value.nlink === 0n) {
    return true;
  }
  const now = lookup();
  return now === null || !sameId(now, id);
}

/**
 * Checks every directory from the root down to real, a real path
 * (SPEC-routes "B の作り方" step 2): each is owned by root or the effective
 * uid, and others cannot write to it (group included) unless it is sticky.
 * With otherX, each must also let others search it. null when all pass;
 * otherwise the failing path and EPERM, or the lstat's errno.
 */
export function checkAncestors(real: string, otherX: boolean): { code: string; path: string } | null {
  const us = BigInt(euid());
  let p = "";
  for (const c of real.split("/")) {
    if (p === "" && c === "") {
      p = "/";
    } else if (c === "") {
      continue;
    } else {
      p = p === "/" ? `/${c}` : `${p}/${c}`;
    }
    const st = lstat(p);
    if (!st.ok) {
      return { code: st.code, path: p };
    }
    const mode = modeBits(st.value);
    let ok = st.value.isDirectory() && (st.value.uid === 0n || st.value.uid === us) && ((mode & 0o022) === 0 || (mode & 0o1000) !== 0);
    if (ok && otherX) {
      ok = (mode & 0o001) !== 0;
    }
    if (!ok) {
      return { code: "EPERM", path: p };
    }
  }
  return null;
}

/** The form of Options.base (SPEC "エラー"): absolute and ending with a name. */
export function givenShapeOk(b: string): boolean {
  return isAbs(b) && splitPath(b) !== null;
}

/**
 * What a process keeps across calls: the B it made, each held by its fd, and
 * the places whose ancestors passed their check. A B that could be made is
 * kept and used by every later call; one that could not is not remembered.
 */
export class World {
  readonly cfg: Config;
  /** The B of the places 1 to 3 (/tmp, $XDG_RUNTIME_DIR, $TMPDIR). */
  auto: Base | null = null;
  /** The B of a usableCrossUid bind; auto itself when it is such a B. */
  autoCross: Base | null = null;
  /** The B of the place 4, per socket's directory. */
  readonly sockdir = new Map<string, Base>();
  /** The B of Options.base, by its (st_dev, st_ino). */
  readonly given = new Map<string, Base>();
  /** The real paths of the places whose ancestors passed the check (once per process). */
  readonly checked = new Set<string>();

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  /** Every B the world holds, each once. */
  bases(): Base[] {
    return [...new Set([this.auto, this.autoCross, ...this.sockdir.values(), ...this.given.values()])].filter((b) => b !== null);
  }

  /** The places 1 to 3 in order; the last two only when set to an absolute path. */
  autoPlaces(): Place[] {
    const ps: Place[] = [{ kind: "tmp", path: this.cfg.tmp }];
    const xdg = this.cfg.getenv("XDG_RUNTIME_DIR");
    if (xdg !== undefined && isAbs(xdg)) {
      ps.push({ kind: "runtime", path: xdg });
    }
    const tmpdir = this.cfg.getenv("TMPDIR");
    if (tmpdir !== undefined && isAbs(tmpdir)) {
      ps.push({ kind: "tmpdir", path: tmpdir });
    }
    return ps;
  }

  /**
   * The world's B of the places 1 to 3 (cross: one others can follow): the
   * first place in order where B is or can be made, whatever the length of
   * the path, so every process of the user finds its B in the same place.
   * Before B is made there, fits estimates the spelling through it: where it
   * cannot fit, nothing is made and the next place is not tried.
   */
  autoBase(cross: boolean, fits: Fits): Base | Unusable {
    this.dropGoneAuto();
    if (!cross && this.auto !== null) {
      return this.auto;
    }
    if (cross) {
      if (this.autoCross !== null) {
        return this.autoCross;
      }
      if (this.auto !== null && crossOf(this.auto)) {
        this.autoCross = this.auto;
        return this.auto;
      }
    }
    for (const p of this.autoPlaces()) {
      const real = realDir(p.path);
      if (!real.ok || !this.ancestorsPass(real.value)) {
        continue;
      }
      if (cross && !crossPlace(real.value, bName(p.kind))) {
        continue;
      }
      if (!fits(p.kind, joinUnder(real.value, bName(p.kind)))) {
        return spellingTooLong;
      }
      const made = this.makeBase(p, real.value, false);
      if (!made.ok) {
        continue;
      }
      const b = this.known(made.value);
      if (cross) {
        if (!crossOf(b)) {
          // Not for this call; held only when it is auto already.
          if (b !== this.auto) {
            closeQuietly(b.fd);
          }
          continue;
        }
        this.autoCross = b;
        return b;
      }
      this.auto = b;
      return b;
    }
    return noBase;
  }

  /**
   * Forgets the B of the places 1 to 3 when it was removed, so this call
   * makes B again (an old systemd-tmpfiles, macOS's cleaning of $TMPDIR, or
   * a hand may remove it).
   *
   * Design rationale: the fds of a B (and its D) forgotten are left open,
   * not closed: an E handed out through it (SocketFile's cleanup) is still
   * unlinked through D's fd on Linux, which a closed and reused fd number
   * would point elsewhere.
   */
  private dropGoneAuto(): void {
    if (this.auto !== null && gone(this.auto)) {
      if (this.autoCross === this.auto) {
        this.autoCross = null;
      }
      this.auto = null;
    }
    if (this.autoCross !== null && gone(this.autoCross)) {
      this.autoCross = null;
    }
  }

  /** b, or the B already held at the same (st_dev, st_ino) (b's fd then closed). */
  private known(b: Base): Base {
    for (const k of [this.auto, this.autoCross]) {
      if (k !== null && sameId(k.id, b.id)) {
        closeQuietly(b.fd);
        return k;
      }
    }
    return b;
  }

  /** Whether the directories down to real pass checkAncestors, checked once per process. */
  ancestorsPass(real: string): boolean {
    if (this.checked.has(real)) {
      return true;
    }
    if (checkAncestors(real, false) !== null) {
      return false;
    }
    this.checked.add(real);
    return true;
  }

  /**
   * Checks Options.base before any route is tried, at every call, making
   * nothing (SPEC-routes "B の作り方"): its parent exists (ENOENT) and is a
   * directory (ENOTDIR), every ancestor passes checkAncestors (EPERM), and B
   * itself, when there, is a directory of ours others cannot write to (a
   * symlink is EPERM, anything else ENOTDIR). With cross, every one of them
   * must let others search it (EPERM): looked at now while the world does not
   * hold the B yet, and taken from when it was first held once it does.
   * The form (absolute, ending with a name) was checked before.
   */
  checkGiven(b: string, cross: boolean, site: CallSite): void {
    const fail = (code: string): never => {
      throw systemError(code, site.syscall, site.path, `Options.base ${b}`);
    };
    const parts = splitPath(b);
    if (parts === null) {
      return fail("EINVAL");
    }
    const real = realDir(parts.dir);
    if (!real.ok) {
      return fail(real.code);
    }
    const pst = attempt(() => fs.statSync(real.value, { bigint: true }));
    if (!pst.ok) {
      return fail(pst.code);
    }
    if (!pst.value.isDirectory()) {
      return fail("ENOTDIR");
    }
    const anc = checkAncestors(real.value, false);
    if (anc !== null) {
      return fail(anc.code);
    }
    const st = lstat(joinUnder(real.value, parts.name));
    if (!st.ok) {
      if (st.code !== "ENOENT") {
        return fail(st.code);
      }
      if (cross && checkAncestors(real.value, true) !== null) {
        return fail("EPERM");
      }
      return;
    }
    if (st.value.isSymbolicLink()) {
      return fail("EPERM");
    }
    if (!st.value.isDirectory()) {
      return fail("ENOTDIR");
    }
    if (!isOurDir(st.value) || (modeBits(st.value) & 0o022) !== 0) {
      return fail("EPERM");
    }
    if (!cross) {
      return;
    }
    const held = this.given.get(key({ dev: st.value.dev, ino: st.value.ino }));
    if (held !== undefined) {
      if (!crossOf(held)) {
        fail("EPERM");
      }
      return;
    }
    if ((modeBits(st.value) & 0o001) === 0 || checkAncestors(real.value, true) !== null) {
      fail("EPERM");
    }
  }

  /**
   * The world's B at b (Options.base, checked by checkGiven), made when there
   * is none there yet. Where the spelling is estimated not to fit, nothing is
   * made and the route is unusable. Otherwise an error making or opening it
   * is thrown, with EPERM for what is not a private directory of ours.
   */
  givenBase(b: string, fits: Fits, site: CallSite): Base | Unusable {
    const fail = (code: string): never => {
      throw systemError(code, site.syscall, site.path, `Options.base ${b}`);
    };
    const parts = splitPath(b);
    if (parts === null) {
      return fail("EINVAL");
    }
    const real = realDir(parts.dir);
    if (!real.ok) {
      return fail(real.code);
    }
    const at = joinUnder(real.value, parts.name);
    const id = lstatId(at);
    if (id !== null) {
      const k = this.given.get(key(id));
      if (k !== undefined) {
        if (!gone(k)) {
          return k;
        }
        this.given.delete(key(id));
      }
    }
    if (!fits("given", at)) {
      return spellingTooLong;
    }
    const made = this.makeBase({ kind: "given", path: b }, real.value, true);
    if (!made.ok) {
      return fail(made.code === "notOurs" ? "EPERM" : made.code);
    }
    this.given.set(key(made.value.id), made.value);
    return made.value;
  }

  /**
   * The world's B in the socket's directory (real, its real path; id, its
   * (st_dev, st_ino)), made when there is none yet: the place 4. null when
   * it cannot be made.
   */
  sockdirBase(real: string, id: FileId): Base | null {
    const k = this.sockdir.get(key(id));
    if (k !== undefined) {
      if (!gone(k)) {
        return k;
      }
      this.sockdir.delete(key(id));
    }
    const made = this.makeBase({ kind: "sockdir", path: real }, real, false);
    if (!made.ok) {
      return null;
    }
    this.sockdir.set(key(id), made.value);
    return made.value;
  }

  /**
   * Makes (or opens) B in the place p, whose real path is real (SPEC-routes
   * "B の作り方" steps 2 to 5). B is named sockat-<euid> (sockat under
   * $XDG_RUNTIME_DIR, .sockat.<random> in the socket's directory); one
   * already there that fails the check is passed over for
   * sockat-<euid>.<random>, except for Options.base (given), whose failure is
   * returned.
   */
  private makeBase(p: Place, real: string, given: boolean): Result<Base> | { readonly ok: false; readonly code: "notOurs" } {
    if (!this.ancestorsPass(real)) {
      const anc = checkAncestors(real, false);
      return { ok: false, code: anc === null ? "EPERM" : anc.code };
    }
    const parent = this.holdParent(real);
    if (!parent.ok) {
      return parent;
    }
    try {
      let name: string;
      let made: Made;
      if (p.kind === "sockdir") {
        ({ name, made } = this.makeFresh(parent.value, ".sockat."));
      } else if (given) {
        const parts = splitPath(p.path);
        if (parts === null) {
          return { ok: false, code: "EINVAL" };
        }
        name = parts.name;
        made = makeOrOpen(parent.value, name);
      } else {
        name = bName(p.kind);
        made = makeOrOpen(parent.value, name);
        if (!made.ok && made.code === "notOurs") {
          ({ name, made } = this.makeFresh(parent.value, `sockat-${euid()}.`));
        }
      }
      if (!made.ok) {
        return made;
      }
      const fd = made.value;
      const st = fstat(fd);
      if (!st.ok) {
        closeQuietly(fd);
        return st;
      }
      const id = { dev: st.value.dev, ino: st.value.ino };
      const breal = joinUnder(real, name);
      return {
        ok: true,
        value: {
          fd,
          id,
          real: breal,
          at: this.cfg.os === "linux" ? procAt(this.cfg.proc, fd, id) : null,
          kind: p.kind,
          ancestorsX: checkAncestors(real, true) === null,
          selfX: (modeBits(st.value) & 0o001) !== 0,
          tmpPath: this.throughPrivateTmp(p.path) || this.throughPrivateTmp(breal),
          d: null,
          nextE: 0,
        },
      };
    } finally {
      if (parent.value.fd !== null) {
        closeQuietly(parent.value.fd);
      }
    }
  }

  /**
   * The parent of a B (a checked real path) as a directory held: on Linux
   * with /proc, opened O_PATH and named through /proc/self/fd (as mkdirat(2)
   * on its fd would); otherwise by its real path, which nobody else can
   * replace (its ancestors passed their check).
   */
  private holdParent(real: string): Result<HeldDir & { readonly fd: number | null }> {
    if (this.cfg.os !== "linux" || this.cfg.proc === "") {
      return { ok: true, value: { real, at: null, fd: null } };
    }
    const r = attempt(() => fs.openSync(real, oPath | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW));
    if (!r.ok) {
      return r;
    }
    const id = fstatId(r.value);
    return { ok: true, value: { real, at: id === null ? null : procAt(this.cfg.proc, r.value, id), fd: r.value } };
  }

  /** Makes a directory named prefix + random characters in parent, as openMade does. */
  private makeFresh(parent: HeldDir, prefix: string): { name: string; made: Made } {
    const r = attempt(() => createAt(this.cfg.random, (n) => fs.mkdirSync(entry(parent, prefix + n), 0o700)));
    if (!r.ok) {
      return { name: "", made: r };
    }
    const name = prefix + r.value;
    return { name, made: openMade(parent, name) };
  }

  /**
   * Whether p goes through a directory a private /tmp replaces: component by
   * component one of cfg.privateTmps or below it, or below its real path.
   */
  throughPrivateTmp(p: string): boolean {
    for (const t of this.cfg.privateTmps) {
      if (sameComponents(p, t) || below(p, t) !== null) {
        return true;
      }
      const real = realDir(t);
      if (real.ok && (sameComponents(p, real.value) || below(p, real.value) !== null)) {
        return true;
      }
    }
    return false;
  }

  /**
   * The process's D in b, made the first time and made again when the D held
   * was removed (its fd left open, as a forgotten B's). null when it cannot
   * be made (not remembered: the next call tries again).
   */
  ownD(b: Base): ProcD | null {
    if (b.d !== null) {
      const d = b.d;
      if (!dirGone(d.fd, d.id, () => lstatId(entry(b, d.name)))) {
        return d;
      }
      b.d = null;
    }
    for (let i = 0; i < nameAttempts; i++) {
      const d = this.makeOwnD(b);
      if (d === "takenAway") {
        continue;
      }
      b.d = d;
      return d;
    }
    return null;
  }

  /**
   * Makes a D in b (SPEC-routes "D と E" steps 1 to 4): mkdir 0700 under a
   * random name, set to 0711, opened without following a symlink with a
   * shared lock taken (openLocked) and checked to be a directory of ours, and
   * its name looked up again. A D taken away before it was locked (another
   * process's sweep saw it unlocked: the chmod or the open finds nothing,
   * the lock is busy, or the name names another) is "takenAway", and the
   * next name is tried; what this call made of it is removed first.
   */
  private makeOwnD(b: Base): ProcD | null | "takenAway" {
    const r = attempt(() => createAt(this.cfg.random, (n) => fs.mkdirSync(entry(b, n), 0o700)));
    if (!r.ok) {
      return null;
    }
    const name = r.value;
    const at = entry(b, name);
    const drop = (): void => {
      const st = lstat(at);
      if (st.ok && isOurDir(st.value)) {
        attempt(() => fs.rmdirSync(at));
      }
    };
    const ch = attempt(() => fs.chmodSync(at, 0o711));
    if (!ch.ok) {
      drop();
      return ch.code === "ENOENT" ? "takenAway" : null;
    }
    const locked = openLocked(at, this.cfg.lock, "shared");
    if (!locked.ok) {
      // An empty D of ours is removed either way: a lock that keeps being
      // busy (flock(1) failing otherwise than on a conflict) must not leave
      // one behind per name tried.
      drop();
      return locked.why === "busy" || locked.code === "ENOENT" ? "takenAway" : null;
    }
    const fd = locked.fd;
    const held = fstat(fd);
    if (!held.ok || !isOurDir(held.value)) {
      closeQuietly(fd);
      return null;
    }
    const id = { dev: held.value.dev, ino: held.value.ino };
    const now = lstatId(at);
    if (now === null || !sameId(now, id)) {
      closeQuietly(fd);
      return "takenAway";
    }
    return { fd, name, id, real: joinUnder(b.real, name), at: this.cfg.os === "linux" ? procAt(this.cfg.proc, fd, id) : null };
  }

  /**
   * Makes a resolve E in d (b's D) pointing to target, named by b's counter
   * in base 36 (D is this process's alone, so a short counter is unique). A
   * name taken is passed over for the next. null when none could be made.
   */
  resolveE(b: Base, d: ProcD, target: string): Link | null {
    for (let i = 0; i < nameAttempts; i++) {
      const name = b.nextE.toString(36);
      b.nextE++;
      const r = attempt(() => fs.symlinkSync(target, entry(dHeld(b, d), name)));
      if (r.ok) {
        return { base: b, d, name };
      }
      if (r.code !== "EEXIST") {
        return null;
      }
    }
    return null;
  }
}

/** The name of B in a place of kind: sockat-<euid>, sockat under $XDG_RUNTIME_DIR. */
export function bName(kind: BaseKind): string {
  return kind === "runtime" ? "sockat" : `sockat-${euid()}`;
}

/**
 * Whether others can follow a real-path spelling through b: every directory
 * on the way and B itself let them search (SPEC-routes "実体の置き場"). B's own
 * mode is looked at again by its fd while it was found without it.
 */
export function crossOf(b: Base): boolean {
  if (!b.selfX) {
    const st = fstat(b.fd);
    b.selfX = st.ok && (modeBits(st.value) & 0o001) !== 0;
  }
  return b.ancestorsX && b.selfX;
}

/** Whether B was removed since it was opened. */
function gone(b: Base): boolean {
  return dirGone(b.fd, b.id, () => lstatId(b.real));
}

/**
 * Whether a B named name in the place real (whose ancestors passed) can be
 * one others can follow, before it is made: every directory down to real
 * lets others search it, and a B of ours already there does too (one that
 * fails B's check is passed over for a fresh B of mode 0711, which does).
 */
function crossPlace(real: string, name: string): boolean {
  if (checkAncestors(real, true) !== null) {
    return false;
  }
  const st = lstat(joinUnder(real, name));
  if (!st.ok || !isOurDir(st.value) || (modeBits(st.value) & 0o022) !== 0) {
    return true;
  }
  return (modeBits(st.value) & 0o001) !== 0;
}

/**
 * Makes B named name in parent, or opens the one there (SPEC-routes "B の作り方"
 * steps 3 to 5): mkdir 0700, then openMade. One already there is used when
 * it is a directory owned by us that others cannot write to, whatever its
 * mode otherwise (left as it is); notOurs when it is not.
 */
function makeOrOpen(parent: HeldDir, name: string): Made {
  const at = entry(parent, name);
  const mk = attempt(() => fs.mkdirSync(at, 0o700));
  if (mk.ok) {
    return openMade(parent, name);
  }
  if (mk.code !== "EEXIST") {
    return mk;
  }
  const r = attempt(() => fs.openSync(at, dirOpenFlags));
  if (!r.ok) {
    // A symlink (ELOOP), a file (ENOTDIR), ...
    return { ok: false, code: "notOurs" };
  }
  const st = fstat(r.value);
  if (!st.ok || !isOurDir(st.value) || (modeBits(st.value) & 0o022) !== 0 || !sameEntry(parent, at, st.value)) {
    closeQuietly(r.value);
    return { ok: false, code: "notOurs" };
  }
  return r;
}

/**
 * Sets the directory name just made in parent to 0711 by its name (whatever
 * a umask took off is put back), opens it without following a symlink and
 * checks it is a directory owned by us (SPEC-routes "B の作り方" step 4).
 * When the mode cannot be set or the directory cannot be opened, the
 * directory made is removed (when it is still one of ours) and the error
 * returned.
 */
function openMade(parent: HeldDir, name: string): Made {
  const at = entry(parent, name);
  const drop = (): void => {
    const st = lstat(at);
    if (st.ok && isOurDir(st.value)) {
      attempt(() => fs.rmdirSync(at));
    }
  };
  const ch = attempt(() => fs.chmodSync(at, 0o711));
  if (!ch.ok) {
    drop();
    return ch;
  }
  const r = attempt(() => fs.openSync(at, dirOpenFlags));
  if (!r.ok) {
    drop();
    return r;
  }
  const st = fstat(r.value);
  if (!st.ok || !isOurDir(st.value) || !sameEntry(parent, at, st.value)) {
    closeQuietly(r.value);
    return { ok: false, code: "notOurs" };
  }
  return r;
}

/**
 * Whether the entry at (named through parent) is the directory st was taken
 * from. Where parent is named by its real path rather than an fd, this is
 * the check after the fact that stands in for *at (DR-0002): lstat of the
 * name and fstat of the fd opened agree on (st_dev, st_ino).
 */
function sameEntry(parent: HeldDir, at: string, st: fs.BigIntStats): boolean {
  if (parent.at !== null) {
    return true;
  }
  const now = lstatId(at);
  return now !== null && sameId(now, { dev: st.dev, ino: st.ino });
}

let defaultWorldHeld: World | null = null;

/** The process's world: the public API's calls share its B and D. */
export function defaultWorld(): World {
  if (defaultWorldHeld === null) {
    defaultWorldHeld = new World(envConfig());
  }
  return defaultWorldHeld;
}

/**
 * Points the public API at w instead of the process's environment. For the
 * tests only (not exported from the package): they keep the public API away
 * from the real /tmp/sockat-<uid>.
 */
export function setDefaultWorld(w: World): void {
  defaultWorldHeld = w;
}
