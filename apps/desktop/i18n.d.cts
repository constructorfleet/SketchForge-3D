/** Types for i18n.cjs, which the desktop main process loads as plain CommonJS. */

export type DesktopTranslationParams = Record<string, string | number>;

export type DesktopI18n = {
  /** The locale currently in use. */
  getLocale: () => string;
  /** Pick the best supported locale for an ordered list of OS languages. */
  resolveLocale: (languages: readonly string[]) => string;
  /** Switch locale; false when the code is not supported. */
  setLocale: (code: unknown) => boolean;
  /** The supported locale a code maps to, or null. */
  supportedLocale: (code: unknown) => string | null;
  /** Translate a key in the current locale, falling back to English. */
  t: (key: string, params?: DesktopTranslationParams) => string;
};

declare const desktopI18n: {
  createDesktopI18n: (loadMessages?: (locale: string) => unknown) => DesktopI18n;
};

export = desktopI18n;
