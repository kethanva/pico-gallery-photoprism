# PhotoPrism source

The shipped runtime supports exactly one enabled `[[sources]]` entry named
`photoprism`. Configuration fails closed if more than one matching source is
enabled. WebDAV and local-directory sources are not implemented by this host.

Use a dedicated least-privilege viewer account and prefer a PhotoPrism app
password over the account password:

```toml
[[sources]]
name             = "photoprism"
enabled          = true
url              = "https://photoprism.internal:2342"
username         = "frame-viewer"
app_password     = "replace-me"
include_private  = false
include_archived = false
```

The current display host consumes `url`, `username`, and `app_password` (with
legacy `password` accepted as a fallback). It does not implement the historical
playlist/filter engine, so filter keys do not change the displayed PhotoPrism
library.

The configuration loader intentionally accepts the scalar TOML subset used by
the supplied configuration: tables, array tables, strings, booleans, numbers,
and scalar arrays. Unsupported TOML syntax causes startup to fail instead of
silently selecting the wrong credential or backend.
