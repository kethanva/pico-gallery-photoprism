# Photo sources

A source supplies the playlist. Configure one or more `[[sources]]` tables in
your `config.toml`. Keys may be written `snake_case` (TOML idiom) or `camelCase`
— the loader normalizes them. Each source is identified by `name`.

Photos exposed by every source share the `directory:…` / `photoprism:…` /
`webdav:…` id prefix so the engine can route an image request back to its source.

## directory

Local folder(s). HEIC/HEIF is supported (transcoded to JPEG before resize).

```toml
[[sources]]
name      = "directory"
enabled   = true
paths     = ["/photos", "/mnt/usb/album"]
recursive = true
order     = "alphabetical"        # shuffle | alphabetical | date_modified
# allowed_albums       = ["Italy 2024"]   # optional subfolder allowlist
# rescan_interval_secs = 3600
```

## photoprism

Streams from a PhotoPrism library with the full typed filter model. Private and
archived photos are excluded by default.

```toml
[[sources]]
name             = "photoprism"
enabled          = true
url              = "http://photoprism:2342"
username         = "admin"
password         = "please-change"   # or app_password = "…"
include_private  = false
include_archived = false
per_page         = 100
order            = "newest"
max_thumb        = "fit_1920"        # smallest thumb ≥ display size
skip_tls_verify  = false

# Optional filters (any combination):
# album = "Italy"      albums = ["Italy", "Spain"]
# favorites = true     quality = 3        memories = true
# country = "it"       state = "Tuscany"  city = "Florence"
# year = 2024          after = "2024-06-01"  before = "2024-09-01"
# color = "blue"       mono = false       panorama = false
# orientation = "landscape"
# people = ["Ada"]     labels = ["beach"]  keywords = ["sunset"]
# media_type = "image"
# query = "flowers"    # raw PhotoPrism search string
```

## webdav

Nextcloud / Synology / ownCloud and other WebDAV shares.

```toml
[[sources]]
name            = "webdav"
enabled         = true
url             = "https://cloud.example.com/remote.php/dav/files/me/Photos"
username        = "me"
password        = "app-token"        # or token = "…"
recursive       = true
skip_tls_verify = false
```

## Multiple sources

List several `[[sources]]` tables; the engine merges them into one playlist and
`/sources` reports the per-source photo count and auth status. Disable a source
without deleting it via `enabled = false`.
