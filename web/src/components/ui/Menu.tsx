"use client";
import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;
export const MenuPortal = DropdownMenu.Portal;
export const MenuGroup = DropdownMenu.Group;
export const MenuRadioGroup = DropdownMenu.RadioGroup;
export const MenuSub = DropdownMenu.Sub;

const surface =
  "z-[var(--z-dropdown)] min-w-[200px] bg-paper border border-hairline-strong rounded-[var(--radius-md)] shadow-md p-1 outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95";

export const MenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenu.Content>,
  React.ComponentProps<typeof DropdownMenu.Content>
>(({ className, sideOffset = 6, align = "start", ...props }, ref) => (
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      ref={ref}
      sideOffset={sideOffset}
      align={align}
      className={cn(surface, className)}
      {...props}
    />
  </DropdownMenu.Portal>
));
MenuContent.displayName = "MenuContent";

const itemBase =
  "relative flex items-center gap-2 px-2.5 py-2 rounded-[var(--radius-sm)] text-body text-ink cursor-pointer outline-none data-[highlighted]:bg-canvas data-[disabled]:opacity-50 data-[disabled]:pointer-events-none";

type MenuItemProps = React.ComponentProps<typeof DropdownMenu.Item> & {
  destructive?: boolean;
  shortcut?: string;
  leftIcon?: React.ReactNode;
};

export const MenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenu.Item>,
  MenuItemProps
>(({ className, destructive, shortcut, leftIcon, children, ...props }, ref) => (
  <DropdownMenu.Item
    ref={ref}
    className={cn(itemBase, destructive && "text-danger data-[highlighted]:bg-danger-soft", className)}
    {...props}
  >
    {leftIcon && <span className="text-muted shrink-0">{leftIcon}</span>}
    <span className="flex-1">{children}</span>
    {shortcut && (
      <span className="ml-3 text-micro font-mono text-muted-soft tracking-wide">
        {shortcut}
      </span>
    )}
  </DropdownMenu.Item>
));
MenuItem.displayName = "MenuItem";

export const MenuCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenu.CheckboxItem>,
  React.ComponentProps<typeof DropdownMenu.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenu.CheckboxItem ref={ref} className={cn(itemBase, "pl-7", className)} {...props}>
    <DropdownMenu.ItemIndicator className="absolute left-2 flex items-center">
      <Check size={14} />
    </DropdownMenu.ItemIndicator>
    {children}
  </DropdownMenu.CheckboxItem>
));
MenuCheckboxItem.displayName = "MenuCheckboxItem";

export const MenuRadioItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenu.RadioItem>,
  React.ComponentProps<typeof DropdownMenu.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenu.RadioItem ref={ref} className={cn(itemBase, "pl-7", className)} {...props}>
    <DropdownMenu.ItemIndicator className="absolute left-2.5 flex items-center">
      <span className="h-1.5 w-1.5 rounded-full bg-ink" />
    </DropdownMenu.ItemIndicator>
    {children}
  </DropdownMenu.RadioItem>
));
MenuRadioItem.displayName = "MenuRadioItem";

export const MenuLabel = React.forwardRef<
  React.ComponentRef<typeof DropdownMenu.Label>,
  React.ComponentProps<typeof DropdownMenu.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenu.Label
    ref={ref}
    className={cn("px-2.5 py-1.5 text-micro uppercase tracking-loose text-muted-soft", className)}
    {...props}
  />
));
MenuLabel.displayName = "MenuLabel";

export const MenuSeparator = React.forwardRef<
  React.ComponentRef<typeof DropdownMenu.Separator>,
  React.ComponentProps<typeof DropdownMenu.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenu.Separator ref={ref} className={cn("my-1 h-px bg-hairline", className)} {...props} />
));
MenuSeparator.displayName = "MenuSeparator";

export const MenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof DropdownMenu.SubTrigger>,
  React.ComponentProps<typeof DropdownMenu.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <DropdownMenu.SubTrigger ref={ref} className={cn(itemBase, className)} {...props}>
    <span className="flex-1">{children}</span>
    <ChevronRight size={14} className="text-muted" />
  </DropdownMenu.SubTrigger>
));
MenuSubTrigger.displayName = "MenuSubTrigger";

export const MenuSubContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenu.SubContent>,
  React.ComponentProps<typeof DropdownMenu.SubContent>
>(({ className, ...props }, ref) => (
  <DropdownMenu.SubContent ref={ref} className={cn(surface, className)} {...props} />
));
MenuSubContent.displayName = "MenuSubContent";
