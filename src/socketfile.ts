import fs from "node:fs";
import { systemError } from "./errors.ts";
import { attempt, type FileId, lstat, sameId } from "./fsx.ts";
import type { SocketFile } from "./types.ts";
import { type Link, removeLink } from "./world.ts";

// The cleanup of a spelling's E and the removal of a bound socket file (SPEC
// "remove と cleanup").

/**
 * Cleans up the E of a spelling (null for none) for every holder of it: the
 * SocketFile of bindEx, and the ForBind (and the SocketFiles it gives) or
 * ForConnect of a resolve. After a success it does nothing; after a failure
 * the next call tries again. JavaScript runs one call at a time, so two
 * calls never remove at once.
 */
export class Cleaner {
  readonly link: Link | null;
  /** The caller's path, for the errors. */
  readonly path: string;
  private done = false;

  constructor(link: Link | null, path: string) {
    this.link = link;
    this.path = path;
  }

  cleanup(): void {
    if (this.done || this.link === null) {
      return;
    }
    const r = removeLink(this.link);
    if (!r.ok) {
      throw systemError(r.code, "unlink", this.path, "the symlink the spelling goes through");
    }
    this.done = true;
  }
}

/** A bound socket file, recorded right after the bind (its real path and (st_dev, st_ino)), and its spelling's cleanup. */
export class RecordedSocketFile implements SocketFile {
  /** The socket file's real path; null for none (an abstract name). */
  private readonly file: string | null;
  private readonly id: FileId | null;
  private readonly cleaner: Cleaner;
  private removed = false;

  constructor(file: { file: string; id: FileId } | null, cleaner: Cleaner) {
    this.file = file === null ? null : file.file;
    this.id = file === null ? null : file.id;
    this.cleaner = cleaner;
  }

  /**
   * Removes the socket file while its path still names the file bound, then
   * cleans up (both are done; the file's error is thrown first, then the
   * cleanup's). A file gone, or replaced, is left alone without an error.
   */
  remove(): void {
    let fileError: Error | null = null;
    if (!this.removed) {
      fileError = this.removeFile();
      if (fileError === null) {
        this.removed = true;
      }
    }
    try {
      this.cleaner.cleanup();
    } catch (e) {
      if (fileError === null) {
        throw e;
      }
    }
    if (fileError !== null) {
      throw fileError;
    }
  }

  cleanup(): void {
    this.cleaner.cleanup();
  }

  private removeFile(): Error | null {
    if (this.file === null || this.id === null) {
      return null;
    }
    const file = this.file;
    const st = lstat(file);
    if (!st.ok) {
      // Gone (or a component no longer a directory): nothing to remove. Any
      // other failure leaves it unknown whether it is the file bound.
      return st.code === "ENOENT" || st.code === "ENOTDIR" ? null : systemError(st.code, "lstat", this.cleaner.path);
    }
    if (!sameId({ dev: st.value.dev, ino: st.value.ino }, this.id)) {
      return null;
    }
    const r = attempt(() => fs.unlinkSync(file));
    return r.ok || r.code === "ENOENT" ? null : systemError(r.code, "unlink", this.cleaner.path);
  }
}
