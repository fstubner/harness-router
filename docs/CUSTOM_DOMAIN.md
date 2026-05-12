# Custom domain setup for the landing page

This repo's GitHub Pages workflow (`.github/workflows/pages.yml`) deploys
`docs/` whenever `main` advances. To switch the landing page from the
default `fstubner.github.io/harness-router` to a custom domain, do
ALL of the following — one before, one after, in this order:

## 1. Register + DNS (do this BEFORE renaming the placeholder)

Pick a registrar (Cloudflare / Namecheap / Porkbun) and acquire the
domain. Then add DNS records:

**For an apex domain (`example.dev`)** — four A records to GitHub's
Pages IPs, plus matching AAAA for IPv6:

| Type  | Host  | Value             |
|-------|-------|-------------------|
| A     | `@`   | `185.199.108.153` |
| A     | `@`   | `185.199.109.153` |
| A     | `@`   | `185.199.110.153` |
| A     | `@`   | `185.199.111.153` |
| AAAA  | `@`   | `2606:50c0:8000::153` |
| AAAA  | `@`   | `2606:50c0:8001::153` |
| AAAA  | `@`   | `2606:50c0:8002::153` |
| AAAA  | `@`   | `2606:50c0:8003::153` |

**For a subdomain (`docs.example.dev`)** — one CNAME:

| Type  | Host   | Value                  |
|-------|--------|------------------------|
| CNAME | `docs` | `fstubner.github.io.`  |

DNS propagation can take 5–30 minutes. Don't rename the CNAME placeholder
file until at least the apex A records resolve from your machine
(`dig <domain>` or `nslookup`).

## 2. Rename the placeholder

Replace `docs/CNAME.placeholder` with `docs/CNAME` containing only the
domain (one line, no protocol, no trailing slash):

```bash
echo "your-domain.dev" > docs/CNAME
git rm docs/CNAME.placeholder
git add docs/CNAME
```

Push to `main`. The pages.yml workflow re-deploys, and GitHub uses the
CNAME file to set the custom domain.

## 3. Update repo references

Three places need the domain string updated in tandem:

- `package.json` → `homepage`
- `README.md` → "Landing page" link near the top
- `docs/index.html` → canonical URL, `og:url`, and JSON-LD `url`

Search-and-replace `fstubner.github.io/harness-router` → `your-domain.dev`.

## 4. Enable HTTPS

In **Settings → Pages** of the GitHub repo, enable "Enforce HTTPS" once
the cert provisions (auto-issued by GitHub via Let's Encrypt; can take
up to 24 h after the CNAME goes live).

## Smoke test

```bash
curl -I https://your-domain.dev
# Should return 200, served from a GitHub IP.

curl -sI https://your-domain.dev | grep -i "strict-transport"
# Should show HSTS once HTTPS is enforced.
```
