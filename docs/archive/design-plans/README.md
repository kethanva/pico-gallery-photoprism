# Historical PicoGallery design plans

These documents explain architectures and feature ideas considered before the
current PhotoPrism appliance converged on a small Node gateway plus a bounded
Cog/WPE display client. They are retained for rationale only.

They are **not requirements or active work**. Use root `spec.md` for binding
requirements, root `plan.md` for current checkboxes, and `docs/architecture.md`
for the shipped architecture.

| File | Historical role |
|---|---|
| `new_browser_first_implementation.md` | Greenfield browser/server V2 specification. |
| `split_client_server_implementation.md` | Pi 4 server + Pi Zero client alternative. |
| `frontend-qt-webengine.md` | Superseded Qt WebEngine kiosk proposal. |
| `client_features_backlog.md` | Browser-client optimization ideas. |
| `raspberry_pi_zero_features.md` | Pi Zero frontend research list. |
| `legacy-optimizations.md` | Optimizations for the abandoned Fastify/sharp design. |

When an archived idea becomes current, restate it in `spec.md` and `plan.md`;
do not reactivate an archive file in place.
