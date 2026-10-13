# mcp-server chart

A generic chart for **one small MCP server running inside the cluster**: a container that serves MCP over
Streamable HTTP on `:8080/mcp` and answers `/healthz` and `/readyz`. Today it deploys `supplier-mcp`.
Because nothing in it is supplier-specific, it can also deploy any other MCP server container image
(the "hosted MCP servers by container image" item).

## What it creates

| Object | Why |
|---|---|
| Deployment | `replicaCount` pods: non-root uid 1000, read-only root filesystem (writable `/tmp` emptyDir), all capabilities dropped, seccomp `RuntimeDefault`, no service-account token. It has readiness (`/readyz`) and liveness (`/healthz`) probes, plus an optional startup probe, and requests and limits. |
| Service (ClusterIP) | Stable in-cluster name: `http://<name>.<namespace>.svc.cluster.local:8080/mcp`. |
| NetworkPolicy | **Default-deny in both directions** for this release's pods. Ingress is allowed only on `:8080` and only from `networkPolicy.ingressFrom`, which by default is pods labelled `app.kubernetes.io/component=gateway` **in** namespace `platform`. Egress is allowed only for DNS, plus any `extraEgress` rules (none by default). |
| ConfigMap (optional) | `configFiles` are mounted read-only at `/config`. A checksum annotation rolls the pods when the files change. |

The chart never creates Secrets. `secretEnv` only *references* Secrets made by `scripts/secrets.sh`.
Labels follow `docs/CONTRACTS.md`: `app.kubernetes.io/name`, `instance` and `part-of: urumi` are set on every
pod. The chart refuses `component: gateway`, because that label is the gateway's network identity.

## Values layering

```
values.yaml                  generic, safe defaults
  + values-local.yaml        k3d: image urumi/<repo>:dev, loaded with `k3d image import`
  | values-prod.yaml         VPS: image ghcr.io/galabavamsi/<repo>:<git-sha> (tag passed with --set)
  + instances/<server>.yaml  which server: image repository, env, secretEnv, config files
```

When the same key appears in more than one file, the later file wins. Maps (`env`, `secretEnv`) merge key by key. Lists are replaced as a whole.

## supplier-mcp

Run from the repo root, inside WSL:

```bash
# local (k3d)
docker build -f docker/node-service.Dockerfile --build-arg APP=supplier-mcp -t urumi/supplier-mcp:dev .
k3d image import urumi/supplier-mcp:dev -c urumi
helm upgrade --install supplier-mcp charts/mcp-server -n mcp-upstreams \
  -f charts/mcp-server/values-local.yaml -f charts/mcp-server/instances/supplier.yaml \
  --wait --timeout 10m --rollback-on-failure

# production (k3s on the VPS)
helm upgrade --install supplier-mcp charts/mcp-server -n mcp-upstreams \
  -f charts/mcp-server/values-prod.yaml -f charts/mcp-server/instances/supplier.yaml \
  --set image.tag=<git-sha> --wait --timeout 10m --rollback-on-failure
```

Demo-only switches. Both are off by default, and you turn one on with an upgrade (`helm rollback` turns it off again):

```bash
helm upgrade supplier-mcp charts/mcp-server -n mcp-upstreams --reuse-values --set env.DEMO_SLOW_TOOL=true --wait
helm upgrade supplier-mcp charts/mcp-server -n mcp-upstreams --reuse-values --set env.DEMO_POISONED_DESCRIPTION=true --wait
```

- `DEMO_SLOW_TOOL` adds `slow_lookup {seconds}`, which shows the gateway's per-call timeout.
- `DEMO_POISONED_DESCRIPTION` adds a clearly labelled injected instruction to `check_stock`'s description, which shows the tool-poisoning threat.

## Adding another MCP server by image

Write `instances/<name>.yaml` with `nameOverride`, `image.repository`, `env`/`secretEnv` and, if the image
has no `/healthz`/`/readyz`, `tcpSocket` probes. If it must call an outside API, add an `extraEgress`
rule. Then install it into `mcp-upstreams` with the same command. A third-party image may run as a
different user, or may need a writable path other than `/tmp`. If so, override `podSecurityContext`
or add volumes. Don't loosen the defaults for everyone.

## Things worth knowing

- **runAsUser must be numeric.** Our image says `USER node`. The kubelet cannot prove that a user *name* is
  non-root, so with `runAsNonRoot: true` it refuses to start the container unless `runAsUser: 1000` is set.
- **In a NetworkPolicy peer, `namespaceSelector` and `podSelector` in the same list item are ANDed.** Writing them as
  two items (`- namespaceSelector` / `- podSelector`) ORs them and would let in every pod in `platform`.
- **Blocked connections fail fast on k3s.** kube-router rejects them, so a client sees `ECONNREFUSED` in about 0.3 s
  instead of a timeout. The same error appears when the server is scaled to 0 (no endpoints). The gateway
  therefore cannot tell "blocked" from "down" by the error alone. It gets the reason from its own health checks.
- **New pods need about 2-5 s** before kube-router's allow rules include them. Connections that are already open
  survive a newly applied policy, so apply policies before the traffic starts.
- **There is no `helm test` pod.** The NetworkPolicy would (correctly) block a test pod created by this release. Verify instead
  from a short-lived pod in `platform` labelled `app.kubernetes.io/component=gateway`. That pod should get 200 with
  the token and 401 without it. The same pod without the label, or in another namespace, should be refused.
