# Platform metrics

All metric names start with `wakeel_`. Only queue names, providers, traffic modes,
operation status and kill reasons are labels. The endpoint contains no workspace,
conversation or message identifiers.

Scrape `GET /metrics` over the deployment's private service network. API, sandbox and
egress expose it on their normal service ports. The worker uses `METRICS_PORT` (9100 by
default). The Studio proxy routes `/v1/` to the API, so its public host does not proxy
this endpoint.

Use `infra/prometheus/scrape.yml` as a service-network configuration and import
`infra/grafana/dashboards/platform.json` into Grafana, selecting the Prometheus data
source. Map service DNS names to the deployment's private hostnames.

The worker reads queue counts at scrape time. A queue dependency failure returns HTTP
503 so Prometheus can report a failed scrape. Metrics are process-local and reset on
restart. Prometheus aggregates replicas with rates.
