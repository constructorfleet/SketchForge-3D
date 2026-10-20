import { createTranslator } from "use-intl/core";
import enMessages from "./locales/en/messages.json" with { type: "json" };
import type { MessageParams } from "./locales.js";

type LeafPaths<T> = { [K in keyof T & string]: T[K] extends string ? K : `${K}.${LeafPaths<T[K]>}` }[keyof T & string];
export type MessageKey = LeafPaths<typeof enMessages>;
export type ErrorKey = Extract<MessageKey, `errors.${string}`>;
const english = createTranslator({ locale: "en", messages: enMessages }) as unknown as (key: string, params?: MessageParams) => string;

export class LocalizedError extends Error {
  readonly key: ErrorKey;
  readonly params?: MessageParams;
  constructor(key: ErrorKey, params?: MessageParams) {
    super(english(key, params));
    this.name = "LocalizedError";
    this.key = key;
    this.params = params;
  }
}
export type LocalizedErrorPayload = { message: string; errorKey?: ErrorKey; errorParams?: MessageParams };
export type ErrorResponseFields = { error: string; errorKey?: ErrorKey; errorParams?: MessageParams };
export function localizedErrorPayload(error: unknown): LocalizedErrorPayload {
  return error instanceof LocalizedError ? { message: error.message, errorKey: error.key, errorParams: error.params } : { message: error instanceof Error ? error.message : String(error) };
}
export function errorFromPayload(payload: LocalizedErrorPayload): Error { return payload.errorKey ? new LocalizedError(payload.errorKey, payload.errorParams) : new Error(payload.message); }
export function errorResponseFields(error: unknown): ErrorResponseFields {
  const value = localizedErrorPayload(error); return { error: value.message, errorKey: value.errorKey, errorParams: value.errorParams };
}
export function errorFromResponse(body: Partial<ErrorResponseFields> | null | undefined): Error | null {
  return body?.error ? errorFromPayload({ message: body.error, errorKey: body.errorKey, errorParams: body.errorParams }) : null;
}
