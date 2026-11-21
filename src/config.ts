import { randomName } from "./names.ts";

// The environment the routes read, made explicit so the tests can vary it
// without touching the process environment (SPEC "各実装に求めること").

/** The systems as SPEC groups them ("用語": Linux / Android, Apple's, ...). */
export type Os = "linux" | "darwin" | "freebsd" | "netbsd" | "openbsd" | "illumos" | "other";

/** The runtime whose standard the spellings go to. */
export type Runtime = "node" | "bun";

/** Whether bind(2) follows a symlink in the last component (SPEC "bind の順"). */
export type Follows = "yes" | "no" | "unknown";

/**
 * How D is locked (DR-0002 "D のロック"): opening it O_SHLOCK / O_EXLOCK
 * (the BSDs and Apple's), flock(1) on an fd handed to it (Linux), or no way
 * (then D cannot be made).
 */
export type LockMethod = { readonly kind: "bsd" } | { readonly kind: "flock-command"; readonly command: string } | { readonly kind: "none" };

export interface Config {
  readonly os: Os;
  /**
   * The longest path handed to the standard as it is (DR-0003), and so the
   * longest spelling a route may hand to it.
   */
  readonly standardLength: number;
  /**
   * The longest spelling a route hands to the kernel: sun_path less the NUL
   * (SPEC "sockaddr に入る長さ": 107 on Linux and illumos, 103 elsewhere),
   * whatever the standard would take.
   */
  readonly spellingLength: number;
  /** The first place for B (SPEC-routes "実体の置き場"): /tmp. */
  readonly tmp: string;
  /** Reads $XDG_RUNTIME_DIR and $TMPDIR at each call. */
  readonly getenv: (name: string) => string | undefined;
  /** Where the kernel's /proc is ("" for none: the routes through it are not tried). */
  readonly proc: string;
  /** The directories a systemd PrivateTmp replaces (Spelling's usableWithPrivateTmp). */
  readonly privateTmps: readonly string[];
  readonly bindFollows: Follows;
  /** Random names of D, of the default connect's E and of a B fallen back to. */
  readonly random: () => string;
  readonly lock: LockMethod;
}

/** The system this process runs on, as SPEC groups them. */
export function currentOs(): Os {
  switch (process.platform) {
    case "linux":
    case "android":
      return "linux";
    case "darwin":
    case "freebsd":
    case "netbsd":
    case "openbsd":
      return process.platform;
    case "sunos":
      return "illumos";
    default:
      return "other";
  }
}

export function currentRuntime(): Runtime {
  return typeof process.versions["bun"] === "string" ? "bun" : "node";
}

/**
 * The standard length (DR-0003): on Linux what the runtime hands to the
 * kernel unchanged in a sockaddr it does not widen (Node 108, Bun 107),
 * elsewhere sun_path less the NUL (103 on Apple's and the BSDs, 107 on
 * illumos).
 *
 * Design rationale: a system SPEC does not name gets 103, the shortest
 * sun_path less the NUL among the systems measured: a path the standard
 * might cut short or widen is better taken by the routes.
 */
export function standardLength(os: Os, runtime: Runtime): number {
  switch (os) {
    case "linux":
      return runtime === "bun" ? 107 : 108;
    case "illumos":
      return 107;
    default:
      return 103;
  }
}

/**
 * sun_path less the NUL (SPEC "sockaddr に入る長さ"). A system SPEC does not
 * name gets 103, as for the standard length.
 */
export function sockaddrLength(os: Os): number {
  return os === "linux" || os === "illumos" ? 107 : 103;
}

/** The systems' table of whether bind(2) follows a symlink (SPEC "bind の順"). */
export function bindFollowsOn(os: Os): Follows {
  switch (os) {
    case "darwin":
    case "netbsd":
      return "yes";
    case "linux":
    case "freebsd":
    case "openbsd":
    case "illumos":
      return "no";
    default:
      return "unknown";
  }
}

/** The systems' way of locking D (DR-0002). */
export function lockMethodOn(os: Os): LockMethod {
  switch (os) {
    case "darwin":
    case "freebsd":
    case "netbsd":
    case "openbsd":
      return { kind: "bsd" };
    case "linux":
      return { kind: "flock-command", command: "flock" };
    default:
      return { kind: "none" };
  }
}

/** The configuration of this process's environment. */
export function envConfig(): Config {
  const os = currentOs();
  return {
    os,
    standardLength: standardLength(os, currentRuntime()),
    spellingLength: sockaddrLength(os),
    tmp: "/tmp",
    getenv: (name) => process.env[name],
    proc: os === "linux" ? "/proc" : "",
    privateTmps: ["/tmp", "/var/tmp"],
    bindFollows: bindFollowsOn(os),
    random: randomName,
    lock: lockMethodOn(os),
  };
}
