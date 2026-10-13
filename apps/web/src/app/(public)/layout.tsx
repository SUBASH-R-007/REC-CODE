import { PublicShell } from "@/components/shell/public-shell";

/**
 * Pages reachable signed out (/judge). Signed-in viewers get the normal app
 * chrome, signed-out visitors a minimal header with Sign in. This layout
 * grants nothing and reads nothing private: each page under it decides what
 * it shows, and shows only public facts.
 */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  return <PublicShell>{children}</PublicShell>;
}
