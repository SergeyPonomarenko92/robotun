"use client";
import * as React from "react";
import { ChevronDown, ArrowDownUp } from "lucide-react";
import { Menu, MenuTrigger, MenuContent, MenuRadioGroup, MenuRadioItem } from "@/components/ui/Menu";
import { Button } from "@/components/ui/Button";

export type SortKey =
  | "relevance"
  | "newest"
  | "price_asc"
  | "price_desc"
  | "rating";

const LABEL: Record<SortKey, string> = {
  relevance: "За релевантністю",
  newest: "Найновіші",
  price_asc: "Дешевші спочатку",
  price_desc: "Дорожчі спочатку",
  rating: "Найкращий рейтинг",
};

type SortDropdownProps = {
  value: SortKey;
  onChange: (key: SortKey) => void;
  /** Які ключі дозволені (наприклад, без relevance, якщо немає q) */
  available?: SortKey[];
  size?: "sm" | "md";
};

const ALL: SortKey[] = ["relevance", "newest", "price_asc", "price_desc", "rating"];

export function SortDropdown({
  value,
  onChange,
  available = ALL,
  size = "md",
}: SortDropdownProps) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          variant="secondary"
          size={size}
          leftIcon={<ArrowDownUp size={14} />}
          rightIcon={<ChevronDown size={14} />}
        >
          {LABEL[value]}
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuRadioGroup
          value={value}
          onValueChange={(v) => onChange(v as SortKey)}
        >
          {available.map((k) => (
            <MenuRadioItem key={k} value={k}>
              {LABEL[k]}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
