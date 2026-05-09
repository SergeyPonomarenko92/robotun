import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Tailwind 4 + custom @theme tokens require us to teach tailwind-merge which
 * `text-*` values are font-sizes vs text-colors — otherwise it collapses
 * `text-paper text-body` to just `text-body` and the button loses its color.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        { text: ["micro", "caption", "body", "body-lg", "h3", "h2", "h1", "display"] },
      ],
      "text-color": [
        {
          text: [
            "canvas",
            "paper",
            "elevated",
            "ink",
            "ink-soft",
            "muted",
            "muted-soft",
            "hairline",
            "hairline-strong",
            "accent",
            "accent-hover",
            "accent-soft",
            "success",
            "success-soft",
            "warning",
            "warning-soft",
            "danger",
            "danger-soft",
            "info",
            "info-soft",
          ],
        },
      ],
      "bg-color": [
        {
          bg: [
            "canvas",
            "paper",
            "elevated",
            "ink",
            "ink-soft",
            "muted",
            "muted-soft",
            "hairline",
            "hairline-strong",
            "accent",
            "accent-hover",
            "accent-soft",
            "success",
            "success-soft",
            "warning",
            "warning-soft",
            "danger",
            "danger-soft",
            "info",
            "info-soft",
          ],
        },
      ],
      "border-color": [
        {
          border: [
            "canvas",
            "paper",
            "elevated",
            "ink",
            "ink-soft",
            "muted",
            "muted-soft",
            "hairline",
            "hairline-strong",
            "accent",
            "accent-hover",
            "accent-soft",
            "success",
            "success-soft",
            "warning",
            "warning-soft",
            "danger",
            "danger-soft",
            "info",
            "info-soft",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
