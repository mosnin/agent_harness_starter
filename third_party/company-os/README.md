# Company OS framework distribution

This is the actual text distribution from `mosnin/companyos`, package
`@mosnin/companyos@0.6.0`, source revision
`5b374ba2066332c44f74eafddab4f8f575715ba3`.

`manifest.json` pins `bundle.json`. The bundle retains all 688 distribution
files, their individual hashes and upstream package licensing metadata
(`UNLICENSED`). Hades' license does not relicense this upstream content.
The content is loaded as guidance; bundling it does not run its scripts or
enable its controllers and scheduling.

Regenerate with `scripts/vendor-company-os.mjs` against the canonical clean
source checkout. Never edit the generated bundle by hand. Both JSON files
are desktop resources; missing or modified bytes make Company OS unavailable
without preventing the rest of Hades from starting.

See `docs/plugins/COMPANY_OS.md` for update trust, resource paths, rollback,
runtime boundaries and verification evidence.
