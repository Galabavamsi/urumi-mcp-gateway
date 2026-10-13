// Prometheus metrics, served on METRICS_PORT (in-cluster only, never on the Ingress).
// A registry per gateway instance (not prom-client's global one) so tests can build several gateways.
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export class GatewayMetrics {
  readonly registry = new Registry();

  readonly toolCalls = new Counter({
    name: 'gateway_tool_calls_total',
    help: 'Tool calls through the gateway, by upstream server slug, exposed tool name and audit status',
    labelNames: ['server', 'tool', 'status'] as const,
    registers: [this.registry],
  });

  readonly toolCallDuration = new Histogram({
    name: 'gateway_tool_call_duration_seconds',
    help: 'Duration of tool calls the upstream answered or that timed out (not fail-fast unreachable ones), by server slug',
    labelNames: ['server'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });

  readonly upstreamUp = new Gauge({
    name: 'gateway_upstream_up',
    help: '1 while the upstream server is connected (it flips on a connection failure or two failed checks in a row), else 0',
    labelNames: ['server'] as const,
    registers: [this.registry],
  });

  readonly authRejections = new Counter({
    name: 'gateway_auth_rejections_total',
    help: 'MCP requests rejected with 401, by reason',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry }); // process CPU, memory, event-loop lag
  }
}
