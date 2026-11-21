import type { Skip } from "./errors.ts";

// The public types (DR-0001), shared by `@kawaz/sockat` and `@kawaz/sockat/bun`.

export type { Skip } from "./errors.ts";

/** What the `*Ex` functions and the resolves take besides the path. */
export interface Options {
  /**
   * Ask for a spelling a peer of another uid can follow: a B where B and
   * every directory on the way to it let others search them, and no /proc
   * spelling. Only the binds look at it. Whether it was met shows in the
   * result's `spelling`.
   */
  readonly usableCrossUid?: boolean;
  /**
   * The path of B itself (a place the application manages, such as
   * `/tmp/app-1000/sockat`): B is made there instead of in /tmp,
   * $XDG_RUNTIME_DIR or $TMPDIR, and a check that fails is an error rather
   * than a fall back to those places. Absolute, ending with a name.
   */
  readonly base?: string;
}

/**
 * What the spelling of a bind is good for afterwards: the spelling the
 * kernel keeps for the socket, which code may later unlink or look up.
 * Branch on it rather than on the diagnostics.
 */
export type Spelling =
  /** The path itself, absolute. */
  | { readonly kind: "Original" }
  /** The path itself, relative: after a change of the cwd it names another place. */
  | { readonly kind: "CwdRelative" }
  /** Through B, D and E, naming the same place as the path. */
  | {
      readonly kind: "Linked";
      /** Unlinking the spelling removes the socket file (false: it removes the E only). */
      readonly removable: boolean;
      /** How long the spelling can be followed: until the process ends, or until the cleanup. */
      readonly until: "Process" | "Cleanup";
      /** A peer of another uid can follow it. */
      readonly usableCrossUid: boolean;
      /** A peer can follow it even when either side has a /tmp of its own (systemd's PrivateTmp). */
      readonly usableWithPrivateTmp: boolean;
    }
  /** Through an E already removed: it names nothing. */
  | { readonly kind: "Dangling" };

/** Removes a bound socket file, and the E its spelling goes through. */
export interface SocketFile {
  /**
   * Removes the socket file, only while its path still names the file bound
   * (the same (st_dev, st_ino)), then does what `cleanup` does. It does not
   * close the listener. Call it before closing the listener.
   */
  remove(): void;
  /** Removes the E the spelling goes through (B and D stay). Do not use the spelling afterwards. */
  cleanup(): void;
}

/** What a bind reports besides the listener (SPEC `Bound`). */
export interface Bound<S> {
  readonly socket: S;
  readonly file: SocketFile;
  readonly spelling: Spelling;
  /** The route taken. For diagnostics: not a promise. */
  readonly route: string;
  /** Which B the spelling goes through (`proc`, `tmp`, `runtime`, `tmpdir`, `sockdir`, `given`); null for none. */
  readonly base: string | null;
  /** The routes found unusable before `route`, in the order tried. */
  readonly skipped: Skip[];
}

/** What a connect reports besides the socket (SPEC `Connected`). */
export interface Connected<S> {
  readonly socket: S;
  readonly route: string;
  readonly skipped: Skip[];
}

/** A spelling of a path to bind by yourself (SPEC `ForBind`). */
export interface ForBind {
  /** The spelling to hand to the standard in place of the path. */
  readonly path: string;
  readonly spelling: Spelling;
  readonly route: string;
  readonly base: string | null;
  readonly skipped: Skip[];
  /** Removes the E the spelling goes through. */
  cleanup(): void;
  /** Call after binding `path` yourself (and before closing it): records the socket file for its removal. */
  socketFile(): SocketFile;
}

/** A spelling of a path to connect to by yourself (SPEC `ForConnect`). */
export interface ForConnect {
  /** The spelling to hand to the standard in place of the path, as many times as you like. */
  readonly path: string;
  readonly route: string;
  readonly skipped: Skip[];
  /** Removes the E the spelling goes through. */
  cleanup(): void;
}
