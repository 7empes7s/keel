# Portal access bootstrap

The live Keel portal authenticates through Cloudflare Access and authorizes the
verified email against Postgres `principal` and `role_grant`.

The initial operator is `marouanedefili@gmail.com`. It must retain both global
grants: `admin` for administration and `viewer` for the portal's `read`
capability. The role matrix is additive; removing `viewer` makes read pages
return 403. The live service runs from `/opt/keel-live/portal`; `/opt/keel` is
the orchestrator checkout.
