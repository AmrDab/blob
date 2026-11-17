// What Blob does differently from one operating system to the next. Each system fills this in, in its own file here;
// nothing outside src/os/ asks which system it is on (test/os-boundary.test.ts). A member that is optional is one
// that some system does not have.

export interface Os {
  /** Node's name for the system (process.platform). */
  id: string;
  /** The name people know it by. */
  name: string;
}
