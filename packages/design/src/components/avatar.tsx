import { cn, initials } from "../utils";

export function Avatar({
  firstName,
  lastName,
  hue = 262,
  size = "md",
  className,
}: {
  firstName: string;
  lastName: string;
  hue?: number;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const sizes = {
    xs: "h-6 w-6 text-[0.6rem]",
    sm: "h-8 w-8 text-xs",
    md: "h-10 w-10 text-sm",
    lg: "h-14 w-14 text-lg",
    xl: "h-20 w-20 text-2xl",
  };
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none",
        sizes[size],
        className,
      )}
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 55% 48%), hsl(${(hue + 40) % 360} 55% 38%))`,
      }}
    >
      {initials(firstName, lastName)}
    </span>
  );
}
