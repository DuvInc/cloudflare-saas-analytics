"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Long lists keep the column header in view: `sticky` pins the header row to
 * the top of the page's one scroller (the app's content area, or the window
 * below `md`, under the mobile top bar). A sticky element sticks to its
 * nearest ancestor that scrolls, so a table that sticks cannot sit in an
 * `overflow-x-auto` box: the sticky form clips instead (`overflow-x-clip`
 * makes no scroll container) and must only be used where the table fits its
 * width, i.e. where narrower widths drop columns or become cards (container
 * queries). A table that really needs horizontal scrolling keeps the default
 * form, with a header that scrolls away. The frame around a sticky table uses
 * `overflow-clip`, never `overflow-hidden` (that is a scroll container too).
 */
const StickyContext = React.createContext(false)

/**
 * Header cell of a sticky table, top below the mobile bar; from `md` it stops
 * 12px under the scroller's edge (`STICKY_GAP_PX`, the same as the rail).
 *
 * The header draws the top of the card itself, at rest and stuck alike: the
 * `after:` element is the opaque fill (rows pass under it), the top and bottom
 * hairlines, and on the outer cells the side borders and rounded corners. It
 * sits 1px out, exactly on the frame's own border (the frame lets it, with
 * `STICKY_FRAME`), so at rest it is the frame's top, and once stuck mid-frame
 * it is still a rounded card top. The cell's own background stays transparent:
 * a square fill would cover the frame's rounded corners.
 *
 * Once stuck (`data-stuck` on the container), a band of page background (the
 * `before:` element, under the fill) covers the gap above the header and the
 * corners outside its curve, 1px wider on the outer cells to hide the frame's
 * side borders there: no rows and no stray vertical lines above the header.
 */
export const STICKY_HEAD_CLASSES =
  "sticky top-14 z-10 md:top-3 after:pointer-events-none after:absolute after:-top-px after:right-0 after:bottom-0 after:left-0 after:-z-10 after:border-y after:border-border after:bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))] after:content-[''] first:after:-left-px first:after:rounded-tl-lg first:after:border-l last:after:-right-px last:after:rounded-tr-lg last:after:border-r before:pointer-events-none before:absolute before:-top-3 before:right-0 before:left-0 before:-z-10 before:hidden before:h-5 before:bg-background before:content-[''] first:before:-left-px last:before:-right-px group-data-[stuck]/sticky-table:before:block"

/** The frame around a sticky table: clips like overflow-hidden without scrolling, and lets the header draw on its 1px border. */
export const STICKY_FRAME = "overflow-clip [overflow-clip-margin:1px] rounded-lg border"

/** The gap between the scroller's top edge and a stuck header or rail, from `md` (Tailwind `top-3`). */
export const STICKY_GAP_PX = 12

/** Below `md` the header sticks under the mobile bar (Tailwind `top-14`). */
const STICKY_TOP_MOBILE_PX = 56

/** Where the header sticks for the current width: under the mobile bar, or the gap from `md`. */
function useStickyTop() {
  const [top, setTop] = React.useState(STICKY_GAP_PX)
  React.useEffect(() => {
    const md = window.matchMedia("(min-width: 48rem)")
    const update = () => setTop(md.matches ? STICKY_GAP_PX : STICKY_TOP_MOBILE_PX)
    update()
    md.addEventListener("change", update)
    return () => md.removeEventListener("change", update)
  }, [])
  return top
}

/** The nearest ancestor that scrolls vertically: the page's scroller, or the window. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY
    if (y === "auto" || y === "scroll") return p
  }
  return null
}

/**
 * True once the table's top has scrolled past the sticky line, so the header
 * is stuck. A 1px sentinel at the top of the table and an IntersectionObserver
 * on the scroller: no scroll handler.
 */
function useStuck(enabled: boolean) {
  const sentinel = React.useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = React.useState(false)
  const top = useStickyTop()
  React.useEffect(() => {
    const el = sentinel.current
    if (!enabled || !el || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      ([entry]) => setStuck(entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0) + top),
      { root: scrollParent(el), rootMargin: `-${top + 1}px 0px 0px 0px`, threshold: [0, 1] }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [enabled, top])
  return { sentinel, stuck }
}

function Table({
  className,
  sticky = false,
  ...props
}: React.ComponentProps<"table"> & { sticky?: boolean }) {
  const { sentinel, stuck } = useStuck(sticky)
  return (
    <StickyContext.Provider value={sticky}>
      <div
        data-slot="table-container"
        data-sticky={sticky ? "" : undefined}
        data-stuck={sticky && stuck ? "" : undefined}
        className={cn("relative w-full", sticky ? "group/sticky-table overflow-clip [overflow-clip-margin:1px]" : "overflow-x-auto")}
      >
        {sticky && <div ref={sentinel} aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px" />}
        <table
          data-slot="table"
          className={cn("w-full caption-bottom text-sm", className)}
          {...props}
        />
      </div>
    </StickyContext.Provider>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  const sticky = React.useContext(StickyContext)
  return (
    <thead
      data-slot="table-header"
      // The collapsed border of a row does not travel with a sticky cell: the
      // cells draw the hairline themselves (STICKY_HEAD_CLASSES).
      className={cn(sticky ? "[&_tr]:border-b-0" : "[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  const sticky = React.useContext(StickyContext)
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        sticky && STICKY_HEAD_CLASSES,
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
