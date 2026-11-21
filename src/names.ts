import { randomBytes } from "node:crypto";
import { errnoCode } from "./errors.ts";

// Random names: of D, of the default connect's E, and of a B in the socket's directory
// (SPEC-routes "D と E").

/** The length of a random name. */
export const randomLength = 10;

/** How many names createAt tries before giving up. */
export const nameAttempts = 16;

/** The characters of a random name: letters and digits (62 kinds). */
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** The largest multiple of 62 a byte can hold: bytes from it up are drawn again. */
const unbiasedLimit = 256 - (256 % alphabet.length);

/**
 * randomLength letters and digits from the system's secure generator, each
 * character equally likely (a byte of 248 or more is drawn again, so no
 * character is favoured by 256 not being a multiple of 62).
 */
export function randomName(): string {
  let name = "";
  while (name.length < randomLength) {
    for (const b of randomBytes(randomLength)) {
      if (b < unbiasedLimit && name.length < randomLength) {
        name += alphabet.charAt(b % alphabet.length);
      }
    }
  }
  return name;
}

/** Whether name has the form randomName gives: what a D's name looks like. */
export function isRandomName(name: string): boolean {
  return name.length === randomLength && [...name].every((c) => alphabet.includes(c));
}

/**
 * Calls create with names from next until one is not taken (EEXIST),
 * nameAttempts at most, and returns the name created. mkdir and symlink fail
 * with EEXIST rather than reuse an entry, so what is created is always new.
 * Any other error of create is thrown; running out of names throws EEXIST's.
 */
export function createAt(next: () => string, create: (name: string) => void): string {
  let last: unknown;
  for (let i = 0; i < nameAttempts; i++) {
    const name = next();
    try {
      create(name);
      return name;
    } catch (e) {
      if (errnoCode(e) !== "EEXIST") {
        throw e;
      }
      last = e;
    }
  }
  throw last;
}
