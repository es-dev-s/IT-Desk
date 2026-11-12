import { cn } from "@/lib/utils";

const VARIANTS = {
  primary: "bg-accent text-white shadow-xs hover:bg-accent-hover",
  dark: "bg-neutral-900 text-white shadow-xs hover:bg-neutral-800",
  secondary: "border border-line-strong bg-white text-neutral-800 shadow-xs hover:bg-neutral-50",
  ghost: "text-neutral-600 hover:bg-neutral-900/[0.04] hover:text-neutral-900",
  danger: "bg-red-600 text-white shadow-xs hover:bg-red-700",
} as const;

const SIZES = {
  sm: "h-8 gap-1.5 rounded-lg px-3 text-[13px] [&_svg]:size-4",
  md: "h-9 gap-2 rounded-lg px-4 text-sm [&_svg]:size-4",
  icon: "size-9 rounded-lg [&_svg]:size-[18px]",
  "icon-sm": "size-8 rounded-lg [&_svg]:size-4",
  "icon-xs": "size-7 rounded-md [&_svg]:size-4",
} as const;

export type ButtonVariant = keyof typeof VARIANTS;
export type ButtonSize = keyof typeof SIZES;

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string) {
  return cn(
    "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium outline-none transition-colors duration-150",
    "focus-visible:ring-2 focus-visible:ring-accent/35 focus-visible:ring-offset-1 focus-visible:ring-offset-white",
    "disabled:pointer-events-none disabled:opacity-40 [&_svg]:shrink-0",
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...props
}: React.ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}
