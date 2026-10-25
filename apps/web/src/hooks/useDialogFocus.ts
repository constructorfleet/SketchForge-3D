"use client";

import { useLayoutEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(container: HTMLElement) {
  const regions = [container, ...document.querySelectorAll<HTMLElement>("[data-dialog-focus-portal]")];
  return regions.flatMap((region) => Array.from(region.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))).filter((element) => {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0;
  });
}

export function useDialogFocus<T extends HTMLElement>({
  active = true,
  trapFocus = true,
  restoreFocus = true,
  onEscape,
}: {
  active?: boolean;
  trapFocus?: boolean;
  restoreFocus?: boolean;
  onEscape?: () => void;
} = {}) {
  const dialogRef = useRef<T>(null);
  const onEscapeRef = useRef(onEscape);

  useLayoutEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useLayoutEffect(() => {
    if (!active) return;
    const container = dialogRef.current;
    if (!container) return;

    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initialTarget = container.querySelector<HTMLElement>("[data-dialog-initial-focus]")
      ?? focusableElements(container)[0]
      ?? container;
    initialTarget.focus({ preventScroll: true });

    const handleKeyDown = (event: KeyboardEvent) => {
      const portals = Array.from(document.querySelectorAll<HTMLElement>("[data-dialog-focus-portal]"));
      const isInside = (target: EventTarget | null) => target instanceof Node
        && (container.contains(target) || portals.some((portal) => portal.contains(target)));
      if (event.key === "Escape" && isInside(event.target) && !event.defaultPrevented && onEscapeRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab" || !trapFocus) return;

      const focusables = focusableElements(container);
      if (focusables.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;
      const inContainer = current instanceof Node && container.contains(current);
      const containerFocusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
        const style = window.getComputedStyle(element);
        return !element.hidden && element.getAttribute("aria-hidden") !== "true" && style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0;
      });
      const portalFocusables = focusables.filter((element) => portals.some((portal) => portal.contains(element)));
      if (!event.shiftKey && inContainer && portalFocusables.length > 0 && current === containerFocusables.at(-1)) {
        event.preventDefault();
        portalFocusables[0].focus();
        return;
      }
      if (event.shiftKey && !inContainer && portalFocusables.length > 0 && current === portalFocusables[0]) {
        event.preventDefault();
        (containerFocusables.at(-1) ?? first).focus();
        return;
      }
      if (event.shiftKey && (current === first || !isInside(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !isInside(current))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [active, restoreFocus, trapFocus]);

  return dialogRef;
}
