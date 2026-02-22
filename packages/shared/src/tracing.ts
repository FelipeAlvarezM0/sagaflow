import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

export async function initTracing(serviceName: string): Promise<void> {
  if (sdk) {
    return;
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const config: ConstructorParameters<typeof NodeSDK>[0] = {
    resource: new Resource({ [SEMRESATTRS_SERVICE_NAME]: serviceName }),
    instrumentations: [getNodeAutoInstrumentations()]
  };

  if (endpoint) {
    config.traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });
  }

  sdk = new NodeSDK(config);

  await sdk.start();
}

export async function shutdownTracing(): Promise<void> {
  if (!sdk) {
    return;
  }

  await sdk.shutdown();
  sdk = undefined;
}
