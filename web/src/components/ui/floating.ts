/**
 * One look for everything that floats above the page: select lists, menus,
 * popovers, the combobox and the command palette. Before this, each wrote its
 * own surface, shadow, radius and item padding, and they drifted (a select
 * list that covered its own field, menus with 4px rows next to popovers with
 * 10px ones).
 *
 * The rules:
 * - A list opens below its trigger (above when there is no room), never over
 *   it, and is at least as wide as it.
 * - Radii are concentric: the surface is `rounded-xl` with a 4px padding, so
 *   its items are `rounded-lg` (14px outside, 10px inside).
 * - One soft shadow and a hairline ring, both lighter than a dialog's.
 * - Opening is short and eased (150ms, a 2% scale, 4px of travel toward the
 *   trigger); closing is quicker (100ms).
 * - Rows are 32px high at least, icons muted until the row is highlighted.
 */

export const floatingSurface =
  "rounded-xl bg-popover text-popover-foreground shadow-lg shadow-black/[0.07] ring-1 ring-foreground/[0.08] outline-none dark:shadow-black/40 dark:ring-foreground/[0.14]";

export const floatingMotion =
  "origin-(--transform-origin) duration-150 ease-(--ease-soft) data-open:animate-in data-open:fade-in-0 data-open:zoom-in-98 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=inline-end]:slide-in-from-left-1 data-[side=inline-start]:slide-in-from-right-1 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-98 data-closed:duration-100";

export const floatingItem =
  "relative flex min-h-8 w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-hidden select-none transition-colors duration-75 data-highlighted:bg-accent data-highlighted:text-accent-foreground focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground data-highlighted:[&_svg:not([class*='text-'])]:text-accent-foreground";

/** A group's heading inside a list. */
export const floatingLabel = "px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground";

export const floatingSeparator = "-mx-1 my-1 h-px bg-border/70";
