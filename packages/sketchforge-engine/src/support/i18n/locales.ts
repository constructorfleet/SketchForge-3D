export type Locale = string;
export type MessageKey = string;
export type MessageParams = Record<string, string | number>;
export const LOCALES = ["en"] as const;
export const DEFAULT_LOCALE = "en";
export function isLocale(value: string): value is Locale { return LOCALES.includes(value as "en"); }
