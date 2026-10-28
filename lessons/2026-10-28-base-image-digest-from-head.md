# A base image pinned to a digest the registry does not have (2026-10-28)

The keel-dsc image (`ops/powershell/Dockerfile.dsc`) pinned its base by digest. The digest was
read from the `Docker-Content-Digest` header of a `HEAD` request made through the cloud
session's proxy. That header did not match the manifest the registry serves for the tag, so the
server's build failed with "not found" (#662) after the PR had merged with green CI.

| Mistake | Rule now |
| --- | --- |
| The digest came from a `HEAD` response header and was not checked. | Take a digest from `docker image inspect --format '{{index .RepoDigests 0}}' <tag>` after a pull, or from a `GET` of the manifest whose body hashes to it (`sha256sum`). |
| Nothing in CI built or resolved the image, so a wrong pin reached master. | The Portal workflow resolves every pinned `FROM` in `ops/powershell/Dockerfile*` with `docker buildx imagetools inspect`, without pulling. |
