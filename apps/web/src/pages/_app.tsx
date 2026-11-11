import type { AppProps } from "next/app";
import { Inter, Sora } from "next/font/google";
import "@/app/globals.css";

// The same faces and CSS variables as the root App Router layout.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const sora = Sora({ subsets: ["latin"], variable: "--font-sora", display: "swap" });

/**
 * Pages Router app shell (only /login uses the Pages Router — see
 * _document.tsx). Mirrors the root layout's body: the font variables, the
 * skip link, then the page. Server-rendered only: /login ships no JS.
 */
export default function App({ Component, pageProps }: AppProps) {
  return (
    <div className={`${inter.variable} ${sora.variable} font-sans`}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-fg"
      >
        Skip to content
      </a>
      <Component {...pageProps} />
    </div>
  );
}
