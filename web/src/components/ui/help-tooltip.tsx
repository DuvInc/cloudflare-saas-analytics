"use client";

import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The one accessible "hover for more info" trigger. A Tooltip's content is
 * mouse-only unless its trigger is a real focusable element with a visible
 * focus state — a bare `<span>`/`<p>`/`<CardDescription>` opens on hover but
 * cannot be reached by keyboard or switch-control users at all, and a
 * `tabIndex={0}` element that strips `outline` without a `focus-visible:ring`
 * replacement is reachable but invisible. This wraps `Tooltip` so every call
 * site gets both by construction instead of hand-rolling one, the other, or
 * neither.
 *
 * Defaults to a real `<button type="button">`. Pass `render` only when a
 * native button does not fit the markup (e.g. a `Badge`, or a wrapper around
 * an already-disabled `Button`) — the same focus-visible ring and cursor are
 * still merged onto it.
 */
export function HelpTooltip({
  children,
  content,
  render,
  className,
  label,
  side = "top",
  align,
  contentClassName,
}: {
  /** The trigger's visible content — label text, an icon, or both. */
  children: ReactNode;
  /** Tooltip content shown on hover/focus. */
  content: ReactNode;
  /**
   * Custom trigger element. Its own className/tabIndex/aria-label are kept;
   * only what is missing is filled in.
   */
  render?: ReactElement;
  /** Extra classes merged onto the trigger element (visual styling only —
   *  cursor and focus state are already handled). */
  className?: string;
  /** Accessible name for triggers whose visible content does not already
   *  describe them (e.g. an icon-only trigger). */
  label?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  contentClassName?: string;
}) {
  const trigger = render ?? <button type="button" />;

  const mergedTrigger = isValidElement<Record<string, unknown>>(trigger)
    ? cloneElement(trigger, {
        className: cn(
          "cursor-help outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          trigger.props.className as string | undefined,
          className
        ),
        tabIndex: (trigger.props.tabIndex as number | undefined) ?? 0,
        "aria-label": (trigger.props["aria-label"] as string | undefined) ?? label,
      })
    : trigger;

  return (
    <Tooltip>
      <TooltipTrigger render={mergedTrigger}>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align} className={contentClassName}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The one way text that names something (a field label, a card or section
 * title, a row label, a column header, a stat label) explains itself: the
 * text is the trigger, a dotted underline says it has an explanation, and the
 * explanation opens on hover or keyboard focus. No (i) icon next to text.
 * An icon trigger is only right when there is no text to underline (an
 * icon-only button, a badge made of an icon): use `HelpTooltip` with `label`.
 *
 * The trigger is an inline `<span>` so it flows inside titles and labels. A
 * string `content` is also read by screen readers right after the text.
 *
 * For the label of a form control, pass `render={<label htmlFor={id} />}` (or
 * your `FieldLabel`): the trigger stays a real label, so clicking it focuses
 * the field. That trigger is not a tab stop (the field is), unless you set
 * `tabIndex` yourself.
 */
export function Hint({
  content,
  children,
  label,
  render,
  side,
  align = "start",
  className,
  contentClassName,
}: {
  /** The explanation, shown on hover or focus. */
  content: ReactNode;
  /** The text that carries the hint. */
  children: ReactNode;
  /** Accessible name, only when the visible text is not enough. */
  label?: string;
  /** Custom trigger element, e.g. `<label htmlFor={id} />`. */
  render?: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  /** Where the bubble sits against the text. Start by default: a label is short, and a bubble centred on it overhangs the edge, gets pushed back by the collision logic and then points at nothing. */
  align?: "start" | "center" | "end";
  className?: string;
  /** Replaces the default `max-w-72` for rich content. */
  contentClassName?: string;
}) {
  const trigger = render
    ? cloneElement(render as ReactElement<{ tabIndex?: number }>, { tabIndex: (render.props as { tabIndex?: number }).tabIndex ?? -1 })
    : <span />;
  return (
    <HelpTooltip
      render={trigger}
      label={label}
      side={side}
      align={align}
      contentClassName={contentClassName ?? "max-w-72"}
      className={cn(
        // w-fit!: inside a Field, `*:w-full` stretches the label to its row, and the bubble's arrow then points at the middle of the row, not at the words. Important, to beat that child selector.
        "w-fit! max-w-full underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground",
        className
      )}
      content={content}
    >
      {children}
      {typeof content === "string" && <span className="sr-only">. {content}</span>}
    </HelpTooltip>
  );
}
