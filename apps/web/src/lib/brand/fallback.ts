import "server-only";

// The pure brand helpers live in ./brand-core (shared with the Pages Router
// sign-in page, where `server-only` is not allowed); App Router code keeps
// importing them from here, behind the server-only guard.
export * from "@/lib/brand/brand-core";
