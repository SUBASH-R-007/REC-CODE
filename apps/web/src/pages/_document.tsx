import Document, { Head, Html, Main, NextScript, type DocumentContext, type DocumentInitialProps } from "next/document";
import { brandForPages } from "@/lib/pages-server";
import { themeInitScript } from "@/lib/theme-script";

type Props = DocumentInitialProps & { themeColorLight: string; themeColorDark: string; nonce?: string };

/**
 * The Pages Router document. Its only page is the sign-in page
 * (src/pages/login.tsx), which ships NO JavaScript in production — the
 * whole product otherwise lives in the App Router (src/app). It mirrors the
 * root layout's <head>:
 *
 *   - the inline theme script, allow-listed in the CSP by its content hash
 *     (src/lib/theme-script.ts), so dark mode applies before first paint;
 *   - the admin-chosen brand <style>, returned as `styles`, which Next emits
 *     AFTER its global stylesheet <link>s — so, as in app/layout.tsx, the
 *     brand's equal-specificity :root rules win over the verbatim tokens;
 *   - theme-color for both colour schemes.
 *
 * The request's CSP nonce (src/middleware.ts, `x-nonce`) is stamped on
 * Next's own scripts. In production there are none on /login; `next dev`
 * always adds its client and HMR scripts — and hides <body> until they run
 * — so without the nonce the strict CSP would leave the dev page blank.
 */
export default class RecDocument extends Document<Props> {
  static override async getInitialProps(ctx: DocumentContext): Promise<Props> {
    const [initial, brand] = await Promise.all([Document.getInitialProps(ctx), brandForPages()]);
    const nonce = ctx.req?.headers["x-nonce"];
    return {
      ...initial,
      ...(typeof nonce === "string" && nonce ? { nonce } : {}),
      themeColorLight: brand.themeColorLight,
      themeColorDark: brand.themeColorDark,
      styles: (
        <>
          {initial.styles}
          <style id="rec-brand" dangerouslySetInnerHTML={{ __html: brand.css }} />
        </>
      ),
    };
  }

  override render() {
    const { nonce } = this.props;
    return (
      <Html lang="en">
        <Head nonce={nonce}>
          <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
          <meta name="theme-color" media="(prefers-color-scheme: light)" content={this.props.themeColorLight} />
          <meta name="theme-color" media="(prefers-color-scheme: dark)" content={this.props.themeColorDark} />
          {/* Authenticated product: nothing here is meant for search engines. */}
          <meta name="robots" content="noindex, nofollow" />
        </Head>
        <body className="antialiased">
          <Main />
          <NextScript nonce={nonce} />
        </body>
      </Html>
    );
  }
}
