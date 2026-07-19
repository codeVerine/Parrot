import { RuntimeSignalSchema, signalId, type RuntimeSignal } from "@platform/contracts";
import type { HerdrCli } from "./client/cli.js";
import type { HerdrClient } from "./client/socket.js";
import type { HerdrSchema, IntegrationStatus } from "./client/types.js";
import { withConfig, type AdapterConfig } from "./config.js";
import { DegradedModeError, ProtocolMismatchError } from "./errors.js";

export type StartupResult = { schema: HerdrSchema; integrations: IntegrationStatus; missingIntegrations: string[]; degraded: boolean };

export async function runStartupChecks(client: HerdrClient, cli: HerdrCli, configInput: Partial<AdapterConfig> = {}, emit?: (signal: RuntimeSignal) => void): Promise<StartupResult> {
  const config = withConfig(configInput);
  const schema = await cli.schema(config.operationTimeoutMs);
  const variants = extractEventVariants(schema);
  if (schema.protocol !== config.protocol || schema.schema_version !== config.schemaVersion || variants.length !== 23) {
    const error = new ProtocolMismatchError(config.protocol, schema.protocol ?? null, config.schemaVersion, schema.schema_version ?? null);
    emit?.(protocolMismatchSignal(error));
    throw error;
  }
  const integrations = await cli.integrationStatus(config.operationTimeoutMs);
  const installed = new Set((integrations.integrations ?? []).filter((item) => item.installed === true || item.status === "installed").map((item) => item.name));
  const missingIntegrations = config.requiredIntegrations.filter((required) => !installed.has(required));
  if (missingIntegrations.length && config.mode === "production") {
    const error = new DegradedModeError(missingIntegrations, ["restore", "session-log-audit", "usage-extraction"], "Required Herdr integrations are missing in production mode.");
    emit?.(degradedErrorSignal(error));
    throw error;
  }
  return { schema, integrations, missingIntegrations, degraded: missingIntegrations.length > 0 };
}

export function extractEventVariants(schema: HerdrSchema): string[] {
  const direct = schema.event?.$defs?.EventData?.oneOf ?? schema.schemas?.event?.$defs?.EventData?.oneOf;
  return (direct ?? []).map((variant) => variant.properties?.type?.const).filter((type): type is string => typeof type === "string");
}

export function degradedSignal(startup: StartupResult) {
  const signal = { signalId: signalId(), kind: "DegradedModeEntered" as const, classification: "fault" as const, observedAt: new Date().toISOString(), source: "adapter_internal" as const, workflowId: null, iterationId: null, turnId: null, agentId: null, missingIntegrations: startup.missingIntegrations, disabledCapabilities: ["restore", "session-log-audit", "usage-extraction"] };
  return RuntimeSignalSchema.parse(signal);
}

function protocolMismatchSignal(error: ProtocolMismatchError): RuntimeSignal {
  return RuntimeSignalSchema.parse({ signalId: signalId(), kind: "ProtocolMismatch", classification: "fault", observedAt: new Date().toISOString(), source: "adapter_internal", workflowId: null, iterationId: null, turnId: null, agentId: null, expectedProtocol: error.expectedProtocol, observedProtocol: error.observedProtocol, expectedSchemaVersion: error.expectedSchemaVersion, observedSchemaVersion: error.observedSchemaVersion });
}

function degradedErrorSignal(error: DegradedModeError): RuntimeSignal {
  return RuntimeSignalSchema.parse({ signalId: signalId(), kind: "DegradedModeEntered", classification: "fault", observedAt: new Date().toISOString(), source: "adapter_internal", workflowId: null, iterationId: null, turnId: null, agentId: null, missingIntegrations: error.missingIntegrations, disabledCapabilities: error.disabledCapabilities });
}
