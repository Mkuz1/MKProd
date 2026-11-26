# MK Prod landing page

A static, dependency free marketing page for MK Prod. Ready for Cloudflare Pages.

## Deploy

**Dashboard upload:** Cloudflare dashboard, Workers & Pages, Create, Pages, *Upload assets*. Name the project `mkprod-landing` and drop this `landing` folder in.

**CLI:**

```bash
npx wrangler pages deploy landing --project-name mkprod-landing
```

Cloudflare Pages picks up `_headers` (security headers, font caching) and serves `404.html` for unknown paths. `/privacy` and `/terms` resolve to their `.html` files automatically.

## If you use a different domain

The canonical URL, `og:image`, `robots.txt` and `sitemap.xml` point at `https://mkprod-landing.pages.dev`. Replace that host everywhere if the project name or a custom domain differs.

## Before going live

- `privacy.html` and `terms.html` contain `{{legal entity}}`, `{{contact email}}`, `{{date}}` and similar placeholders to complete with your legal details.
- No testimonials or customer logos are on the page, because none were supplied. Add real ones to the security or final section when you have them.

## Contents

- `index.html`, `styles.css`, `main.js`: the page
- `fonts/`: Geist, Geist Mono and a Phosphor icon font, self hosted (no third party requests, no cookies)
- `og.png`: 1200 by 630 social share image
- `404.html`, `privacy.html`, `terms.html`
