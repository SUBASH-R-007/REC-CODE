import type { Metadata, Viewport } from "next";
import { Inter, Sora } from "next/font/google";
import { headers } from "next/headers";
import { ToastProvider } from "@recx/design";
import { ImpersonationBanner } from "@/components/impersonation/impersonation-banner";
import { ServiceWorkerRegistration } from "@/components/pwa/service-worker-registration";
import { getBrand } from "@/lib/brand/theme";
import { COLLEGE_NAME, PRODUCT_NAME } from "@/lib/brand/names";
import { themeInitScript } from "@/lib/theme-script";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? "http://localhost:3000"),
  title: {
    default: `${PRODUCT_NAME} — ${COLLEGE_NAME}`,
    template: `%s · ${PRODUCT_NAME}`,
  },
  description: `${PRODUCT_NAME} is the coding practice platform of ${COLLEGE_NAME}: original problems, instant judging and progress you can see.`,
  applicationName: PRODUCT_NAME,
  // Authenticated product: nothing here is meant for search engines.
  robots: { index: false, follow: false },
};

/** theme-color follows the active brand palette (light + dark). */
export async function generateViewport(): Promise<Viewport> {
  const brand = await getBrand();
  return {
    themeColor: [
      { media: "(prefers-color-scheme: light)", color: brand.themeColorLight },
      { media: "(prefers-color-scheme: dark)", color: brand.themeColorDark },
    ],
    width: "device-width",
    initialScale: 1,
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const [headerStore, brand] = await Promise.all([headers(), getBrand()]);
  const nonce = headerStore.get("x-nonce") ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Allow-listed in the CSP by content hash (src/lib/theme-script.ts). */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {/* The admin-chosen brand: plain CSS from the PlatformTheme row, no
            client JS. React emits the global stylesheet <link>s in the head
            preamble, ahead of these children, so equal-specificity :root
            rules here win over the verbatim tokens. Browsers hide nonce
            values from the DOM (the client sees nonce=""), hence
            suppressHydrationWarning on this element only. */}
        <style
          id="rec-brand"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: brand.css }}
        />
      </head>
      <body className={`${inter.variable} ${sora.variable} font-sans antialiased`}>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-fg"
        >
          Skip to content
        </a>
        {/* Read-only "view as" banner (super-admin impersonation); renders nothing otherwise. */}
        <ImpersonationBanner />
        <ToastProvider>{children}</ToastProvider>
        {/* Registers public/sw.js in production; never on exam routes. */}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
