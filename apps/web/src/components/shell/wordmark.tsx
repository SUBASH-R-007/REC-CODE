import Link from "next/link";
import { CodeXml } from "lucide-react";
import { cn } from "@recx/design";
import { PRODUCT_NAME } from "@/lib/brand/names";

/** Product mark + name. Colours come from the brand tokens only. */
export function Wordmark({
  href,
  size = "md",
  className,
}: {
  href?: string;
  size?: "md" | "lg";
  className?: string;
}) {
  const content = (
    <span className={cn("flex items-center gap-2", className)}>
      <span
        aria-hidden
        className={cn(
          "flex shrink-0 items-center justify-center rounded-xl bg-primary text-primary-fg shadow-sm",
          size === "lg" ? "h-11 w-11" : "h-8 w-8",
        )}
      >
        <CodeXml className={size === "lg" ? "h-6 w-6" : "h-4.5 w-4.5"} />
      </span>
      <span
        className={cn(
          "font-display font-bold tracking-tight text-text",
          size === "lg" ? "text-2xl" : "text-base",
        )}
      >
        {PRODUCT_NAME}
      </span>
    </span>
  );
  if (!href) return content;
  return (
    <Link href={href} className="rounded-xl">
      {content}
    </Link>
  );
}
