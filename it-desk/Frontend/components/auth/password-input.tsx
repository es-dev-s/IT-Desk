"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { inputClass } from "@/components/ui/field";

/** Password field with a show/hide toggle and a Caps Lock hint. */
export function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  invalid,
  disabled,
  autoFocus,
  onCapsLock,
  describedBy,
  name,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  onCapsLock?: (on: boolean) => void;
  describedBy?: string;
  name?: string;
}) {
  const [visible, setVisible] = useState(false);
  const caps = (e: React.KeyboardEvent<HTMLInputElement>) => onCapsLock?.(e.getModifierState("CapsLock"));
  return (
    <div className="relative">
      <input
        id={id}
        name={name ?? id}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyUp={caps}
        onKeyDown={caps}
        onBlur={() => onCapsLock?.(false)}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        maxLength={256}
        className={cn(inputClass, "h-11 pr-11 text-[15px] disabled:bg-subtle")}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        aria-controls={id}
        disabled={disabled}
        className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-lg text-neutral-400 outline-none transition-colors hover:text-neutral-700 focus-visible:text-accent disabled:opacity-40"
      >
        {visible ? <EyeOff className="size-[18px]" aria-hidden /> : <Eye className="size-[18px]" aria-hidden />}
      </button>
    </div>
  );
}
