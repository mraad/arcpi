# Running arcpi in OpenShell

Recommendation, not yet run. Written against the OpenShell checkout at
`v0.1.3-pre.4` (`../OpenShell`, `docs/tutorials/run-pi-with-openrouter.mdx` is
the closest worked example). It needs OpenShell 0.1.x with a running gateway;
the commands below match the 0.1.2 CLI. Moving from 0.0.x is not an in-place
upgrade: uninstall first (`docs/upgrade/0-1-0.mdx` in the OpenShell checkout),
then install with `OPENSHELL_VERSION=v0.1.2`; on macOS that is the Homebrew
formula with the gateway as a Homebrew service.

[OpenShell](https://github.com/NVIDIA/OpenShell) runs an agent in a sandbox
whose file, process and network access come from a policy, and keeps real
credentials outside it: the sandbox sees placeholders that the proxy swaps for
the real value only on requests to approved endpoints.

## How arcpi fits

| arcpi piece | In a sandbox |
|---|---|
| pi and its model | Pi runs on Node; the model key comes from a provider whose `binaries` is `/usr/local/bin/node`. |
| Project and skills | Built into the image. `sandbox create --upload` cannot be combined with a start command yet (`crates/openshell-cli/src/run.rs`), whatever the Pi tutorial shows. |
| `.pi/settings.json` | pi locks it before reading, so the project directory must be writable: keep it under the sandbox working directory. |
| `artifacts/` | Inside the sandbox. Copy maps and data out with `openshell sandbox download`. |
| ArcGIS sign-in | `./arcpi login` cannot work inside: its browser callback listens on the sandbox's loopback. See phase 2. |
| `mappi` live map | Not in phase 1. The sandbox cannot reach the host's `127.0.0.1:8787` (policy never allows loopback destinations), and mappi serves `artifacts/` from its own filesystem. |
| Network | Denied by default. Each provider opens only its own endpoints. |

## Phase 1: local work and standalone maps

No ArcGIS REST, so no ArcGIS credential in the sandbox: local projects and
exports, `local-gis`, standalone HTML maps.

**Image.** Build from the checkout with its own ignore file, so the build
context holds only the named paths: never `.arcgis/`, `artifacts/` or `.env`.
Save as `Dockerfile.openshell.dockerignore` (BuildKit reads it instead of
`.dockerignore` for this Dockerfile):

```
**
!arcpi
!README.md
!arcgis-rest
!mappi
!.pi/APPEND_SYSTEM.md
!.pi/settings.json
```

and as `Dockerfile.openshell`:

```dockerfile
FROM node:26-trixie-slim
ARG PI_VERSION=1.1.0
# pi fetches fd and ripgrep from GitHub when missing; the sandbox blocks that.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates fd-find git ripgrep \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
  && npm cache clean --force
COPY --chown=node:node arcpi README.md /sandbox/arcpi/
COPY --chown=node:node arcgis-rest /sandbox/arcpi/arcgis-rest
COPY --chown=node:node .pi/APPEND_SYSTEM.md .pi/settings.json /sandbox/arcpi/.pi/
USER node
WORKDIR /sandbox/arcpi
# pi's settings and sessions; /tmp is writable in every policy.
ENV PI_CODING_AGENT_DIR=/tmp/pi-agent
```

```bash
docker build -t arcpi-sandbox:local -f Dockerfile.openshell .
```

Add local data the same way (`COPY` into `/sandbox/data`), or `openshell
sandbox upload` it into a running sandbox.

This layout assumes a Docker gateway, where the image's `WORKDIR` becomes the
writable workspace. Podman, Kubernetes and MicroVM always use `/sandbox`, and
on Kubernetes a workspace volume mounted there hides what the image put under
it (`../OpenShell/docs/how-it-works/sandboxes/runtimes.mdx`).

**Model provider.** Copy `../OpenShell/providers/anthropic.yaml` to
`provider-anthropic.yaml` and set `binaries: [/usr/local/bin/node]`: the
example allows only `curl`, and pi calls the API from Node. Then:

```bash
openshell profile lint -f provider-anthropic.yaml
openshell profile import -f provider-anthropic.yaml
ANTHROPIC_API_KEY=... openshell provider create --name anthropic --type anthropic --from-existing
```

pi sees only a placeholder in `ANTHROPIC_API_KEY`; the real key goes only to
`api.anthropic.com`. This assumes pi signs in to Anthropic with an API key; a
subscription login needs its own profile.

**Start.**

```bash
openshell sandbox create --name arcpi --from arcpi-sandbox:local --provider anthropic -- ./arcpi
openshell sandbox download arcpi artifacts ./artifacts-from-sandbox   # from another terminal
```

Trust the project when pi asks, or `.pi/settings.json` is ignored and codemode
stays off. Watch blocked connections with `openshell logs arcpi --tail`, and
review drafted rules with `openshell rule get arcpi --status pending`.

## Phase 2: ArcGIS REST with the token kept at the gateway

Recommended: let the gateway hold the ArcGIS refresh token and keep the access
token renewed (`strategy: oauth2_refresh_token`, as in
`../OpenShell/docs/tutorials/microsoft-graph-provider-refresh.mdx`). The
sandbox gets a stable placeholder in `ARCGIS_ACCESS_TOKEN`, and the proxy puts
the real token only into requests for the portal's hosts.

Sketch of the profile (unverified):

```yaml
id: arcgis
display_name: ArcGIS
category: other
credentials:
  - name: access_token
    env_vars: [ARCGIS_ACCESS_TOKEN]
    required: true
    auth_style: query
    query_param: token
    refresh:
      strategy: oauth2_refresh_token
      token_url: https://<portal>/sharing/rest/oauth2/token
      refresh_before: "300s"
      material:
        - { name: client_id, required: true }
        - { name: refresh_token, required: true, secret: true }
endpoints:
  - host: "*.arcgis.com"   # an ArcGIS Online portal and its services; list an Enterprise portal and its servers instead
    port: 443
    protocol: rest
    access: read-write
    enforcement: enforce
    request_body_credential_rewrite: true   # arcgis_request posts token as a form field
binaries: [/usr/local/bin/node]
```

Sign in once on the host with `./arcpi login`, then pass the refresh token to
`openshell provider refresh configure` without printing it.

This needs a change in `arcgis.ts` first: when `ARCGIS_ACCESS_TOKEN` is set,
use it as the token, skip the session file, refresh and the 498 retry, and keep
the trusted-host check and the `token` parameter refusal. To check before
building it:

- that OpenShell's `oauth2_refresh_token` request matches the ArcGIS token
  endpoint (`client_id`, `grant_type=refresh_token`, no client secret);
- that the placeholder is substituted in the POST form body and query string;
- whether responses that echo the real token reach the sandbox, since
  `arcgis.ts` can only redact the placeholder it knows.

Not recommended: uploading `.arcgis/` into the sandbox. It works without code
changes, but the refresh token then sits inside the sandbox, which is what
OpenShell exists to prevent.

## Phase 3: the live map

Run mappi (`node mappi/server.ts`)
inside the same sandbox, on its loopback (the default `127.0.0.1:8787` in
`arcgis-rest/mcp.json` then just works), and publish the page to the host
browser with OpenShell service forwarding ("Expose Long Running Services" in
`../OpenShell/docs/how-it-works/sandboxes/overview.mdx`). mappi's `/artifacts`
and arcpi's `artifacts/` then share one filesystem. Add
`COPY --chown=node:node mappi /sandbox/arcpi/mappi` to the image.
