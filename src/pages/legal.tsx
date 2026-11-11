// /privacy and /terms, rendered from content/privacy.md and content/terms.md.
//
// The Markdown files are PLACEHOLDERS: you, the developer running this app, are responsible for your own
// privacy policy and terms. Edit the files (they're versioned with your code), replace every [bracketed]
// value, and delete the PLACEHOLDER line at the top. While that line is there, the page shows a warning and
// /admin lists it as a to-do. This is not legal advice.

import { Hono } from "hono";
import { raw } from "hono/html";
import { marked } from "marked";
import privacyMarkdown from "../../content/privacy.md";
import termsMarkdown from "../../content/terms.md";
import { APP } from "../app.config";
import type { AppEnv } from "../env";
import { Layout } from "../views/Layout";
import { Banner } from "../views/components";

export const legalRoutes = new Hono<AppEnv>();

export const LEGAL_DOCUMENTS = {
  privacy: { path: "/privacy", title: "Privacy policy", markdown: privacyMarkdown },
  terms: { path: "/terms", title: "Terms of use", markdown: termsMarkdown },
} as const;

/** True while a document still has the template's PLACEHOLDER line. */
export function isPlaceholder(markdown: string): boolean {
  return markdown.includes("<!-- PLACEHOLDER");
}

for (const doc of Object.values(LEGAL_DOCUMENTS)) {
  // The Markdown is your own content (trusted), so its HTML is rendered as-is.
  const html = marked.parse(doc.markdown.replaceAll("{{APP_NAME}}", APP.name), { async: false });

  legalRoutes.get(doc.path, (c) =>
    c.html(
      <Layout title={doc.title} user={c.var.user}>
        {isPlaceholder(doc.markdown) && (
          <Banner tone="warn" title="Placeholder">
            <p>
              The people who run this app haven't published their own {doc.title.toLowerCase()} yet. This page is the
              template's starting point, not a legal document.
            </p>
          </Banner>
        )}
        <article class="prose">{raw(html)}</article>
      </Layout>,
    ),
  );
}
