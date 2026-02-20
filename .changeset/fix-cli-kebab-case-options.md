---
"@stoneforge/quarry": patch
---

Fix CLI parser to accept kebab-case flags for camelCase options (e.g., --reply-to, --root-only, --doc-version). Both kebab-case and camelCase forms are now accepted, with kebab-case being the preferred convention.
