"use client"

import * as React from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"

import { floatingItem, floatingLabel, floatingMotion, floatingSeparator, floatingSurface } from "@/components/ui/floating"
import { cn } from "@/lib/utils"
import { ChevronRightIcon, CheckIcon } from "lucide-react"

const DropdownMenu = (props: MenuPrimitive.Root.Props) => (
  <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
)

const DropdownMenuPortal = (props: MenuPrimitive.Portal.Props) => (
  <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
)

const DropdownMenuTrigger = React.forwardRef<
  HTMLButtonElement,
  MenuPrimitive.Trigger.Props
>((props, ref) => (
  <MenuPrimitive.Trigger
    data-slot="dropdown-menu-trigger"
    {...props}
    ref={ref}
  />
))
DropdownMenuTrigger.displayName = "DropdownMenuTrigger"

const DropdownMenuContent = React.forwardRef<
  HTMLDivElement,
  MenuPrimitive.Popup.Props &
    Pick<
      MenuPrimitive.Positioner.Props,
      "align" | "alignOffset" | "side" | "sideOffset"
    >
>(
  (
    {
      align = "start",
      alignOffset = 0,
      side = "bottom",
      sideOffset = 4,
      className,
      ...props
    },
    ref
  ) => (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          ref={ref}
          data-slot="dropdown-menu-content"
          className={cn(
            // As wide as its longest item (a menu opened from an icon is not as narrow as the icon), never wider than 20rem.
            "z-50 max-h-(--available-height) w-max max-w-[min(20rem,var(--available-width))] min-w-[max(10rem,var(--anchor-width))] overflow-x-hidden overflow-y-auto p-1 data-closed:overflow-hidden",
            floatingSurface,
            floatingMotion,
            className
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
)
DropdownMenuContent.displayName = "DropdownMenuContent"

const DropdownMenuGroup = React.forwardRef<
  HTMLDivElement,
  MenuPrimitive.Group.Props
>((props, ref) => (
  <MenuPrimitive.Group ref={ref} data-slot="dropdown-menu-group" {...props} />
))
DropdownMenuGroup.displayName = "DropdownMenuGroup"

const DropdownMenuLabel = React.forwardRef<
  HTMLDivElement,
  MenuPrimitive.GroupLabel.Props & {
    inset?: boolean
  }
>(({ className, inset, ...props }, ref) => (
  <MenuPrimitive.GroupLabel
    ref={ref}
    data-slot="dropdown-menu-label"
    data-inset={inset}
    className={cn(
      floatingLabel,
      "data-inset:pl-8",
      className
    )}
    {...props}
  />
))
DropdownMenuLabel.displayName = "DropdownMenuLabel"

const DropdownMenuItem = React.forwardRef<
  HTMLDivElement,
  MenuPrimitive.Item.Props & {
    inset?: boolean
    variant?: "default" | "destructive"
  }
>(({ className, inset, variant = "default", ...props }, ref) => (
  <MenuPrimitive.Item
    ref={ref}
    data-slot="dropdown-menu-item"
    data-inset={inset}
    data-variant={variant}
    className={cn(
      floatingItem,
      "group/dropdown-menu-item data-inset:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:data-highlighted:bg-destructive/10 data-[variant=destructive]:data-highlighted:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:*:[svg]:text-destructive!",
      className
    )}
    {...props}
  />
))
DropdownMenuItem.displayName = "DropdownMenuItem"

const DropdownMenuSub = MenuPrimitive.SubmenuRoot

const DropdownMenuSubTrigger = React.forwardRef<
  HTMLDivElement,
  MenuPrimitive.SubmenuTrigger.Props & {
    inset?: boolean
  }
>(({ className, inset, children, ...props }, ref) => (
  <MenuPrimitive.SubmenuTrigger
    ref={ref}
    data-slot="dropdown-menu-sub-trigger"
    data-inset={inset}
    className={cn(
      floatingItem,
      "data-inset:pl-8 data-popup-open:bg-accent data-popup-open:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground",
      className
    )}
    {...props}
  >
    {children}
    <ChevronRightIcon className="ml-auto" />
  </MenuPrimitive.SubmenuTrigger>
))
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger"

const DropdownMenuSubContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof DropdownMenuContent>
>(({ align = "start", alignOffset = -3, side = "right", sideOffset = 0, className, ...props }, ref) => (
  <DropdownMenuContent
    ref={ref}
    data-slot="dropdown-menu-sub-content"
    className={cn("w-auto min-w-40 p-1", floatingSurface, floatingMotion, className)}
    align={align}
    alignOffset={alignOffset}
    side={side}
    sideOffset={sideOffset}
    {...props}
  />
))
DropdownMenuSubContent.displayName = "DropdownMenuSubContent"

const DropdownMenuCheckboxItem = React.forwardRef<
  HTMLDivElement,
  MenuPrimitive.CheckboxItem.Props & {
    inset?: boolean
  }
>(({ className, children, checked, inset, ...props }, ref) => (
  <MenuPrimitive.CheckboxItem
    ref={ref}
    data-slot="dropdown-menu-checkbox-item"
    data-inset={inset}
    className={cn(
      floatingItem,
      "pr-8 data-inset:pl-8",
      className
    )}
    checked={checked}
    {...props}
  >
    <span
      className="pointer-events-none absolute right-2 flex items-center justify-center"
      data-slot="dropdown-menu-checkbox-item-indicator"
    >
      <MenuPrimitive.CheckboxItemIndicator>
        <CheckIcon />
      </MenuPrimitive.CheckboxItemIndicator>
    </span>
    {children}
  </MenuPrimitive.CheckboxItem>
))
DropdownMenuCheckboxItem.displayName = "DropdownMenuCheckboxItem"

const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup

const DropdownMenuRadioItem = React.forwardRef<
  HTMLDivElement,
  MenuPrimitive.RadioItem.Props & {
    inset?: boolean
  }
>(({ className, children, inset, ...props }, ref) => (
  <MenuPrimitive.RadioItem
    ref={ref}
    data-slot="dropdown-menu-radio-item"
    data-inset={inset}
    className={cn(
      floatingItem,
      "pr-8 data-inset:pl-8",
      className
    )}
    {...props}
  >
    <span
      className="pointer-events-none absolute right-2 flex items-center justify-center"
      data-slot="dropdown-menu-radio-item-indicator"
    >
      <MenuPrimitive.RadioItemIndicator>
        <CheckIcon />
      </MenuPrimitive.RadioItemIndicator>
    </span>
    {children}
  </MenuPrimitive.RadioItem>
))
DropdownMenuRadioItem.displayName = "DropdownMenuRadioItem"

const DropdownMenuSeparator = React.forwardRef<
  HTMLDivElement,
  MenuPrimitive.Separator.Props
>(({ className, ...props }, ref) => (
  <MenuPrimitive.Separator
    ref={ref}
    data-slot="dropdown-menu-separator"
    className={cn(floatingSeparator, className)}
    {...props}
  />
))
DropdownMenuSeparator.displayName = "DropdownMenuSeparator"

const DropdownMenuShortcut = ({
  className,
  ...props
}: React.ComponentProps<"span">) => (
  <span
    data-slot="dropdown-menu-shortcut"
    className={cn(
      "ml-auto text-xs tracking-widest text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground",
      className
    )}
    {...props}
  />
)
DropdownMenuShortcut.displayName = "DropdownMenuShortcut"

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
