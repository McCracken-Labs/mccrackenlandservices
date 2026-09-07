# Tool PDF sources

The HTML each tool PDF in `tools/downloads/` was rendered from. Keep these. A PDF
cannot be edited back into a document, so if the source is lost the only way to
change that guide is to rewrite it from scratch.

To rebuild one after editing:

    page.pdf(format='Letter', print_background=True, prefer_css_page_size=True)

rendered headless in Chromium, then verify: page count, navy full bleed on the
top edge of page 1, footer on every page, no page ending on a heading, link count
unchanged. The full spec is in the project doc `tool-pdf-base-template.md`.

Only three of the twenty-one tool PDFs have source. The other eighteen predate
this folder and were built in throwaway sessions. Each one gets a source file here
the first time it is genuinely rebuilt.

Excluded from search indexing in `robots.txt`. These pages are the same content as
the public PDFs, but there is no reason for Google to index both.
