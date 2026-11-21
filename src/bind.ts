import { type CallSite, NoBase, systemError, type Trace, Unusable } from "./errors.ts";
import fs from "node:fs";
import { attempt, closeQuietly, fstatId, lstat, oPath, sameId, statId } from "./fsx.ts";
import { randomLength } from "./names.ts";
import { byteLength } from "./paths.ts";
import { absTarget, classify, lookUpDir, noNative, type Outcome, type RouteName, routeFailure, type SocketDir, type StandardSpelling } from "./route.ts";
import type { Options, Spelling } from "./types.ts";
import { type Base, crossOf, type Fits, type Link, type ProcD, removeLink, type World } from "./world.ts";

// The bind order of a long path (SPEC "bind の順", DR-0002):
//
//   | system           | order                                         |
//   |------------------|-----------------------------------------------|
//   | Linux, Android   | link-dir (procB, then the real path), thread-cwd (not made) |
//   | Apple's          | link-dir, link-file, thread-cwd (not made)    |
//   | FreeBSD          | link-dir, at (not made)                       |
//   | NetBSD           | link-dir, link-file                           |
//   | OpenBSD, illumos | link-dir                                      |
//   | other Unix       | link-dir, link-file (told at run time)        |
//
// link-dir and link-file leave their spelling (B/D/E/<name>, B/D/E) for as
// long as E is there. A route that cannot be used is passed over (recorded
// in the trace); the first route that binds decides, its failure included,
// except link-file's failure where nothing is at the path (bind(2) did not
// follow the symlink).

/** What a bind produced besides the listener. */
export interface BindResult {
  readonly route: RouteName;
  readonly spelling: Spelling;
  /** The diagnostics' base; null for a spelling through no B. */
  readonly base: string | null;
  /** The E kept for the spelling (link-dir, link-file), which SocketFile cleans up. */
  readonly link: Link | null;
  /** The spelling handed to the standard. */
  readonly spelt: string;
}

/** One bind, or one resolve, of a long path. */
export interface BindCall {
  readonly w: World;
  readonly path: string;
  readonly dir: SocketDir;
  readonly opts: Options;
  readonly site: CallSite;
  /** The B in which D could not be made during this call (not tried again in it). */
  readonly noD: Set<Base>;
}

/** Looks up the socket's directory (lookUpDir) and starts a bind call. */
export function newBindCall(w: World, path: string, opts: Options, site: CallSite): BindCall {
  const dir = lookUpDir(w, path, opts, opts.usableCrossUid === true, site);
  return { w, path, dir, opts, site, noD: new Set() };
}

/** b's D for a route of this call; unusable when it could not be made, for this route and every later one. */
function ownD(c: BindCall, b: Base): ProcD | Unusable {
  if (c.noD.has(b)) {
    return new Unusable("D not made");
  }
  const d = c.w.ownD(b);
  if (d === null) {
    c.noD.add(b);
    return new Unusable("D not made");
  }
  return d;
}

/**
 * The B for a route of this call: Options.base's when given (its errors
 * thrown, except a spelling estimated not to fit); otherwise the world's B of
 * the places 1 to 3 (cross: one others can follow), and, when none of them
 * has or can make one (not for cross), the socket's directory's.
 */
function baseFor(c: BindCall, cross: boolean, fits: Fits): Base | Unusable {
  if (c.opts.base !== undefined) {
    return c.w.givenBase(c.opts.base, fits, c.site);
  }
  const b = c.w.autoBase(cross, fits);
  if (!(b instanceof NoBase)) {
    return b;
  }
  // When a place was taken, the reason says so whatever comes next.
  const taken = b.reason === "no base" ? "" : ` (${b.reason})`;
  if (cross) {
    return new Unusable(`no base others can follow${taken}`);
  }
  if (!fits("sockdir", "")) {
    return new Unusable(`spelling too long${taken}`);
  }
  return c.w.sockdirBase(c.dir.real, c.dir.id) ?? b;
}

/** /proc/<pid>/fd. */
function procFD(w: World): string {
  return `${w.cfg.proc}/${process.pid}/fd`;
}

/**
 * procB, /proc/<pid>/fd/<B's fd>, when /proc can be used for it: a stat of
 * it has B's (st_dev, st_ino) (SPEC-routes "綴りの形").
 */
function procB(w: World, b: Base): string | null {
  if (w.cfg.os !== "linux" || w.cfg.proc === "") {
    return null;
  }
  const p = `${procFD(w)}/${b.fd}`;
  const id = statId(p);
  return id !== null && sameId(id, b.id) ? p : null;
}

/** The shortest procB can be (a one-digit fd), for the estimate before B is opened; null without /proc. */
function procBShortest(w: World): string | null {
  if (w.cfg.os !== "linux" || w.cfg.proc === "") {
    return null;
  }
  // Checked as procB is, with a directory opened for it (B is not open
  // yet): /proc/<pid>/fd/<fd> has its (st_dev, st_ino) (SPEC-routes "綴りの形").
  const r = attempt(() => fs.openSync("/", oPath | fs.constants.O_DIRECTORY));
  if (!r.ok) {
    return null;
  }
  try {
    const id = fstatId(r.value);
    const seen = statId(`${procFD(w)}/${r.value}`);
    return id !== null && seen !== null && sameId(id, seen) ? `${procFD(w)}/0` : null;
  } finally {
    closeQuietly(r.value);
  }
}

/** The length of link-dir's spelling <bspell>/<D>/<E>/<name>. */
function linkDirLen(bspell: string, e: string, name: string): number {
  return byteLength(bspell) + 1 + randomLength + 1 + byteLength(e) + 1 + byteLength(name);
}

/** The length of link-file's spelling <bspell>/<D>/<E>. */
function linkFileLen(bspell: string, e: string): number {
  return byteLength(bspell) + 1 + randomLength + 1 + byteLength(e);
}

/**
 * What a spelling through b is good for: through procB it lasts as long as
 * the process, is followed by the same uid only, and goes through no /tmp;
 * through B's real path it lasts until the cleanup, and b's mode and place
 * decide the rest.
 */
function linkedSpelling(b: Base, viaProc: boolean, removable: boolean): Spelling {
  if (viaProc) {
    return { kind: "Linked", removable, until: "Process", usableCrossUid: false, usableWithPrivateTmp: true };
  }
  return { kind: "Linked", removable, until: "Cleanup", usableCrossUid: crossOf(b), usableWithPrivateTmp: !b.tmpPath };
}

/**
 * The diagnostics' base of a spelling through b: the form of the spelling
 * for a B in a temporary place (procB is "proc", a real path the place's
 * kind), and the B itself otherwise ("sockdir", "given").
 */
function baseValue(b: Base, viaProc: boolean): string {
  if (viaProc && (b.kind === "tmp" || b.kind === "runtime" || b.kind === "tmpdir")) {
    return "proc";
  }
  return b.kind;
}

/** A spelling through a resolve E. */
export interface Linked {
  readonly spelling: string;
  readonly link: Link;
  /**
   * The E was made by this call (removed when its bind fails); false for
   * the default bind's shared E made by an earlier call (kept).
   */
  readonly fresh: boolean;
  /**
   * The E is the default bind's shared one (link-dir): kept when the bind
   * fails, even when this call made it (SPEC-routes "経路の失敗の扱い").
   */
  readonly shared: boolean;
  readonly sp: Spelling;
  readonly base: string;
}

/**
 * Makes the spelling <B>/<D>/<E><rest> of length size(<B>, <E>), E a resolve
 * E in the process's D of the call's B pointing to target. B is spelt by
 * procB when useProc and it fits, otherwise by its real path when B is not in
 * the socket's directory and it fits; unusable when neither does (estimated
 * before B is made, with the shortest procB and E).
 */
function throughB(
  c: BindCall,
  useProc: boolean,
  target: string,
  rest: string,
  removable: boolean,
  size: (bspell: string, e: string) => number,
  share: boolean,
): Linked | Unusable {
  const w = c.w;
  const max = w.cfg.spellingLength;
  const fits: Fits = (kind, breal) => {
    const p = procBShortest(w);
    if (useProc && p !== null && size(p, "0") <= max) {
      return true;
    }
    return kind !== "sockdir" && size(breal, "0") <= max;
  };
  const b = baseFor(c, c.opts.usableCrossUid === true, fits);
  if (b instanceof Unusable) {
    return b;
  }
  // The E the spelling will go through: the default bind's shared one when
  // its D has it already (made again only if it is gone), the next counter
  // otherwise.
  const known = share && b.d !== null ? b.d.shared.get(target) : undefined;
  const e = known ?? b.nextE.toString(36);
  let spell: string | null = null;
  let viaProc = false;
  if (useProc) {
    const p = procB(w, b);
    if (p !== null && size(p, e) <= max) {
      spell = p;
      viaProc = true;
    }
  }
  if (spell === null && b.kind !== "sockdir" && size(b.real, e) <= max) {
    spell = b.real;
  }
  if (spell === null) {
    return new Unusable("spelling too long");
  }
  const d = ownD(c, b);
  if (d instanceof Unusable) {
    return d;
  }
  const kept = share ? w.sharedE(b, d, target) : null;
  const link = kept ?? w.resolveE(b, d, target);
  if (link === null) {
    return new Unusable("E not made");
  }
  const fresh = kept === null;
  if (share && fresh) {
    d.shared.set(target, link.name);
  }
  const spelling = `${spell}/${d.name}/${link.name}${rest}`;
  const ln: Linked = { spelling, link, fresh, shared: share, sp: linkedSpelling(b, viaProc, removable), base: baseValue(b, viaProc) };
  if (byteLength(spelling) > max) {
    // A name taken made the E's name longer than estimated.
    dropFresh(ln);
    return new Unusable("spelling too long");
  }
  return ln;
}

/**
 * Removes the E of ln when this call made it (and forgets it as the shared
 * one); an E shared from an earlier call stays, for the binds through it.
 * A failure to remove it is not reported.
 */
function dropFresh(ln: Linked): void {
  if (!ln.fresh) {
    return;
  }
  removeLink(ln.link);
  for (const [target, name] of ln.link.d.shared) {
    if (name === ln.link.name) {
      ln.link.d.shared.delete(target);
    }
  }
}

/**
 * link-dir's spelling <B>/<D>/<E>/<name>, E a symlink to the socket's
 * directory (its real path), B spelt by procB (Linux with /proc, not for
 * usableCrossUid) or its real path, the first that fits. share is for the
 * default bind, which keeps one E per directory in D and goes through it
 * again (SPEC-routes "link-dir"); the others make an E per call, which their
 * cleanup removes.
 */
export function linkDirSpelling(c: BindCall, share: boolean): Linked | Unusable {
  const useProc = c.w.cfg.os === "linux" && c.opts.usableCrossUid !== true;
  return throughB(c, useProc, c.dir.real, `/${c.dir.name}`, true, (bspell, e) => linkDirLen(bspell, e, c.dir.name), share);
}

/**
 * link-file's spelling <B>/<D>/<E>, E a symlink to target (the socket file),
 * B spelt by procB when useProc (a connect's resolve) or its real path.
 */
export function linkFileSpelling(c: BindCall, target: string, useProc: boolean): Linked | Unusable {
  return throughB(c, useProc, target, "", false, linkFileLen, false);
}

/** The routes of the bind order after standard on this system, with those not made. */
function bindOrder(w: World): RouteName[] {
  const order: RouteName[] = ["link-dir"];
  if (w.cfg.bindFollows !== "no") {
    order.push("link-file");
  }
  switch (w.cfg.os) {
    case "linux":
    case "darwin":
      order.push("thread-cwd");
      break;
    case "freebsd":
      order.push("at");
      break;
    default:
      break;
  }
  return order;
}

/**
 * The bind of path, as the steps the standard takes: yields each spelling to
 * bind (and listen) and gets what the standard did with it. A path the
 * standard takes, and an abstract name, are yielded as they are; their
 * failure is the standard's own error. A long path takes the bind order; a
 * route that bound and failed removes its E and throws the standard's errno
 * with the caller's path. ENAMETOOLONG when no route can be used.
 */
export function* bindSteps(
  w: World,
  path: string,
  opts: Options,
  trace: Trace,
  syscall: string,
  spell: StandardSpelling,
  share: boolean,
): Generator<string, BindResult, Outcome> {
  const site: CallSite = { syscall, path };
  const kind = classify(w, path, opts, spell);
  if (kind.kind !== "long") {
    const o = yield kind.spelt;
    trace.route = "standard";
    if (!o.ok) {
      throw o.error;
    }
    const spelling: Spelling = kind.kind === "short" && !path.startsWith("/") ? { kind: "CwdRelative" } : { kind: "Original" };
    return { route: "standard", spelling, base: null, link: null, spelt: kind.spelt };
  }
  const c = newBindCall(w, path, opts, site);
  trace.skip("standard", "path too long");
  for (const route of bindOrder(w)) {
    let ln: Linked | Unusable;
    let target = "";
    switch (route) {
      case "link-dir":
        ln = linkDirSpelling(c, share);
        break;
      case "link-file": {
        const t = absTarget(path);
        if (t instanceof Unusable) {
          ln = t;
          break;
        }
        target = t;
        ln = linkFileSpelling(c, t, false);
        break;
      }
      default:
        trace.skip(route, noNative);
        continue;
    }
    if (ln instanceof Unusable) {
      trace.skip(route, ln.reason);
      continue;
    }
    const o = yield ln.spelling;
    if (o.ok) {
      trace.route = route;
      return { route, spelling: ln.sp, base: ln.base, link: ln.link, spelt: ln.spelling };
    }
    // The E this call made goes, a failure to remove it not reported (the
    // bind's error is the call's). The default bind's shared E stays, even
    // one this call made: another default bind running alongside may be
    // going through it, and the next one will (no lock is needed for that).
    if (!ln.shared) {
      dropFresh(ln);
    }
    // Where bind(2) is not known to follow a symlink, a failure with nothing
    // at the path is taken for one that did not follow it (SPEC-routes
    // "link-file"). Where it is known to follow, the failure is real
    // (EACCES, ...): no route after link-file here (thread-cwd is not made)
    // would meet it again and return it.
    if (route === "link-file" && w.cfg.bindFollows === "unknown" && !lstat(target).ok) {
      trace.skip(route, "bind did not follow the symlink");
      continue;
    }
    trace.route = route;
    throw routeFailure(o.error, site, ln.spelling);
  }
  throw systemError("ENAMETOOLONG", syscall, path);
}
