export type FlexiErrorKind =
  | "auth" // could not obtain/refresh a token
  | "http" // non-2xx from Flexischools
  | "schema" // response did not match what we expect (API drift)
  | "not_found" // student/service/item/date not found
  | "precondition" // refused before sending (e.g. item out of stock, cutoff passed)
  | "outcome_unknown"; // a write was sent but its result could not be confirmed: it MAY have happened, never retry blindly

export class FlexiError extends Error {
  readonly kind: FlexiErrorKind;
  readonly status: number | undefined;

  constructor(kind: FlexiErrorKind, message: string, status?: number) {
    super(message);
    this.name = "FlexiError";
    this.kind = kind;
    this.status = status;
  }
}
