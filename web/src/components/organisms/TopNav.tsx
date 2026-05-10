"use client";
import * as React from "react";
import Link from "next/link";
import { Bell, MessageCircle, Plus, Menu as MenuIcon, ChevronDown, LogOut, Settings, User } from "lucide-react";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";
import { CountBadge } from "@/components/ui/CountBadge";
import { SearchBar, type SearchSuggestion } from "@/components/ui/SearchBar";
import {
  Menu,
  MenuTrigger,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
} from "@/components/ui/Menu";

export type Role = "client" | "provider";

export type TopNavUser = {
  id: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
  kycVerified?: boolean;
  /** Чи є provider-роль (для перемикача) */
  hasProviderRole?: boolean;
};

type TopNavProps = {
  user?: TopNavUser | null;
  role?: Role;
  onRoleSwitch?: (next: Role) => void;
  notificationsUnread?: number;
  messagesUnread?: number;
  searchSuggestions?: SearchSuggestion[];
  onSearchSubmit?: (q: string) => void;
  className?: string;
};

export function TopNav({
  user,
  role = "client",
  onRoleSwitch,
  notificationsUnread = 0,
  messagesUnread = 0,
  searchSuggestions,
  onSearchSubmit,
  className,
}: TopNavProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-[var(--z-sticky)] bg-canvas/85 backdrop-blur supports-[backdrop-filter]:bg-canvas/60 border-b border-hairline",
        className
      )}
    >
      <div className="mx-auto max-w-7xl px-4 md:px-6 h-16 flex items-center gap-3 md:gap-6">
        {/* Logo */}
        <Link
          href="/"
          className="font-display text-h3 tracking-tight text-ink shrink-0 leading-none"
        >
          Robotun<span className="text-accent">.</span>
        </Link>

        {/* Desktop search */}
        <div className="hidden md:block flex-1 max-w-xl">
          <SearchBar
            suggestions={searchSuggestions}
            onSubmit={onSearchSubmit}
            placeholder="Шукати майстра, послугу або категорію"
          />
        </div>

        {/* Spacer for mobile */}
        <div className="flex-1 md:hidden" />

        {/* Right cluster */}
        <div className="flex items-center gap-1 md:gap-2 shrink-0">
          {role === "provider" && (
            <Link
              href="/provider/listings/new"
              className="hidden md:inline-flex"
            >
              <Button size="sm" variant="accent" leftIcon={<Plus size={14} />}>
                Нова послуга
              </Button>
            </Link>
          )}

          <ThemeToggle className="border-transparent bg-transparent hover:border-hairline-strong hover:bg-paper text-ink-soft hover:text-ink" />

          {user ? (
            <>
              <Link href="/messages" aria-label="Повідомлення" className="relative inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-sm)] text-ink-soft hover:bg-paper hover:text-ink transition-colors">
                <MessageCircle size={18} />
                {messagesUnread > 0 && (
                  <span className="absolute top-1 right-1">
                    <CountBadge value={messagesUnread} tone="accent" />
                  </span>
                )}
              </Link>
              <Link href="/inbox" aria-label="Сповіщення" className="relative inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-sm)] text-ink-soft hover:bg-paper hover:text-ink transition-colors">
                <Bell size={18} />
                {notificationsUnread > 0 && (
                  <span className="absolute top-1 right-1">
                    <CountBadge value={notificationsUnread} tone="accent" />
                  </span>
                )}
              </Link>
              <Menu>
                <MenuTrigger asChild>
                  <button className="ml-1 inline-flex items-center gap-2 px-1.5 py-1 rounded-[var(--radius-sm)] hover:bg-paper transition-colors">
                    <Avatar
                      shape="circle"
                      size="sm"
                      alt={user.displayName}
                      src={user.avatarUrl}
                      kycVerified={user.kycVerified}
                    />
                    <span className="hidden md:inline-flex items-center gap-1 text-caption text-ink-soft">
                      {role === "client" ? "Клієнт" : "Провайдер"}
                      <ChevronDown size={12} className="text-muted-soft" />
                    </span>
                  </button>
                </MenuTrigger>
                <MenuContent align="end">
                  <MenuLabel>{user.displayName}</MenuLabel>
                  {user.email && (
                    <div className="px-2.5 pb-2 text-caption text-muted-soft truncate">
                      {user.email}
                    </div>
                  )}
                  <MenuSeparator />
                  {user.hasProviderRole && onRoleSwitch && (
                    <>
                      <MenuItem
                        onSelect={() => onRoleSwitch(role === "client" ? "provider" : "client")}
                      >
                        Перейти у режим: {role === "client" ? "Провайдер" : "Клієнт"}
                      </MenuItem>
                      <MenuSeparator />
                    </>
                  )}
                  <MenuItem leftIcon={<User size={14} />}>Мій профіль</MenuItem>
                  <MenuItem leftIcon={<Settings size={14} />}>Налаштування</MenuItem>
                  <MenuSeparator />
                  <MenuItem destructive leftIcon={<LogOut size={14} />}>
                    Вийти
                  </MenuItem>
                </MenuContent>
              </Menu>
            </>
          ) : (
            <>
              <Link href="/auth/sign-in" className="hidden md:inline-flex">
                <Button size="sm" variant="ghost">Увійти</Button>
              </Link>
              <Link href="/auth/sign-up">
                <Button size="sm">Зареєструватись</Button>
              </Link>
            </>
          )}

          {/* Mobile menu */}
          <button
            className="md:hidden inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-sm)] text-ink-soft hover:bg-paper transition-colors"
            aria-label="Меню"
          >
            <MenuIcon size={20} />
          </button>
        </div>
      </div>

      {/* Mobile search row */}
      <div className="md:hidden px-4 pb-3">
        <SearchBar
          suggestions={searchSuggestions}
          onSubmit={onSearchSubmit}
          placeholder="Шукати"
        />
      </div>
    </header>
  );
}
