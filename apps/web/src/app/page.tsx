import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { homeForRole } from "@/lib/auth/guards";

/** "/" has no content of its own: send people where they belong. */
export default async function RootPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  redirect(homeForRole(user.role));
}
